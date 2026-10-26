import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts, initDb } from '../db.js';
import type { Agent, ChatMessage, Project, RouteDeps } from '../types.js';
import { qaRunPreviewOwnerSessionId } from '../qa-run-kickoff.js';
import createQaRoutes from './qa.js';

vi.mock('../effective-model.js', () => ({
  resolveAgentSpawnEngineAndModel: () => ({ engine: 'claude-code', model: 'sonnet' }),
}));

const broadcast = vi.fn();
let acceptSeed = true;
// Stands in for the chat path: no CLI is spawned, the seed is just accepted or dropped.
const handleChat = vi.fn(async (_ws: unknown, msg: ChatMessage) => {
  msg._onUserMessagePersisted?.(acceptSeed && (msg._acceptTurn?.({ busy: false }) ?? true));
});
const handleCancel = vi.fn();
// Previews the dev-server runtime reports as running.
let activePreviews: Array<{ session_id: string; status: string; port: number; url: string }> = [];
const PREVIEW_BASE = 'preview.hub.example.com';
const HOST_SESSION = '0b7e6a52-1c1d-4f3e-9a7b-2f6c3e8d9a10';
const FOREIGN_SESSION = '7f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f';

const projects: Record<string, Project> = {
  proj: {
    id: 'proj',
    name: 'Proj',
    cwd: '/tmp/proj',
    ahw: '/tmp/proj-ahw',
    agents: [
      { id: 'proj-dev', name: 'Dev', role: 'dev' } as Agent,
      { id: 'proj-qa', name: 'Proj QA', role: 'qa' } as Agent,
    ],
  },
  noqa: {
    id: 'noqa',
    name: 'No QA',
    cwd: '/tmp/n',
    ahw: '/tmp/n-ahw',
    agents: [{ id: 'noqa-dev', name: 'Dev', role: 'dev' } as Agent],
  },
};

let app: Express;

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-run-kickoff-')));
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
      handleCancel,
      config: { previewSubdomainBase: PREVIEW_BASE, publicUrl: 'https://hub.example.com' },
      getDevServerRuntime: () => ({
        stopBySessionId: async () => 0,
        listActive: () => activePreviews,
        getActiveBySessionId: (id: string) =>
          activePreviews.some((p) => p.session_id === id) ? { id: `grp-${id}` } : null,
        getPorts: () => [
          { internalPort: 3000, primary: true },
          { internalPort: 8080, primary: false },
        ],
      }),
      findProject: (id: string) => projects[id] ?? null,
    } as unknown as RouteDeps),
  );
});

beforeEach(() => {
  getDb().exec('DELETE FROM qa_plans');
  getDb().exec("DELETE FROM sessions WHERE agent_id = 'proj-qa'");
  acceptSeed = true;
  activePreviews = [];
  // The dev session hosting the target preview, and one from another project.
  getDb().exec(`DELETE FROM sessions WHERE id IN ('${HOST_SESSION}', '${FOREIGN_SESSION}')`);
  getDb()
    .prepare('INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, ?), (?, ?, ?)')
    .run(HOST_SESSION, 'proj-dev', 'Feature work', FOREIGN_SESSION, 'noqa-dev', 'Elsewhere');
  broadcast.mockClear();
  handleChat.mockClear();
  handleCancel.mockClear();
});

async function approvedPlan(projectId = 'proj', targetUrl = 'https://staging.example.com') {
  const base = `/api/projects/${projectId}/qa/plans`;
  const plan = (
    await request(app).post(base).send({ title: 'Checkout', targetUrl, goal: 'Buy' }).expect(201)
  ).body.plan as { id: string };
  const caseIds: string[] = [];
  for (const [title, steps] of [
    ['Login', '1. Open /login'],
    ['Pay', '1. Press Pay'],
  ]) {
    const res = await request(app)
      .post(`${base}/${plan.id}/cases`)
      .send({ title, steps, expected: `${title} works` })
      .expect(201);
    caseIds.push(res.body.case.id);
  }
  await request(app).post(`${base}/${plan.id}/approve`).expect(200);
  return { base: `${base}/${plan.id}`, planId: plan.id, caseIds };
}

const seedOf = (call = 0) => (handleChat.mock.calls[call][1] as ChatMessage).content as string;

