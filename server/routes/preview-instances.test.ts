/**
 * Route-level coverage for the project preview instances surface.
 *
 *   GET  /api/projects/:projectId/previews
 *   POST /api/projects/:projectId/previews/:previewId/stop
 *   POST /api/projects/:projectId/previews/purge
 *
 * The router is mounted standalone (with a stub auth middleware) against
 * an in-memory DB so the runtime-dispatch wiring is exercised without
 * booting the whole app. The regression guarded here: dev-server groups
 * used to fall through to the legacy spawn runtime, which ignores them —
 * the request returned 200 while the process and its host port survived.
 */
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WORKTREE_PREVIEW_GROUPS_SCHEMA } from '../preview/preview-schema.js';

let db: Database.Database;

vi.mock('../db.js', () => ({ getDb: () => db }));

const { default: createPreviewInstancesRoutes } = await import('./preview-instances.js');

function makeApp(deps: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { authRole: string }).authRole = 'Owner';
    next();
  });
  app.use(
    createPreviewInstancesRoutes({
      findProject: (id: string) => (id === 'proj-a' ? { id: 'proj-a' } : null),
      ...deps,
    } as never),
  );
  return app;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(WORKTREE_PREVIEW_GROUPS_SCHEMA);
  // Compose companion column, added by the compose runtime's migration
  // rather than the base schema, but still selected by the list query.
  db.exec(`ALTER TABLE worktree_preview_groups ADD COLUMN worktree_path TEXT`);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT
    );
  `);
  db.prepare(
    `INSERT INTO sessions (id, agent_id, name) VALUES ('sess-1', 'a1', 'Dev session')`,
  ).run();
  db.prepare(
    `INSERT INTO worktree_preview_groups (id, session_id, project_id, status, runtime)
     VALUES ('g-dev', 'sess-1', 'proj-a', 'ready', 'dev-server')`,
  ).run();
  db.prepare(
    `INSERT INTO worktree_preview_processes
       (id, group_id, name, port, url, status, internal_port, is_primary)
     VALUES ('g-dev:client', 'g-dev', 'client', 4200, 'http://localhost:4200', 'ready', 3050, 1)`,
  ).run();
});

describe('preview instances routes', () => {
  it("lists a dev-server group as kind 'dev-server' with its primary port", async () => {
    const app = makeApp({});
    const res = await request(app).get('/api/projects/proj-a/previews').expect(200);
    expect(res.body.previews).toHaveLength(1);
    expect(res.body.previews[0]).toMatchObject({
      id: 'g-dev',
      kind: 'dev-server',
      port: 4200,
      url: 'http://localhost:4200',
    });
  });

  it('stop routes a dev-server group to DevServerRuntime.stop', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const stopPreview = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({
      getDevServerRuntime: () => ({ stop }),
      getPreviewRuntime: () => ({ stopPreview }),
      getPreviewComposeRuntime: () => ({ stopPreview }),
    });
    await request(app).post('/api/projects/proj-a/previews/g-dev/stop').expect(200);
    expect(stop).toHaveBeenCalledWith('g-dev');
    expect(stopPreview).not.toHaveBeenCalled();
  });

  it('purge routes a dev-server group to DevServerRuntime.stop', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const app = makeApp({ getDevServerRuntime: () => ({ stop }) });
    const res = await request(app).post('/api/projects/proj-a/previews/purge').expect(200);
    expect(res.body).toMatchObject({ ok: true, stopped: 1, failed: [] });
    expect(stop).toHaveBeenCalledWith('g-dev');
  });

  it('reports a 500 rather than a silent success when no dev-server runtime is wired', async () => {
    const app = makeApp({ getPreviewRuntime: () => ({ stopPreview: vi.fn() }) });
    const res = await request(app).post('/api/projects/proj-a/previews/g-dev/stop').expect(500);
    expect(res.body.error).toMatch(/Dev server runtime is not available/);
  });
});
