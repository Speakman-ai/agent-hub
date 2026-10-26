import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../db.js';
import type { Project, RouteDeps } from '../types.js';
import createQaRoutes from './qa.js';

const broadcast = vi.fn();
const projects: Record<string, Project> = {
  proj: { id: 'proj', name: 'Proj', cwd: '/tmp/proj', ahw: '/tmp/proj-ahw', agents: [] },
  other: { id: 'other', name: 'Other', cwd: '/tmp/other', ahw: '/tmp/other-ahw', agents: [] },
};

let app: Express;

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-routes-')));
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as Record<string, unknown>).authUserId = 'user-1';
    next();
  });
  app.use(
    createQaRoutes({
      broadcast,
      findProject: (id: string) => projects[id] ?? null,
    } as unknown as RouteDeps),
  );
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM qa_plans');
  db.exec("DELETE FROM kanban_epics WHERE id IN ('epic-1', 'epic-x')");
  db.exec("DELETE FROM kanban_boards WHERE id IN ('board-proj', 'board-other')");
  db.exec(
    `INSERT INTO kanban_boards (id, project_id, name) VALUES
       ('board-proj', 'proj', 'Board'), ('board-other', 'other', 'Board')`,
  );
  db.exec(
    `INSERT INTO kanban_epics (id, board_id, name) VALUES
       ('epic-1', 'board-proj', 'Epic'), ('epic-x', 'board-other', 'Other epic')`,
  );
  broadcast.mockClear();
});

const base = '/api/projects/proj/qa/plans';

async function createPlan(extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(base)
    .send({ title: 'Checkout', targetUrl: 'https://example.com', ...extra })
    .expect(201);
  return res.body.plan as { id: string; status: string; approved: boolean };
}

async function addCase(planId: string, title: string) {
  const res = await request(app).post(`${base}/${planId}/cases`).send({ title }).expect(201);
  return res.body.case as { id: string; version: number };
}

/** A plan with two approved cases. */
async function approvedPlan() {
  const plan = await createPlan();
  const a = await addCase(plan.id, 'Login');
  const b = await addCase(plan.id, 'Pay');
  await request(app).post(`${base}/${plan.id}/approve`).expect(200);
  return { planId: plan.id, caseIds: [a.id, b.id] };
}

