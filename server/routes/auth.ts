/**
 * Authentication & user-management routes.
 *
 * Auth bootstrap (still single-user at install time):
 *   POST /api/auth/setup    { username, password } → { ok, token, user }
 *   POST /api/auth/login    { username, password } → { token, expiresAt, user }
 *   GET  /api/auth/me       → { user: { username, role } }  (requires bearer token)
 *   POST /api/auth/logout   → { ok }
 *   GET  /api/auth/status   → { authConfigured, username?, role? }
 *
 * Phase 3 additions — users + memberships + invites:
 *   GET    /api/auth/users             (Admin+)  list members of active org
 *   POST   /api/auth/users             (Owner)   create user + membership
 *   PUT    /api/auth/users/:id/role    (Admin+/Owner) change membership role
 *   DELETE /api/auth/users/:id         (Owner)   remove from active org
 *   POST   /api/auth/users/:id/password            self or Owner — reset
 *   POST   /api/auth/invites           (Admin+)  issue invite token
 *   GET    /api/auth/invites           (Admin+)  list active invites
 *   DELETE /api/auth/invites/:token    (Admin+)  revoke invite
 *   GET    /api/auth/invites/:token    (public)  invite landing metadata
 *   POST   /api/auth/invites/:token/accept (public) redeem invite
 *
 * PUBLIC_PATHS + PUBLIC_PREFIXES in `server/auth.ts` let `/status`,
 * `/login`, and the invite landing/accept endpoints through without
 * authentication. Everything else goes through the auth middleware.
 */
import { Router, Request, Response } from 'express';
import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';
import config from '../config.js';
import { signJwt } from '../jwt.js';
import { hashPassword, verifyPassword } from '../password.js';
import {
  getAuthRecord,
  isAuthConfigured,
  saveAuthRecord,
  generateJwtSecret,
} from '../auth-store.js';
import { requireRole, hasAtLeastRole, parseRole, type Role } from '../roles.js';
import { isLocalBundledServer, type AuthenticatedRequest } from '../auth.js';
import { getActiveOrgId, getOrg, getOrgsDb } from '../orgs.js';
import {
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  deleteUser,
  updateUserPassword,
  countUsers,
  migrateAuthRecordIfNeeded,
  getUserClaudeAuth,
  setUserClaudeAuth,
} from '../users-store.js';
import {
  createMembership,
  deleteMembership,
  getMembershipRole,
  setMembershipRole,
  countOwnersForOrg,
  countMembershipsForUser,
  listMembersForOrg,
} from '../memberships-store.js';
import {
  createInvite,
  deleteInvite,
  getInvite,
  inviteState,
  listActiveInvitesForOrg,
  markInviteAccepted,
} from '../invites-store.js';
import {
  sanitizeUsername,
  sanitizePassword,
  MIN_PASSWORD_LEN,
  MAX_PASSWORD_LEN,
} from '../auth-validation.js';
import { parseClaudeOAuthExpiry } from '../oauth-expiry.js';
import { createApiKey, listApiKeys, revokeApiKey, countApiKeysForUser } from '../api-keys-store.js';
import {
  listMaskedUserSkillCredentials,
  upsertUserSkillCredential,
  deleteUserSkillCredential,
  existsUserSkillCredential,
  deleteUserSkillCredentialByKey,
} from '../skill-credentials-store.js';
import { readCredentialsSchemaForSkill } from '../skill-credentials-resolve.js';
import { findAgent } from '../project-model.js';

const DEFAULT_TOKEN_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

function issueToken(user: { id: string; username: string }, role: Role, jwtSecret: string) {
  const token = signJwt(user.username, jwtSecret, {
    expiresInSec: DEFAULT_TOKEN_TTL_SEC,
    claims: { role, uid: user.id },
  });
  const expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_SEC * 1000).toISOString();
  return { token, expiresAt };
}

// ── Rate-limit defaults ────────────────────────────────────────────
// Public launch blocker (see kanban "Auth hardening: rate-limit login
// & invite-accept endpoints"). Without these, two-account brute-force
// works over the internet. Thresholds were chosen to be permissive
// enough that a human fat-fingering their password a few times won't
// lock themselves out, but tight enough that a credential-stuffing
// script can't meaningfully chip away at the space.
// Exported so tests can pin the default thresholds — a typo here
// (dropping a zero, swapping min↔h) would otherwise slip past CI since
// the override-based tests pass their own numbers.
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
export const LOGIN_RATE_LIMIT_MAX = 10;
export const INVITE_ACCEPT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 h
export const INVITE_ACCEPT_RATE_LIMIT_MAX = 5;

/**
 * Render a credential for the UI without leaking the secret. Returns
 * `null` for empty inputs so the client can simply check truthiness to
 * decide whether the field is configured.
 *
 * Format: keep the recognisable prefix up to the first `-` (or first 8
 * chars when no `-`) plus a fixed `…` marker. Never echo the raw value.
 */
