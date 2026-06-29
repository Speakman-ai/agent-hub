/**
 * Rate-limit coverage for the public auth surface.
 *
 * Tracks kanban card "Auth hardening: rate-limit login & invite-accept
 * endpoints". Two thresholds are enforced in routes/auth.ts:
 *
 *   POST /api/auth/login                      — 10 / 15 min / IP (default)
 *   POST /api/auth/invites/:token/accept      — 5  / 1 h  / IP  (default)
 *
 * These tests pass tiny windowMs overrides so we can exercise the 429
 * path quickly and assert the cooldown recovers cleanly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig: { apiKey: string | null; dataDir: string } = {
  apiKey: null,
  get dataDir() {
    return TMP_DIR;
  },
} as { apiKey: string | null; dataDir: string };

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

const {
  default: createAuthRoutes,
  LOGIN_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  INVITE_ACCEPT_RATE_LIMIT_MAX,
  INVITE_ACCEPT_RATE_LIMIT_WINDOW_MS,
} = await import('./auth.js');
const { reloadAuthRecord, setAuthFilePathForTests } = await import('../auth-store.js');
const { setOrgsDbPathForTests, initOrgsDb } = await import('../orgs.js');

function buildApp(opts: Parameters<typeof createAuthRoutes>[0] = {}): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());
  app.use(createAuthRoutes(opts));
  return app;
}

async function setup(app: ReturnType<typeof express>) {
  const res = await supertest(app)
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', password: 'a-strong-password' });
  if (res.status !== 200) throw new Error(`setup failed: ${res.status}`);
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-rate-limit-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  reloadAuthRecord();
  mockConfig.apiKey = null;
});

describe('Rate-limit defaults — pinned thresholds', () => {
  // PR #421 review — the override-based tests below all pass their own
  // numbers, so a typo in the exported constants (dropping a zero,
  // flipping min↔hour) would otherwise slip past CI. Pin the production
  // numbers explicitly.
  it('login defaults to 10 attempts / 15 minutes / IP', () => {
    expect(LOGIN_RATE_LIMIT_MAX).toBe(10);
    expect(LOGIN_RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
  });
  it('invite-accept defaults to 5 attempts / 1 hour / IP', () => {
    expect(INVITE_ACCEPT_RATE_LIMIT_MAX).toBe(5);
    expect(INVITE_ACCEPT_RATE_LIMIT_WINDOW_MS).toBe(60 * 60 * 1000);
  });
});

describe('POST /api/auth/login — rate limit', () => {
  it('returns 429 with Retry-After on the 11th rapid attempt', async () => {
    // Default thresholds (10 / 15 min) with a long window so the 11th
    // hit lands inside the window even on a slow CI runner.
    const app = buildApp({ loginRateLimit: { windowMs: 60_000, limit: 10 } });
    await setup(app);

    // Fire 10 wrong-password attempts — every one should come back 401.
    for (let i = 0; i < 10; i++) {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'owner@example.com', password: 'nope-nope-nope' });
      expect(res.status).toBe(401);
    }

    // The 11th is blocked by the limiter before the handler even runs.
    const blocked = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'nope-nope-nope' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'rate_limited' });
    // standardHeaders='draft-7' emits Retry-After + RateLimit-* headers.
    expect(blocked.headers['retry-after']).toBeDefined();

    // A correct-password attempt within the same window is ALSO blocked —
    // the limiter keys on IP, not on credential validity, which is the
    // whole point for brute-force mitigation.
    const blockedValid = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(blockedValid.status).toBe(429);
  });

  it('lets a valid login succeed after the window resets', async () => {
    // Use fake timers so we can skip the cooldown without actually
    // sleeping 15 minutes in CI.
    vi.useFakeTimers();
    try {
      const app = buildApp({ loginRateLimit: { windowMs: 60_000, limit: 2 } });
      await setup(app);

      // Burn through the 2-hit quota with bad passwords → 401, 401, 429.
      for (let i = 0; i < 2; i++) {
        await supertest(app)
          .post('/api/auth/login')
          .send({ email: 'owner@example.com', password: 'nope-nope-nope' });
      }
      const blocked = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'owner@example.com', password: 'a-strong-password' });
      expect(blocked.status).toBe(429);

      // Advance beyond the window — the default MemoryStore's internal
      // reset key is keyed off request-time diffs, so nudging both
      // system clock and timer queue is the reliable way to cross the
      // boundary.
      vi.setSystemTime(new Date(Date.now() + 120_000));
      await vi.advanceTimersByTimeAsync(120_000);

      const ok = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'owner@example.com', password: 'a-strong-password' });
      expect(ok.status).toBe(200);
      expect(ok.body.token.split('.')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes through untouched when disableRateLimit is set (regression safeguard)', async () => {
    const app = buildApp({ disableRateLimit: true });
    await setup(app);
    // 25 wrong-password hits — would have tripped the default limiter.
    for (let i = 0; i < 25; i++) {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'owner@example.com', password: 'nope-nope-nope' });
      expect(res.status).toBe(401);
    }
  });
});

describe('POST /api/auth/invites/:token/accept — rate limit', () => {
  it('returns 429 on the 6th rapid accept attempt', async () => {
    // Real token resolution requires a valid invite in the DB. The
    // limiter runs BEFORE the route handler, so we can exercise it
    // against a bogus token — we only care that the 6th call is
    // rejected by the limiter, not by the 404-on-invalid-token path.
    const app = buildApp({ inviteAcceptRateLimit: { windowMs: 60_000, limit: 5 } });
    await setup(app);

    for (let i = 0; i < 5; i++) {
      const res = await supertest(app)
        .post('/api/auth/invites/not-a-real-token/accept')
        .send({ email: 'squatter@example.com', password: 'squatters-strong-password' });
      // 404 because the token is bogus — but the request made it past
      // the limiter and ticked the counter.
      expect(res.status).toBe(404);
    }

    const blocked = await supertest(app)
      .post('/api/auth/invites/not-a-real-token/accept')
      .send({ email: 'squatter@example.com', password: 'squatters-strong-password' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body).toMatchObject({ code: 'rate_limited' });
  });
});
