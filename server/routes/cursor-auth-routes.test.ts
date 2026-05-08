import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RouteDeps } from '../types.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: (...args: Parameters<typeof import('child_process').spawn>) =>
    spawnMock(...args) as ReturnType<typeof import('child_process').spawn>,
}));

import createCursorAuthRoutes from './cursor-auth.js';

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

describe('cursor-auth routes', () => {
  let tmpDir: string;
  let fakeBin: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cursor-auth-rt-'));
    fakeBin = join(tmpDir, 'cursor-agent');
    writeFileSync(fakeBin, '');

    const deps = {
      config: { cursorBin: fakeBin, dataDir: tmpDir, codexBin: fakeBin },
      broadcast: vi.fn(),
      getCursorBin: () => fakeBin,
    } as unknown as RouteDeps;

    app = express();
    app.use(createCursorAuthRoutes(deps));
    spawnMock.mockReset();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('GET /api/config/cursor-auth returns JSON when status --format json succeeds', async () => {
    const statusJson = JSON.stringify({
      isAuthenticated: true,
      userInfo: { email: 'u@x.com' },
    });
    spawnMock.mockImplementation((_cmd, args) => {
      const a = args as string[];
      if (a[0] === 'status' && a[1] === '--format' && a[2] === 'json') {
        return fakeSpawnProc({ stdoutChunks: [statusJson], closeCode: 0 });
      }
      return fakeSpawnProc({ closeCode: 1 });
    });

    const res = await request(app).get('/api/config/cursor-auth').expect(200);
    expect(res.body.uiStatus).toBe('authenticated');
    expect(res.body.oauth.loggedIn).toBe(true);
    expect(res.body.oauth.email).toBe('u@x.com');
    expect(res.body.activeMethod).toBe('oauth');
    expect(spawnMock).toHaveBeenCalled();
  });

  it('GET /api/config/cursor-auth prefers cursorBin query over getCursorBin when probing status', async () => {
    const otherBin = join(tmpDir, 'wizard-cursor-agent');
    writeFileSync(otherBin, '');

    const statusJson = JSON.stringify({
      isAuthenticated: true,
      userInfo: { email: 'wiz@example.com' },
    });
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      expect(cmd).toBe(otherBin);
      if (args[0] === 'status' && args[1] === '--format' && args[2] === 'json') {
        return fakeSpawnProc({ stdoutChunks: [statusJson], closeCode: 0 });
      }
      return fakeSpawnProc({ closeCode: 1 });
    });

    const res = await request(app)
      .get(`/api/config/cursor-auth`)
      .query({ cursorBin: otherBin })
      .expect(200);

    expect(res.body.activeMethod).toBe('oauth');
    expect(res.body.binary.path).toBe(otherBin);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('POST /api/config/cursor-auth/login responds once with loginUrl when NO_OPEN_BROWSER output includes URL', async () => {
    spawnMock.mockImplementation(() =>
      fakeSpawnProc({
        stdoutChunks: [
          'Open https://cursor.com/loginDeepControl?challenge=a&uuid=b&mode=login&redirectTarget=cli\n',
        ],
        closeCode: 0,
      }),
    );

    const res = await request(app).post('/api/config/cursor-auth/login').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.loginUrl).toMatch(/^https:\/\/cursor\.com\/loginDeepControl/);
    expect(res.body.loginId).toBeTruthy();
  });

  it('POST /api/config/cursor-auth/cancel-login returns ok when no login active', async () => {
    const res = await request(app).post('/api/config/cursor-auth/cancel-login').expect(200);
    expect(res.body.ok).toBe(true);
  });
});