export function maskCredential(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const dash = trimmed.indexOf('-', 8);
  const prefix = dash > 0 ? trimmed.slice(0, dash + 1) : trimmed.slice(0, 8);
  return `${prefix}…`;
}

export interface AuthRoutesOptions {
  /** Override login limiter. Tests pass tiny windows to exercise 429s quickly. */
  loginRateLimit?: { windowMs: number; limit: number };
  /** Override invite-accept limiter. */
  inviteAcceptRateLimit?: { windowMs: number; limit: number };
  /** Disable rate limiting entirely — used by tests that aren't about the limiter itself. */
  disableRateLimit?: boolean;
}

type LimiterHandler = NonNullable<RateLimitOptions['handler']>;

function makeLimitHandler(label: string, pathLabel: string): LimiterHandler {
  return (req, res, _next, options) => {
    // Console-warn rather than structured-log for v1 — fuels the
    // Session Health observability work without introducing a new
    // sink. We deliberately log `pathLabel` (the route pattern) rather
    // than `req.originalUrl`: the invite-accept URL contains the real
    // invite token, which is a bearer-equivalent secret. A fat-fingered
    // invitee who trips the limiter would otherwise burn that token
    // straight into PM2 logs. Username is also omitted for the same
    // class of reason — a naive log scrape shouldn't double as an
    // enumerated hit-list of targeted accounts.
    const ip = req.ip ?? 'unknown';
    console.warn(
      `[auth] rate-limit hit label=${label} ip=${ip} path=${pathLabel} limit=${options.limit} windowMs=${options.windowMs}`,
    );
    // express-rate-limit will have already set Retry-After via
    // standardHeaders='draft-7'. We just shape the body.
    res.status(options.statusCode).json({
      error: 'Too many requests. Please try again later.',
      code: 'rate_limited',
    });
  };
}

function buildLoginLimiter(opts: AuthRoutesOptions) {
  if (opts.disableRateLimit) {
    return (_req: Request, _res: Response, next: () => void) => next();
  }
  const { windowMs, limit } = opts.loginRateLimit ?? {
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: LOGIN_RATE_LIMIT_MAX,
  };
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // `skipSuccessfulRequests: true` would mean a successful login
    // doesn't burn quota — but it would also let an attacker who
    // *happens* to guess a password mid-window avoid the rate cap.
    // Keep the default (count everything) so successful logins still
    // tick the meter.
    //
    // `keyGenerator` is omitted — express-rate-limit v8's default
    // already uses `ipKeyGenerator(req.ip, ipv6Subnet)`. Leaving it
    // unset also means IPv6 subnet masking stays consistent with the
    // library default if we ever configure `ipv6Subnet`.
    handler: makeLimitHandler('login', '/api/auth/login'),
  });
}

function buildInviteAcceptLimiter(opts: AuthRoutesOptions) {
  if (opts.disableRateLimit) {
    return (_req: Request, _res: Response, next: () => void) => next();
  }
  const { windowMs, limit } = opts.inviteAcceptRateLimit ?? {
    windowMs: INVITE_ACCEPT_RATE_LIMIT_WINDOW_MS,
    limit: INVITE_ACCEPT_RATE_LIMIT_MAX,
  };
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // See comment in buildLoginLimiter — keyGenerator omitted on
    // purpose to inherit the library default (ipKeyGenerator over
    // req.ip). The pathLabel is critical here: the real URL contains
    // the invite token, which must never hit the logs.
    handler: makeLimitHandler('invite-accept', '/api/auth/invites/:token/accept'),
  });
}

