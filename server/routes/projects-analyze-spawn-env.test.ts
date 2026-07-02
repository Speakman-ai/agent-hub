/**
 * Regression test for `POST /api/projects/analyze` spawn-env credential
 * threading.
 *
 * Bug: the analyze route built the CLI spawn env with
 * `buildSpawnEnv(config, { engine })` only — it never threaded the acting
 * user's id or their stored credential override. So the analyzer inherited
 * the host HOME with no per-user Claude OAuth token, and users whose Claude
 * auth lives in the DB got "Not logged in · Please run /login" when
 * analyzing a new project.
 *
 * This locks in that BOTH analyze spawn paths (Claude stream-json and the
 * one-shot fallback) pass `userId` + `userOverride:
 * resolveUserCliCredOverride(userId)` through to `buildSpawnEnv`, mirroring
 * the heartbeat / chat spawn-env resolution.
 *
 * We drive the one-shot fallback path (codex-cli) because it surfaces the
 * resolved env as an argument to the mocked `runOneShotPrompt`, and we spy
 * on `buildSpawnEnv` / `resolveUserCliCredOverride` to assert the wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

vi.mock('../engine-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine-resolver.js')>();
  return { ...actual, resolveOneShotEngine: vi.fn() };
});

vi.mock('../one-shot-spawn.js', () => ({
  runOneShotPrompt: vi.fn(),
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, buildSpawnEnv: vi.fn() };
});

vi.mock('../per-user-cli-spawn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../per-user-cli-spawn.js')>();
  return { ...actual, resolveUserCliCredOverride: vi.fn() };
});

const { resolveOneShotEngine } = await import('../engine-resolver.js');
const { runOneShotPrompt } = await import('../one-shot-spawn.js');
const { buildSpawnEnv } = await import('../config.js');
const { resolveUserCliCredOverride } = await import('../per-user-cli-spawn.js');
const { default: createProjectRoutes } = await import('./projects.js');

const resolveMock = resolveOneShotEngine as unknown as ReturnType<typeof vi.fn>;
const runOneShotMock = runOneShotPrompt as unknown as ReturnType<typeof vi.fn>;
const buildSpawnEnvMock = buildSpawnEnv as unknown as ReturnType<typeof vi.fn>;
const resolveCredMock = resolveUserCliCredOverride as unknown as ReturnType<typeof vi.fn>;

function buildApp(opts: { authUserId?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.authUserId !== undefined) {
      (req as unknown as { authUserId?: string }).authUserId = opts.authUserId;
    }
    next();
  });
  const config = {
    dataDir: tmpdir(),
    defaultModel: 'claude-opus-4-8',
    engineDefaultModels: {
      'claude-code': 'claude-opus-4-8',
      'cursor-agent': 'composer-2.5',
      'codex-cli': 'gpt-5.5',
    },
    engineValidModels: {
      'claude-code': ['claude-opus-4-8'],
      'cursor-agent': ['composer-2.5'],
      'codex-cli': ['gpt-5.5'],
    },
  };
  const deps = {
    config,
    broadcast: vi.fn(),
    getClaudeBin: () => '/usr/local/bin/claude',
  };
  app.use(createProjectRoutes(deps as unknown as Parameters<typeof createProjectRoutes>[0]));
  return app;
}

describe('POST /api/projects/analyze — spawn env credential threading', () => {
  let cwd = '';

  beforeEach(() => {
    resolveMock.mockReset();
    runOneShotMock.mockReset();
    buildSpawnEnvMock.mockReset();
    resolveCredMock.mockReset();
    cwd = mkdtempSync(path.join(tmpdir(), 'analyze-env-'));
    // Never resolves — keeps the spawn pending so the request returns 200
    // immediately after wiring the env, without a real CLI ever running.
    runOneShotMock.mockReturnValue(new Promise(() => {}));
  });

  it('threads the acting user id + credential override into the spawn env', async () => {
    const credOverride = { claudeCodeOAuthToken: 'oauth-token-for-user-abc' };
    const sentinelEnv = {
      HOME: '/home/users/user-abc',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-for-user-abc',
    };
    resolveCredMock.mockReturnValue(credOverride);
    buildSpawnEnvMock.mockReturnValue(sentinelEnv);
    resolveMock.mockResolvedValue({
      engine: 'codex-cli',
      model: 'gpt-5.5',
      fallbackUsed: true,
      fallbackFromReason: 'claude unavailable',
    });

    const app = buildApp({ authUserId: 'user-abc' });
    const res = await supertest(app).post('/api/projects/analyze').send({ cwd });

    expect(res.status).toBe(200);

    // The acting user's stored credentials were looked up.
    expect(resolveCredMock).toHaveBeenCalledWith('user-abc');

    // buildSpawnEnv received the acting user's id AND the resolved override.
    expect(buildSpawnEnvMock).toHaveBeenCalledTimes(1);
    const [, buildOpts] = buildSpawnEnvMock.mock.calls[0];
    expect(buildOpts).toMatchObject({
      userId: 'user-abc',
      userOverride: credOverride,
      engine: 'codex-cli',
    });

    // The resolved env (with the user's HOME + token) reached the spawn.
    expect(runOneShotMock).toHaveBeenCalledTimes(1);
    const [spawnArgs] = runOneShotMock.mock.calls[0];
    expect(spawnArgs.env).toBe(sentinelEnv);
  });

  it('passes userId=null through to the override lookup when unauthenticated', async () => {
    resolveCredMock.mockReturnValue(null);
    buildSpawnEnvMock.mockReturnValue({ HOME: '/host' });
    resolveMock.mockResolvedValue({
      engine: 'codex-cli',
      model: 'gpt-5.5',
      fallbackUsed: true,
      fallbackFromReason: 'claude unavailable',
    });

    const app = buildApp({});
    const res = await supertest(app).post('/api/projects/analyze').send({ cwd });

    expect(res.status).toBe(200);
    expect(resolveCredMock).toHaveBeenCalledWith(null);
    const [, buildOpts] = buildSpawnEnvMock.mock.calls[0];
    expect(buildOpts).toMatchObject({ userId: null, userOverride: null });
  });
});
