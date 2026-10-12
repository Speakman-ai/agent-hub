import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: (...args: Parameters<typeof import('child_process').spawn>) =>
    spawnMock(...args) as ReturnType<typeof import('child_process').spawn>,
}));

vi.mock('../process-groups.js', () => ({
  trackChild: vi.fn(),
  killProcessGroup: vi.fn((proc: { kill: () => void }) => proc.kill()),
}));

import createPerUserMuseAuthRoutes from './per-user-muse-auth.js';
import { perUserHomePath } from '../per-user-home.js';

const LOGIN_BANNER =
  'Open this page to sign in:\n  https://auth.meta.com/oauth/device/?code=WXYZ-1234\n' +
  'Confirm this code matches:\n  WXYZ-1234\n\nWaiting for approval…';

/** Fake child: emits `stderr` chunks, then closes with `closeCode` unless held open. */
function fakeProc(opts: { stderr?: string[]; closeCode?: number; holdOpen?: boolean }) {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => proc.emit('close', null)),
  });
  queueMicrotask(() => {
    for (const c of opts.stderr ?? []) proc.stderr.emit('data', Buffer.from(c));
    if (!opts.holdOpen) proc.emit('close', opts.closeCode ?? 0);
  });
  return proc;
}

describe('per-user Muse auth routes', () => {
  let dataDir: string;
  let museBin: string;
  let broadcast: ReturnType<typeof vi.fn>;

  function app(userId: string | null = 'user-1', deviceCodeTimeoutMs?: number) {
    const a = express();
    a.use(express.json());
    a.use((req: Request, _res: Response, next: NextFunction) => {
      if (userId) (req as AuthenticatedRequest).authUserId = userId;
      next();
    });
    const deps = {
      config: { dataDir, museBin },
      broadcast,
      getMuseBin: () => museBin,
    } as unknown as RouteDeps;
    a.use(createPerUserMuseAuthRoutes(deps, { deviceCodeTimeoutMs }));
    return a;
  }

  function writeAuth(userId: string, body: unknown): string {
    const dir = join(perUserHomePath(userId, dataDir), '.config', 'muse');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'auth.json');
    writeFileSync(file, JSON.stringify(body));
    return file;
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'muse-auth-routes-'));
    museBin = join(dataDir, 'muse');
    writeFileSync(museBin, '');
    broadcast = vi.fn();
    spawnMock.mockReset();
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('rejects unauthenticated callers', async () => {
    const res = await request(app(null)).get('/api/auth/me/muse-auth/browser');
    expect(res.status).toBe(401);
  });

  it('reports missing, then authenticated once a login token exists', async () => {
    let res = await request(app()).get('/api/auth/me/muse-auth/browser');
    expect(res.body).toMatchObject({ uiStatus: 'missing', auth: { loggedIn: false } });

    writeAuth('user-1', { providers: { meta: { mechanism: 'oauth', access_token: 't' } } });
    res = await request(app()).get('/api/auth/me/muse-auth/browser');
    expect(res.body).toMatchObject({
      uiStatus: 'authenticated',
      auth: { loggedIn: true, mode: 'oauth' },
      statusError: null,
    });
  });

  it('reports a missing binary instead of a login state', async () => {
    rmSync(museBin);
    const res = await request(app()).get('/api/auth/me/muse-auth/browser');
    expect(res.body.uiStatus).toBe('missing');
    expect(res.body.auth.loggedIn).toBeNull();
    expect(res.body.statusError).toContain('museBin');
  });

  it('starts `muse login` under the per-user HOME without host credentials', async () => {
    process.env.META_API_KEY = 'host-key';
    process.env.XDG_CONFIG_HOME = '/host/.config';
    try {
      spawnMock.mockImplementation(() => fakeProc({ stderr: [LOGIN_BANNER], holdOpen: true }));
      const res = await request(app()).post('/api/auth/me/muse-auth/browser/device-login');
      expect(res.body).toMatchObject({
        ok: true,
        deviceAuthUrl: 'https://auth.meta.com/oauth/device/?code=WXYZ-1234',
        userCode: 'WXYZ-1234',
      });
      const [bin, args, opts] = spawnMock.mock.calls[0];
      expect(bin).toBe(museBin);
      expect(args).toEqual(['login']);
      expect(opts.env.HOME).toBe(perUserHomePath('user-1', dataDir));
      expect(opts.env.META_API_KEY).toBeUndefined();
      expect(opts.env.XDG_CONFIG_HOME).toBeUndefined();
      expect(opts.env.MUSE_NO_AUTO_UPDATE).toBe('1');
    } finally {
      delete process.env.META_API_KEY;
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  it('broadcasts the outcome when the login process finishes', async () => {
    let proc!: ReturnType<typeof fakeProc>;
    spawnMock.mockImplementation(
      () => (proc = fakeProc({ stderr: [LOGIN_BANNER], holdOpen: true })),
    );
    await request(app()).post('/api/auth/me/muse-auth/browser/device-login');
    proc.emit('close', 0);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'per-user-muse-auth-update',
        userId: 'user-1',
        status: 'success',
      }),
    );
  });

  it('returns the CLI output when login exits before printing a code', async () => {
    spawnMock.mockImplementation(() => fakeProc({ stderr: ['network unreachable'], closeCode: 1 }));
    const res = await request(app()).post('/api/auth/me/muse-auth/browser/device-login');
    expect(res.body).toEqual({
      ok: false,
      loginId: expect.any(String),
      output: 'network unreachable',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('cancels an in-flight login without broadcasting a failure', async () => {
    let proc!: ReturnType<typeof fakeProc>;
    spawnMock.mockImplementation(
      () => (proc = fakeProc({ stderr: [LOGIN_BANNER], holdOpen: true })),
    );
    const a = app();
    await request(a).post('/api/auth/me/muse-auth/browser/device-login');
    const res = await request(a).post('/api/auth/me/muse-auth/browser/cancel-login');
    expect(res.body).toEqual({ ok: true, output: 'Device login cancelled' });
    expect(proc.kill).toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('only cancels the login named by loginId', async () => {
    const procs: ReturnType<typeof fakeProc>[] = [];
    spawnMock.mockImplementation(() => {
      const p = fakeProc({ stderr: [LOGIN_BANNER], holdOpen: true });
      procs.push(p);
      return p;
    });
    const a = app();
    const first = await request(a).post('/api/auth/me/muse-auth/browser/device-login');
    const retry = await request(a).post('/api/auth/me/muse-auth/browser/device-login');
    expect(retry.body.loginId).not.toBe(first.body.loginId);

    // A late cancel for the first attempt must leave the retry running.
    const stale = await request(a)
      .post('/api/auth/me/muse-auth/browser/cancel-login')
      .send({ loginId: first.body.loginId });
    expect(stale.body).toEqual({ ok: true, output: 'No device login in progress' });
    expect(procs[1].kill).not.toHaveBeenCalled();

    const current = await request(a)
      .post('/api/auth/me/muse-auth/browser/cancel-login')
      .send({ loginId: retry.body.loginId });
    expect(current.body).toEqual({ ok: true, output: 'Device login cancelled' });
    expect(procs[1].kill).toHaveBeenCalled();
  });

  it("a superseded attempt's timer never kills the attempt that replaced it", async () => {
    // Attempt A prints nothing and ignores SIGTERM, so it never closes.
    const stuck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    let retry!: ReturnType<typeof fakeProc>;
    spawnMock
      .mockImplementationOnce(() => stuck)
      .mockImplementationOnce(() => (retry = fakeProc({ stderr: [LOGIN_BANNER], holdOpen: true })));
    const a = app('user-1', 100);

    const first = request(a)
      .post('/api/auth/me/muse-auth/browser/device-login')
      .then((r) => r);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    const second = await request(a).post('/api/auth/me/muse-auth/browser/device-login');
    expect(second.body.ok).toBe(true);

    // Replacing A answers A's request at once instead of leaving it hanging.
    expect((await first).body).toMatchObject({ ok: false, output: 'Device login cancelled' });
    expect(stuck.kill).toHaveBeenCalled();

    // Well past A's device-code timeout: B must still be running.
    await new Promise((r) => setTimeout(r, 300));
    expect(retry.kill).not.toHaveBeenCalled();
    const st = await request(a).get('/api/auth/me/muse-auth/browser');
    expect(st.body.loginInProgress).toBe(true);
  });

  it('times out an attempt that never prints a code', async () => {
    const stuck = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    spawnMock.mockImplementation(() => stuck);
    const a = app('user-1', 50);
    const res = await request(a).post('/api/auth/me/muse-auth/browser/device-login');
    expect(res.body).toMatchObject({ ok: false, output: 'Timed out waiting for Muse device code' });
    expect(stuck.kill).toHaveBeenCalled();
    const st = await request(a).get('/api/auth/me/muse-auth/browser');
    expect(st.body.loginInProgress).toBe(false);
  });

  it('400s when the binary is missing', async () => {
    rmSync(museBin);
    const res = await request(app()).post('/api/auth/me/muse-auth/browser/device-login');
    expect(res.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('signs out by running `muse logout` and removing auth.json', async () => {
    const file = writeAuth('user-1', { providers: { meta: { api_key: 'k' } } });
    spawnMock.mockImplementation(() => fakeProc({ stderr: ['logged out'] }));
    const res = await request(app()).delete('/api/auth/me/muse-auth/browser');
    expect(res.body).toEqual({ ok: true, output: 'Muse credential removed — logged out' });
    expect(spawnMock.mock.calls[0][1]).toEqual(['logout']);
    expect(existsSync(file)).toBe(false);
  });
});