function lastBroadcast() {
  return broadcast.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe('plans', () => {
  it('creates a draft plan and broadcasts qa_update', async () => {
    const plan = await createPlan({ epicId: 'epic-1', goal: 'Buy a thing' });
    expect(plan).toMatchObject({
      projectId: 'proj',
      title: 'Checkout',
      goal: 'Buy a thing',
      epicId: 'epic-1',
      status: 'new',
      approved: false,
      autoRerun: true,
      maxIterations: 5,
      createdBy: 'user-1',
    });
    expect(lastBroadcast()).toMatchObject({
      type: 'qa_update',
      projectId: 'proj',
      planId: plan.id,
    });
  });

  it('rejects an invalid body with 400', async () => {
    await request(app).post(base).send({ title: '', targetUrl: 'nope' }).expect(400);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('404s an unknown project and an epic from another project', async () => {
    await request(app)
      .post('/api/projects/missing/qa/plans')
      .send({ title: 'x', targetUrl: 'https://example.com' })
      .expect(404);
    await request(app)
      .post(base)
      .send({ title: 'x', targetUrl: 'https://example.com', epicId: 'epic-x' })
      .expect(404);
  });

  it('lists with status filter and whole-project counts', async () => {
    const { planId } = await approvedPlan();
    await createPlan();
    await request(app).post(`${base}/${planId}/runs`).send({}).expect(201);

    const all = await request(app).get(base).expect(200);
    expect(all.body.plans).toHaveLength(2);
    expect(all.body.counts).toEqual({ new: 1, in_progress: 1, done: 0 });

    const filtered = await request(app).get(`${base}?status=in_progress`).expect(200);
    expect(filtered.body.plans.map((p: { id: string }) => p.id)).toEqual([planId]);
    expect(filtered.body.counts.new).toBe(1);

    await request(app).get(`${base}?status=bogus`).expect(400);
  });

  it('summarizes the latest run verdicts, case count, and linked epic per plan', async () => {
    const { planId, caseIds } = await approvedPlan();
    await request(app).patch(`${base}/${planId}`).send({ epicId: 'epic-1' }).expect(200);
    const detail = await request(app).get(`${base}/${planId}`).expect(200);
    expect(detail.body.links).toEqual({ epic: { id: 'epic-1', name: 'Epic' }, card: null });
    const draft = await createPlan();

    const first = await request(app).post(`${base}/${planId}/runs`).send({}).expect(201);
    const firstRun = first.body.run.id;
    await request(app).post(`${base}/${planId}/runs/${firstRun}/begin`).expect(200);
    for (const caseId of caseIds) {
      await request(app)
        .post(`${base}/${planId}/runs/${firstRun}/results`)
        .send({ caseId, verdict: 'fail' })
        .expect(200);
    }
    await request(app).post(`${base}/${planId}/runs/${firstRun}/finish`).expect(200);

    const second = await request(app).post(`${base}/${planId}/runs`).send({}).expect(201);
    const secondRun = second.body.run.id;
    await request(app).post(`${base}/${planId}/runs/${secondRun}/begin`).expect(200);
    await request(app)
      .post(`${base}/${planId}/runs/${secondRun}/results`)
      .send({ caseId: caseIds[0], verdict: 'pass' })
      .expect(200);
    await request(app)
      .post(`${base}/${planId}/runs/${secondRun}/results`)
      .send({ caseId: caseIds[1], verdict: 'needs_change' })
      .expect(200);

    const res = await request(app).get(base).expect(200);
    const byId = new Map(
      res.body.plans.map((p: { id: string; summary: unknown }) => [p.id, p.summary]),
    );
    expect(byId.get(planId)).toEqual({
      caseCount: 2,
      latestRun: {
        id: secondRun,
        iteration: 2,
        status: 'running',
        scope: 'full',
        finishedAt: null,
        verdicts: { pass: 1, fail: 0, needs_change: 1, blocked: 0 },
      },
      epic: { id: 'epic-1', name: 'Epic' },
      card: null,
    });
    expect(byId.get(draft.id)).toEqual({ caseCount: 0, latestRun: null, epic: null, card: null });
  });

  it('does not leak a plan through another project', async () => {
    const plan = await createPlan();
    await request(app).get(`/api/projects/other/qa/plans/${plan.id}`).expect(404);
    await request(app).delete(`/api/projects/other/qa/plans/${plan.id}`).expect(404);
  });

  it('returns detail with cases, latest verdicts, runs, and the sign-off blocker', async () => {
    const { planId, caseIds } = await approvedPlan();
    const started = await request(app).post(`${base}/${planId}/runs`).send({}).expect(201);
    const runId = started.body.run.id;
    await request(app).post(`${base}/${planId}/runs/${runId}/begin`).expect(200);
    await request(app)
      .post(`${base}/${planId}/runs/${runId}/results`)
      .send({ caseId: caseIds[0], verdict: 'fail', screenshotArtifactIds: ['art-1'] })
      .expect(200);

    const res = await request(app).get(`${base}/${planId}`).expect(200);
    expect(res.body.plan.status).toBe('in_progress');
    expect(res.body.cases.map((c: { id: string }) => c.id)).toEqual(caseIds);
    expect(res.body.cases[0].latestVerdict).toMatchObject({
      verdict: 'fail',
      current: true,
      runId,
      iteration: 1,
    });
    expect(res.body.cases[1].latestVerdict).toBeNull();
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].sessionAgentId).toBeNull();
    expect(res.body.links).toEqual({ epic: null, card: null });
    expect(res.body.signOffBlocker).toMatch(/running/);

    const db = getDb();
    db.prepare(
      `INSERT OR REPLACE INTO sessions (id, agent_id, name) VALUES ('qa-sess', 'qa-agent', 'QA')`,
    ).run();
    db.prepare('UPDATE qa_runs SET session_id = ? WHERE id = ?').run('qa-sess', runId);
    const withSession = await request(app).get(`${base}/${planId}`).expect(200);
    expect(withSession.body.runs[0]).toMatchObject({
      sessionId: 'qa-sess',
      sessionAgentId: 'qa-agent',
    });
  });

  it('updates fields; changing the target revokes approval', async () => {
    const { planId } = await approvedPlan();
    const label = await request(app)
      .patch(`${base}/${planId}`)
      .send({ title: 'Renamed', autoRerun: false })
      .expect(200);
    expect(label.body.plan).toMatchObject({ title: 'Renamed', autoRerun: false, approved: true });

    const target = await request(app)
      .patch(`${base}/${planId}`)
      .send({ targetUrl: 'https://staging.example.com' })
      .expect(200);
    expect(target.body.plan).toMatchObject({
      targetUrl: 'https://staging.example.com',
      approved: false,
    });
  });

  it('refuses to delete a plan with an active run, then deletes after cancel', async () => {
    const { planId } = await approvedPlan();
    const run = (await request(app).post(`${base}/${planId}/runs`).send({}).expect(201)).body.run;
    const refused = await request(app).delete(`${base}/${planId}`).expect(409);
    expect(refused.body.code).toBe('run_active');
    await request(app).post(`${base}/${planId}/runs/${run.id}/cancel`).expect(200);
    await request(app).delete(`${base}/${planId}`).expect(200);
    await request(app).get(`${base}/${planId}`).expect(404);
  });
});

describe('cases', () => {
  it('edit bumps the version and revokes approval; delete revokes too', async () => {
    const { planId, caseIds } = await approvedPlan();
    const edited = await request(app)
      .patch(`${base}/${planId}/cases/${caseIds[0]}`)
      .send({ expected: 'Lands on dashboard' })
      .expect(200);
    expect(edited.body.case).toMatchObject({ version: 2, expected: 'Lands on dashboard' });
    expect(edited.body.plan.approved).toBe(false);

    await request(app).post(`${base}/${planId}/approve`).expect(200);
    const removed = await request(app).delete(`${base}/${planId}/cases/${caseIds[1]}`).expect(200);
    expect(removed.body.plan.approved).toBe(false);
  });

  it('rejects an empty edit with 400 and an unknown case with 404', async () => {
    const { planId, caseIds } = await approvedPlan();
    await request(app).patch(`${base}/${planId}/cases/${caseIds[0]}`).send({}).expect(400);
    await request(app).patch(`${base}/${planId}/cases/nope`).send({ title: 'x' }).expect(404);
    await request(app).delete(`${base}/${planId}/cases/nope`).expect(404);
  });

  it('reorders without revoking approval and validates the id list', async () => {
    const { planId, caseIds } = await approvedPlan();
    const res = await request(app)
      .post(`${base}/${planId}/cases/reorder`)
      .send({ orderedIds: [caseIds[1], caseIds[0]] })
      .expect(200);
    expect(res.body.cases.map((c: { id: string }) => c.id)).toEqual([caseIds[1], caseIds[0]]);
    const detail = await request(app).get(`${base}/${planId}`).expect(200);
    expect(detail.body.plan.approved).toBe(true);

    const bad = await request(app)
      .post(`${base}/${planId}/cases/reorder`)
      .send({ orderedIds: [caseIds[0]] })
      .expect(400);
    expect(bad.body.code).toBe('invalid_order');
  });

  it('freezes the case list while a run is active', async () => {
    const { planId, caseIds } = await approvedPlan();
    await request(app).post(`${base}/${planId}/runs`).send({}).expect(201);
    expect(
      (await request(app).post(`${base}/${planId}/cases`).send({ title: 'x' }).expect(409)).body
        .code,
    ).toBe('run_active');
    await request(app)
      .patch(`${base}/${planId}/cases/${caseIds[0]}`)
      .send({ title: 'x' })
      .expect(409);
    await request(app)
      .post(`${base}/${planId}/cases/reorder`)
      .send({ orderedIds: [caseIds[1], caseIds[0]] })
      .expect(409);
  });
});

describe('approval and runs', () => {
  it('refuses to approve a plan with no cases', async () => {
    const plan = await createPlan();
    const res = await request(app).post(`${base}/${plan.id}/approve`).expect(409);
    expect(res.body.code).toBe('no_cases');
  });

  it('refuses to start a run on an unapproved plan', async () => {
    const plan = await createPlan();
    await addCase(plan.id, 'Login');
    const res = await request(app).post(`${base}/${plan.id}/runs`).send({}).expect(409);
    expect(res.body.code).toBe('not_approved');
  });

  it('refuses a second run while one is active', async () => {
    const { planId } = await approvedPlan();
    await request(app).post(`${base}/${planId}/runs`).send({}).expect(201);
    const res = await request(app).post(`${base}/${planId}/runs`).send({}).expect(409);
    expect(res.body.code).toBe('run_active');
  });

  it('runs a full pass, signs off, and broadcasts each mutation', async () => {
    const { planId, caseIds } = await approvedPlan();
    const started = await request(app)
      .post(`${base}/${planId}/runs`)
      .send({ scope: 'full' })
      .expect(201);
    expect(started.body.plan.status).toBe('in_progress');
    const runId = started.body.run.id;

    await request(app).post(`${base}/${planId}/runs/${runId}/begin`).expect(200);
    broadcast.mockClear();
    for (const caseId of caseIds) {
      const r = await request(app)
        .post(`${base}/${planId}/runs/${runId}/results`)
        .send({ caseId, verdict: 'pass', actual: 'ok' })
        .expect(200);
      expect(r.body.result).toMatchObject({ caseId, verdict: 'pass', screenshotArtifactIds: [] });
    }
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(lastBroadcast()).toMatchObject({ type: 'qa_update', planId, runId });

    const finished = await request(app).post(`${base}/${planId}/runs/${runId}/finish`).expect(200);
    expect(finished.body.run.status).toBe('passed');

    const run = await request(app).get(`${base}/${planId}/runs/${runId}`).expect(200);
    expect(run.body.results).toHaveLength(2);

    const signed = await request(app).post(`${base}/${planId}/sign-off`).expect(200);
    expect(signed.body.plan).toMatchObject({ status: 'done', signedOffBy: 'user-1' });
  });

  it('refuses sign-off when the latest run did not pass', async () => {
    const { planId, caseIds } = await approvedPlan();
    const runId = (await request(app).post(`${base}/${planId}/runs`).send({}).expect(201)).body.run
      .id;
    await request(app).post(`${base}/${planId}/runs/${runId}/begin`).expect(200);
    await request(app)
      .post(`${base}/${planId}/runs/${runId}/results`)
      .send({ caseId: caseIds[0], verdict: 'fail' })
      .expect(200);
    await request(app).post(`${base}/${planId}/runs/${runId}/finish`).expect(200);
    const res = await request(app).post(`${base}/${planId}/sign-off`).expect(409);
    expect(res.body.code).toBe('not_all_pass');
  });

  it('refuses results on a queued run and on a cancelled run', async () => {
    const { planId, caseIds } = await approvedPlan();
    const runId = (await request(app).post(`${base}/${planId}/runs`).send({}).expect(201)).body.run
      .id;
    const queued = await request(app)
      .post(`${base}/${planId}/runs/${runId}/results`)
      .send({ caseId: caseIds[0], verdict: 'pass' })
      .expect(409);
    expect(queued.body.code).toBe('run_not_running');

    const cancelled = await request(app).post(`${base}/${planId}/runs/${runId}/cancel`).expect(200);
    expect(cancelled.body.run.status).toBe('cancelled');
    await request(app).post(`${base}/${planId}/runs/${runId}/cancel`).expect(409);
    await request(app)
      .post(`${base}/${planId}/runs/${runId}/results`)
      .send({ caseId: caseIds[0], verdict: 'pass' })
      .expect(409);
  });

  it('404s an unknown run, a case from another plan, and a foreign finding card', async () => {
    const { planId } = await approvedPlan();
    const other = await approvedPlan();
    await request(app).post(`${base}/${planId}/runs/nope/cancel`).expect(404);
    const runId = (await request(app).post(`${base}/${planId}/runs`).send({}).expect(201)).body.run
      .id;
    await request(app).post(`${base}/${planId}/runs/${runId}/begin`).expect(200);
    await request(app)
      .post(`${base}/${planId}/runs/${runId}/results`)
      .send({ caseId: other.caseIds[0], verdict: 'pass' })
      .expect(404);
    await request(app)
      .post(`${base}/${planId}/runs/${runId}/results`)
      .send({ caseId: 'x', verdict: 'fail', findingCardId: 'card-missing' })
      .expect(404);
    // A run id from another plan is not reachable through this plan.
    await request(app).get(`${base}/${other.planId}/runs/${runId}`).expect(404);
  });

  it('rejects an unknown verdict with 400', async () => {
    const { planId, caseIds } = await approvedPlan();
    const runId = (await request(app).post(`${base}/${planId}/runs`).send({}).expect(201)).body.run
      .id;
    await request(app)
      .post(`${base}/${planId}/runs/${runId}/results`)
      .send({ caseId: caseIds[0], verdict: 'maybe' })
      .expect(400);
  });
});
