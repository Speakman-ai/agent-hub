import type supertest from 'supertest';
import {
  AGENT_HUB_SESSION_ID_HEADER,
  resolveCardSessionId,
  sessionIdFromSpawnKeyName,
} from '../kanban-caller-session.js';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function getFirstColumnId(projectId: string): Promise<string> {
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const cols = (boardRes.body as { columns: Array<{ id: string }> }).columns;
  if (!cols[0]) throw new Error('No columns');
  return cols[0].id;
}

describe('kanban-caller-session helpers', () => {
  it('sessionIdFromSpawnKeyName parses spawn-creds key names', () => {
    expect(sessionIdFromSpawnKeyName('spawn:sess-abc')).toBe('sess-abc');
    expect(sessionIdFromSpawnKeyName('spawn-recovery (abc)')).toBeNull();
    expect(sessionIdFromSpawnKeyName('my-key')).toBeNull();
  });

  it('resolveCardSessionId prefers explicit body over header', () => {
    const req = {
      get: (name: string) =>
        name.toLowerCase() === AGENT_HUB_SESSION_ID_HEADER ? 'header-session' : undefined,
    } as unknown as import('express').Request;

    expect(resolveCardSessionId(req, 'body-session')).toBe('body-session');
    expect(resolveCardSessionId(req, undefined)).toBe('header-session');
    expect(resolveCardSessionId(req, null)).toBeNull();
  });

  it('resolveCardSessionId uses authSpawnSessionId when body and header omit', () => {
    const req = {
      get: () => undefined,
      authSpawnSessionId: 'spawn-session',
    } as unknown as import('express').Request;

    expect(resolveCardSessionId(req, undefined)).toBe('spawn-session');
  });
});

describe('POST /board/cards session auto-link', () => {
  it('stamps session_id from X-Agent-Hub-Session-Id when body omits it', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Auto Link Worker' });
    const session = await createSession({ agentId: agent.id as string });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set(AGENT_HUB_SESSION_ID_HEADER, sessionId)
      .send({ title: 'Auto-linked via header', columnId })
      .expect(200);

    expect((res.body as { session_id: string }).session_id).toBe(sessionId);
  });

  it('honors explicit sessionId: null over header auto-link', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Opt Out Worker' });
    const session = await createSession({ agentId: agent.id as string });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set(AGENT_HUB_SESSION_ID_HEADER, sessionId)
      .send({ title: 'Explicitly unlinked card', columnId, sessionId: null })
      .expect(200);

    expect((res.body as { session_id: string | null }).session_id).toBeNull();
  });

  it('renames placeholder session title when card links mid-flight', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Rename Worker' });
    const session = await createSession({
      agentId: agent.id as string,
      name: 'Session 5/26/2026, 7:00 PM',
    });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set(AGENT_HUB_SESSION_ID_HEADER, sessionId)
      .send({ title: 'Rename me in sidebar', columnId })
      .expect(200);

    expect((res.body as { session_id: string }).session_id).toBe(sessionId);

    const sessRes = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect((sessRes.body as { name: string }).name).toBe('Rename me in sidebar');
  });

  it('still strips intake session_id even when auto-filled from header', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const intakeAgent = await createAgent({
      projectId,
      role: 'intake',
      name: 'Intake Auto Link',
    });
    const session = await createSession({ agentId: intakeAgent.id as string });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set(AGENT_HUB_SESSION_ID_HEADER, sessionId)
      .send({ title: 'Intake filed ticket', columnId })
      .expect(200);

    const body = res.body as { session_id: string | null; assignee: string | null };
    expect(body.session_id).toBeNull();
    expect(body.assignee).toBeNull();
  });
});
