import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import type { AuthRecord } from './auth-store.js';
import type { Role } from './roles.js';
import type { UserRow } from './users-store.js';

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

// Phase 3 — mock the orgs + users + memberships stores so we can drive
// the middleware's per-org role resolution without spinning up SQLite.
let mockActiveOrgId = 'default';
let mockActiveOrgMode: 'local' | 'remote' = 'remote';
let mockOrgsDbUnavailable = false;
const mockUsersById = new Map<string, UserRow>();
const mockUsersByName = new Map<string, UserRow>();
const mockMemberships = new Map<string, Role>(); // key: `${userId}|${orgId}`

vi.mock('./orgs.js', () => ({
  getActiveOrgId: () => {
    if (mockOrgsDbUnavailable) throw new Error('orgs.db not initialized');
    return mockActiveOrgId;
  },
  getOrg: (id: string) => {
    if (mockOrgsDbUnavailable) throw new Error('orgs.db not initialized');
    if (id === mockActiveOrgId) {
      return { id, name: id, mode: mockActiveOrgMode };
    }
    return undefined;
  },
}));
vi.mock('./users-store.js', () => ({
  getUserById: (id: string) => mockUsersById.get(id) ?? null,
  getUserByUsername: (name: string) => mockUsersByName.get(name) ?? null,
  getUserCredentialVersion: () => 0,
}));
vi.mock('./memberships-store.js', () => ({
  getMembershipRole: (userId: string, orgId: string) =>
    mockMemberships.get(`${userId}|${orgId}`) ?? null,
}));

function seedUser(row: UserRow): void {
  mockUsersById.set(row.id, row);
  mockUsersByName.set(row.username, row);
}
function seedMembership(userId: string, orgId: string, role: Role): void {
  mockMemberships.set(`${userId}|${orgId}`, role);
}
function resetPhase3Mocks(): void {
  mockActiveOrgId = 'default';
  mockActiveOrgMode = 'remote';
  mockOrgsDbUnavailable = false;
  mockUsersById.clear();
  mockUsersByName.clear();
  mockMemberships.clear();
}

const { default: config } = await import('./config.js');
const { authMiddleware, authenticateWs, authenticateWsDetailed } = await import('./auth.js');
const { signJwt } = await import('./jwt.js');

