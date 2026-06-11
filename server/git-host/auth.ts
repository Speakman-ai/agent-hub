/**
 * auth.ts — self-contained authentication for the git smart-HTTP routes.
 *
 * `/git/*` is mounted BEFORE `express.json` and outside `/api/*`, so the
 * main `authMiddleware` (server/auth.ts:213 only gates `/api/*`) never
 * sees these requests. Git clients speak HTTP Basic; the password field
 * carries the credential — a per-user `ahub_*` API key (verified via
 * `verifyApiKey`, role from org membership; the exact chain
 * authMiddleware uses for `ahub_*` Bearer tokens), the legacy global
 * `config.apiKey` break-glass secret, or the account password paired
 * with the username (same credentials as the web login, with a per-IP
 * failure lockout). `Authorization: Bearer ahub_…` is also accepted for
 * curl/scripts.
 *
 * A 401 MUST carry `WWW-Authenticate: Basic` — that header is what makes
 * `git` invoke its credential helpers instead of failing outright.
 */

import type { Request } from 'express';
import config from '../config.js';
import { getAuthRecord } from '../auth-store.js';
import { getActiveOrgId } from '../orgs.js';
import { getUserById, getUserByUsername } from '../users-store.js';
import { getMembershipRole } from '../memberships-store.js';
import { verifyApiKey } from '../api-keys-store.js';
import { verifyPassword } from '../password.js';
import { canViewProject } from '../project-visibility.js';
import type { Role } from '../roles.js';
import type { Project } from '../types.js';

export const GIT_WWW_AUTHENTICATE = 'Basic realm="Agent Hub Git"';

export interface GitCaller {
  userId: string | null;
  username: string | null;
  role: Role;
  /**
   * True for the legacy global apiKey and for open mode (no auth
   * configured). These callers have no per-user identity but carry full
   * Owner privilege, mirroring `authMiddleware`'s treatment.
   */
  breakGlass: boolean;
}

export type GitAuthResult =
  | { ok: true; caller: GitCaller }
  | { ok: false; status: 401 | 403; message: string };

function parseBasicAuth(header: string): { username: string; password: string } | null {
  if (!/^basic\s/i.test(header)) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep < 0) return null;
    return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

function resolveApiKeyCaller(token: string): GitAuthResult {
  const verified = verifyApiKey(token);
  if (!verified) {
    return { ok: false, status: 401, message: 'Invalid API key.' };
  }
  const user = getUserById(verified.userId);
  if (!user) {
    return { ok: false, status: 401, message: 'API key user no longer exists.' };
  }
  let orgId = '';
  try {
    orgId = getActiveOrgId();
  } catch {
    // orgs.db not initialized — fall through with no org scoping.
  }
  const role = orgId ? getMembershipRole(verified.userId, orgId) : null;
  if (orgId && !role) {
    return { ok: false, status: 403, message: 'You are not a member of this org.' };
  }
  return {
    ok: true,
    caller: { userId: user.id, username: user.username, role: role ?? 'User', breakGlass: false },
  };
}

/**
 * Per-IP lockout for failed PASSWORD attempts (API keys are
 * high-entropy; passwords are the brute-forceable credential). The main
 * login route has an express-rate-limit guard; `/git` is mounted outside
 * it, so it carries its own.
 */
const PASSWORD_FAIL_LIMIT = 10;
const PASSWORD_LOCK_MS = 60_000;
const passwordFailures = new Map<string, { count: number; lockedUntil: number }>();

function passwordAttemptLocked(ip: string): boolean {
  const entry = passwordFailures.get(ip);
  return Boolean(entry && entry.lockedUntil > Date.now());
}

function recordPasswordFailure(ip: string): void {
  const entry = passwordFailures.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= PASSWORD_FAIL_LIMIT) {
    entry.lockedUntil = Date.now() + PASSWORD_LOCK_MS;
    entry.count = 0;
  }
  passwordFailures.set(ip, entry);
}

function clearPasswordFailures(ip: string): void {
  passwordFailures.delete(ip);
}

/** Test seam. */
export function __clearGitPasswordLockouts(): void {
  passwordFailures.clear();
}

/**
 * Username + account password — the same credentials as the web login
 * (users table first, auth.json single-user record as the boot/legacy
 * fallback — mirrors the login route in routes/auth.ts).
 */
