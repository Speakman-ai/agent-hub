/**
 * Integration tests for `/api/auth/me/sidebar-collapsed-projects` — the
 * per-user list of projects collapsed in the sidebar project list.
 *
 * Covers:
 *   - 401 when no `authUserId` (apiKey-only / unauthenticated callers)
 *   - 404 when `authUserId` is resolved but no user row exists
 *   - GET returns `[]` initially, and reflects a toggle afterwards
 *   - collapsing is idempotent; expanding removes the entry
 *   - toggles merge server-side, so two concurrent tabs can't clobber
 *     each other's project (the regression this endpoint shape exists for)
 *   - the list is scoped per user
 *   - a bad body / blank projectId is a 400
 *   - the collapsed list doesn't stomp unrelated preference sub-maps
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
const { getUserPreferencesRow, replaceUserPreferencesJson, MAX_SIDEBAR_COLLAPSED_PROJECTS } =
  await import('../user-preferences-store.js');

const { getOrgsDb } = await import('../orgs.js');

const BASE = '/api/auth/me/sidebar-collapsed-projects';

/** The stored `preferences_json` text, before any normalization on read. */
const rawPrefs = (userId: string) =>
  (
    getOrgsDb().prepare('SELECT preferences_json FROM users WHERE id = ?').get(userId) as {
      preferences_json: string | null;
    }
  ).preferences_json;

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

