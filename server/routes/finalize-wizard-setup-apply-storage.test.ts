/**
 * Regression tests for the `storage` discriminator on
 * `POST /api/projects/:projectId/finalize/setup-apply`.
 *
 * Guards the reviewer-flagged bug: an invalid `storage` value must 400, not
 * silently fall through to the worktree write/commit path. Also covers the
 * happy `storage: 'server'` path (validated config persisted, no commit).
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { FINALIZE_SERVER_CI_SCHEMA, getServerCiConfig } from '../finalize/ci-config-store.js';
import createFinalizeWizardRoutes from './finalize-wizard.js';
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
    upsertFinalizeServerCi: db.prepare(
      `INSERT INTO finalize_server_ci
         (id, project_id, owner_user_id, yaml_text, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, IFNULL(owner_user_id, '')) DO UPDATE SET
         yaml_text = excluded.yaml_text,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ),
  };
}

function buildApp(userId?: string) {
  const stmts = makeStmts();
  const deps = {
    stmts,
    findProject: (id: string) => (id === 'proj1' ? { id: 'proj1', name: 'Proj One' } : null),
    findAgent: () => null,
    handleChat: vi.fn(),
    broadcast: vi.fn(),
    config: {},
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authRole?: string }).authRole = 'Admin';
    if (userId) (req as unknown as { authUserId?: string }).authUserId = userId;
    next();
  });
  app.use(createFinalizeWizardRoutes(deps));
  return { app, stmts };
}

describe('finalize setup-apply — storage discriminator', () => {
  it('400s on an unknown storage value (no silent fall-through to commit)', async () => {
    const { app } = buildApp('admin1');
    const res = await supertest(app)
      .post('/api/projects/proj1/finalize/setup-apply')
      .send({ ci_yaml_content: VALID_YAML, storage: 'serverr' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/storage must be/i);
  });

  it("stores the config on the server for storage: 'server' (no commit)", async () => {
    const { app, stmts } = buildApp('admin1');
    const res = await supertest(app)
      .post('/api/projects/proj1/finalize/setup-apply')
      .send({ ci_yaml_content: VALID_YAML, storage: 'server' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, storage: 'server', server_scope: 'project' });
    // Persisted to the project scope, not committed anywhere.
    expect(getServerCiConfig(stmts, 'proj1', null)?.yaml_text).toContain('echo hi');
  });

  it("400s on an unknown server_scope for storage: 'server'", async () => {
    const { app } = buildApp('admin1');
    const res = await supertest(app)
      .post('/api/projects/proj1/finalize/setup-apply')
      .send({ ci_yaml_content: VALID_YAML, storage: 'server', server_scope: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/server_scope must be/i);
  });
});
