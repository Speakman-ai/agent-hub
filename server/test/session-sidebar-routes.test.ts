/**
 * SideBar routes: GET/POST/DELETE /api/sessions/:id/sidebar.
 *
 * No test sends `content`, so no CLI turn is dispatched.
 */
import './setup.js';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';
import { getDb, getStmts } from '../db.js';
import { openSidebar } from '../session-sidebar.js';
import type { SessionRow } from '../types.js';

let request: TestAgent;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ id: 'sidebar-proj', name: 'SideBar', cwd: '/tmp' });
  const agent = await createAgent({ projectId: project.id as string, id: 'sidebar-agent' });
  agentId = agent.id as string;
});

async function parentWithMessages(engineSessionId: string | null): Promise<string> {
  const session = await createSession({ agentId, name: 'Main work' });
  const id = session.id as string;
  const db = getDb();
  db.prepare("UPDATE sessions SET engine = 'claude-code', engine_session_id = ? WHERE id = ?").run(
    engineSessionId,
    id,
  );
  const insert = db.prepare(
    'INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)',
  );
  insert.run(`${id}-m1`, id, 'user', 'Refactor the parser');
  insert.run(`${id}-m2`, id, 'assistant', 'Parser refactored into three passes');
  return id;
}

function row(id: string): Record<string, unknown> {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
}

describe('SideBar routes', () => {
  it('returns null before a SideBar is opened', async () => {
    const parent = await parentWithMessages(null);
    const res = await request.get(`/api/sessions/${parent}/sidebar`).expect(200);
    expect(res.body.session).toBeNull();
    expect(res.body.running).toBe(false);
  });

  it("forks a Claude parent's CLI session into a hidden Consult child", async () => {
    const parent = await parentWithMessages('cli-parent-1');
    const res = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    expect(res.body.forked).toBe(true);
    const child = row(res.body.session.id);
    expect(child.sidebar_parent_id).toBe(parent);
    expect(child.fork_from_engine_session_id).toBe('cli-parent-1');
    expect(child.session_mode).toBe('consult');
    expect(child.use_worktree).toBe(0);
    expect(child.agent_id).toBe(agentId);
    expect(child.pending_skill_context).toBeNull();

    const got = await request.get(`/api/sessions/${parent}/sidebar`).expect(200);
    expect(got.body.session.id).toBe(res.body.session.id);
  });

  it('seeds the transcript when there is no CLI session to fork', async () => {
    const parent = await parentWithMessages(null);
    const res = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    expect(res.body.forked).toBe(false);
    const child = row(res.body.session.id);
    expect(child.fork_from_engine_session_id).toBeNull();
    expect(String(child.pending_skill_context)).toContain('Parser refactored into three passes');
  });

  it('keeps SideBar children out of the agent session list', async () => {
    const parent = await parentWithMessages('cli-parent-2');
    const res = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    const list = await request.get(`/api/agents/${agentId}/sessions`).expect(200);
    const rows = (Array.isArray(list.body) ? list.body : list.body.sessions) as Array<{
      id: string;
    }>;
    const ids = rows.map((s) => s.id);
    expect(ids).toContain(parent);
    expect(ids).not.toContain(res.body.session.id);
  });

  it('allows one SideBar at a time: opening a new one archives the old', async () => {
    const parent = await parentWithMessages('cli-parent-3');
    const first = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    const second = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    expect(second.body.closedSessionIds).toEqual([first.body.session.id]);
    expect(second.body.session.sidebar_seq).toBe(first.body.session.sidebar_seq + 1);
    expect(row(first.body.session.id).deleted_at).not.toBeNull();
    const got = await request.get(`/api/sessions/${parent}/sidebar`).expect(200);
    expect(got.body.session.id).toBe(second.body.session.id);
  });

  it('DELETE archives the SideBar', async () => {
    const parent = await parentWithMessages('cli-parent-4');
    const opened = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    const del = await request.delete(`/api/sessions/${parent}/sidebar`).expect(200);
    expect(del.body.closedSessionIds).toEqual([opened.body.session.id]);
    const got = await request.get(`/api/sessions/${parent}/sidebar`).expect(200);
    expect(got.body.session).toBeNull();
  });

  it('archiving the parent archives its SideBar', async () => {
    const parent = await parentWithMessages('cli-parent-5');
    const opened = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    await request.delete(`/api/sessions/${parent}`).expect(200);
    expect(row(opened.body.session.id).deleted_at).not.toBeNull();
  });

  it('refuses a SideBar of a SideBar', async () => {
    const parent = await parentWithMessages('cli-parent-6');
    const opened = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    await request.post(`/api/sessions/${opened.body.session.id}/sidebar`).send({}).expect(400);
  });

  it('rejects unknown body fields', async () => {
    const parent = await parentWithMessages(null);
    await request.post(`/api/sessions/${parent}/sidebar`).send({ bogus: 1 }).expect(400);
  });

  it('404s for an unknown session', async () => {
    await request.get('/api/sessions/does-not-exist/sidebar').expect(404);
  });

  it('a failed replacement leaves the old SideBar live and its turn running', async () => {
    const parent = await parentWithMessages('cli-parent-7');
    const opened = await request.post(`/api/sessions/${parent}/sidebar`).send({}).expect(201);
    const oldId = opened.body.session.id as string;
    const stmts = getStmts();
    const kill = vi.fn();
    const activeProcesses = new Map([[oldId, { kill } as never]]);
    const failing = {
      ...stmts,
      createSession: {
        run: () => {
          throw new Error('disk full');
        },
      },
    } as unknown as typeof stmts;
    expect(() =>
      openSidebar({
        stmts: failing,
        parent: stmts.getSession.get(parent) as SessionRow,
        agentName: 'Dev',
        activeProcesses,
      }),
    ).toThrow('disk full');
    expect(row(oldId).deleted_at).toBeNull();
    expect(kill).not.toHaveBeenCalled();
    const got = await request.get(`/api/sessions/${parent}/sidebar`).expect(200);
    expect(got.body.session.id).toBe(oldId);
  });
});