export default function createAuthRoutes(options: AuthRoutesOptions = {}): Router {
  const router = Router();
  const loginLimiter = buildLoginLimiter(options);
  const inviteAcceptLimiter = buildInviteAcceptLimiter(options);

  // ── Status (public) ────────────────────────────────────────────
  router.get('/api/auth/status', (_req: Request, res: Response) => {
    const record = getAuthRecord();
    const jwtConfigured = !!record;
    const apiKeyConfigured = !!config.apiKey;
    // `needsMigration` is true only for the apiKey-only deployment state:
    // the server is already protected by the legacy shared secret, but no
    // JWT `auth.json` has been written yet. The client uses this to show
    // the "upgrade my auth" banner. Once /api/auth/setup has run the
    // record exists and this flips to false even if the apiKey is still
    // present (apiKey stays as break-glass, not a migration signal).
    const needsMigration = apiKeyConfigured && !jwtConfigured;
    // Signals to the client whether the auth gate is short-circuited
    // because the server is running as a local bundled install
    // (Electron / dev box). Source-of-truth is the `AGENT_HUB_MODE` env
    // var, set by the launching process — not the orgs DB. See the
    // JSDoc on `isLocalBundledServer()` for why.
    //
    // Field name `activeOrgIsLocal` is preserved for client/back-compat;
    // the AuthGate consumes it to suppress the login screen on local.
    const activeOrgIsLocal = isLocalBundledServer();
    res.json({
      authConfigured: jwtConfigured,
      username: record?.username ?? null,
      // Role is safe to leak publicly — it's the owner's role at install
      // time, not a per-caller claim. The UI uses it to decide whether
      // to show the "first Owner" vs "sign in" copy.
      role: record?.role ?? null,
      jwtConfigured,
      apiKeyConfigured,
      needsMigration,
      activeOrgIsLocal,
    });
  });

  // ── First-run setup (public, but idempotent / locked) ──────────
  router.post('/api/auth/setup', async (req: Request, res: Response) => {
    if (isAuthConfigured()) {
      res.status(409).json({ error: 'Auth already configured' });
      return;
    }
    const { username: rawUser, password: rawPass } = req.body as {
      username?: string;
      password?: string;
    };
    const username = sanitizeUsername(rawUser);
    const password = sanitizePassword(rawPass);
    if (!username) {
      res.status(400).json({
        error: 'username must be 1–64 chars of letters, digits, ., _, -, @',
      });
      return;
    }
    if (!password) {
      res.status(400).json({
        error: `password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars`,
      });
      return;
    }

    const passwordHash = await hashPassword(password);
    // First-run setup always creates the Owner — there's nobody else to
    // promote them, and the install would otherwise have no way to
    // reach admin endpoints.
    const record = saveAuthRecord({
      username,
      passwordHash,
      jwtSecret: generateJwtSecret(),
      role: 'Owner',
    });

    // Phase 3: also seed the users + memberships tables. The migration
    // helper is a no-op after the first run, so it's safe to call every
    // time setup is invoked. Swallow orgs-db-not-initialized — a few
    // legacy test paths skip that setup and we still want auth.json to
    // land.
    let user = null;
    try {
      migrateAuthRecordIfNeeded();
      user = getUserByUsername(record.username);
    } catch (err) {
      console.error('[Auth] migrateAuthRecordIfNeeded after /setup failed:', err);
    }

    // Belt-and-suspenders cache invalidation. `getOrgOwnerUserId` no
    // longer caches `null` (see `session-ownership.ts`), but resetting
    // here keeps the cache honest if a future change re-introduces a
    // negative-cache code path. Without this, system spawns immediately
    // after first-run setup might still resolve to a stale `null`.
    // Imported lazily so test files that mock `../config.js` (without
    // seeding `defaultCwd`) don't trigger `db.ts` module-load initDb.
    try {
      const { resetOrgOwnerCache } = await import('../session-ownership.js');
      resetOrgOwnerCache();
    } catch (err) {
      console.warn('[Auth] failed to reset org owner cache after /setup:', err);
    }

    const { token, expiresAt } = issueToken(
      user ?? { id: '', username: record.username },
      record.role,
      record.jwtSecret,
    );

    res.json({
      ok: true,
      token,
      expiresAt,
      user: { username: record.username, role: record.role },
    });
  });

  // ── Login (public, rate-limited per IP) ────────────────────────
  router.post('/api/auth/login', loginLimiter, async (req: Request, res: Response) => {
    const authRecord = getAuthRecord();
    if (!authRecord) {
      res.status(409).json({ error: 'Auth not configured. Call /api/auth/setup first.' });
      return;
    }
    const { username: rawUser, password: rawPass } = req.body as {
      username?: string;
      password?: string;
    };
    const username = typeof rawUser === 'string' ? rawUser.trim() : '';
    const password = typeof rawPass === 'string' ? rawPass : '';

    // Run verifyPassword even on an unknown user so response time doesn't
    // leak whether the username exists. If orgs.db isn't initialized
    // (some legacy test paths / mid-boot), fall through to the auth.json
    // single-user record so those callers keep working.
    let user = null;
    try {
      user = getUserByUsername(username);
    } catch {
      user = null;
    }
    // Fallback for boot-in-progress: if the users table hasn't been
    // seeded yet (rare — migration should have run), and the input
    // matches the auth-store owner, accept against that record.
    const usingAuthRecordFallback = !user && username === authRecord.username;
    const storedHash = user?.password_hash ?? authRecord.passwordHash;

    const ok = await verifyPassword(password, storedHash);
    if ((!user && !usingAuthRecordFallback) || !ok) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    if (!user) {
      // Run the migration and re-resolve so we can issue a proper uid token.
      try {
        migrateAuthRecordIfNeeded();
        user = getUserByUsername(username);
      } catch {
        user = null;
      }
    }

    // Resolve the caller's role in the currently active org. If they
    // have no membership, reject the login so the client doesn't end up
    // holding a token that fails every API call. If orgs.db isn't
    // initialized yet (legacy boot paths), skip enforcement and fall
    // back to the auth.json role.
    let orgId = '';
    let role: Role | null = null;
    let orgsDbReady = false;
    try {
      orgId = getActiveOrgId();
      orgsDbReady = true;
      role = user ? getMembershipRole(user.id, orgId) : null;
    } catch {
      // orgs.db not initialized — skip membership enforcement.
      orgsDbReady = false;
    }

    // Auto-seed an Owner membership for the *sole* user on a fresh
    // install — this covers the Phase-2 → Phase-3 upgrade where the
    // migration ran but the only user row doesn't yet have a membership
    // in the active org. This is intentionally scoped to `countUsers()
    // === 1`: in a multi-user install, a missing membership is a real
    // permissions state ("removed from org") and we must NOT invent one.
    if (user && !role && orgsDbReady && orgId) {
      try {
        if (countUsers() === 1) {
          createMembership(user.id, orgId, 'Owner');
          role = 'Owner';
        }
      } catch {}
    }

    // Multi-user case: user exists, orgs.db is healthy, they authed
    // successfully, but they have no membership in the active org.
    // Refuse to issue a token — per the comment above, a token without
    // a membership would 403 on every subsequent API call. Surface that
    // as an explicit login failure instead of a half-broken session.
    if (user && !role && orgsDbReady) {
      res.status(403).json({
        error:
          'You are not a member of the active organization. Ask an admin to add you or accept an invite.',
        code: 'no_membership',
      });
      return;
    }

    // At this point either (a) we have a real membership role, or
    // (b) orgs.db wasn't ready and we're on the legacy single-user
    // fallback. Issuing authRecord.role in case (b) is safe because the
    // middleware falls back to the same record for uninitialized-orgs.db
    // requests.
    const resolvedRole: Role = role ?? authRecord.role;
    const subject = user ?? { id: '', username: authRecord.username };
    const { token, expiresAt } = issueToken(subject, resolvedRole, authRecord.jwtSecret);
    res.json({
      token,
      expiresAt,
      user: { username: subject.username, role: resolvedRole },
    });
  });

  // ── Current user (protected by auth middleware) ────────────────
  router.get('/api/auth/me', (req: Request, res: Response) => {
    const record = getAuthRecord();
    const authedReq = req as AuthenticatedRequest;
    const subject = authedReq.authUser || record?.username || null;
    const role: Role | null = authedReq.authRole ?? record?.role ?? null;
    res.json({
      user: subject ? { username: subject, role } : null,
      authConfigured: !!record,
      role,
      orgId: authedReq.authOrgId ?? null,
    });
  });

  // ── Per-user Claude credentials ────────────────────────────────
  //
  // Each authenticated user may attach their own ANTHROPIC_API_KEY and
  // CLAUDE_CODE_OAUTH_TOKEN. When set, `buildSpawnEnv` injects the
  // session owner's values instead of the host-wide config — see
  // `server/config.ts::buildSpawnEnv`. Tokens are returned masked so
  // the page can display "configured" status without leaking secrets;
  // only the metadata (length, prefix, expiry, updatedAt) round-trips.
  router.get('/api/auth/me/claude-auth', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const stored = getUserClaudeAuth(authedReq.authUserId);
    if (!stored) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // Normalise the stored expiry through the same seconds-vs-ms helper the
    // host-config path uses (`server/routes/claude-auth.ts`), so a value
    // written as JWT-style Unix seconds doesn't render as "Expired" in the
    // UI for the next ~55 years. Returning a normalised ISO string plus a
    // server-computed `claudeCodeOAuthExpired` boolean lets the UI render
    // the chip without doing its own `Date.now() > expiresAt` comparison
    // against an un-normalised value.
    const expiry = parseClaudeOAuthExpiry(stored.claudeCodeOAuthExpiresAt);
    res.json({
      anthropicApiKey: maskCredential(stored.anthropicApiKey),
      claudeCodeOAuthToken: maskCredential(stored.claudeCodeOAuthToken),
      claudeCodeOAuthExpiresAt: expiry ? expiry.iso : stored.claudeCodeOAuthExpiresAt,
      claudeCodeOAuthExpired: expiry ? expiry.expired : null,
      updatedAt: stored.updatedAt,
      hostConfigFallback: {
        anthropicApiKey: !!config.anthropicApiKey,
        claudeCodeOAuthToken: !!config.claudeCodeOAuthToken,
      },
    });
  });

  router.put('/api/auth/me/claude-auth', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const body = (req.body ?? {}) as {
      anthropicApiKey?: string | null;
      claudeCodeOAuthToken?: string | null;
      claudeCodeOAuthExpiresAt?: string | null;
    };
    // Whitelist fields to prevent stray JSON keys from reaching the DB.
    const patch: {
      anthropicApiKey?: string | null;
      claudeCodeOAuthToken?: string | null;
      claudeCodeOAuthExpiresAt?: string | null;
    } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'anthropicApiKey')) {
      patch.anthropicApiKey = body.anthropicApiKey ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'claudeCodeOAuthToken')) {
      patch.claudeCodeOAuthToken = body.claudeCodeOAuthToken ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'claudeCodeOAuthExpiresAt')) {
      patch.claudeCodeOAuthExpiresAt = body.claudeCodeOAuthExpiresAt ?? null;
    }
    const updated = setUserClaudeAuth(authedReq.authUserId, patch);
    if (!updated) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // Same normalisation as GET so the UI can re-render the expiry chip
    // immediately on save without waiting for a follow-up GET. Without
    // this, a client that PUTs Unix-seconds expiry would see the raw
    // value echoed back and recompute `expired` against an un-normalised
    // numeric string — the exact bug PR #723 fixed for the host path.
    const expiryAfter = parseClaudeOAuthExpiry(updated.claudeCodeOAuthExpiresAt);
    res.json({
      anthropicApiKey: maskCredential(updated.anthropicApiKey),
      claudeCodeOAuthToken: maskCredential(updated.claudeCodeOAuthToken),
      claudeCodeOAuthExpiresAt: expiryAfter ? expiryAfter.iso : updated.claudeCodeOAuthExpiresAt,
      claudeCodeOAuthExpired: expiryAfter ? expiryAfter.expired : null,
      updatedAt: updated.updatedAt,
      // Mirror GET so a client can re-render the "falling back to host"
      // hint without an extra round-trip after save.
      hostConfigFallback: {
        anthropicApiKey: !!config.anthropicApiKey,
        claudeCodeOAuthToken: !!config.claudeCodeOAuthToken,
      },
    });
  });

  // ── Per-user skill credentials (encrypted; keys merged into spawn env) ──
  router.get('/api/auth/me/skill-credentials', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const skillIdRaw = req.query.skillId;
    const skillId = typeof skillIdRaw === 'string' && skillIdRaw.trim() ? skillIdRaw.trim() : null;
    try {
      const rows = listMaskedUserSkillCredentials(authedReq.authUserId, skillId);
      res.json({ credentials: rows });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/api/auth/me/skill-credentials', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const body = (req.body ?? {}) as {
      skill_id?: unknown;
      key_name?: unknown;
      value?: unknown;
      agent_id?: unknown;
    };
    const skill_id = typeof body.skill_id === 'string' ? body.skill_id.trim() : '';
    const key_name = typeof body.key_name === 'string' ? body.key_name.trim() : '';
    const agent_id = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
    const value = typeof body.value === 'string' ? body.value : '';
    if (!skill_id || !key_name || !agent_id) {
      res.status(400).json({ error: 'skill_id, key_name, and agent_id are required' });
      return;
    }

    const foundAgent = findAgent(agent_id);
    if (!foundAgent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const workspace =
      typeof foundAgent.project.ahw === 'string' ? foundAgent.project.ahw.trim() : '';
    if (!workspace) {
      res.status(404).json({ error: 'No workspace configured for this agent' });
      return;
    }

    const parsed = readCredentialsSchemaForSkill(skill_id, {
      projectWorkspaces: [workspace],
    });
    if (parsed.error) {
      res.status(400).json({ error: `invalid credential schema for skill: ${parsed.error}` });
      return;
    }
    if (parsed.credentials.length === 0) {
      res.status(400).json({ error: 'This skill declares no credentials in SKILL.md frontmatter' });
      return;
    }
    const spec = parsed.credentials.find((c) => c.name === key_name);
    if (!spec) {
      res
        .status(400)
        .json({ error: `Unknown credential key "${key_name}" for skill "${skill_id}"` });
      return;
    }
    if (spec.required && value.trim().length === 0) {
      res.status(400).json({ error: `Credential "${key_name}" is required` });
      return;
    }
    if (!spec.required && value.trim().length === 0) {
      if (!existsUserSkillCredential(authedReq.authUserId, skill_id, key_name)) {
        res.json({ credential: null, skipped: true as const });
        return;
      }
      deleteUserSkillCredentialByKey(
        authedReq.authUserId,
        skill_id,
        key_name,
        authedReq.authUserId,
      );
      res.json({ credential: null, cleared: true as const });
      return;
    }

    try {
      const row = upsertUserSkillCredential({
        userId: authedReq.authUserId,
        skillId: skill_id,
        keyName: key_name,
        value,
        actorUserId: authedReq.authUserId,
      });
      res.json({ credential: row });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/auth/me/skill-credentials/:id', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { id } = req.params as { id: string };
    const result = deleteUserSkillCredential(authedReq.authUserId, id, authedReq.authUserId);
    if (!result.ok) {
      res.status(404).json({ error: 'Credential not found' });
      return;
    }
    res.json({ ok: true });
  });

  // ──────────────────────────────────────────────────────────────
  //  Per-user API keys
  // ──────────────────────────────────────────────────────────────
  //
  // Long-lived programmatic credentials owned by an individual user.
  // Distinct from JWTs (7-day session tokens) and from the global
  // AGENT_HUB_API_KEY break-glass. Use cases: scripts, CI, remote
  // Electron clients that need stable creds without re-logging in.
  //
  //   POST   /api/auth/keys        create a new key — token in response ONCE
  //   GET    /api/auth/keys        list active keys for the caller (no token)
  //   DELETE /api/auth/keys/:id    revoke (soft delete)
  //
  // Generation is rate-limited to MAX_KEYS_PER_USER active keys per user
  // to prevent runaway accumulation; revoke an old one to make room.

  const MAX_KEYS_PER_USER = 50;

  router.get('/api/auth/keys', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const keys = listApiKeys(authedReq.authUserId).map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
    }));
    res.json({ keys });
  });

  router.post('/api/auth/keys', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const body = (req.body ?? {}) as { name?: unknown; expiresInDays?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length === 0 || name.length > 100) {
      res.status(400).json({ error: 'name must be 1-100 characters' });
      return;
    }
    let expiresInDays: number | null = null;
    if (body.expiresInDays != null && body.expiresInDays !== '') {
      const n = Number(body.expiresInDays);
      if (!Number.isFinite(n) || n < 1 || n > 3650) {
        res.status(400).json({ error: 'expiresInDays must be between 1 and 3650' });
        return;
      }
      expiresInDays = Math.floor(n);
    }

    // Cap active keys per user. Revoked keys don't count.
    const active = listApiKeys(authedReq.authUserId).length;
    if (active >= MAX_KEYS_PER_USER) {
      res.status(429).json({
        error: `Limit of ${MAX_KEYS_PER_USER} active API keys per user. Revoke an existing key first.`,
      });
      return;
    }

    try {
      const key = createApiKey(authedReq.authUserId, name, expiresInDays);
      res.status(201).json({
        id: key.id,
        name: key.name,
        token: key.token, // shown ONCE — never returned again
        prefix: key.prefix,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to create API key';
      res.status(400).json({ error: message });
    }
  });

  router.delete('/api/auth/keys/:id', (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    if (!authedReq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const { id } = req.params as { id: string };
    const ok = revokeApiKey(authedReq.authUserId, id);
    if (!ok) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }
    res.json({ ok: true });
  });

  // Lightweight back-door for tests / future audit UI: total key count
  // (active + revoked) for the caller. Kept un-exported from the route
  // surface for now; tests import countApiKeysForUser directly. The
  // _unused_ marker suppresses the lint warning while keeping the symbol
  // referenced for tree-shaking awareness.
  void countApiKeysForUser;

  // ──────────────────────────────────────────────────────────────
  //  Users — multi-user roster (Phase 3)
  // ──────────────────────────────────────────────────────────────

  // GET /api/auth/users — Admin+ — members of the active org
  router.get('/api/auth/users', requireRole('Admin'), (_req: Request, res: Response) => {
    const record = getAuthRecord();
    let orgId: string;
    try {
      orgId = getActiveOrgId();
    } catch {
      // orgs.db not initialized (some legacy test harnesses). Fall back
      // to the single-user auth.json view — this keeps the pre-Phase-3
      // behavior intact in those paths.
      const users = record
        ? [{ username: record.username, role: record.role, createdAt: record.createdAt }]
        : [];
      res.json({ users });
      return;
    }

    const members = listMembersForOrg(orgId);
    if (members.length === 0 && record) {
      // orgs.db is healthy but migration hasn't been kicked yet (fresh
      // setup followed by an immediate list). Fall back to the legacy
      // shape — migration will catch up on next boot.
      res.json({
        users: [
          {
            id: null,
            username: record.username,
            role: record.role,
            createdAt: record.createdAt,
          },
        ],
      });
      return;
    }
    res.json({
      users: members.map((m) => ({
        id: m.userId,
        username: m.username,
        role: m.role,
        createdAt: m.createdAt,
      })),
    });
  });

  // POST /api/auth/users — Owner only
  router.post('/api/auth/users', requireRole('Owner'), async (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const {
      username: rawUser,
      password: rawPass,
      role: rawRole,
    } = req.body as {
      username?: string;
      password?: string;
      role?: string;
    };
    const username = sanitizeUsername(rawUser);
    const password = sanitizePassword(rawPass);
    const role = parseRole(rawRole) ?? 'User';
    if (!username) {
      res.status(400).json({ error: 'invalid username' });
      return;
    }
    if (!password) {
      res
        .status(400)
        .json({ error: `password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars` });
      return;
    }
    if (role === 'Owner' && authedReq.authRole !== 'Owner') {
      // Belt-and-suspenders — requireRole('Owner') already gates this,
      // but the extra check keeps the invariant readable at the route.
      res.status(403).json({ error: 'Only an Owner can create another Owner.' });
      return;
    }
    if (getUserByUsername(username)) {
      res.status(409).json({ error: 'username already taken' });
      return;
    }
    const orgId = getActiveOrgId();
    const passwordHash = await hashPassword(password);
    const user = createUser({ username, passwordHash });
    createMembership(user.id, orgId, role);
    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        role,
        createdAt: user.created_at,
      },
    });
  });

  // PUT /api/auth/users/:id/role — change membership role in active org
  router.put('/api/auth/users/:id/role', requireRole('Admin'), (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const { id } = req.params as { id: string };
    const nextRole = parseRole((req.body as { role?: unknown }).role);
    if (!nextRole) {
      res.status(400).json({ error: 'role must be Owner, Admin, or User' });
      return;
    }

    const target = getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    const orgId = getActiveOrgId();
    const currentRole = getMembershipRole(id, orgId);
    if (!currentRole) {
      res.status(404).json({ error: 'user is not a member of this org' });
      return;
    }

    // Promotions to or from Owner require Owner privilege on the caller.
    const touchingOwner = currentRole === 'Owner' || nextRole === 'Owner';
    if (touchingOwner && authedReq.authRole !== 'Owner') {
      res.status(403).json({ error: 'Only an Owner can change the Owner role.' });
      return;
    }

    // Preserve the "don't strand the org without an Owner" invariant.
    if (currentRole === 'Owner' && nextRole !== 'Owner') {
      const owners = countOwnersForOrg(orgId);
      if (owners <= 1) {
        res.status(400).json({
          error: 'Cannot demote the only Owner of this org. Promote another user first.',
        });
        return;
      }
    }

    setMembershipRole(id, orgId, nextRole);
    res.json({ ok: true, userId: id, orgId, role: nextRole });
  });

  // DELETE /api/auth/users/:id — remove from active org (Owner only)
  router.delete('/api/auth/users/:id', requireRole('Owner'), (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const target = getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    const orgId = getActiveOrgId();
    const currentRole = getMembershipRole(id, orgId);
    if (!currentRole) {
      res.status(404).json({ error: 'user is not a member of this org' });
      return;
    }
    if (currentRole === 'Owner' && countOwnersForOrg(orgId) <= 1) {
      res.status(400).json({ error: 'Cannot remove the only Owner of this org.' });
      return;
    }

    deleteMembership(id, orgId);
    let userDeleted = false;
    if (countMembershipsForUser(id) === 0) {
      deleteUser(id);
      userDeleted = true;
    }
    res.json({ ok: true, userId: id, orgId, userDeleted });
  });

  // POST /api/auth/users/:id/password — self-reset or Owner-reset
  router.post('/api/auth/users/:id/password', async (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const { id } = req.params as { id: string };
    const { newPassword } = req.body as { newPassword?: string };
    const password = sanitizePassword(newPassword);
    if (!password) {
      res.status(400).json({
        error: `newPassword must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars`,
      });
      return;
    }

    const target = getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'user not found' });
      return;
    }

    const isSelf = authedReq.authUserId === id;
    const isOwner = authedReq.authRole === 'Owner';
    if (!isSelf && !isOwner) {
      res.status(403).json({
        error: 'You can only reset your own password. Owners can reset any password.',
      });
      return;
    }

    const passwordHash = await hashPassword(password);
    updateUserPassword(id, passwordHash);
    // Known limitation: stateless JWTs can't be server-revoked — tokens
    // issued before this call remain valid until their `exp`. Phase 4
    // will layer on a revocation list.
    res.json({ ok: true, userId: id });
  });

  // ──────────────────────────────────────────────────────────────
  //  Invites
  // ──────────────────────────────────────────────────────────────

  // POST /api/auth/invites — Admin+
  router.post('/api/auth/invites', requireRole('Admin'), (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const {
      role: rawRole,
      email,
      ttlHours,
    } = req.body as {
      role?: string;
      email?: string;
      ttlHours?: number;
    };
    const role = parseRole(rawRole);
    if (!role || role === 'Owner') {
      res.status(400).json({ error: 'role must be Admin or User (Owner is never invited)' });
      return;
    }
    if (!authedReq.authUserId || !authedReq.authOrgId) {
      // API-key caller or misconfigured request — we need both to
      // attribute the invite. Break-glass callers can POST with a
      // bearer token if they need to issue invites.
      res.status(400).json({ error: 'invite issuance requires an authenticated user session' });
      return;
    }
    const invite = createInvite({
      orgId: authedReq.authOrgId,
      role,
      email: email ?? null,
      createdBy: authedReq.authUserId,
      ttlHours,
    });
    const baseUrl = process.env.PUBLIC_ORIGIN || '';
    const url = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/invite/${invite.token}`
      : `/invite/${invite.token}`;
    res.status(201).json({
      token: invite.token,
      url,
      role: invite.role,
      email: invite.email,
      expiresAt: invite.expires_at,
      createdAt: invite.created_at,
    });
  });

  // GET /api/auth/invites — Admin+ — list active invites for active org
  router.get('/api/auth/invites', requireRole('Admin'), (req: Request, res: Response) => {
    const authedReq = req as AuthenticatedRequest;
    const orgId = authedReq.authOrgId || getActiveOrgId();
    const rows = listActiveInvitesForOrg(orgId);
    res.json({
      invites: rows.map((r) => ({
        token: r.token,
        orgId: r.org_id,
        role: r.role,
        email: r.email,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      })),
    });
  });

  // DELETE /api/auth/invites/:token — Admin+
  router.delete('/api/auth/invites/:token', requireRole('Admin'), (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    const row = getInvite(token);
    if (!row) {
      res.status(404).json({ error: 'invite not found' });
      return;
    }
    const authedReq = req as AuthenticatedRequest;
    if (authedReq.authOrgId && row.org_id !== authedReq.authOrgId) {
      // Prevent cross-org revocation — caller's active org has to
      // match the invite's home org.
      res.status(403).json({ error: 'invite belongs to another org' });
      return;
    }
    deleteInvite(token);
    res.json({ ok: true, token });
  });

  // GET /api/auth/invites/:token — public landing metadata
  router.get('/api/auth/invites/:token', (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    const row = getInvite(token);
    const state = inviteState(row);
    if (!row || state === 'not-found') {
      res.status(404).json({ error: 'invite not found' });
      return;
    }
    if (state === 'expired') {
      res.status(410).json({ error: 'invite expired', state });
      return;
    }
    const org = getOrg(row.org_id);
    res.json({
      orgId: row.org_id,
      orgName: org?.name ?? row.org_id,
      role: row.role,
      email: row.email,
      expiresAt: row.expires_at,
      accepted: state === 'already-accepted',
    });
  });

  // POST /api/auth/invites/:token/accept — public (consumes invite, rate-limited per IP)
  router.post(
    '/api/auth/invites/:token/accept',
    inviteAcceptLimiter,
    async (req: Request, res: Response) => {
      const { token } = req.params as { token: string };
      const row = getInvite(token);
      const state = inviteState(row);
      if (!row || state === 'not-found') {
        res.status(404).json({ error: 'invite not found' });
        return;
      }
      if (state === 'expired' || state === 'already-accepted') {
        res.status(410).json({ error: `invite ${state}` });
        return;
      }

      const { username: rawUser, password: rawPass } = req.body as {
        username?: string;
        password?: string;
      };
      const username = sanitizeUsername(rawUser);
      const password = sanitizePassword(rawPass);
      if (!username) {
        res.status(400).json({ error: 'invalid username' });
        return;
      }
      if (!password) {
        res.status(400).json({
          error: `password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} chars`,
        });
        return;
      }
      if (getUserByUsername(username)) {
        res.status(409).json({ error: 'username already taken' });
        return;
      }

      const passwordHash = await hashPassword(password);

      // Wrap user creation + invite acceptance + membership in a single
      // DB transaction so a crash mid-flow can't strand a consumed invite
      // against a user row with no membership (a "ghost account" that can
      // log in but 403s on every call). better-sqlite3's db.transaction()
      // returns a function that commits on normal return and rolls back
      // on any thrown error, so we throw an in-band sentinel when the
      // atomic `markInviteAccepted` loses its race.
      class InviteRaceLost extends Error {}
      let user: { id: string; username: string };
      try {
        user = getOrgsDb().transaction(() => {
          const u = createUser({ username, passwordHash });
          const won = markInviteAccepted(token, u.id);
          if (!won) {
            // Losing the race rolls back the createUser + leaves the
            // original winner's acceptance intact.
            throw new InviteRaceLost();
          }
          createMembership(u.id, row.org_id, row.role);
          return u;
        })();
      } catch (err) {
        if (err instanceof InviteRaceLost) {
          res.status(410).json({ error: 'invite no longer valid' });
          return;
        }
        throw err;
      }

      const authRecord = getAuthRecord();
      if (!authRecord) {
        // Can't issue a token with no JWT secret on disk. Invite flow is
        // post-setup only — this is effectively a server-misconfiguration.
        res.status(500).json({ error: 'server auth not configured' });
        return;
      }
      const { token: jwt, expiresAt } = issueToken(user, row.role, authRecord.jwtSecret);
      res.status(201).json({
        token: jwt,
        expiresAt,
        user: { id: user.id, username: user.username, role: row.role },
        orgId: row.org_id,
      });
    },
  );

  // ── Logout (protected) ─────────────────────────────────────────
  // Stateless JWTs — logout is a client-side drop. The endpoint exists so
  // the UI has a symmetric call and so we have a hook for future
  // revocation lists (Phase 4).
  router.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return router;
}

// Re-export so tests can verify helpers without reaching into internals.
export const __internals = { hasAtLeastRole };