async function resolvePasswordCaller(
  username: string,
  password: string,
  ip: string,
): Promise<GitAuthResult> {
  if (passwordAttemptLocked(ip)) {
    return { ok: false, status: 401, message: 'Too many failed attempts — try again shortly.' };
  }

  let user: ReturnType<typeof getUserByUsername> = null;
  try {
    user = getUserByUsername(username);
  } catch {
    user = null;
  }
  const authRecord = getAuthRecord();
  const usingAuthRecordFallback = !user && authRecord !== null && username === authRecord.username;
  const storedHash =
    user?.password_hash ?? (usingAuthRecordFallback ? authRecord.passwordHash : null);
  if (!storedHash || !(await verifyPassword(password, storedHash))) {
    recordPasswordFailure(ip);
    return { ok: false, status: 401, message: 'Invalid credentials.' };
  }
  clearPasswordFailures(ip);

  if (!user) {
    // Single-user auth.json record (pre-migration): this IS the owner.
    return {
      ok: true,
      caller: { userId: null, username, role: 'Owner', breakGlass: true },
    };
  }

  let orgId = '';
  try {
    orgId = getActiveOrgId();
  } catch {
    // orgs.db not initialized — fall through with no org scoping.
  }
  const role = orgId ? getMembershipRole(user.id, orgId) : null;
  if (orgId && !role) {
    return { ok: false, status: 403, message: 'You are not a member of this org.' };
  }
  return {
    ok: true,
    caller: { userId: user.id, username: user.username, role: role ?? 'User', breakGlass: false },
  };
}

/**
 * Authenticate a git smart-HTTP request. Never throws; never logs the
 * credential (callers must not echo `req.headers.authorization` either).
 */
export async function authenticateGitRequest(req: Request): Promise<GitAuthResult> {
  // Open mode — no auth configured at all (dev / fresh install): allow as
  // Owner, exactly like authMiddleware's open-mode branch.
  if (!config.apiKey && !getAuthRecord()) {
    return {
      ok: true,
      caller: { userId: null, username: null, role: 'Owner', breakGlass: true },
    };
  }

  const header = req.headers.authorization;
  if (!header) {
    return { ok: false, status: 401, message: 'Authentication required.' };
  }

  // Bearer form (curl/scripts): only ahub_ keys or the global apiKey.
  if (/^bearer\s/i.test(header)) {
    const token = header.slice(7).trim();
    if (token.startsWith('ahub_')) return resolveApiKeyCaller(token);
    if (config.apiKey && token === config.apiKey) {
      return {
        ok: true,
        caller: { userId: null, username: null, role: 'Owner', breakGlass: true },
      };
    }
    return { ok: false, status: 401, message: 'Invalid token.' };
  }

  const basic = parseBasicAuth(header);
  if (!basic) {
    return { ok: false, status: 401, message: 'Unsupported authorization scheme.' };
  }
  // The password field carries the credential: an ahub_ API key, the
  // break-glass global key, or — like the web login — the account
  // password paired with the username.
  if (basic.password.startsWith('ahub_')) return resolveApiKeyCaller(basic.password);
  if (config.apiKey && basic.password === config.apiKey) {
    return { ok: true, caller: { userId: null, username: null, role: 'Owner', breakGlass: true } };
  }
  if (basic.username && basic.password) {
    return resolvePasswordCaller(basic.username, basic.password, req.ip ?? 'unknown');
  }
  return { ok: false, status: 401, message: 'Invalid credentials.' };
}

export type GitAccess = 'read' | 'write';

/**
 * May this caller read (clone/fetch) or write (push) this hosted repo?
 *
 * Read follows project visibility (`canViewProject`). Write additionally
 * requires a real identity: a membership-resolved user or the break-glass
 * Owner. Per-branch protection is out of scope — merge-to-main policy is
 * owned by the native PR layer.
 */
export function canAccessHostedRepo(
  project: Project,
  caller: GitCaller,
  access: GitAccess,
): boolean {
  const visible = canViewProject(project, {
    userId: caller.userId,
    role: caller.role,
    localBypass: caller.breakGlass,
  });
  if (!visible) return false;
  if (access === 'read') return true;
  return caller.breakGlass || Boolean(caller.userId);
}
