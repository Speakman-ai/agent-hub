import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: (...args: Parameters<typeof import('child_process').spawn>) =>
    spawnMock(...args) as ReturnType<typeof import('child_process').spawn>,
}));

import createPerUserEngineAuthRoutes from './per-user-engine-auth.js';
import { resetActiveCodexDeviceLoginsForTest } from '../per-user-codex-device-login.js';

function fakeSpawnProc(events: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  closeCode?: number | null;
}): EventEmitter {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(),
  });
  queueMicrotask(() => {
    for (const c of events.stdoutChunks ?? []) stdout.emit('data', Buffer.from(c));
    for (const c of events.stderrChunks ?? []) stderr.emit('data', Buffer.from(c));
    proc.emit('close', events.closeCode ?? 0);
  });
  return proc as unknown as import('child_process').ChildProcess;
}

function buildApp(opts: {
  cursorBin: string;
  codexBin: string;
  dataDir: string;
  userId?: string | null;
}): express.Express {
  const app = express();
  app.use(express.json());

  // Inject auth identity middleware (mirrors the real `authMiddleware`
  // attaching `authUserId` after JWT verification).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (opts.userId) {
      (req as AuthenticatedRequest).authUserId = opts.userId;
    }
    next();
  });

  const deps = {
    config: {
      cursorBin: opts.cursorBin,
      codexBin: opts.codexBin,
      dataDir: opts.dataDir,
      codexApiKey: null,
    },
    broadcast: vi.fn(),
    getCursorBin: () => opts.cursorBin,
    getCodexBin: () => opts.codexBin,
  } as unknown as RouteDeps;

  app.use(createPerUserEngineAuthRoutes(deps));
  return app;
}

const sampleCursorLoginOutput = 'Visit https://cursor.com/loginDeepControl?token=abc123 to log in';
const sampleCodexDeviceOutput = `
Follow these steps to sign in with ChatGPT using device code authorization:
1. Open this link
   https://auth.openai.com/codex/device
2. Enter this one-time code
   UYG9-Q1Q9N
`;

