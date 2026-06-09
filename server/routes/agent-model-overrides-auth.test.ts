/**
 * Integration tests for `/api/auth/me/agent-model-overrides` —
 * the per-user, per-agent **default model** map that backs the agent /
 * reviewer model dropdowns.
 *
 * Covers:
 *   - 401 when no `authUserId` (apiKey-only / unauthenticated callers)
 *   - 404 when `authUserId` is resolved but no user row exists
 *   - GET returns `{}` initially
 *   - PUT round-trips a valid pick + GET reflects it
 *   - PUT rejects models that aren't valid for any configured engine
 *   - empty-string values drop a single agent's pick
 *   - PUT with an empty map clears all picks
 *   - the model map and the engine-override map don't clobber each other
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
const { createUser } = await import('../users-store.js');
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

describe('agent-model-overrides routes', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'amo-routes-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
  });

  it('returns 401 when no authUserId is set on the request', async () => {
    const app = buildStubbedApp({});
    const r1 = await supertest(app).get('/api/auth/me/agent-model-overrides');
    expect(r1.status).toBe(401);
    const r2 = await supertest(app)
      .put('/api/auth/me/agent-model-overrides')
      .send({ agentModelOverrides: {} });
    expect(r2.status).toBe(401);
  });

  it('returns 404 when authUserId points at a missing user row', async () => {
    const app = buildStubbedApp({ authUserId: 'ghost' });
    const r = await supertest(app).get('/api/auth/me/agent-model-overrides');
    expect(r.status).toBe(404);
  });

  it('round-trips a model pick and GET reflects it', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });

    const get1 = await supertest(app).get('/api/auth/me/agent-model-overrides');
    expect(get1.status).toBe(200);
    expect(get1.body).toEqual({ agentModelOverrides: {} });

    const put = await supertest(app)
      .put('/api/auth/me/agent-model-overrides')
      .send({
        agentModelOverrides: { 'agent-hub': 'gpt-5-codex', reviewer: 'claude-sonnet-4.5' },
      });
    expect(put.status).toBe(200);
    expect(put.body.agentModelOverrides).toEqual({
      'agent-hub': 'gpt-5-codex',
      reviewer: 'claude-sonnet-4.5',
    });

    const get2 = await supertest(app).get('/api/auth/me/agent-model-overrides');
    expect(get2.body.agentModelOverrides['agent-hub']).toBe('gpt-5-codex');
  });

  it('rejects a model not valid for any engine with a 400', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app)
      .put('/api/auth/me/agent-model-overrides')
      .send({ agentModelOverrides: { 'agent-hub': 'totally-made-up-model' } });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/totally-made-up-model/);
  });

  it('drops a single entry when its value is an empty string', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app)
      .put('/api/auth/me/agent-model-overrides')
      .send({ agentModelOverrides: { 'agent-hub': 'gpt-5-codex', reviewer: '' } });
    expect(r.status).toBe(200);
    expect(r.body.agentModelOverrides).toEqual({ 'agent-hub': 'gpt-5-codex' });
  });

  it('clears every pick when PUT receives an empty map', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', { agentModelOverrides: { 'agent-hub': 'gpt-5-codex' } });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app)
      .put('/api/auth/me/agent-model-overrides')
      .send({ agentModelOverrides: {} });
    expect(r.status).toBe(200);
    expect(r.body.agentModelOverrides).toEqual({});
    expect(getUserPreferencesRow('u1').agentModelOverrides).toBeUndefined();
  });

  it('does not clobber the engine-override map', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', {
      agentEngineOverrides: { reviewer: { engine: 'codex-cli' } },
    });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app)
      .put('/api/auth/me/agent-model-overrides')
      .send({ agentModelOverrides: { 'agent-hub': 'gpt-5-codex' } });
    expect(r.status).toBe(200);
    // Both maps coexist after the merge.
    const prefs = getUserPreferencesRow('u1');
    expect(prefs.agentEngineOverrides?.reviewer).toEqual({ engine: 'codex-cli' });
    expect(prefs.agentModelOverrides).toEqual({ 'agent-hub': 'gpt-5-codex' });
  });
});