describe('sidebar-collapsed-projects routes', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'scp-routes-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
  });

  it('returns 401 when no authUserId is set on the request', async () => {
    const app = buildStubbedApp({});
    expect((await supertest(app).get(BASE)).status).toBe(401);
    expect((await supertest(app).put(`${BASE}/agent-hub`).send({ collapsed: true })).status).toBe(
      401,
    );
  });

  it('returns 404 when authUserId points at a missing user row', async () => {
    const app = buildStubbedApp({ authUserId: 'ghost' });
    expect((await supertest(app).get(BASE)).status).toBe(404);
    expect((await supertest(app).put(`${BASE}/agent-hub`).send({ collapsed: true })).status).toBe(
      404,
    );
  });

  it('starts empty, then persists a collapse and reflects it on GET', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });

    const get1 = await supertest(app).get(BASE);
    expect(get1.status).toBe(200);
    expect(get1.body).toEqual({ sidebarCollapsedProjects: [] });

    const put = await supertest(app).put(`${BASE}/agent-hub`).send({ collapsed: true });
    expect(put.status).toBe(200);
    expect(put.body.sidebarCollapsedProjects).toEqual(['agent-hub']);

    const get2 = await supertest(app).get(BASE);
    expect(get2.body.sidebarCollapsedProjects).toEqual(['agent-hub']);
  });

  it('is idempotent when collapsing an already-collapsed project', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    await supertest(app).put(`${BASE}/agent-hub`).send({ collapsed: true });
    const again = await supertest(app).put(`${BASE}/agent-hub`).send({ collapsed: true });
    expect(again.body.sidebarCollapsedProjects).toEqual(['agent-hub']);
  });

  it('removes the entry when expanding, and tolerates expanding an unknown project', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    await supertest(app).put(`${BASE}/agent-hub`).send({ collapsed: true });

    const expanded = await supertest(app).put(`${BASE}/agent-hub`).send({ collapsed: false });
    expect(expanded.status).toBe(200);
    expect(expanded.body.sidebarCollapsedProjects).toEqual([]);

    const noop = await supertest(app).put(`${BASE}/never-collapsed`).send({ collapsed: false });
    expect(noop.status).toBe(200);
    expect(noop.body.sidebarCollapsedProjects).toEqual([]);

    // Cleared to empty, the key is dropped from the stored JSON entirely.
    // Asserted on the RAW column, not through the normalizing reader, so a
    // regression that left the old list persisted (and kept serving the
    // project as collapsed on the next GET) can't hide behind normalization.
    expect(rawPrefs('u1')).toBeNull();
    expect(getUserPreferencesRow('u1').sidebarCollapsedProjects).toBeUndefined();

    // …and the next GET agrees, which is what the user actually sees.
    const after = await supertest(app).get(BASE);
    expect(after.body.sidebarCollapsedProjects).toEqual([]);
  });

  it('expanding one project leaves the others (and other preferences) stored', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', { todoAutoCompleteOnPromote: true });
    const app = buildStubbedApp({ authUserId: 'u1' });
    await supertest(app).put(`${BASE}/alpha`).send({ collapsed: true });
    await supertest(app).put(`${BASE}/beta`).send({ collapsed: true });

    await supertest(app).put(`${BASE}/alpha`).send({ collapsed: false });

    expect(JSON.parse(rawPrefs('u1') as string)).toEqual({
      todoAutoCompleteOnPromote: true,
      sidebarCollapsedProjects: ['beta'],
    });
  });

  it('merges per project so one toggle never clobbers another', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });

    await supertest(app).put(`${BASE}/alpha`).send({ collapsed: true });
    await supertest(app).put(`${BASE}/beta`).send({ collapsed: true });
    const third = await supertest(app).put(`${BASE}/gamma`).send({ collapsed: true });
    expect(third.body.sidebarCollapsedProjects).toEqual(['alpha', 'beta', 'gamma']);

    const expandBeta = await supertest(app).put(`${BASE}/beta`).send({ collapsed: false });
    expect(expandBeta.body.sidebarCollapsedProjects).toEqual(['alpha', 'gamma']);
  });

  it('scopes the list to the calling user', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    createUser({ id: 'u2', username: 'bob', passwordHash: 'x' });

    await supertest(buildStubbedApp({ authUserId: 'u1' }))
      .put(`${BASE}/alpha`)
      .send({ collapsed: true });

    const bob = await supertest(buildStubbedApp({ authUserId: 'u2' })).get(BASE);
    expect(bob.body.sidebarCollapsedProjects).toEqual([]);
  });

  it('rejects a non-boolean `collapsed` with a 400', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app).put(`${BASE}/alpha`).send({ collapsed: 'yes' });
    expect(r.status).toBe(400);
    expect(getUserPreferencesRow('u1').sidebarCollapsedProjects).toBeUndefined();
  });

  it('rejects a blank projectId with a 400', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });
    const r = await supertest(app).put(`${BASE}/%20`).send({ collapsed: true });
    expect(r.status).toBe(400);
  });

  it('does not clobber unrelated preference sub-maps', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    replaceUserPreferencesJson('u1', {
      agentModelOverrides: { 'agent-hub': 'gpt-5-codex' },
      todoAutoCompleteOnPromote: true,
    });
    const app = buildStubbedApp({ authUserId: 'u1' });
    await supertest(app).put(`${BASE}/alpha`).send({ collapsed: true });

    const prefs = getUserPreferencesRow('u1');
    expect(prefs.sidebarCollapsedProjects).toEqual(['alpha']);
    expect(prefs.agentModelOverrides).toEqual({ 'agent-hub': 'gpt-5-codex' });
    expect(prefs.todoAutoCompleteOnPromote).toBe(true);

    // …and the reverse: an unrelated preference write keeps the collapsed list.
    const models = await supertest(app)
      .put('/api/auth/me/agent-model-overrides')
      .send({ agentModelOverrides: { reviewer: 'claude-sonnet-4.5' } });
    expect(models.status).toBe(200);
    expect(getUserPreferencesRow('u1').sidebarCollapsedProjects).toEqual(['alpha']);
  });

  it('rejects a collapse past the cap without partially writing', async () => {
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const full = Array.from({ length: MAX_SIDEBAR_COLLAPSED_PROJECTS }, (_, i) => `p${i}`);
    replaceUserPreferencesJson('u1', { sidebarCollapsedProjects: full });
    const app = buildStubbedApp({ authUserId: 'u1' });

    const r = await supertest(app).put(`${BASE}/one-too-many`).send({ collapsed: true });
    expect(r.status).toBe(400);
    // The mutation aborts inside the transaction, so the row is untouched.
    expect(getUserPreferencesRow('u1').sidebarCollapsedProjects).toEqual(full);

    // An expand still works at the cap — only growth is refused.
    const expand = await supertest(app).put(`${BASE}/p0`).send({ collapsed: false });
    expect(expand.status).toBe(200);
    expect(expand.body.sidebarCollapsedProjects).toHaveLength(MAX_SIDEBAR_COLLAPSED_PROJECTS - 1);
  });

  it('serializes concurrent toggles instead of dropping one', async () => {
    // Regression for the read-modify-write clobber: two in-flight toggles for
    // DIFFERENT projects must both survive, not just whichever wrote last.
    createUser({ id: 'u1', username: 'alice', passwordHash: 'x' });
    const app = buildStubbedApp({ authUserId: 'u1' });

    await Promise.all([
      supertest(app).put(`${BASE}/alpha`).send({ collapsed: true }),
      supertest(app).put(`${BASE}/beta`).send({ collapsed: true }),
      supertest(app).put(`${BASE}/gamma`).send({ collapsed: true }),
    ]);

    const stored = getUserPreferencesRow('u1').sidebarCollapsedProjects ?? [];
    expect([...stored].sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
});