interface MockReqOverrides {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

function mockReq(overrides: MockReqOverrides = {}): Request {
  return {
    path: '/api/agents',
    method: 'GET',
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

  it('passes through for /api/auth/google/callback without bearer auth', () => {
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'scrypt$x$x$x$x$x',
      jwtSecret: 'secret',
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ path: '/api/auth/google/callback' }),
      res as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it('does NOT treat the retired support-request intake path as public', () => {
    // Regression: the legacy `POST /api/projects/:projectId/support-requests`
    // intake (which dispatched an intake agent to file a kanban card) has been
    // retired. With an API key configured, the path must now be auth-gated
    // like any other project route — it is no longer in PUBLIC_PATTERNS.
    config.apiKey = 'secret-key';
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ path: '/api/projects/agent-hub/support-requests' }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('passes through POST/OPTIONS for the public chunked replay-ingest path', () => {
    config.apiKey = 'secret-key';
    for (const method of ['POST', 'OPTIONS']) {
      const next = vi.fn();
      authMiddleware(
        mockReq({ path: '/api/replays/abc-123-def-456/events', method }),
        mockRes() as unknown as Response,
        next,
      );
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('still gates GET on the same replay-events path behind auth', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ path: '/api/replays/abc-123-def-456/events', method: 'GET' }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('still gates a non-support project subpath behind auth', () => {
    config.apiKey = 'secret-key';
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ path: '/api/projects/agent-hub/board' }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
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
  const OWNER_USER: UserRow = {
    id: 'user-owner-uuid',
    username: 'owner',
    password_hash: 'scrypt$ignored',
    created_at: '2026-04-18',
  };

  beforeEach(() => {
    config.apiKey = null;
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'scrypt$ignored',
      jwtSecret: JWT_SECRET,
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    resetPhase3Mocks();
    seedUser(OWNER_USER);
    seedMembership(OWNER_USER.id, 'default', 'Owner');
  });

  it('accepts a valid Bearer token and stashes the subject', () => {
    const token = signJwt('owner', JWT_SECRET, { claims: { uid: OWNER_USER.id } });
    const next = vi.fn();
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    authMiddleware(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request & { authUser?: string }).authUser).toBe('owner');
    // Phase 2/3: role comes from membership in the active org.
    expect((req as Request & { authRole?: string }).authRole).toBe('Owner');
    expect((req as Request & { authUserId?: string }).authUserId).toBe(OWNER_USER.id);
    expect((req as Request & { authOrgId?: string }).authOrgId).toBe('default');
  });

  it('accepts a pre-Phase-3 token (sub only, no uid) by falling back to username lookup', () => {
    const legacyToken = signJwt('owner', JWT_SECRET); // no uid claim
    const next = vi.fn();
    const req = mockReq({ headers: { authorization: `Bearer ${legacyToken}` } });
    authMiddleware(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request & { authUserId?: string }).authUserId).toBe(OWNER_USER.id);
    expect((req as Request & { authRole?: string }).authRole).toBe('Owner');
  });

  it('rejects a JWT when the user has no membership in the active org (403)', () => {
    // Seed a valid user without a membership row.
    const stranger: UserRow = {
      id: 'user-stranger-uuid',
      username: 'stranger',
      password_hash: 'x',
      created_at: '2026-04-18',
    };
    seedUser(stranger);
    const token = signJwt(stranger.username, JWT_SECRET, { claims: { uid: stranger.id } });
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ headers: { authorization: `Bearer ${token}` } }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toMatch(/not a member/i);
  });

  it('rejects a JWT whose user row has been deleted with 401', () => {
    const token = signJwt('ghost', JWT_SECRET, { claims: { uid: 'missing-uuid' } });
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(
      mockReq({ headers: { authorization: `Bearer ${token}` } }),
      res as unknown as Response,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body?.error).toMatch(/no longer exists/i);
  });

  it('uses the membership role for the active org (not the auth-store global role)', () => {
    mockAuthRecord = {
      ...mockAuthRecord!,
      role: 'Owner', // irrelevant in Phase 3
    };
    // Demote the owner for this specific test by re-seeding membership.
    mockMemberships.clear();
    seedMembership(OWNER_USER.id, 'default', 'Admin');

    const token = signJwt('owner', JWT_SECRET, { claims: { uid: OWNER_USER.id } });
    const next = vi.fn();
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    authMiddleware(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as Request & { authRole?: string }).authRole).toBe('Admin');
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
    resetPhase3Mocks();
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
    const user: UserRow = {
      id: 'ws-owner-id',
      username: 'owner',
      password_hash: 'x',
      created_at: '2026-04-18',
    };
    seedUser(user);
    seedMembership(user.id, 'default', 'Owner');
    const token = signJwt('owner', 'ws-jwt-secret', { claims: { uid: user.id } });
    const result = authenticateWsDetailed({
      url: `/ws?token=${encodeURIComponent(token)}`,
      headers: { host: 'localhost:3051' },
    } as unknown as import('http').IncomingMessage);
    expect(result.ok).toBe(true);
    expect(result.subject).toBe('owner');
    expect(result.userId).toBe(user.id);
    expect(result.role).toBe('Owner');
    expect(result.orgId).toBe('default');
  });

  it('rejects a WS handshake from a user with no membership in the active org', () => {
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'x',
      jwtSecret: 'ws-jwt-secret',
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    const stranger: UserRow = {
      id: 'ws-stranger',
      username: 'stranger',
      password_hash: 'x',
      created_at: '2026-04-18',
    };
    seedUser(stranger);
    const token = signJwt(stranger.username, 'ws-jwt-secret', { claims: { uid: stranger.id } });
    const result = authenticateWsDetailed({
      url: `/ws?token=${encodeURIComponent(token)}`,
      headers: { host: 'localhost:3051' },
    } as unknown as import('http').IncomingMessage);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-membership');
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

// ─── Local-bundled-server bypass ─────────────────────────────────
// When the server is launched with `AGENT_HUB_MODE=local` (Electron
// desktop / single-tenant dev box), the REST middleware and WS
// handshake short-circuit the JWT/apiKey gate and install a synthetic
// `local` Owner identity. The earlier coupling to `org.mode='local'`
// was removed because that value is editable from the Settings UI —
// keying off a process-env signal instead means a deployed multi-user
// server cannot have its auth gate disabled by a stray DB write.
describe('authMiddleware — local-bundled-server bypass (AGENT_HUB_MODE)', () => {
  const originalMode = process.env.AGENT_HUB_MODE;
  beforeEach(() => {
    config.apiKey = null;
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'scrypt$ignored',
      jwtSecret: 'active-org-bypass-secret',
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    resetPhase3Mocks();
    delete process.env.AGENT_HUB_MODE;
  });

  afterEach(() => {
    // Always restore — leaking AGENT_HUB_MODE='local' into another
    // suite would silently disable auth in the rest of the file.
    if (originalMode === undefined) delete process.env.AGENT_HUB_MODE;
    else process.env.AGENT_HUB_MODE = originalMode;
    resetPhase3Mocks();
  });

  it('bypasses the gate when AGENT_HUB_MODE=local and populates synthetic identity', () => {
    process.env.AGENT_HUB_MODE = 'local';
    mockActiveOrgId = 'default';
    const next = vi.fn();
    const req = mockReq();
    authMiddleware(req, mockRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    const r = req as Request & {
      authUser?: string;
      authRole?: string;
      authOrgId?: string;
      authLocalOrgBypass?: boolean;
    };
    expect(r.authUser).toBe('local');
    expect(r.authRole).toBe('Owner');
    expect(r.authOrgId).toBe('default');
    expect(r.authLocalOrgBypass).toBe(true);
  });

  it('returns 401 when AGENT_HUB_MODE is unset and no credentials are provided', () => {
    // Default deployment: no env var → multi-user → auth required.
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq(), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when AGENT_HUB_MODE is set to a non-local value', () => {
    // Anything other than the literal string 'local' must NOT bypass —
    // including 'LOCAL', 'remote', 'true', or accidental whitespace.
    for (const v of ['', 'remote', 'LOCAL', 'true', ' local ']) {
      process.env.AGENT_HUB_MODE = v;
      const res = mockRes();
      authMiddleware(mockReq(), res as unknown as Response, vi.fn());
      expect(res.statusCode).toBe(401);
    }
  });

  it('flips enforcement when AGENT_HUB_MODE changes between requests', () => {
    // Same process, env var changed (e.g. an operator set it via a
    // pm2 restart with a different env). Behavior must follow.
    process.env.AGENT_HUB_MODE = 'local';
    const next1 = vi.fn();
    authMiddleware(mockReq(), mockRes() as unknown as Response, next1);
    expect(next1).toHaveBeenCalledOnce();

    delete process.env.AGENT_HUB_MODE;
    const next2 = vi.fn();
    const res2 = mockRes();
    authMiddleware(mockReq(), res2 as unknown as Response, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(401);
  });

  it('does NOT bypass when orgs.db is unavailable in non-local mode', () => {
    // Regression: the old code path returned `false` from
    // isActiveOrgLocal() on orgs.db error so the JWT gate still
    // enforced. The env-based check doesn't read the DB at all, so
    // the same scenario must still result in a 401.
    mockOrgsDbUnavailable = true;
    const next = vi.fn();
    const res = mockRes();
    authMiddleware(mockReq(), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('authenticateWsDetailed — local-bundled-server bypass (AGENT_HUB_MODE)', () => {
  const originalMode = process.env.AGENT_HUB_MODE;
  beforeEach(() => {
    config.apiKey = null;
    mockAuthRecord = {
      username: 'owner',
      passwordHash: 'x',
      jwtSecret: 'ws-active-org-secret',
      role: 'Owner',
      createdAt: '2026-04-18',
    };
    resetPhase3Mocks();
    delete process.env.AGENT_HUB_MODE;
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.AGENT_HUB_MODE;
    else process.env.AGENT_HUB_MODE = originalMode;
    resetPhase3Mocks();
  });

  it('returns ok with synthetic local Owner when AGENT_HUB_MODE=local', () => {
    process.env.AGENT_HUB_MODE = 'local';
    mockActiveOrgId = 'default';
    const result = authenticateWsDetailed({
      url: '/ws',
      headers: { host: 'localhost:3051' },
    } as unknown as import('http').IncomingMessage);
    expect(result.ok).toBe(true);
    expect(result.subject).toBe('local');
    expect(result.role).toBe('Owner');
    expect(result.orgId).toBe('default');
  });

  it('rejects WS handshake when AGENT_HUB_MODE is unset and no token is provided', () => {
    const result = authenticateWsDetailed({
      url: '/ws',
      headers: { host: 'localhost:3051' },
    } as unknown as import('http').IncomingMessage);
    expect(result.ok).toBe(false);
  });

  it('does NOT bypass on WS handshake when orgs.db is unavailable', () => {
    mockOrgsDbUnavailable = true;
    const result = authenticateWsDetailed({
      url: '/ws',
      headers: { host: 'localhost:3051' },
    } as unknown as import('http').IncomingMessage);
    expect(result.ok).toBe(false);
  });
});
