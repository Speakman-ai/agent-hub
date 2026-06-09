/**
 * Integration tests for the PER-AGENT merge endpoints:
 *   PUT/DELETE /api/auth/me/agent-model-overrides/:agentId
 *   PUT/DELETE /api/auth/me/agent-engine-overrides/:agentId
 *
 * These exist so a single-agent edit never sends the whole map (which could
 * clobber another agent's pick or another tab's concurrent edit). The engine
 * PUT must also PRESERVE any existing per-agent `model` subfield rather than
 * silently dropping it — the regression flagged in review.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig = {
  apiKey: null,
  anthropicApiKey: null,
  claudeCodeOAuthToken: null,
  cursorApiKey: null,
  geminiApiKey: null,
  codexApiKey: null,
  engineValidModels: {
    'claude-code': ['claude-sonnet-4.5', 'claude-opus-4.8'],
    'codex-cli': ['gpt-5-codex'],
    'cursor-agent': ['composer-2.5'],
  },
  get dataDir() {
    return TMP_DIR;
  },
} as unknown as { engineValidModels: Record<string, string[]>; dataDir: string };

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
  return supertest(app);
}

describe('per-agent model-override merge endpoints', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'amo-merge-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
  });

  it('401/400 guards', async () => {
    const anon = buildStubbedApp({});
    expect(
      (await anon.put('/api/auth/me/agent-model-overrides/a').send({ model: 'x' })).status,
    ).toBe(401);
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    // Unknown model → 400.
    expect(
      (await app.put('/api/auth/me/agent-model-overrides/a').send({ model: 'nope' })).status,
    ).toBe(400);
  });

  it('PUT :agentId merges without clobbering other agents', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', { agentModelOverrides: { keep: 'gpt-5-codex' } });
    const app = buildStubbedApp({ authUserId: 'u1' });

    const r = await app
      .put('/api/auth/me/agent-model-overrides/agent-hub')
      .send({ model: 'claude-sonnet-4.5' });
    expect(r.status).toBe(200);
    expect(r.body.agentModelOverrides).toEqual({
      keep: 'gpt-5-codex',
      'agent-hub': 'claude-sonnet-4.5',
    });
    expect(getUserPreferencesRow('u1').agentModelOverrides).toEqual({
      keep: 'gpt-5-codex',
      'agent-hub': 'claude-sonnet-4.5',
    });
  });

  it('DELETE :agentId removes only that agent', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', {
      agentModelOverrides: { a: 'gpt-5-codex', b: 'claude-sonnet-4.5' },
    });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await app.delete('/api/auth/me/agent-model-overrides/a');
    expect(r.status).toBe(200);
    expect(r.body.agentModelOverrides).toEqual({ b: 'claude-sonnet-4.5' });
  });
});

describe('per-agent engine-override merge endpoints', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'aeo-merge-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
  });

  it('engine-only PUT PRESERVES the existing per-agent model (regression)', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    // Legacy combined override written by the old UI/API.
    replaceUserPreferencesJson('u1', {
      agentEngineOverrides: { 'agent-hub': { engine: 'claude-code', model: 'claude-opus-4.8' } },
    });
    const app = buildStubbedApp({ authUserId: 'u1' });

    // Re-pick the SAME engine with no model in the body — the model must survive.
    const r = await app
      .put('/api/auth/me/agent-engine-overrides/agent-hub')
      .send({ engine: 'claude-code' });
    expect(r.status).toBe(200);
    expect(r.body.agentEngineOverrides['agent-hub']).toEqual({
      engine: 'claude-code',
      model: 'claude-opus-4.8',
    });
    expect(getUserPreferencesRow('u1').agentEngineOverrides?.['agent-hub']).toEqual({
      engine: 'claude-code',
      model: 'claude-opus-4.8',
    });
  });

  it('does not wipe a different agent’s combined engine+model entry', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', {
      agentEngineOverrides: {
        a: { engine: 'claude-code', model: 'claude-opus-4.8' },
        b: { engine: 'codex-cli', model: 'gpt-5-codex' },
      },
    });
    const app = buildStubbedApp({ authUserId: 'u1' });

    // Change agent a's engine; agent b must be untouched.
    const r = await app.put('/api/auth/me/agent-engine-overrides/a').send({ engine: 'codex-cli' });
    expect(r.status).toBe(200);
    expect(r.body.agentEngineOverrides.b).toEqual({ engine: 'codex-cli', model: 'gpt-5-codex' });
    // a's old model isn't valid for codex-cli, so it's dropped (not persisted bad).
    expect(r.body.agentEngineOverrides.a).toEqual({ engine: 'codex-cli' });
  });

  it('accepts an explicit valid model and rejects an invalid one', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });

    const ok = await app
      .put('/api/auth/me/agent-engine-overrides/a')
      .send({ engine: 'codex-cli', model: 'gpt-5-codex' });
    expect(ok.status).toBe(200);
    expect(ok.body.agentEngineOverrides.a).toEqual({ engine: 'codex-cli', model: 'gpt-5-codex' });

    const bad = await app
      .put('/api/auth/me/agent-engine-overrides/a')
      .send({ engine: 'claude-code', model: 'gpt-5-codex' });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/not allowed/);
  });

  it('DELETE :agentId removes only that agent', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', {
      agentEngineOverrides: { a: { engine: 'claude-code' }, b: { engine: 'codex-cli' } },
    });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await app.delete('/api/auth/me/agent-engine-overrides/a');
    expect(r.status).toBe(200);
    expect(r.body.agentEngineOverrides).toEqual({ b: { engine: 'codex-cli' } });
  });
});
