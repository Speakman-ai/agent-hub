/**
 * JWT authentication routes — Phase 1 (single-user model).
 *
 *   POST /api/auth/setup    { username, password } → { ok }
 *       First-run bootstrap: creates the single user record. Rejected once
 *       auth is already configured unless the requester is the current
 *       authenticated user (covered by the auth middleware gating).
 *   POST /api/auth/login    { username, password } → { token, expiresAt, user }
 *   GET  /api/auth/me       → { user: { username } }  (requires bearer token)
 *   POST /api/auth/logout   → { ok }                  (stateless — client drops the token)
 *   GET  /api/auth/status   → { authConfigured, username? }
 *
 * The login and status endpoints are public (listed in PUBLIC_PATHS in
 * `server/auth.ts`). Setup is gated by the auth middleware: when an
 * `apiKey` is configured, the caller must provide it to reach this
 * endpoint — this prevents an unauthenticated hijack during the window
 * between server upgrade and first JWT setup. Once JWT auth is
 * configured the handler itself returns 409.
 * `/me` and `/logout` go through the normal auth middleware which will
 * enforce the bearer token.
 */
import { Router, Request, Response } from 'express';
import { signJwt } from '../jwt.js';
import { hashPassword, verifyPassword } from '../password.js';
import {
  getAuthRecord,
  isAuthConfigured,
  saveAuthRecord,
  generateJwtSecret,
} from '../auth-store.js';

const DEFAULT_TOKEN_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

function sanitizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return null;
  if (!/^[a-zA-Z0-9_.\-@]+$/.test(trimmed)) return null;
  return trimmed;
}

// Minimum password length for the single-admin credential. This account
// grants full server control (process spawning, arbitrary shell via CLI),
// so we follow NIST 800-63B guidance for privileged accounts (≥ 12).
const MIN_PASSWORD_LEN = 12;
const MAX_PASSWORD_LEN = 256;

function sanitizePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length < MIN_PASSWORD_LEN || raw.length > MAX_PASSWORD_LEN) return null;
  return raw;
}

export default function createAuthRoutes(): Router {
  const router = Router();

  // ── Status (public) ────────────────────────────────────────────
  router.get('/api/auth/status', (_req: Request, res: Response) => {
    const record = getAuthRecord();
    res.json({
      authConfigured: !!record,
      username: record?.username ?? null,
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
    const record = saveAuthRecord({
      username,
      passwordHash,
      jwtSecret: generateJwtSecret(),
    });

    const token = signJwt(record.username, record.jwtSecret, {
      expiresInSec: DEFAULT_TOKEN_TTL_SEC,
    });
    const expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_SEC * 1000).toISOString();

    res.json({
      ok: true,
      token,
      expiresAt,
      user: { username: record.username },
    });
  });

  // ── Login (public) ─────────────────────────────────────────────
  router.post('/api/auth/login', async (req: Request, res: Response) => {
    const record = getAuthRecord();
    if (!record) {
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
    // leak whether the username exists.
    const userMatches = username === record.username;
    const ok = await verifyPassword(password, record.passwordHash);
    if (!userMatches || !ok) {
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    const token = signJwt(record.username, record.jwtSecret, {
      expiresInSec: DEFAULT_TOKEN_TTL_SEC,
    });
    const expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_SEC * 1000).toISOString();
    res.json({
      token,
      expiresAt,
      user: { username: record.username },
    });
  });

  // ── Current user (protected by auth middleware) ────────────────
  router.get('/api/auth/me', (req: Request, res: Response) => {
    // The middleware has already validated the token or the apiKey. When
    // JWT auth was used, it stashes the decoded payload on req (see
    // `authMiddleware` in server/auth.ts).
    const record = getAuthRecord();
    const subject = (req as Request & { authUser?: string }).authUser || record?.username || null;
    res.json({
      user: subject ? { username: subject } : null,
      authConfigured: !!record,
    });
  });

  // ── Logout (protected) ─────────────────────────────────────────
  // Stateless JWTs — logout is a client-side drop. The endpoint exists so
  // the UI has a symmetric call to hit and so we have a hook for Phase 2
  // revocation lists.
  router.post('/api/auth/logout', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return router;
}
