/**
 * PR creation rows feed the merged GET /api/projects/:id/reviews timeline and
 * the org dashboard recent-activity union.
 */
import type supertest from 'supertest';
import { randomUUID } from 'crypto';
import { getRequest, createProject } from './helpers.js';
import { webhookHandlerDeps } from '../index.js';
import { getDb } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PR creation activity', () => {
  it('includes pr_created events in GET /projects/:id/reviews merged with reviews', async () => {
    const project = await createProject({ name: 'PR Activity Test Project' });
    const projectId = project.id as string;

    const prId = randomUUID();
    const reviewId = randomUUID();
    const now = new Date().toISOString();
    const { stmts } = webhookHandlerDeps;

    stmts.createPrCreationLog.run(
      prId,
      projectId,
      null,
      'sess-pr-act',
      'https://github.com/example/repo/pull/42',
      42,
      'Add activity coverage',
      'hub-backend',
    );
    stmts.createReviewLog.run(
      reviewId,
      projectId,
      null,
      'https://github.com/example/repo/pull/42',
      'reviewer-bot',
      'hub-backend',
      'sess-pr-act',
      'approved',
      'LGTM',
      now,
      now,
    );

    const res = await request.get(`/api/projects/${projectId}/reviews?limit=20`).expect(200);
    const rows = res.body as Array<{ event_kind?: string; outcome?: string; pr_title?: string }>;
    const prEvt = rows.find((r) => r.event_kind === 'pr_created');
    const revEvt = rows.find((r) => r.event_kind === 'review');

    expect(prEvt).toBeDefined();
    expect(prEvt?.pr_title).toBe('Add activity coverage');
    expect(prEvt?.outcome).toBeNull();
    expect(revEvt?.event_kind).toBe('review');
    expect(revEvt?.outcome).toBe('approved');
    expect(rows.some((r) => r.event_kind === 'pr_created')).toBe(true);
  });

  it('sorts merged GET /projects/:id/reviews newest-first when pr_created and review timestamps differ', async () => {
    const project = await createProject({ name: 'PR Reviews Sort Project' });
    const projectId = project.id as string;
    const { stmts } = webhookHandlerDeps;
    const db = getDb();

    const reviewOld = '2000-06-15T12:00:00.000Z';
    const reviewId = randomUUID();
    stmts.createReviewLog.run(
      reviewId,
      projectId,
      null,
      'https://github.com/example/sort-repo/pull/900',
      'reviewer-bot',
      'hub-backend',
      'sess-sort',
      'approved',
      'ok',
      reviewOld,
      reviewOld,
    );

    const prId = randomUUID();
    stmts.createPrCreationLog.run(
      prId,
      projectId,
      null,
      'sess-sort',
      'https://github.com/example/sort-repo/pull/901',
      901,
      'Newer PR row',
      'hub-backend',
    );
    db.prepare('UPDATE pr_creation_logs SET created_at = ? WHERE id = ?').run(
      '2026-04-21T18:00:00.000Z',
      prId,
    );

    const res = await request.get(`/api/projects/${projectId}/reviews?limit=20`).expect(200);
    const rows = res.body as Array<{ event_kind?: string; completed_at?: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].event_kind).toBe('pr_created');
    expect(rows[1].event_kind).toBe('review');
  });

  it('surfaces pr_created in GET /api/orgs/default/dashboard recentActivity', async () => {
    const project = await createProject({ name: 'Dashboard PR Activity' });
    const projectId = project.id as string;
    const prId = randomUUID();
    const { stmts } = webhookHandlerDeps;

    stmts.createPrCreationLog.run(
      prId,
      projectId,
      'card-1',
      'sess-dash-pr',
      'https://github.com/example/repo/pull/99',
      99,
      'Dashboard wiring',
      'hub-backend',
    );

    const res = await request.get('/api/orgs/default/dashboard').expect(200);
    const feed = res.body.recentActivity as Array<{ type: string; title: string; meta?: unknown }>;
    const hit = feed.find((e) => e.type === 'pr_created' && e.title.includes('PR #99'));
    expect(hit).toBeDefined();
    expect(hit?.title).toContain('Dashboard wiring');
  });

  it('dedupes pr_creation_logs on repeated (project_id, pr_url) inserts', () => {
    const projectId = `dedupe-${randomUUID().slice(0, 8)}`;
    const prUrl = 'https://github.com/example/dedupe/pull/7';
    const { stmts } = webhookHandlerDeps;

    const r1 = stmts.createPrCreationLog.run(
      randomUUID(),
      projectId,
      null,
      's-a',
      prUrl,
      7,
      'First title',
      'agent-a',
    );
    const r2 = stmts.createPrCreationLog.run(
      randomUUID(),
      projectId,
      null,
      's-b',
      prUrl,
      7,
      'Second title',
      'agent-b',
    );

    expect(r1.changes).toBe(1);
    expect(r2.changes).toBe(0);

    const db = getDb();
    const row = db
      .prepare(
        'SELECT author_agent, pr_title FROM pr_creation_logs WHERE project_id = ? AND pr_url = ?',
      )
      .get(projectId, prUrl) as { author_agent: string; pr_title: string };
    expect(row.author_agent).toBe('agent-a');
    expect(row.pr_title).toBe('First title');
  });
});
