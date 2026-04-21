import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { RouteDeps } from '../types.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: (...args: Parameters<typeof import('child_process').spawn>) =>
    spawnMock(...args) as ReturnType<typeof import('child_process').spawn>,
}));

import createCodexAuthRoutes from './codex-auth.js';

const sampleDeviceOutput = `
Follow these steps to sign in with ChatGPT using device code authorization:
1. Open this link
   https://auth.openai.com/codex/device
2. Enter this one-time code
   UYG9-Q1Q9N
`;

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

describe('codex-auth routes', () => {
  let tmpDir: string;
  let fakeBin: string;
  let app: express.Express;
  let prevCodexHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-auth-rt-'));
    fakeBin = join(tmpDir, 'codex');
    writeFileSync(fakeBin, '');

    prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(tmpDir, 'codex-home');
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    writeFileSync(
      join(process.env.CODEX_HOME, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }),
    );

    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, '{}');

    const deps = {
      config: {
        cursorBin: fakeBin,
        codexBin: fakeBin,
        dataDir: tmpDir,
        codexApiKey: null,
      },
      broadcast: vi.fn(),
      getCodexBin: () => fakeBin,
    } as unknown as RouteDeps;

    app = express();
    app.use(express.json());
    app.use(createCodexAuthRoutes(deps));
    spawnMock.mockReset();
  });

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('GET /api/config/codex-auth reports activeMethod oauth when ChatGPT tokens exist in auth.json', async () => {
    const res = await request(app).get('/api/config/codex-auth').expect(200);
    expect(res.body.binary.present).toBe(true);
    expect(res.body.activeMethod).toBe('oauth');
    expect(res.body.oauth.loggedIn).toBe(true);
    expect(res.body.oauth.mode).toBe('chatgpt');
  });

  it('POST /api/config/codex-auth/device-login returns deviceAuthUrl and userCode once', async () => {
    spawnMock.mockImplementation(() =>
      fakeSpawnProc({
        stdoutChunks: [sampleDeviceOutput],
        closeCode: 0,
      }),
    );

    const res = await request(app).post('/api/config/codex-auth/device-login').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deviceAuthUrl).toBe('https://auth.openai.com/codex/device');
    expect(res.body.userCode).toBe('UYG9-Q1Q9N');
    expect(res.body.loginId).toBeTruthy();
  });

  it('POST /api/config/codex-auth/cancel-login responds ok when idle', async () => {
    const res = await request(app).post('/api/config/codex-auth/cancel-login').expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/config/codex-auth/api-key persists and round-trips in config file', async () => {
    const res = await request(app)
      .post('/api/config/codex-auth/api-key')
      .send({ apiKey: 'sk-test1234abcd' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.masked).toContain('abcd');

    const cfg = JSON.parse(readFileSync(join(tmpDir, 'config.json'), 'utf-8')) as {
      codexApiKey?: string;
    };
    expect(cfg.codexApiKey).toBe('sk-test1234abcd');
  });
});
