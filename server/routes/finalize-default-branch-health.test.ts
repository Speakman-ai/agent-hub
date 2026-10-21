import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Project } from '../types.js';
import createDefaultBranchHealthRoutes from './finalize-default-branch-health.js';

function schema(db: Database.Database) {
  db.exec(`
    CREATE TABLE default_branch_ci_state (
      project_id TEXT PRIMARY KEY, branch TEXT NOT NULL, last_sha TEXT NOT NULL,
      range_from_sha TEXT, last_status TEXT NOT NULL, last_run_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE default_branch_breakages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch TEXT NOT NULL,
      first_failing_sha TEXT NOT NULL, last_failing_sha TEXT NOT NULL, range_from_sha TEXT,
      status TEXT NOT NULL, card_id TEXT, opened_run_id TEXT, last_run_id TEXT, fixed_sha TEXT,
      fixed_run_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE default_branch_failures (
      project_id TEXT NOT NULL, job_id TEXT NOT NULL, matrix_key TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL, first_failing_sha TEXT NOT NULL, last_failing_sha TEXT NOT NULL,
      last_run_id TEXT, breakage_id TEXT, recorded_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, job_id, matrix_key)
    );
  `);
}

function app(seed: (db: Database.Database) => void = () => {}) {
  const db = new Database(':memory:');
  schema(db);
  seed(db);
  const project = { id: 'p1', cwd: '/repo' } as Project;
  const a = express();
  a.use(
    createDefaultBranchHealthRoutes(
      { findProject: (id: string) => (id === 'p1' ? project : undefined) } as never,
      { db: () => db },
    ),
  );
  return a;
}

const URL = '/api/projects/p1/finalize/default-branch-health';

describe('GET /api/projects/:projectId/finalize/default-branch-health', () => {
  it('is unknown before CI has reported on the default branch', async () => {
    const res = await request(app()).get(URL);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: 'unknown',
      branch: null,
      breakage: null,
      failures: [],
    });
  });

  it('is green when the last report had nothing failing', async () => {
    const res = await request(
      app((db) =>
        db
          .prepare(
            `INSERT INTO default_branch_ci_state VALUES ('p1','main','abc',NULL,'succeeded','r1',5)`,
          )
          .run(),
      ),
    ).get(URL);
    expect(res.body).toMatchObject({ state: 'green', branch: 'main', last_sha: 'abc' });
  });

  it('reports failing instances and the open breakage card when red', async () => {
    const res = await request(
      app((db) => {
        db.prepare(
          `INSERT INTO default_branch_ci_state VALUES ('p1','main','def',NULL,'failed','r2',9)`,
        ).run();
        db.prepare(
          `INSERT INTO default_branch_breakages VALUES
            ('old','p1','main','aaa','aaa',NULL,'fixed','card-old',NULL,NULL,'bbb',NULL,1,1),
            ('b1','p1','main','ccc','def',NULL,'open','card-1','r1','r2',NULL,NULL,7,9)`,
        ).run();
        db.prepare(
          `INSERT INTO default_branch_failures VALUES
            ('p1','server','shard=2','main','ccc','def','r2','b1',9),
            ('p2','other','','main','x','x',NULL,NULL,9)`,
        ).run();
      }),
    ).get(URL);
    expect(res.body).toEqual({
      project_id: 'p1',
      state: 'red',
      branch: 'main',
      last_sha: 'def',
      last_status: 'failed',
      updated_at: 9,
      breakage: {
        id: 'b1',
        card_id: 'card-1',
        first_failing_sha: 'ccc',
        last_failing_sha: 'def',
        created_at: 7,
      },
      failures: [
        {
          job_id: 'server',
          matrix_key: 'shard=2',
          first_failing_sha: 'ccc',
          last_failing_sha: 'def',
          last_run_id: 'r2',
        },
      ],
    });
  });

  it('404s for an unknown project', async () => {
    const res = await request(app()).get('/api/projects/nope/finalize/default-branch-health');
    expect(res.status).toBe(404);
  });
});
