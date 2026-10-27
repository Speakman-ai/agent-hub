import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts, initDb } from '../db.js';
import { buildQaTroubleshootSeed } from '../qa-troubleshoot.js';
import type { Agent, ChatMessage, Project, RouteDeps } from '../types.js';
import createQaRoutes from './qa.js';

vi.mock('../effective-model.js', () => ({
  resolveAgentSpawnEngineAndModel: () => ({ engine: 'claude-code', model: 'sonnet' }),
}));

const broadcast = vi.fn();
let accept = true;
const handleChat = vi.fn(async (_ws: unknown, msg: ChatMessage) => {
  msg._onUserMessagePersisted?.(accept);
});

const projects: Record<string, Project> = {
  proj: {
    id: 'proj',
    name: 'Proj',
    cwd: '/tmp/proj',
    ahw: '/tmp/proj-ahw',
    agents: [
      { id: 'proj-qa', name: 'Proj QA', role: 'qa' } as Agent,
      { id: 'proj-dev', name: 'Dev', role: 'dev' } as Agent,
    ],
  },
  nodev: {
    id: 'nodev',
    name: 'No dev',
    cwd: '/tmp/nodev',
    ahw: '/tmp/nodev-ahw',
    agents: [{ id: 'nodev-qa', name: 'QA', role: 'qa' } as Agent],
  },
};

let app: Express;

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-troubleshoot-')));
  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as Record<string, unknown>).authUserId = 'user-1';
    next();
  });
  app.use(
    createQaRoutes({
      broadcast,
      handleChat,
      config: {},
      findProject: (id: string) => projects[id] ?? null,
    } as unknown as RouteDeps),
  );
});

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM qa_plans');
  db.exec("DELETE FROM sessions WHERE agent_id IN ('proj-dev', 'proj-qa')");
  broadcast.mockClear();
  handleChat.mockClear();
  accept = true;
});

/** A plan with one case and a run that recorded `verdict` for it. */
async function seedResult(verdict: string, projectId = 'proj') {
  const plan = (
    await request(app)
      .post(`/api/projects/${projectId}/qa/plans`)
      .send({ title: 'Checkout', targetUrl: 'https://staging.example.com' })
      .expect(201)
  ).body.plan as { id: string };
  const qaCase = (
    await request(app)
      .post(`/api/projects/${projectId}/qa/plans/${plan.id}/cases`)
      .send({ title: 'Pay with saved card', steps: '1. Open cart', expected: 'Order placed' })
      .expect(201)
  ).body.case as { id: string };
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (id, agent_id, name, engine, model) VALUES ('run-sess', 'proj-qa', 'run', 'claude-code', 'sonnet')
       ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO qa_runs (id, plan_id, iteration, status, session_id, approval_seq)
       VALUES ('run-1', ?, 1, 'failed', 'run-sess', 1)`,
  ).run(plan.id);
  db.prepare(
    `INSERT INTO qa_results (id, run_id, case_id, case_version, verdict, actual, notes)
       VALUES ('res-1', 'run-1', ?, 1, ?, 'Spinner forever', 'Console shows 500')`,
  ).run(qaCase.id, verdict);
  return {
    plan,
    qaCase,
    url: `/api/projects/${projectId}/qa/plans/${plan.id}/runs/run-1/results/${qaCase.id}/troubleshoot`,
  };
}

describe('POST /qa/plans/:planId/runs/:runId/results/:caseId/troubleshoot', () => {
  it.each(['fail', 'needs_change', 'blocked'])(
    'opens a dev-agent session seeded with the %s result',
    async (verdict) => {
      const { plan, qaCase, url } = await seedResult(verdict);
      const res = await request(app).post(url).expect(201);
      expect(res.body.agentId).toBe('proj-dev');

      const session = getStmts().getSession.get(res.body.sessionId) as {
        agent_id: string;
        use_worktree: number;
        name: string;
      };
      expect(session).toMatchObject({
        agent_id: 'proj-dev',
        use_worktree: 1,
        name: '[QA troubleshoot] Pay with saved card',
      });

      const msg = handleChat.mock.calls[0]![1];
      expect(msg).toMatchObject({ agentId: 'proj-dev', sessionId: res.body.sessionId });
      expect(msg.content).toContain(plan.id);
      expect(msg.content).toContain(qaCase.id);
      expect(msg.content).toContain('Spinner forever');
      expect(msg.content).toContain('Console shows 500');
      expect(msg.content).toContain('Order placed');
      expect(msg.content).toContain('sessions.sh messages run-sess');
      expect(broadcast.mock.calls.map((c) => c[0].type)).toContain('session_created');
    },
  );

  it('refuses a passing result', async () => {
    const { url } = await seedResult('pass');
    const res = await request(app).post(url).expect(409);
    expect(res.body.code).toBe('not_troubleshootable');
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('refuses when the project has no dev agent', async () => {
    const { url } = await seedResult('fail', 'nodev');
    const res = await request(app).post(url).expect(409);
    expect(res.body.code).toBe('no_dev_agent');
  });

  it('404s for a case with no result in the run', async () => {
    const { plan } = await seedResult('fail');
    const other = (
      await request(app)
        .post(`/api/projects/proj/qa/plans/${plan.id}/cases`)
        .send({ title: 'Untested' })
        .expect(201)
    ).body.case as { id: string };
    await request(app)
      .post(`/api/projects/proj/qa/plans/${plan.id}/runs/run-1/results/${other.id}/troubleshoot`)
      .expect(404);
  });

  it('drops the session when the seed is not accepted', async () => {
    const { url } = await seedResult('blocked');
    accept = false;
    await request(app).post(url).expect(502);
    const live = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE agent_id = 'proj-dev' AND deleted_at IS NULL",
      )
      .get() as { n: number };
    expect(live.n).toBe(0);
  });
});

describe('buildQaTroubleshootSeed', () => {
  const base = {
    plan: { id: 'p1', project_id: 'proj', title: 'Checkout', target_url: 'https://x.test' },
    run: { id: 'r1', iteration: 2, session_id: 's1' },
    qaCase: { id: 'c1', title: 'Pay', steps: '', expected: '', version: 2 },
    result: {
      verdict: 'blocked' as const,
      actual: '',
      notes: '',
      screenshot_artifact_ids: JSON.stringify(['a1']),
      case_version: 1,
    },
    screenshots: new Map([['a1', { id: 'a1', filename: 'login.png', contentType: 'image/png' }]]),
  };

  it('frames a blocked case around why it could not be tested', () => {
    const seed = buildQaTroubleshootSeed(base);
    expect(seed).toContain('could not be tested');
    expect(seed).toContain('login.png (artifact `a1`)');
    expect(seed).toContain('recorded against case v1; the case is now v2');
  });

  it('frames a failure around reproducing it and links the finding card', () => {
    const seed = buildQaTroubleshootSeed({
      ...base,
      result: { ...base.result, verdict: 'fail', screenshot_artifact_ids: '[]', case_version: 2 },
      findingCard: { id: 'card-9', title: 'QA: Pay' },
    });
    expect(seed).toContain('Reproduce the failure');
    expect(seed).toContain('QA: Pay (`card-9`)');
    expect(seed).toContain('_No screenshots attached._');
    expect(seed).not.toContain('recorded against');
  });
});
