import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type supertest from 'supertest';
import { createProject, createAgent, createSession, getRequest } from './test/helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('DELETE /api/agents/:agentId — hard delete', () => {
  it('returns 404 for nonexistent agent', async () => {
    await request.delete('/api/agents/does-not-exist').expect(404);
  });

  it('removes the agent from the project', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });

    await request.delete(`/api/agents/${agent.id}`).expect(204);

    const after = await request.get('/api/agents').expect(200);
    const ids = (after.body as Array<{ id: string }>).map((a) => a.id);
    expect(ids).not.toContain(agent.id);
  });

  it('cascades child rows in sessions/messages/heartbeat_logs/slack_messages/session_agents/active_tasks/heartbeat_state/agent_skill_overrides', async () => {
    const { stmts, db } = await import('./db.js');
    if (!stmts || !db) throw new Error('Database not initialized');

    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });
    const agentId = agent.id as string;

    // Seed a session — that gives us a message_id we can hang an active_task off.
    const session = await createSession({ agentId });
    const sessionId = session.id as string;

    // Seed: a message, a heartbeat_log, a heartbeat_state row, a slack_message,
    // a session_agent advisor row, an active_task, and an agent_skill_override.
    stmts.addMessage.run(
      'msg-1',
      sessionId,
      'user',
      'hi',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    stmts.addHeartbeatLog.run(agentId, 'tick', 'success');
    stmts.upsertHeartbeatState.run(agentId, '2030-01-01T00:00:00Z', null);
    stmts.addSlackMessage.run(agentId, 'C123', null, 'U1', 'hello', 'hi back');
    stmts.insertActiveTask.run(sessionId, 'msg-1', agentId, 1234, 'p', 'claude-code', 'sonnet');
    stmts.upsertAgentSkillOverride.run(agentId, 'kanban', 0);

    stmts.addSessionAgent.run(sessionId, agentId, sessionId);

    // Sanity — every store has a row before deletion.
    const beforeSessions = (
      db.prepare('SELECT COUNT(*) as c FROM sessions WHERE agent_id = ?').get(agentId) as {
        c: number;
      }
    ).c;
    const beforeMessages = (
      db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as {
        c: number;
      }
    ).c;
    const beforeHb = (
      db.prepare('SELECT COUNT(*) as c FROM heartbeat_logs WHERE agent_id = ?').get(agentId) as {
        c: number;
      }
    ).c;
    const beforeHbState = (
      db.prepare('SELECT COUNT(*) as c FROM heartbeat_state WHERE agent_id = ?').get(agentId) as {
        c: number;
      }
    ).c;
    const beforeSlack = (
      db.prepare('SELECT COUNT(*) as c FROM slack_messages WHERE agent_id = ?').get(agentId) as {
        c: number;
      }
    ).c;
    const beforeSessionAgents = (
      db.prepare('SELECT COUNT(*) as c FROM session_agents WHERE agent_id = ?').get(agentId) as {
        c: number;
      }
    ).c;
    const beforeActive = (
      db.prepare('SELECT COUNT(*) as c FROM active_tasks WHERE agent_id = ?').get(agentId) as {
        c: number;
      }
    ).c;
    const beforeOverrides = (
      db
        .prepare('SELECT COUNT(*) as c FROM agent_skill_overrides WHERE agent_id = ?')
        .get(agentId) as { c: number }
    ).c;

    expect(beforeSessions).toBeGreaterThan(0);
    expect(beforeMessages).toBeGreaterThan(0);
    expect(beforeHb).toBeGreaterThan(0);
    expect(beforeHbState).toBe(1);
    expect(beforeSlack).toBeGreaterThan(0);
    expect(beforeActive).toBe(1);
    expect(beforeOverrides).toBe(1);
    expect(beforeSessionAgents).toBeGreaterThan(0);

    await request.delete(`/api/agents/${agentId}`).expect(204);

    // Every store is empty for this agent after delete.
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM sessions WHERE agent_id = ?').get(agentId) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM heartbeat_logs WHERE agent_id = ?').get(agentId) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM heartbeat_state WHERE agent_id = ?').get(agentId) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM slack_messages WHERE agent_id = ?').get(agentId) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM session_agents WHERE agent_id = ?').get(agentId) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) as c FROM active_tasks WHERE agent_id = ?').get(agentId) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) as c FROM agent_skill_overrides WHERE agent_id = ?')
          .get(agentId) as { c: number }
      ).c,
    ).toBe(0);
  });

  it('removes the agent workspace directory on disk', async () => {
    const project = await createProject();
    const agent = await createAgent({ projectId: project.id as string });
    const agentId = agent.id as string;

    // Look up the project's resolved ahw path and seed a marker file so we
    // can prove the directory was wiped (and didn't just race with creation).
    const projectRow = await request.get(`/api/projects/${project.id}`).expect(200);
    const ahw = (projectRow.body as { ahw: string }).ahw;
    const agentDir = path.join(ahw, 'agents', agentId);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, 'marker.txt'), 'leave-no-trace');
    expect(existsSync(agentDir)).toBe(true);

    await request.delete(`/api/agents/${agentId}`).expect(204);

    expect(existsSync(agentDir)).toBe(false);
  });

  it('lets a fresh agent with the same id start clean (no leaked sessions)', async () => {
    const project = await createProject();
    const agent = await createAgent({ id: 'recycled-id', projectId: project.id as string });
    await createSession({ agentId: agent.id as string });

    await request.delete(`/api/agents/${agent.id}`).expect(204);

    const recreated = await createAgent({ id: 'recycled-id', projectId: project.id as string });
    const sessions = await request.get(`/api/agents/${recreated.id}/sessions`).expect(200);
    expect(Array.isArray(sessions.body)).toBe(true);
    expect(sessions.body).toHaveLength(0);
  });

  it('strips deleted agent id from remaining agents subAgents lists', async () => {
    const project = await createProject();
    const pid = project.id as string;
    const leadId = `ld-${randomUUID().slice(0, 8)}`;
    const subId = `sb-${randomUUID().slice(0, 8)}`;
    await createAgent({ projectId: pid, id: leadId, role: 'lead' });
    await createAgent({ projectId: pid, id: subId, role: 'sub' });

    const { getProjects, saveProjects } = await import('./project-model.js');
    const proj = getProjects().find((p) => p.id === pid);
    expect(proj).toBeTruthy();
    const leadAgent = proj!.agents.find((a) => a.id === leadId);
    expect(leadAgent).toBeTruthy();
    leadAgent!.subAgents = [subId, 'other-kept'];
    saveProjects();

    await request.delete(`/api/agents/${subId}`).expect(204);

    const after = getProjects().find((p) => p.id === pid)!;
    expect(after.agents.find((a) => a.id === subId)).toBeUndefined();
    expect(after.agents.find((a) => a.id === leadId)!.subAgents).toEqual(['other-kept']);
  });
});
