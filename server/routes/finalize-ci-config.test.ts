/**
 * Integration tests for the server-stored Finalize CI config routes.
 *
 * Covers: Admin gate, GET project+personal split, PUT validation + scope
 * round-trip, personal-scope requires a user, and DELETE.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { FINALIZE_SERVER_CI_SCHEMA } from '../finalize/ci-config-store.js';
import createFinalizeCiConfigRoutes from './finalize-ci-config.js';
import type { RouteDeps } from '../types.js';

const VALID_YAML =
  'version: 2\non: [finalize]\njobs:\n  checks:\n    runs-on: host\n    steps:\n      - run: echo hi\n';

function makeStmts() {
  const db = new Database(':memory:');
  db.exec(FINALIZE_SERVER_CI_SCHEMA);
  return {
    getFinalizeServerCi: db.prepare(
      `SELECT id, project_id, owner_user_id, yaml_text, updated_by, updated_at
         FROM finalize_server_ci
        WHERE project_id = ? AND IFNULL(owner_user_id, '') = IFNULL(?, '')`,
    ),
    listFinalizeServerCiForProject: db.prepare(
      `SELECT id, project_id, owner_user_id, yaml_text, updated_by, updated_at
         FROM finalize_server_ci WHERE project_id = ?`,
    ),
    upsertFinalizeServerCi: db.prepare(
      `INSERT INTO finalize_server_ci
         (id, project_id, owner_user_id, yaml_text, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, IFNULL(owner_user_id, '')) DO UPDATE SET
         yaml_text = excluded.yaml_text,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ),
    deleteFinalizeServerCi: db.prepare(
      `DELETE FROM finalize_server_ci
        WHERE project_id = ? AND IFNULL(owner_user_id, '') = IFNULL(?, '')`,
    ),
  };
}

function buildApp(opts: { role?: string | null; userId?: string }) {
  const stmts = makeStmts();
  const deps = {
    stmts,
    findProject: (id: string) => (id === 'proj1' ? { id: 'proj1', name: 'Proj One' } : null),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.role !== null) {
      (req as unknown as { authRole?: string }).authRole = opts.role ?? 'Admin';
    }
    if (opts.userId) (req as unknown as { authUserId?: string }).authUserId = opts.userId;
    next();
  });
  app.use(createFinalizeCiConfigRoutes(deps));
  return app;
}

describe('finalize-ci-config routes', () => {
  it('403s for a non-Admin caller', async () => {
    const app = buildApp({ role: 'User', userId: 'u1' });
    const res = await supertest(app).get('/api/projects/proj1/finalize/ci-config');
    expect(res.status).toBe(403);
  });

  it('404s for an unknown project', async () => {
    const app = buildApp({ role: 'Admin', userId: 'u1' });
    const res = await supertest(app).get('/api/projects/ghost/finalize/ci-config');
    expect(res.status).toBe(404);
  });

  it('GET returns null scopes initially', async () => {
    const app = buildApp({ role: 'Admin', userId: 'u1' });
    const res = await supertest(app).get('/api/projects/proj1/finalize/ci-config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ project_id: 'proj1', project: null, personal: null });
  });

  it('PUT rejects an invalid ci.yaml with ci_config_invalid', async () => {
    const app = buildApp({ role: 'Admin', userId: 'u1' });
    const res = await supertest(app)
      .put('/api/projects/proj1/finalize/ci-config')
      .send({ ci_yaml_content: 'version: 99\n' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ci_config_invalid');
    expect(res.body.code).toBeTruthy();
  });

  it('PUT stores a project-scoped config and GET reflects it', async () => {
    const app = buildApp({ role: 'Admin', userId: 'admin1' });
    const put = await supertest(app)
      .put('/api/projects/proj1/finalize/ci-config')
      .send({ ci_yaml_content: VALID_YAML });
    expect(put.status).toBe(200);
    expect(put.body.config).toMatchObject({ scope: 'project', updated_by: 'admin1' });

    const get = await supertest(app).get('/api/projects/proj1/finalize/ci-config');
    expect(get.body.project.ci_yaml_content).toContain('echo hi');
    expect(get.body.personal).toBeNull();
  });

  it('PUT personal scope stores an override keyed to the caller', async () => {
    const app = buildApp({ role: 'Admin', userId: 'alice' });
    const put = await supertest(app)
      .put('/api/projects/proj1/finalize/ci-config')
      .send({ ci_yaml_content: VALID_YAML, scope: 'personal' });
    expect(put.status).toBe(200);
    expect(put.body.config.scope).toBe('personal');

    const get = await supertest(app).get('/api/projects/proj1/finalize/ci-config');
    expect(get.body.personal.ci_yaml_content).toContain('echo hi');
    // No project-scoped row was written.
    expect(get.body.project).toBeNull();
  });

  it('PUT personal scope 400s when there is no authenticated user', async () => {
    const app = buildApp({ role: 'Admin' }); // no userId
    const res = await supertest(app)
      .put('/api/projects/proj1/finalize/ci-config')
      .send({ ci_yaml_content: VALID_YAML, scope: 'personal' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_user');
  });

  it('DELETE removes the project scope', async () => {
    const app = buildApp({ role: 'Admin', userId: 'admin1' });
    await supertest(app)
      .put('/api/projects/proj1/finalize/ci-config')
      .send({ ci_yaml_content: VALID_YAML });
    const del = await supertest(app).delete('/api/projects/proj1/finalize/ci-config?scope=project');
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ deleted: true, scope: 'project' });

    const get = await supertest(app).get('/api/projects/proj1/finalize/ci-config');
    expect(get.body.project).toBeNull();
  });
});