describe('per-user engine auth routes', () => {
  let tmpDir: string;
  let cursorBin: string;
  let codexBin: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'per-user-auth-rt-'));
    cursorBin = join(tmpDir, 'cursor-agent');
    codexBin = join(tmpDir, 'codex');
    writeFileSync(cursorBin, '');
    writeFileSync(codexBin, '');
    spawnMock.mockReset();
    resetActiveCodexDeviceLoginsForTest();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── Auth gate ──────────────────────────────────────────────────────
  it('returns 401 when caller is unauthenticated', async () => {
    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: null });
    const responses = await Promise.all([
      request(app).get('/api/auth/me/cursor-auth/browser'),
      request(app).post('/api/auth/me/cursor-auth/browser/login'),
      request(app).post('/api/auth/me/cursor-auth/browser/cancel-login'),
      request(app).delete('/api/auth/me/cursor-auth/browser'),
      request(app).get('/api/auth/me/codex-auth/browser'),
      request(app).post('/api/auth/me/codex-auth/browser/device-login'),
      request(app).post('/api/auth/me/codex-auth/browser/cancel-login'),
      request(app).delete('/api/auth/me/codex-auth/browser'),
    ]);
    for (const res of responses) expect(res.status).toBe(401);
  });

  // ── Cursor: status ─────────────────────────────────────────────────
  it('GET /api/auth/me/cursor-auth/browser parses status JSON under per-user HOME', async () => {
    const userId = 'user-alpha';
    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId });

    spawnMock.mockImplementation((_cmd, args, opts) => {
      const a = args as string[];
      // The spawn must be pinned at the per-user HOME.
      const env = (opts as { env: Record<string, string> }).env;
      expect(env.HOME).toBe(join(tmpDir, 'per-user-creds', userId, 'home'));
      if (a[0] === 'status' && a[1] === '--format' && a[2] === 'json') {
        const json = JSON.stringify({
          isAuthenticated: true,
          userInfo: { email: 'alpha@example.com' },
        });
        return fakeSpawnProc({ stdoutChunks: [json], closeCode: 0 });
      }
      return fakeSpawnProc({ closeCode: 1 });
    });

    const res = await request(app).get('/api/auth/me/cursor-auth/browser').expect(200);
    expect(res.body.uiStatus).toBe('authenticated');
    expect(res.body.oauth.loggedIn).toBe(true);
    expect(res.body.oauth.email).toBe('alpha@example.com');
    expect(res.body.activeMethod).toBe('oauth');
  });

  it('GET /api/auth/me/cursor-auth/browser reports binary-missing when bin absent', async () => {
    const missingBin = join(tmpDir, 'nope-cursor');
    const app = buildApp({ cursorBin: missingBin, codexBin, dataDir: tmpDir, userId: 'u1' });
    const res = await request(app).get('/api/auth/me/cursor-auth/browser').expect(200);
    expect(res.body.binary.present).toBe(false);
    expect(res.body.statusError).toContain('Cursor Agent binary not found');
  });

  it('ensures per-user HOME directory is created on first status hit', async () => {
    const userId = 'user-create-home';
    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId });

    spawnMock.mockImplementation(() => fakeSpawnProc({ stdoutChunks: ['{}'], closeCode: 0 }));

    await request(app).get('/api/auth/me/cursor-auth/browser').expect(200);

    const home = join(tmpDir, 'per-user-creds', userId, 'home');
    expect(existsSync(home)).toBe(true);
    const st = statSync(home);
    // Lower 9 bits should be 0o700 (owner rwx only).
    expect(st.mode & 0o777).toBe(0o700);
  });

  // ── Cursor: login emits URL ────────────────────────────────────────
  it('POST /api/auth/me/cursor-auth/browser/login returns loginUrl from CLI output', async () => {
    const userId = 'user-login';
    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId });

    spawnMock.mockImplementation((cmd, args, opts) => {
      expect(cmd).toBe(cursorBin);
      expect(args).toEqual(['login']);
      const env = (opts as { env: Record<string, string> }).env;
      expect(env.HOME).toBe(join(tmpDir, 'per-user-creds', userId, 'home'));
      expect(env.NO_OPEN_BROWSER).toBe('1');
      return fakeSpawnProc({ stdoutChunks: [sampleCursorLoginOutput], closeCode: 0 });
    });

    const res = await request(app).post('/api/auth/me/cursor-auth/browser/login').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.loginUrl).toMatch(/^https:\/\/cursor\.com\//);
    expect(res.body.loginId).toBeTruthy();
  });

  it('POST /api/auth/me/cursor-auth/browser/login → 400 when cursor binary missing', async () => {
    const missingBin = join(tmpDir, 'nope');
    const app = buildApp({ cursorBin: missingBin, codexBin, dataDir: tmpDir, userId: 'u1' });
    const res = await request(app).post('/api/auth/me/cursor-auth/browser/login').expect(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('Cursor Agent binary not found');
  });

  // ── Cursor: cancel + DELETE ────────────────────────────────────────
  it('POST /api/auth/me/cursor-auth/browser/cancel-login is idempotent', async () => {
    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: 'idempotent-user' });
    const res = await request(app)
      .post('/api/auth/me/cursor-auth/browser/cancel-login')
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.output).toMatch(/no login in progress/i);
  });

  it('DELETE /api/auth/me/cursor-auth/browser wipes per-user .cursor cache', async () => {
    const userId = 'user-wipe';
    const home = join(tmpDir, 'per-user-creds', userId, 'home');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'token.json'), '{"token":"x"}');

    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId });

    spawnMock.mockImplementation(() =>
      fakeSpawnProc({ stdoutChunks: ['Logged out'], closeCode: 0 }),
    );

    const res = await request(app).delete('/api/auth/me/cursor-auth/browser').expect(200);
    expect(res.body.ok).toBe(true);
    expect(existsSync(join(home, '.cursor'))).toBe(false);
  });

  // ── Codex: device-login emits URL + code ───────────────────────────
  it('POST /api/auth/me/codex-auth/browser/device-login returns deviceAuthUrl + userCode', async () => {
    const userId = 'user-codex';
    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId });

    spawnMock.mockImplementation((cmd, args, opts) => {
      expect(cmd).toBe(codexBin);
      expect(args).toEqual(['login', '--device-auth']);
      const env = (opts as { env: Record<string, string> }).env;
      expect(env.HOME).toBe(join(tmpDir, 'per-user-creds', userId, 'home'));
      return fakeSpawnProc({ stdoutChunks: [sampleCodexDeviceOutput], closeCode: 0 });
    });

    const res = await request(app).post('/api/auth/me/codex-auth/browser/device-login').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deviceAuthUrl).toContain('auth.openai.com/codex/device');
    expect(res.body.userCode).toBe('UYG9-Q1Q9N');
  });

  it('POST /api/auth/me/codex-auth/browser/device-login → 400 when codex binary missing', async () => {
    const missingBin = join(tmpDir, 'nope-codex');
    const app = buildApp({ cursorBin, codexBin: missingBin, dataDir: tmpDir, userId: 'u1' });
    const res = await request(app).post('/api/auth/me/codex-auth/browser/device-login').expect(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('Codex binary not found');
  });

  // ── Codex: status & DELETE ─────────────────────────────────────────
  it('GET /api/auth/me/codex-auth/browser reports OAuth when per-user .codex/auth.json holds chatgpt tokens', async () => {
    const userId = 'user-codex-status';
    const home = join(tmpDir, 'per-user-creds', userId, 'home');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x', id_token: 'y' } }),
    );

    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId });
    const res = await request(app).get('/api/auth/me/codex-auth/browser').expect(200);
    expect(res.body.binary.present).toBe(true);
    expect(res.body.oauth.mode).toBe('chatgpt');
    expect(res.body.activeMethod).toBe('oauth');
    expect(res.body.oauth.loggedIn).toBe(true);
  });

  it('DELETE /api/auth/me/codex-auth/browser wipes per-user .codex cache', async () => {
    const userId = 'user-codex-wipe';
    const home = join(tmpDir, 'per-user-creds', userId, 'home');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');

    const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId });
    spawnMock.mockImplementation(() =>
      fakeSpawnProc({ stdoutChunks: ['Successfully logged out'], closeCode: 0 }),
    );

    const res = await request(app).delete('/api/auth/me/codex-auth/browser').expect(200);
    expect(res.body.ok).toBe(true);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  // ── P4: per-user Codex device-login (engine-isolated CODEX_HOME) ──
  describe('POST /api/auth/me/codex-auth/login', () => {
    it('spawns codex login --device-auth with CODEX_HOME pinned at <dataDir>/per-user-cli-home/codex/<uid>', async () => {
      const userId = 'codex-p4-user';
      const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId });

      const observed: {
        env?: Record<string, string>;
        cwd?: string;
        args?: string[];
      } = {};
      spawnMock.mockImplementation((cmd, args, opts) => {
        expect(cmd).toBe(codexBin);
        observed.args = args as string[];
        observed.cwd = (opts as { cwd: string }).cwd;
        observed.env = (opts as { env: Record<string, string> }).env;
        return fakeSpawnProc({ stdoutChunks: [sampleCodexDeviceOutput], closeCode: 0 });
      });

      const res = await request(app).post('/api/auth/me/codex-auth/login').expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.deviceAuthUrl).toContain('auth.openai.com/codex/device');
      expect(res.body.userCode).toBe('UYG9-Q1Q9N');
      expect(res.body.loginId).toBeTruthy();

      expect(observed.args).toEqual(['login', '--device-auth']);
      const expectedHome = join(tmpDir, 'per-user-cli-home', 'codex', userId);
      // CODEX_HOME is the engine-isolated knob — that's what makes this
      // distinct from the older /browser/device-login flow which pinned HOME.
      expect(observed.env?.CODEX_HOME).toBe(expectedHome);
      expect(observed.cwd).toBe(expectedHome);
      // The directory must have been created (mode 0700).
      expect(existsSync(expectedHome)).toBe(true);
      const st = statSync(expectedHome);
      expect(st.mode & 0o777).toBe(0o700);
    });

    it('returns 401 when the caller is unauthenticated', async () => {
      const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: null });
      await request(app).post('/api/auth/me/codex-auth/login').expect(401);
      await request(app).post('/api/auth/me/codex-auth/login/cancel').expect(401);
    });

    it('returns 400 when the codex binary is missing', async () => {
      const missingBin = join(tmpDir, 'no-codex');
      const app = buildApp({ cursorBin, codexBin: missingBin, dataDir: tmpDir, userId: 'u-1' });
      const res = await request(app).post('/api/auth/me/codex-auth/login').expect(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain('Codex binary not found');
    });

    it('two users get isolated CODEX_HOME trees', async () => {
      const observedHomes: string[] = [];
      spawnMock.mockImplementation((_cmd, _args, opts) => {
        const env = (opts as { env: Record<string, string> }).env;
        observedHomes.push(env.CODEX_HOME);
        return fakeSpawnProc({ stdoutChunks: [sampleCodexDeviceOutput], closeCode: 0 });
      });

      const appA = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: 'codex-A' });
      const appB = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: 'codex-B' });

      await request(appA).post('/api/auth/me/codex-auth/login').expect(200);
      await request(appB).post('/api/auth/me/codex-auth/login').expect(200);

      expect(observedHomes).toHaveLength(2);
      expect(observedHomes[0]).toBe(join(tmpDir, 'per-user-cli-home', 'codex', 'codex-A'));
      expect(observedHomes[1]).toBe(join(tmpDir, 'per-user-cli-home', 'codex', 'codex-B'));
      expect(observedHomes[0]).not.toBe(observedHomes[1]);
    });

    it('reports loginId + completion when the CLI exits 0 before emitting a device code', async () => {
      // Edge case: codex sometimes finds cached credentials and exits 0
      // immediately. We should report that as a successful no-op rather
      // than a timeout.
      const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: 'fast-codex' });
      spawnMock.mockImplementation(() =>
        fakeSpawnProc({ stdoutChunks: ['already logged in'], closeCode: 0 }),
      );
      const res = await request(app).post('/api/auth/me/codex-auth/login').expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.loginId).toBeTruthy();
      expect(res.body.output).toMatch(/logged in/i);
    });
  });

  describe('POST /api/auth/me/codex-auth/login/cancel', () => {
    it('is idempotent — returns ok even when no login is in progress', async () => {
      const app = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: 'cancel-clean' });
      const res = await request(app).post('/api/auth/me/codex-auth/login/cancel').expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.output).toMatch(/no device login in progress/i);
    });
  });

  // ── Per-user isolation ─────────────────────────────────────────────
  it('two users share no HOME — login spawns land in distinct per-user trees', async () => {
    const spawnHomes: string[] = [];
    spawnMock.mockImplementation((_cmd, _args, opts) => {
      const env = (opts as { env: Record<string, string> }).env;
      spawnHomes.push(env.HOME);
      return fakeSpawnProc({ stdoutChunks: [sampleCursorLoginOutput], closeCode: 0 });
    });

    const appA = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: 'A' });
    const appB = buildApp({ cursorBin, codexBin, dataDir: tmpDir, userId: 'B' });

    await request(appA).post('/api/auth/me/cursor-auth/browser/login').expect(200);
    await request(appB).post('/api/auth/me/cursor-auth/browser/login').expect(200);

    expect(spawnHomes).toHaveLength(2);
    expect(spawnHomes[0]).toBe(join(tmpDir, 'per-user-creds', 'A', 'home'));
    expect(spawnHomes[1]).toBe(join(tmpDir, 'per-user-creds', 'B', 'home'));
    expect(spawnHomes[0]).not.toBe(spawnHomes[1]);
  });
});
