/**
 * Integration coverage for GET /api/projects/:projectId/stats — live app via
 * supertest. Seeds a board card + support ticket + merged PR directly through
 * the DB, then asserts the endpoint aggregates and shapes them correctly.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { getDb } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `stats-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

function today(): string {
  // Same UTC day the endpoint's `now` falls in; use a mid-day timestamp.
  return new Date().toISOString().slice(0, 10);
}

describe('GET /api/projects/:projectId/stats', () => {
  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/stats').expect(404);
  });

  it('returns the full metric shape with all-zero series for an empty project', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/stats`).expect(200);
    expect(res.body.granularity).toBe('day');
    expect(Array.isArray(res.body.buckets)).toBe(true);
    expect(res.body.buckets).toHaveLength(30);
    for (const key of [
      'prs_merged',
      'support_tickets_resolved',
      'tickets_made',
      'tickets_completed',
      'epics_completed',
    ]) {
      expect(res.body.series[key]).toHaveLength(30);
      expect(res.body.totals[key]).toBe(0);
    }
    expect(res.body.model_usage).toEqual([]);
    expect(res.body.top_model).toBeNull();
  });

  it('counts a created card, a resolved ticket, and a merged PR in the window', async () => {
    const projectId = await freshProject();
    const db = getDb();
    const day = today();

    // The board is created lazily on first read; hit the board route so a
    // kanban_boards row exists for this project, then seed a card on it.
    const board = db.prepare('SELECT id FROM kanban_boards WHERE project_id = ?').get(projectId) as
      | { id: string }
      | undefined;
    let boardId = board?.id;
    if (!boardId) {
      boardId = uuidv4();
      db.prepare('INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)').run(
        boardId,
        projectId,
        'Board',
      );
    }
    const colId = uuidv4();
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, 0)').run(
      colId,
      boardId,
      'To Do',
    );
    db.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(uuidv4(), colId, boardId, 'card', `${day} 09:00:00`);

    db.prepare(
      `INSERT INTO support_tickets (id, project_id, status, body, resolved_at)
       VALUES (?, ?, 'closed', 'x', ?)`,
    ).run(uuidv4(), projectId, `${day} 09:00:00`);

    const nowMs = Date.now();
    db.prepare(
      `INSERT INTO pull_requests
         (id, project_id, number, title, head_branch, base_branch, head_sha, status,
          author, created_at, updated_at, merged_at)
       VALUES (?, ?, ?, 'pr', 'feature', 'main', 'abc123', 'merged', 'tester', ?, ?, ?)`,
    ).run(uuidv4(), projectId, 1, nowMs, nowMs, nowMs);

    const res = await request.get(`/api/projects/${projectId}/stats?granularity=day`).expect(200);
    expect(res.body.totals.tickets_made).toBe(1);
    expect(res.body.totals.support_tickets_resolved).toBe(1);
    expect(res.body.totals.prs_merged).toBe(1);
    // The events land in the last (current-day) bucket.
    expect(res.body.series.tickets_made[29]).toBe(1);
    expect(res.body.series.support_tickets_resolved[29]).toBe(1);
    expect(res.body.series.prs_merged[29]).toBe(1);
  });

  it('honors the granularity query param', async () => {
    const projectId = await freshProject();
    const res = await request
      .get(`/api/projects/${projectId}/stats?granularity=week&buckets=6`)
      .expect(200);
    expect(res.body.granularity).toBe('week');
    expect(res.body.buckets).toHaveLength(6);
  });
});