describe('run kickoff', () => {
  it('starts a QA session seeded with the cases, target, and scope, and marks the run running', async () => {
    const { base, planId, caseIds } = await approvedPlan();
    const res = await request(app).post(`${base}/runs`).send({ scope: 'full' }).expect(201);

    expect(res.body).toMatchObject({
      agentId: 'proj-qa',
      plan: { id: planId, status: 'in_progress' },
      run: { status: 'running', scope: 'full', caseIds, iteration: 1 },
    });
    const { sessionId } = res.body;
    expect(res.body.run.sessionId).toBe(sessionId);
    expect(res.body.run.startedAt).not.toBeNull();

    expect(handleChat).toHaveBeenCalledTimes(1);
    const msg = handleChat.mock.calls[0][1] as ChatMessage;
    expect(msg).toMatchObject({ agentId: 'proj-qa', sessionId });
    const seed = seedOf();
    expect(seed).toContain(res.body.run.id);
    expect(seed).toContain('https://staging.example.com');
    expect(seed).toContain('Scope: **full**');
    for (const id of caseIds) expect(seed).toContain(id);
    expect(seed).toContain('the `browser` ReAct tool');

    const session = getStmts().getSession.get(sessionId) as {
      agent_id: string;
      session_mode: string;
      name: string;
    };
    expect(session).toMatchObject({ agent_id: 'proj-qa', session_mode: 'qa' });
    expect(session.name).toBe('[QA run #1] Checkout');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'qa_update', action: 'run_started', planId }),
    );
  });

  it('attaches the run to the preview of the session hosting a preview-subdomain target', async () => {
    const { base } = await approvedPlan('proj', `https://${HOST_SESSION}.${PREVIEW_BASE}/login`);
    const res = await request(app).post(`${base}/runs`).send({}).expect(201);
    expect(res.body.run.previewSessionId).toBe(HOST_SESSION);
    expect(res.body.sessionId).not.toBe(HOST_SESSION);
    // The chat path resolves the QA session's preview tool to the host session.
    expect(qaRunPreviewOwnerSessionId(getStmts(), res.body.sessionId)).toBe(HOST_SESSION);
    expect(qaRunPreviewOwnerSessionId(getStmts(), HOST_SESSION)).toBeNull();
    const seed = seedOf();
    expect(seed).toContain('the `preview` ReAct tool');
    expect(seed).toContain(`drives session \`${HOST_SESSION}\`'s preview`);
    expect(seed).toContain('`/login`');
    expect(seed).not.toContain('"op":"start"');
  });

  it("refuses a port-prefixed target that names a non-primary port of the host's preview", async () => {
    activePreviews = [
      { session_id: HOST_SESSION, status: 'ready', port: 41000, url: 'http://localhost:41000' },
    ];
    // The host session's preview serves its primary port 3000; 8080 is another endpoint.
    const other = await approvedPlan('proj', `https://8080--${HOST_SESSION}.${PREVIEW_BASE}/login`);
    const res = await request(app).post(`${other.base}/runs`).send({}).expect(409);
    expect(res.body).toMatchObject({ code: 'target_unreachable' });
    expect(res.body.error).toMatch(/primary port 3000/);
    expect(getStmts().listQaRunsByPlan.all(other.planId)).toHaveLength(0);
    expect(handleChat).not.toHaveBeenCalled();

    const primary = await approvedPlan(
      'proj',
      `https://3000--${HOST_SESSION}.${PREVIEW_BASE}/login`,
    );
    const ok = await request(app).post(`${primary.base}/runs`).send({}).expect(201);
    expect(ok.body.run.previewSessionId).toBe(HOST_SESSION);
  });

  it('attaches a loopback target to the running preview on its port', async () => {
    activePreviews = [
      { session_id: HOST_SESSION, status: 'ready', port: 3050, url: 'http://localhost:3050' },
    ];
    const { base } = await approvedPlan('proj', 'http://localhost:3050/#/checkout');
    const res = await request(app).post(`${base}/runs`).send({}).expect(201);
    expect(res.body.run.previewSessionId).toBe(HOST_SESSION);
    // Hash-routed target: the seed sends the agent to the same screen.
    expect(seedOf()).toContain('(the target is `/#/checkout`)');
    expect(seedOf()).toContain('the `preview` ReAct tool, because the target is a loopback host');
  });

  it('refuses a preview target no session in this project serves, without a run', async () => {
    const loopback = await approvedPlan('proj', 'http://localhost:4999');
    const res = await request(app).post(`${loopback.base}/runs`).send({}).expect(409);
    expect(res.body.code).toBe('target_unreachable');
    expect(getStmts().listQaRunsByPlan.all(loopback.planId)).toHaveLength(0);

    // A preview hosted by another project's session is not reachable either.
    activePreviews = [
      { session_id: FOREIGN_SESSION, status: 'ready', port: 4999, url: 'http://localhost:4999' },
    ];
    await request(app).post(`${loopback.base}/runs`).send({}).expect(409);

    // A private host on the same port as an unrelated local preview is a different app.
    activePreviews = [
      { session_id: HOST_SESSION, status: 'ready', port: 3050, url: 'http://localhost:3050' },
    ];
    const lan = await approvedPlan('proj', 'http://192.168.1.10:3050/');
    const lanRes = await request(app).post(`${lan.base}/runs`).send({}).expect(409);
    expect(lanRes.body.code).toBe('target_unreachable');
    expect(getStmts().listQaRunsByPlan.all(lan.planId)).toHaveLength(0);

    const foreign = await approvedPlan('proj', `https://${FOREIGN_SESSION}.${PREVIEW_BASE}/`);
    await request(app).post(`${foreign.base}/runs`).send({}).expect(409);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('seeds a failed_only rerun with only the cases that did not pass', async () => {
    const { base, caseIds } = await approvedPlan();
    const first = (await request(app).post(`${base}/runs`).send({}).expect(201)).body.run.id;
    await request(app)
      .post(`${base}/runs/${first}/results`)
      .send({ caseId: caseIds[0], verdict: 'pass' })
      .expect(200);
    const last = await request(app)
      .post(`${base}/runs/${first}/results`)
      .send({ caseId: caseIds[1], verdict: 'fail' })
      .expect(200);
    expect(last.body.run.status).toBe('failed');

    const rerun = await request(app)
      .post(`${base}/runs`)
      .send({ scope: 'failed_only' })
      .expect(201);
    expect(rerun.body.run).toMatchObject({ scope: 'failed_only', caseIds: [caseIds[1]] });
    expect(seedOf(1)).toContain(caseIds[1]);
    expect(seedOf(1)).not.toContain(caseIds[0]);

    const outOfScope = await request(app)
      .post(`${base}/runs/${rerun.body.run.id}/results`)
      .send({ caseId: caseIds[0], verdict: 'pass' })
      .expect(409);
    expect(outOfScope.body.code).toBe('out_of_scope');
    const fixed = await request(app)
      .post(`${base}/runs/${rerun.body.run.id}/results`)
      .send({ caseId: caseIds[1], verdict: 'pass' })
      .expect(200);
    expect(fixed.body.run.status).toBe('passed');
    await request(app).post(`${base}/sign-off`).expect(200);
  });

  it('refuses a failed_only run with nothing to rerun, without spawning', async () => {
    const { base, caseIds } = await approvedPlan();
    const run = (await request(app).post(`${base}/runs`).send({}).expect(201)).body.run.id;
    for (const caseId of caseIds) {
      await request(app).post(`${base}/runs/${run}/results`).send({ caseId, verdict: 'pass' });
    }
    handleChat.mockClear();
    const res = await request(app).post(`${base}/runs`).send({ scope: 'failed_only' }).expect(409);
    expect(res.body.code).toBe('nothing_to_rerun');
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('refuses when the project has no QA agent, without creating a run', async () => {
    const { base, planId } = await approvedPlan('noqa');
    const res = await request(app).post(`${base}/runs`).send({}).expect(409);
    expect(res.body.code).toBe('no_qa_agent');
    expect(getStmts().listQaRunsByPlan.all(planId)).toHaveLength(0);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('cancels the run and drops the session when the seed is not accepted', async () => {
    const { base, planId } = await approvedPlan();
    acceptSeed = false;
    const res = await request(app).post(`${base}/runs`).send({}).expect(502);
    const run = getStmts().getQaRun.get(res.body.runId)!;
    expect(run).toMatchObject({ status: 'cancelled', session_id: null });
    const sessions = getDb()
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE agent_id = 'proj-qa'")
      .get() as { n: number };
    expect(sessions.n).toBe(0);

    // The plan is not stuck behind a phantom active run.
    acceptSeed = true;
    const retry = await request(app).post(`${base}/runs`).send({}).expect(201);
    expect(retry.body.run.iteration).toBe(2);
    expect(getStmts().getQaPlan.get(planId)!.status).toBe('in_progress');
  });

  it('cancelling a run stops its session', async () => {
    const { base } = await approvedPlan();
    const started = (await request(app).post(`${base}/runs`).send({}).expect(201)).body;
    const res = await request(app).post(`${base}/runs/${started.run.id}/cancel`).expect(200);
    expect(res.body.run.status).toBe('cancelled');
    expect(handleCancel).toHaveBeenCalledWith(started.sessionId);
  });
});
