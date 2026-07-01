import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import createDesignRoutes from './designs.js';
import { createDesign, linkProject, ensureDesignsRoot, designDir } from '../designs-store.js';
import { getDb, getStmts } from '../db.js';
import { wipeTables } from '../test/destructive-db.js';
import { initOrgsDb } from '../orgs.js';
import type { AppConfig, Project, RouteDeps, SessionRow } from '../types.js';

const projects = new Map<string, Project>();
function findProject(id: string): Project | null {
  return projects.get(id) ?? null;
}

let designsRoot: string;
let worktreeRoot: string;
let provision: ReturnType<typeof vi.fn>;

function buildApp(overrides: Partial<RouteDeps> = {}) {
  const deps = {
    stmts: getStmts(),
    broadcast: vi.fn(),
    findProject,
    findAgent: (id: string) => ({
      agent: { id, name: id, engine: 'claude-code', model: null },
      project: findProject('p1')!,
    }),
    allAgents: () => [{ id: 'agent-1', name: 'Agent', engine: 'claude-code', projectId: 'p1' }],
    provisionSessionWorkspace: provision,
    config: { allValidModels: ['sonnet'], engineValidModels: {} } as unknown as AppConfig,
    handleChat: vi.fn(),
    getDesignsRoot: () => designsRoot,
    ...overrides,
  } as unknown as RouteDeps & { getDesignsRoot: () => string };

  const app = express();
  app.use(express.json());
  app.use(createDesignRoutes(deps));
  return app;
}

beforeEach(() => {
  designsRoot = mkdtempSync(path.join(tmpdir(), 'designs-route-test-'));
  worktreeRoot = mkdtempSync(path.join(tmpdir(), 'designs-route-wt-'));
  ensureDesignsRoot(designsRoot);
  projects.clear();
  projects.set('p1', { id: 'p1', name: 'P1', cwd: '/tmp', ahw: '/tmp', agents: [] });
  provision = vi.fn(async () => worktreeRoot);

  initOrgsDb(); // prepare org statements used by getActiveOrgId() in the routes
  // wipeTables enforces the scratch-DB check (server/test/destructive-db.ts).
  wipeTables(getDb(), ['design_messages', 'design_projects', 'designs', 'messages', 'sessions']);
});

function seedDesign(linked = ['p1']): string {
  const design = createDesign('Hero Page', linked, designsRoot, findProject, 'default');
  for (const p of linked) linkProject(design.id, p);
  writeFileSync(path.join(designDir(designsRoot, design.id), 'index.html'), '<h1>x</h1>');
  getStmts().appendDesignMessage.run('dm1', design.id, 'user', 'hi');
  return design.id;
}

describe('POST /api/designs/:id/import', () => {
  it('404s for an unknown design', async () => {
    const res = await supertest(buildApp()).post('/api/designs/nope/import');
    expect(res.status).toBe(404);
  });

  it('imports a design into a design-mode session (201)', async () => {
    const id = seedDesign();
    const res = await supertest(buildApp()).post(`/api/designs/${id}/import`);
    expect(res.status).toBe(201);
    expect(res.body.reused).toBe(false);
    expect(res.body.importedMessages).toBe(1);
    expect(provision).toHaveBeenCalledOnce();

    const session = getStmts().getSession.get(res.body.sessionId) as SessionRow;
    expect(session.session_mode).toBe('design');
    expect(existsSync(path.join(worktreeRoot, 'design', 'index.html'))).toBe(true);
  });

  it('is idempotent: second import returns the same session (200, reused)', async () => {
    const id = seedDesign();
    const first = await supertest(buildApp()).post(`/api/designs/${id}/import`);
    const second = await supertest(buildApp()).post(`/api/designs/${id}/import`);
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.sessionId).toBe(first.body.sessionId);
  });

  it('409s when no linked project has an eligible agent', async () => {
    const id = seedDesign([]); // no linked projects → no target agent
    const res = await supertest(buildApp()).post(`/api/designs/${id}/import`);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('no-target-agent');
  });

  it('503s when worktree provisioning is not wired', async () => {
    const id = seedDesign();
    const res = await supertest(buildApp({ provisionSessionWorkspace: undefined })).post(
      `/api/designs/${id}/import`,
    );
    expect(res.status).toBe(503);
  });

  it('409s import_in_progress when another import holds the lock', async () => {
    const id = seedDesign();
    // Simulate an in-flight import by acquiring the lock under a different id.
    const held = getStmts().acquireDesignImportLock.run('other-session', id, '-300 seconds');
    expect(held.changes).toBe(1);

    const res = await supertest(buildApp()).post(`/api/designs/${id}/import`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('import_in_progress');
    expect(res.body.retryable).toBe(true);

    // No session was created while the lock was held by the other importer.
    const count = (getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

describe('legacy design mutations are blocked once imported', () => {
  function markImported(id: string, sessionId = 'sess-migrated'): void {
    getDb().prepare('UPDATE designs SET imported_session_id = ? WHERE id = ?').run(sessionId, id);
  }

  it('PATCH /api/designs/:id 409s with design_migrated', async () => {
    const id = seedDesign();
    markImported(id);
    const res = await supertest(buildApp()).patch(`/api/designs/${id}`).send({ name: 'renamed' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('design_migrated');
    expect(res.body.sessionId).toBe('sess-migrated');
    // The rename did not take effect.
    const row = getStmts().getDesign.get(id) as { name: string };
    expect(row.name).toBe('Hero Page');
  });

  it('DELETE /api/designs/:id 409s with design_migrated and preserves the row', async () => {
    const id = seedDesign();
    markImported(id);
    const res = await supertest(buildApp()).delete(`/api/designs/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('design_migrated');
    // The design row is preserved (no destructive delete during migration).
    const row = getStmts().getDesign.get(id) as { id: string } | undefined;
    expect(row?.id).toBe(id);
  });

  it('PATCH still works on a not-yet-imported design', async () => {
    const id = seedDesign();
    const res = await supertest(buildApp()).patch(`/api/designs/${id}`).send({ name: 'renamed' });
    expect(res.status).toBe(200);
    const row = getStmts().getDesign.get(id) as { name: string };
    expect(row.name).toBe('renamed');
  });
});
