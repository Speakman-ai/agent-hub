/**
 * Integration tests for `/api/auth/me/agent-engine-overrides` —
 * the per-user, per-agent engine (+ optional model) override map.
 *
 * Covers:
 *   - 401 when no `authUserId` (apiKey-only / unauthenticated callers)
 *   - 404 when `authUserId` is resolved but no user row exists
 *   - GET returns `{}` initially
 *   - PUT round-trips a valid override + GET reflects it
 *   - PUT rejects unknown engines
 *   - PUT rejects models that aren't valid for the named engine
 *   - PUT with an empty map clears all overrides
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig: {
  apiKey: string | null;
  anthropicApiKey: string | null;
  claudeCodeOAuthToken: string | null;
  cursorApiKey: string | null;
  geminiApiKey: string | null;
  codexApiKey: string | null;
  dataDir: string;
  engineValidModels: Record<string, string[]>;
} = {
  apiKey: null,
  anthropicApiKey: null,
  claudeCodeOAuthToken: null,
  cursorApiKey: null,
  geminiApiKey: null,
  codexApiKey: null,
  engineValidModels: {
    'claude-code': ['claude-sonnet-4.5'],
    'codex-cli': ['gpt-5-codex'],
    'cursor-agent': ['composer-2.5'],
  },
  get dataDir() {
    return TMP_DIR;
  },
} as typeof mockConfig;

vi.mock('../config.js', () => ({ default: mockConfig }));

const { default: createAuthRoutes } = await import('./auth.js');
const { setAuthFilePathForTests } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser, getUserByUsername } = await import('../users-store.js');
const { getUserPreferencesRow, replaceUserPreferencesJson } =
  await import('../user-preferences-store.js');

function buildStubbedApp(stub: { authUserId?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (stub.authUserId !== undefined) {
      (req as unknown as { authUserId?: string }).authUserId = stub.authUserId;
    }
    next();
  });
  app.use(createAuthRoutes());
  return app;
}

describe('agent-engine-overrides routes', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'aeo-routes-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
  });

  it('returns 401 when no authUserId is set on the request', async () => {
    const app = buildStubbedApp({});
    const r1 = await supertest(app).get('/api/auth/me/agent-engine-overrides');
    expect(r1.status).toBe(401);
    const r2 = await supertest(app)
      .put('/api/auth/me/agent-engine-overrides')
      .send({ agentEngineOverrides: {} });
    expect(r2.status).toBe(401);
  });

  it('returns 404 when authUserId points at a missing user row', async () => {
    const app = buildStubbedApp({ authUserId: 'ghost' });
    const r = await supertest(app).get('/api/auth/me/agent-engine-overrides');
    expect(r.status).toBe(404);
  });

  it('round-trips an override and GET reflects it', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });

    const get1 = await supertest(app).get('/api/auth/me/agent-engine-overrides');
    expect(get1.status).toBe(200);
    expect(get1.body).toEqual({ agentEngineOverrides: {} });

    const put = await supertest(app)
      .put('/api/auth/me/agent-engine-overrides')
      .send({
        agentEngineOverrides: {
          'agent-hub': { engine: 'codex-cli', model: 'gpt-5-codex' },
          reviewer: { engine: 'claude-code' },
        },
      });
    expect(put.status).toBe(200);
    expect(put.body.agentEngineOverrides['agent-hub']).toEqual({
      engine: 'codex-cli',
      model: 'gpt-5-codex',
    });
    expect(put.body.agentEngineOverrides.reviewer).toEqual({ engine: 'claude-code' });

    const get2 = await supertest(app).get('/api/auth/me/agent-engine-overrides');
    expect(get2.body.agentEngineOverrides['agent-hub'].engine).toBe('codex-cli');
    expect(get2.body.agentEngineOverrides.reviewer.engine).toBe('claude-code');
  });

  it('rejects unknown engines with a 400', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app)
      .put('/api/auth/me/agent-engine-overrides')
      .send({
        agentEngineOverrides: { foo: { engine: 'made-up-engine' } },
      });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/made-up-engine/);
  });

  it('rejects models not allowed for the named engine with a 400', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app)
      .put('/api/auth/me/agent-engine-overrides')
      .send({
        agentEngineOverrides: {
          'agent-hub': { engine: 'codex-cli', model: 'sonnet-but-on-codex' },
        },
      });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/not allowed/);
  });

  it('clears every override when PUT receives an empty map', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', {
      agentEngineOverrides: { 'agent-hub': { engine: 'codex-cli', model: 'gpt-5-codex' } },
    });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app)
      .put('/api/auth/me/agent-engine-overrides')
      .send({ agentEngineOverrides: {} });
    expect(r.status).toBe(200);
    expect(r.body.agentEngineOverrides).toEqual({});
    expect(getUserPreferencesRow('u1').agentEngineOverrides).toBeUndefined();
  });
});

// Ensure the userByUsername helper survives a refresh (parity with the
// other auth tests — silences "imported but unused" lint).
void getUserByUsername;
