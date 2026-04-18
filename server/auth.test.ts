import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { AuthRecord } from './auth-store.js';

// ── Mocks ────────────────────────────────────────────────────────
// `./config.js` is stubbed so tests can flip `apiKey` between cases. The
// auth-store mock lets us simulate "no JWT user configured" vs "user
// configured" without touching the filesystem.
vi.mock('./config.js', () => {
  return {
    default: { apiKey: null } as { apiKey: string | null },
  };
});

let mockAuthRecord: AuthRecord | null = null;
vi.mock('./auth-store.js', () => ({
  getAuthRecord: () => mockAuthRecord,
  isAuthConfigured: () => mockAuthRecord !== null,
}));

const { default: config } = await import('./config.js');
const { authMiddleware, authenticateWs, authenticateWsDetailed } = await import('./auth.js');
const { signJwt } = await import('./jwt.js');

interface MockReqOverrides {
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

function mockReq(overrides: MockReqOverrides = {}): Request {
  return {
    path: '/api/agents',
    headers: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

interface MockRes {
  statusCode: number | null;
  body: Record<string, unknown> | null;
  status(code: number): MockRes;
  json(data: Record<string, unknown>): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      res.body = data;
      return res;
    },
  };
  return res;
}

describe('authMiddleware (API key)', () => {
  beforeEach(() => {
    config.apiKey = null;
    mockAuthRecord = null;
  });

  it('passes through when no auth is configured at all', () => {
    const next = vi.fn();
    authMiddleware(mockReq(), mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for /api/health regardless of key', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(mockReq({ path: '/api/health' }), mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for /api/auth/login so clients can authenticate', () => {
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'scrypt$x$x$x$x$x',
      jwtSecret: 'secret',
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    const next = vi.fn();
    authMiddleware(mockReq({ path: '/api/auth/login' }), mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 401 when key is required but not provided', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq(), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body?.error).toContain('API key required');
  });

  it('returns 403 when wrong key is provided via header', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ headers: { 'x-api-key': 'wrong-key' } }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toContain('Invalid API key');
  });

  it('accepts correct key via X-API-Key header', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(
      mockReq({ headers: { 'x-api-key': 'secret-key' } }),
      mockRes() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts correct key via query parameter', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(
      mockReq({ query: { apiKey: 'secret-key' } }),
      mockRes() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for non-API paths (static files / SPA fallback)', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(mockReq({ path: '/' }), mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('requires apiKey for /api/auth/setup when apiKey is set and JWT is not configured', () => {
    config.apiKey = 'secret-key';
    // mockAuthRecord is null → JWT not configured, but apiKey protects the server.
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq({ path: '/api/auth/setup' }), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('allows /api/auth/setup with valid apiKey when JWT is not configured', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(
      mockReq({ path: '/api/auth/setup', headers: { 'x-api-key': 'secret-key' } }),
      mockRes() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows /api/auth/setup without auth when neither apiKey nor JWT is configured', () => {
    // Fresh install — no apiKey, no JWT.
    const next = vi.fn();
    authMiddleware(mockReq({ path: '/api/auth/setup' }), mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for static asset paths', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(
      mockReq({ path: '/assets/index-abc123.js' }),
      mockRes() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('prefers header over query param', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    authMiddleware(
      mockReq({
        headers: { 'x-api-key': 'secret-key' },
        query: { apiKey: 'wrong' },
      }),
      mockRes() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('authMiddleware (JWT)', () => {
  const JWT_SECRET = 'jwt-unit-test-secret';

  beforeEach(() => {
    config.apiKey = null;
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'scrypt$ignored',
      jwtSecret: JWT_SECRET,
      role: 'Owner',
      createdAt: '2026-04-18',
    };
  });

  it('accepts a valid Bearer token and stashes the subject', () => {
    const token = signJwt('owner', JWT_SECRET);
    const next = vi.fn();
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    authMiddleware(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request & { authUser?: string }).authUser).toBe('owner');
    // Phase 2: the middleware now also resolves and attaches the role.
    expect((req as Request & { authRole?: string }).authRole).toBe('Owner');
  });

  it('attaches authRole=Owner when the apiKey fallback is used', () => {
    config.apiKey = 'legacy-key';
    const next = vi.fn();
    const req = mockReq({ headers: { 'x-api-key': 'legacy-key' } });
    authMiddleware(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request & { authRole?: string }).authRole).toBe('Owner');
  });

  it('rejects a token passed as ?token= query param on REST paths', () => {
    // Query-string tokens end up in access logs / Referer / history, so the
    // REST middleware accepts the Authorization header only. (WS still
    // allows `?token=` because browsers can't set headers on handshakes —
    // see `authenticateWsDetailed`.)
    const token = signJwt('owner', JWT_SECRET);
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq({ query: { token } }), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with a different secret with 401', () => {
    const badToken = signJwt('owner', 'wrong-secret');
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ headers: { authorization: `Bearer ${badToken}` } }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body?.error).toContain('Authentication required');
  });

  it('rejects an expired token with 401', () => {
    const expired = signJwt('owner', JWT_SECRET, { expiresInSec: -10 });
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ headers: { authorization: `Bearer ${expired}` } }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('requests auth when no token is provided', () => {
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq(), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body?.error).toContain('Authentication required');
  });

  it('falls back to a valid apiKey when both mechanisms are configured', () => {
    config.apiKey = 'legacy-key';
    const next = vi.fn();
    const req = mockReq({ headers: { 'x-api-key': 'legacy-key' } });
    authMiddleware(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request & { authViaApiKey?: boolean }).authViaApiKey).toBe(true);
  });

  it('lets /api/auth/me pass the gate when a valid JWT is provided', () => {
    const token = signJwt('owner', JWT_SECRET);
    const next = vi.fn();
    authMiddleware(
      mockReq({ path: '/api/auth/me', headers: { authorization: `Bearer ${token}` } }),
      mockRes() as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('authMiddleware — /api/auth/setup additional gating', () => {
  // Complements the three upstream tests in the "authMiddleware (API key)"
  // block (wrong-key not-null, wrong-key supplied, post-JWT lockdown).
  beforeEach(() => {
    config.apiKey = null;
    mockAuthRecord = null;
  });

  it('rejects setup when a WRONG apiKey is supplied on an apiKey-protected deployment', () => {
    config.apiKey = 'legacy-key';
    mockAuthRecord = null;
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({
        path: '/api/auth/setup',
        headers: { 'x-api-key': 'wrong-key' },
      }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    // Goes through the normal apiKey check → 403 (not 401 because a key
    // was provided, it just didn't match).
    expect([401, 403]).toContain(res.statusCode);
  });

  it('still requires a valid bearer token for setup after JWT is already configured', () => {
    // Once JWT auth is configured, setup falls through to normal gating:
    // an unauthenticated request is rejected (and the handler would 409
    // even if it got through). This prevents stealthy re-setup attempts.
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'scrypt$ignored',
      jwtSecret: 'configured-secret',
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq({ path: '/api/auth/setup' }), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('authenticateWs', () => {
  beforeEach(() => {
    config.apiKey = null;
    mockAuthRecord = null;
  });

  it('returns true when no auth is configured', () => {
    expect(
      authenticateWs({
        url: '/ws',
        headers: { host: 'localhost:3051' },
      } as unknown as import('http').IncomingMessage),
    ).toBe(true);
  });

  it('returns true when correct apiKey is provided', () => {
    config.apiKey = 'ws-key';
    expect(
      authenticateWs({
        url: '/ws?apiKey=ws-key',
        headers: { host: 'localhost:3051' },
      } as unknown as import('http').IncomingMessage),
    ).toBe(true);
  });

  it('returns false when wrong apiKey is provided', () => {
    config.apiKey = 'ws-key';
    expect(
      authenticateWs({
        url: '/ws?apiKey=bad',
        headers: { host: 'localhost:3051' },
      } as unknown as import('http').IncomingMessage),
    ).toBe(false);
  });

  it('returns false when no key is provided but one is required', () => {
    config.apiKey = 'ws-key';
    expect(
      authenticateWs({
        url: '/ws',
        headers: { host: 'localhost:3051' },
      } as unknown as import('http').IncomingMessage),
    ).toBe(false);
  });

  it('accepts a valid JWT via ?token= when JWT auth is configured', () => {
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'x',
      jwtSecret: 'ws-jwt-secret',
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    const token = signJwt('owner', 'ws-jwt-secret');
    const result = authenticateWsDetailed({
      url: `/ws?token=${encodeURIComponent(token)}`,
      headers: { host: 'localhost:3051' },
    } as unknown as import('http').IncomingMessage);
    expect(result.ok).toBe(true);
    expect(result.subject).toBe('owner');
  });

  it('rejects an invalid JWT via ?token=', () => {
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'x',
      jwtSecret: 'ws-jwt-secret',
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    const bad = signJwt('owner', 'wrong-secret');
    expect(
      authenticateWs({
        url: `/ws?token=${encodeURIComponent(bad)}`,
        headers: { host: 'localhost:3051' },
      } as unknown as import('http').IncomingMessage),
    ).toBe(false);
  });
});
