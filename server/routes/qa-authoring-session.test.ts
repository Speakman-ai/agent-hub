import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts, initDb } from '../db.js';
import type { Agent, ChatMessage, Project, RouteDeps } from '../types.js';
import createQaRoutes from './qa.js';

vi.mock('../effective-model.js', () => ({
  resolveAgentSpawnEngineAndModel: () => ({ engine: 'claude-code', model: 'sonnet' }),
}));

const broadcast = vi.fn();
const handleChat = vi.fn(async (_ws: unknown, msg: ChatMessage) => {
  msg._onUserMessagePersisted?.(true);
});

const qaAgent = { id: 'proj-qa', name: 'Proj QA', role: 'qa' } as Agent;
const projects: Record<string, Project> = {
  proj: {
    id: 'proj',
    name: 'Proj',
    cwd: '/tmp/proj',
    ahw: '/tmp/proj-ahw',
    agents: [{ id: 'proj-dev', name: 'Dev', role: 'dev' } as Agent, qaAgent],
  },
  noqa: {
    id: 'noqa',
    name: 'No QA',
    cwd: '/tmp/noqa',
    ahw: '/tmp/noqa-ahw',
    agents: [{ id: 'noqa-dev', name: 'Dev', role: 'dev' } as Agent],
  },
};

let app: Express;

beforeAll(() => {
  initDb(mkdtempSync(path.join(tmpdir(), 'ah-qa-authoring-')));
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
  db.exec("DELETE FROM sessions WHERE agent_id = 'proj-qa'");
  db.exec("DELETE FROM kanban_cards WHERE id = 'card-1'");
  db.exec("DELETE FROM kanban_epics WHERE id = 'epic-1'");
  db.exec("DELETE FROM kanban_columns WHERE id = 'col-1'");
  db.exec("DELETE FROM kanban_boards WHERE id = 'board-proj'");
  db.exec(
    "INSERT INTO kanban_boards (id, project_id, name) VALUES ('board-proj', 'proj', 'Board')",
  );
  db.exec(
    "INSERT INTO kanban_columns (id, board_id, name, position) VALUES ('col-1', 'board-proj', 'To Do', 0)",
  );
  db.exec(
    `INSERT INTO kanban_epics (id, board_id, name, description)
       VALUES ('epic-1', 'board-proj', 'Payments', 'Epic: take card payments')`,
  );
  db.exec(
    `INSERT INTO kanban_cards (id, board_id, column_id, title, description)
       VALUES ('card-1', 'board-proj', 'col-1', 'Saved card', '- [ ] Saved card is preselected')`,
  );
  broadcast.mockClear();
  handleChat.mockClear();
});

async function createPlan(projectId = 'proj') {
  const res = await request(app)
    .post(`/api/projects/${projectId}/qa/plans`)
    .send({
      title: 'Checkout',
      targetUrl: 'https://staging.example.com',
      goal: 'Buy with a saved card',
      epicId: projectId === 'proj' ? 'epic-1' : undefined,
      cardId: projectId === 'proj' ? 'card-1' : undefined,
    })
    .expect(201);
  return res.body.plan as { id: string };
}

