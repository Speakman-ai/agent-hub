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

describe('GET /api/projects/:projectId/stats/sessions', () => {
  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/stats/sessions').expect(404);
  });

  it('lists work sessions with card, PR, review rounds, and CI rounds', async () => {
    const projectId = await freshProject();
    const agentId = `${projectId}-dev`;
    await request
      .post('/api/agents')
      .send({ id: agentId, projectId, name: 'Dev', engine: 'claude-code' })
      .expect(201);
    const db = getDb();

    const workId = uuidv4();
    const branch = `agent-hub/${agentId}/session-${workId.slice(0, 8)}`;
    db.prepare(
      `INSERT INTO sessions (id, agent_id, name, worktree_branch, updated_at)
       VALUES (?, ?, 'Add history table', ?, datetime('now'))`,
    ).run(workId, agentId, branch);
    // A plain chat session with nothing linked is left out.
    db.prepare(`INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, 'just chatting')`).run(
      uuidv4(),
      agentId,
    );

    const boardId = uuidv4();
    db.prepare(
      'INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)',
    ).run(boardId, projectId, 'Board', 'ST');
    const colId = uuidv4();
    db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, 0)').run(
      colId,
      boardId,
      'To Do',
    );
    const cardId = uuidv4();
    db.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, session_id) VALUES (?, ?, ?, ?, ?)`,
    ).run(cardId, colId, boardId, 'History card', workId);

    const nowMs = Date.now();
    db.prepare(
      `INSERT INTO pull_requests
         (id, project_id, number, title, head_branch, base_branch, head_sha, status,
          author, created_at, updated_at)
       VALUES (?, ?, 7, 'History PR', ?, 'main', 'abc', 'open', 'tester', ?, ?)`,
    ).run(uuidv4(), projectId, branch, nowMs, nowMs);
    db.prepare(
      `INSERT INTO pull_request_reviews (id, project_id, pr_number, reviewer, state, created_at)
       VALUES (?, ?, 7, 'reviewer', 'changes_requested', ?)`,
    ).run(uuidv4(), projectId, nowMs);

    const runId = uuidv4();
    db.prepare(
      `INSERT INTO finalize_runs
         (id, card_id, session_id, project_id, branch, head_sha, idempotency_key, status,
          trigger_source, triggered_by_user_id, author_name, author_email, started_at)
       VALUES (?, ?, ?, ?, ?, 'abc', ?, 'passed', 'manual', 'u', 'n', 'e', ?)`,
    ).run(runId, cardId, workId, projectId, branch, uuidv4(), nowMs);
    const attempt = db.prepare(
      `INSERT INTO finalize_run_job_attempts (run_id, job_id, matrix_key, round, state)
       VALUES (?, ?, '', ?, ?)`,
    );
    attempt.run(runId, 'test', 1, 'failed');
    attempt.run(runId, 'lint', 1, 'passed');
    attempt.run(runId, 'test', 2, 'passed');

    const reviewMsg = db.prepare(
      `INSERT INTO messages (id, session_id, role, content, metadata) VALUES (?, ?, 'system', 'r', ?)`,
    );
    const meta = (round: number) =>
      JSON.stringify({ kind: 'finalize_review_round', runId, round, verdict: 'approved' });
    reviewMsg.run(uuidv4(), workId, meta(1));
    // A re-review of the same round counts once.
    reviewMsg.run(uuidv4(), workId, meta(1));
    reviewMsg.run(uuidv4(), workId, meta(2));

    const res = await request.get(`/api/projects/${projectId}/stats/sessions`).expect(200);
    expect(res.body.sessions).toHaveLength(1);
    const row = res.body.sessions[0];
    expect(row.session_id).toBe(workId);
    expect(row.title).toBe('Add history table');
    expect(row.card).toMatchObject({ id: cardId, card_prefix: 'ST', title: 'History card' });
    expect(row.pr).toMatchObject({ number: 7, title: 'History PR', status: 'open' });
    expect(row.finalize_review_rounds).toBe(2);
    expect(row.pr_reviews).toBe(1);
    expect(row.review_rounds).toBe(3);
    expect(row.ci_rounds).toBe(2);
  });

  it('does not expose a PR number for a fallback link into another project', async () => {
    const projectId = await freshProject();
    const agentId = `${projectId}-dev`;
    await request
      .post('/api/agents')
      .send({ id: agentId, projectId, name: 'Dev', engine: 'claude-code' })
      .expect(201);
    const db = getDb();
    const sessionId = uuidv4();
    db.prepare(`INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, 'cross-project')`).run(
      sessionId,
      agentId,
    );
    // Same number exists locally; it must not be matched to the other project's link.
    const nowMs = Date.now();
    db.prepare(
      `INSERT INTO pull_requests
         (id, project_id, number, title, head_branch, base_branch, head_sha, status,
          author, created_at, updated_at)
       VALUES (?, ?, 7, 'Local PR', 'unrelated', 'main', 'abc', 'open', 'tester', ?, ?)`,
    ).run(uuidv4(), projectId, nowMs, nowMs);
    db.prepare(
      `INSERT INTO finalize_runs
         (id, card_id, session_id, project_id, branch, head_sha, idempotency_key, status,
          trigger_source, triggered_by_user_id, author_name, author_email, started_at, pr_url)
       VALUES (?, 'c', ?, ?, 'b', 'abc', ?, 'passed', 'manual', 'u', 'n', 'e', ?, ?)`,
    ).run(uuidv4(), sessionId, projectId, uuidv4(), nowMs, '/projects/other-project/pulls/7');

    const res = await request.get(`/api/projects/${projectId}/stats/sessions`).expect(200);
    const row = res.body.sessions.find((r: { session_id: string }) => r.session_id === sessionId);
    expect(row.pr).toEqual({
      number: null,
      url: '/projects/other-project/pulls/7',
      title: null,
      status: null,
    });
    expect(row.pr_reviews).toBe(0);
  });
});
