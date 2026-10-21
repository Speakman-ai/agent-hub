import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Project } from '../types.js';
import createFinalizeTestInventoryRoutes from './finalize-test-inventory.js';
import { ensureTestInventorySchema, writeTestInventory } from '../finalize/test-inventory.js';

function app(opts: { ancestor: boolean | null; seed?: boolean; cwd?: string }) {
  const db = new Database(':memory:');
  ensureTestInventorySchema(db);
  if (opts.seed !== false) {
    writeTestInventory(db, {
      projectId: 'p1',
      branch: 'main',
      sha: 'abc1234',
      runId: 'r1',
      reports: [
        {
          jobId: 'unit',
          matrixKey: 'shard=1',
          testFiles: ['src/a.test.ts'],
          status: 'reported' as const,
        },
      ],
      now: 42,
    });
  }
  const project = { id: 'p1', cwd: opts.cwd ?? '/repo', gitHost: 'github' } as Project;
  const a = express();
  a.use(
    createFinalizeTestInventoryRoutes(
      { findProject: (id: string) => (id === 'p1' ? project : undefined) } as never,
      { db: () => db, dataDir: '/nonexistent-data-dir', isAncestor: async () => opts.ancestor },
    ),
  );
  return a;
}

const URL = '/api/projects/p1/finalize/test-inventory';

describe('GET /api/projects/:projectId/finalize/test-inventory', () => {
  it('returns the entries when the inventory sha is an ancestor of the base', async () => {
    const res = await request(app({ ancestor: true })).get(`${URL}?baseSha=def5678`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      project_id: 'p1',
      base_sha: 'def5678',
      status: 'ok',
      sha: 'abc1234',
      branch: 'main',
      recorded_at: 42,
      entries: [{ job_id: 'unit', matrix_key: 'shard=1', test_file: 'src/a.test.ts' }],
    });
  });

  it('reports stale when the inventory sha is not an ancestor', async () => {
    const res = await request(app({ ancestor: false })).get(`${URL}?baseSha=def5678`);
    expect(res.body).toMatchObject({ status: 'stale', sha: 'abc1234' });
    expect(res.body.entries).toBeUndefined();
  });

  it('reports stale when there is no local history to check against', async () => {
    const res = await request(app({ ancestor: true, cwd: '' })).get(`${URL}?baseSha=def5678`);
    expect(res.body.status).toBe('stale');
  });

  it('reports missing before any full default-branch run', async () => {
    const res = await request(app({ ancestor: true, seed: false })).get(`${URL}?baseSha=def5678`);
    expect(res.body).toEqual({ project_id: 'p1', base_sha: 'def5678', status: 'missing' });
  });

  it('rejects a missing or malformed baseSha and an unknown project', async () => {
    const a = app({ ancestor: true });
    expect((await request(a).get(URL)).status).toBe(400);
    expect((await request(a).get(`${URL}?baseSha=HEAD~1`)).status).toBe(400);
    expect(
      (await request(a).get('/api/projects/nope/finalize/test-inventory?baseSha=abc1234')).status,
    ).toBe(404);
  });
});