describe('POST /qa/plans/:planId/authoring-session', () => {
  it('opens a QA-mode session on the QA agent, seeded with the plan and its links', async () => {
    const plan = await createPlan();
    const res = await request(app)
      .post(`/api/projects/proj/qa/plans/${plan.id}/authoring-session`)
      .expect(201);
    expect(res.body).toMatchObject({ agentId: 'proj-qa', created: true });

    const session = getStmts().getSession.get(res.body.sessionId) as {
      agent_id: string;
      session_mode: string;
      use_worktree: number;
      name: string;
    };
    expect(session).toMatchObject({
      agent_id: 'proj-qa',
      session_mode: 'qa',
      use_worktree: 0,
      name: '[QA plan] Checkout',
    });

    expect(handleChat).toHaveBeenCalledTimes(1);
    const msg = handleChat.mock.calls[0]![1];
    expect(msg).toMatchObject({ agentId: 'proj-qa', sessionId: res.body.sessionId });
    expect(msg.content).toContain(plan.id);
    expect(msg.content).toContain('https://staging.example.com');
    expect(msg.content).toContain('Buy with a saved card');
    expect(msg.content).toContain('Epic: take card payments');
    expect(msg.content).toContain('Saved card is preselected');

    const detail = await request(app).get(`/api/projects/proj/qa/plans/${plan.id}`).expect(200);
    expect(detail.body.plan.authoringSessionId).toBe(res.body.sessionId);
    expect(broadcast.mock.calls.map((c) => c[0].type)).toEqual(
      expect.arrayContaining(['session_created', 'qa_update']),
    );
  });

  it('returns the existing live session instead of creating another', async () => {
    const plan = await createPlan();
    const url = `/api/projects/proj/qa/plans/${plan.id}/authoring-session`;
    const first = await request(app).post(url).expect(201);
    const again = await request(app).post(url).expect(200);
    expect(again.body).toEqual({
      sessionId: first.body.sessionId,
      agentId: 'proj-qa',
      created: false,
    });
    expect(handleChat).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh session once the previous one is archived', async () => {
    const plan = await createPlan();
    const url = `/api/projects/proj/qa/plans/${plan.id}/authoring-session`;
    const first = await request(app).post(url).expect(201);
    getDb()
      .prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?")
      .run(first.body.sessionId);
    const second = await request(app).post(url).expect(201);
    expect(second.body.sessionId).not.toBe(first.body.sessionId);
  });

  it('409s when the project has no QA agent', async () => {
    const plan = await createPlan('noqa');
    const res = await request(app)
      .post(`/api/projects/noqa/qa/plans/${plan.id}/authoring-session`)
      .expect(409);
    expect(res.body.code).toBe('no_qa_agent');
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('drops the session and the link when the seed is not accepted', async () => {
    const plan = await createPlan();
    handleChat.mockImplementationOnce(async (_ws, msg) => {
      msg._onUserMessagePersisted?.(false);
    });
    await request(app).post(`/api/projects/proj/qa/plans/${plan.id}/authoring-session`).expect(502);
    const rows = getDb().prepare("SELECT id FROM sessions WHERE agent_id = 'proj-qa'").all();
    expect(rows).toEqual([]);
    const detail = await request(app).get(`/api/projects/proj/qa/plans/${plan.id}`).expect(200);
    expect(detail.body.plan.authoringSessionId).toBeNull();
  });

  /** handleChat that waits for the test to accept or drop the seed. */
  function deferSeed() {
    let settle!: (accepted: boolean) => void;
    const started = new Promise<void>((resolveStarted) => {
      handleChat.mockImplementationOnce(async (_ws, msg) => {
        resolveStarted();
        await new Promise<void>((resolve) => {
          settle = (accepted) => {
            msg._onUserMessagePersisted?.(accepted);
            resolve();
          };
        });
      });
    });
    return { started, settle: (accepted: boolean) => settle(accepted) };
  }

  it('an overlapping open waits for a failing seed and reports the failure', async () => {
    const plan = await createPlan();
    const url = `/api/projects/proj/qa/plans/${plan.id}/authoring-session`;
    const seed = deferSeed();
    const first = request(app)
      .post(url)
      .then((r) => r);
    await seed.started;
    const second = request(app)
      .post(url)
      .then((r) => r);
    // Give the second request time to reach the route while the seed is pending.
    await new Promise((r) => setTimeout(r, 50));
    seed.settle(false);
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(502);
    expect(b.status).toBe(502);
    expect(handleChat).toHaveBeenCalledTimes(1);
    const rows = getDb().prepare("SELECT id FROM sessions WHERE agent_id = 'proj-qa'").all();
    expect(rows).toEqual([]);
  });

  it('an overlapping open shares the session once the seed is accepted', async () => {
    const plan = await createPlan();
    const url = `/api/projects/proj/qa/plans/${plan.id}/authoring-session`;
    const seed = deferSeed();
    const first = request(app)
      .post(url)
      .then((r) => r);
    await seed.started;
    const second = request(app)
      .post(url)
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 50));
    const detail = await request(app).get(`/api/projects/proj/qa/plans/${plan.id}`).expect(200);
    expect(detail.body.plan.authoringSessionId).toBeNull();
    seed.settle(true);
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ sessionId: a.body.sessionId, agentId: 'proj-qa', created: false });
    expect(handleChat).toHaveBeenCalledTimes(1);
  });

  it('404s a plan from another project', async () => {
    const plan = await createPlan();
    await request(app).post(`/api/projects/noqa/qa/plans/${plan.id}/authoring-session`).expect(404);
  });
});
