/**
 * Regression: per-user model / engine overrides must accept the
 * capability-gated Codex models the installed CLI advertises (gpt-5.6-sol
 * etc.), not just the static `config.engineValidModels['codex-cli']` baseline.
 *
 * The bug: `/api/config/models` offers gpt-5.6-sol whenever the user's
 * `models_cache.json` advertises the slug (see codex-model-capability.ts), but
 * the override PUTs validated against the static baseline only, so saving the
 * offered model 400'd with "Unknown model" and a persisted pick was silently
 * dropped from the GET response — "can't use gpt-5.6 for codex anymore".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig: {
  apiKey: string | null;
  dataDir: string;
  engineValidModels: Record<string, string[]>;
} = {
  apiKey: null,
  engineValidModels: {
    'claude-code': ['claude-opus-5'],
    // Real baseline: the gpt-5.6 family / gpt-6-astra are NOT here — they are
    // capability-gated and only surface when the models cache advertises them.
    'codex-cli': ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'],
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
const { getUserPreferencesRow } = await import('../user-preferences-store.js');
const { ensurePerUserHome } = await import('../per-user-home.js');
const { __resetCodexModelsCacheMemo } = await import('../codex-model-capability.js');

function buildStubbedApp(authUserId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUserId?: string }).authUserId = authUserId;
    next();
  });
  app.use(createAuthRoutes());
  return app;
}

/** Write a codex `models_cache.json` under the user's per-user codex home. */
function writeUserCodexCache(userId: string, slugs: string[]) {
  const codexHome = path.join(ensurePerUserHome(userId, TMP_DIR), '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    path.join(codexHome, 'models_cache.json'),
    JSON.stringify({ client_version: '0.153.4', models: slugs.map((slug) => ({ slug })) }),
    'utf8',
  );
}

describe('agent-model-overrides — codex capability gating', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'amo-codex-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    __resetCodexModelsCacheMemo();
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
  });

  it('rejects a gated codex model when the CLI cache does not advertise it', async () => {
    // A per-user cache that advertises only baseline slugs — the first readable
    // cache wins, so capability resolves to baseline and the host ~/.codex
    // fallback (which may advertise gpt-5.6 on a dev box) is never consulted.
    writeUserCodexCache('u1', ['gpt-5.5', 'gpt-5.4']);
    const app = buildStubbedApp('u1');
    const r = await supertest(app)
      .put('/api/auth/me/agent-model-overrides/reviewer')
      .send({ model: 'gpt-5.6-sol' });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/gpt-5\.6-sol/);
  });

  it('accepts and persists a gated codex model the CLI cache advertises', async () => {
    writeUserCodexCache('u1', ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5']);
    const app = buildStubbedApp('u1');

    const put = await supertest(app)
      .put('/api/auth/me/agent-model-overrides/reviewer')
      .send({ model: 'gpt-5.6-sol' });
    expect(put.status).toBe(200);
    expect(put.body.agentModelOverrides.reviewer).toBe('gpt-5.6-sol');

    // GET must not strip the persisted gated pick.
    const get = await supertest(app).get('/api/auth/me/agent-model-overrides');
    expect(get.body.agentModelOverrides.reviewer).toBe('gpt-5.6-sol');
    expect(getUserPreferencesRow('u1').agentModelOverrides?.reviewer).toBe('gpt-5.6-sol');
  });

  it('whole-map PUT accepts a gated codex model the cache advertises', async () => {
    writeUserCodexCache('u1', ['gpt-6-astra', 'gpt-5.6-sol']);
    const app = buildStubbedApp('u1');
    const r = await supertest(app)
      .put('/api/auth/me/agent-model-overrides')
      .send({ agentModelOverrides: { reviewer: 'gpt-6-astra' } });
    expect(r.status).toBe(200);
    expect(r.body.agentModelOverrides.reviewer).toBe('gpt-6-astra');
  });

  it('engine-override PUT accepts a gated codex model the cache advertises', async () => {
    writeUserCodexCache('u1', ['gpt-6-astra', 'gpt-5.6-sol']);
    const app = buildStubbedApp('u1');
    const r = await supertest(app)
      .put('/api/auth/me/agent-engine-overrides/reviewer')
      .send({ engine: 'codex-cli', model: 'gpt-5.6-sol' });
    expect(r.status).toBe(200);
    expect(r.body.agentEngineOverrides.reviewer).toEqual({
      engine: 'codex-cli',
      model: 'gpt-5.6-sol',
    });
  });
});
