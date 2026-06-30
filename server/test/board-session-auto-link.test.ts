import type supertest from 'supertest';
import {
  AGENT_HUB_SESSION_ID_HEADER,
  sessionIdFromSpawnKeyName,
} from '../kanban-caller-session.js';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

async function getFirstColumnId(projectId: string): Promise<string> {
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const cols = (boardRes.body as { columns: Array<{ id: string }> }).columns;
  if (!cols[0]) throw new Error('No columns');
  return cols[0].id;
}

describe('sessionIdFromSpawnKeyName', () => {
  it('parses spawn-creds key names', () => {
    expect(sessionIdFromSpawnKeyName('spawn:sess-abc')).toBe('sess-abc');
    expect(sessionIdFromSpawnKeyName('spawn-recovery (abc)')).toBeNull();
    expect(sessionIdFromSpawnKeyName('my-key')).toBeNull();
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

  it('ignores an empty session header when body omits sessionId', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const columnId = await getFirstColumnId(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set(AGENT_HUB_SESSION_ID_HEADER, '')
      .send({ title: 'No session link from empty header', columnId })
      .expect(200);

    expect((res.body as { session_id: string | null }).session_id).toBeNull();
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

  it('dedups via header only when body omits sessionId (no body session_id key)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Header Dedup Worker' });
    const session = await createSession({ agentId: agent.id as string });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    const first = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set(AGENT_HUB_SESSION_ID_HEADER, sessionId)
      .send({ title: 'First linked card', columnId })
      .expect(200);
    const firstId = (first.body as { id: string }).id;

    const second = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set(AGENT_HUB_SESSION_ID_HEADER, sessionId)
      .send({ title: 'Second card same session via header', columnId })
      .expect(200);

    expect((second.body as { id: string }).id).toBe(firstId);
  });

  it('dedups via body sessionId only (no session header)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Body Dedup Worker' });
    const session = await createSession({ agentId: agent.id as string });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    const first = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Body-linked first card', columnId, sessionId })
      .expect(200);
    const firstId = (first.body as { id: string }).id;

    const second = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Body-linked second card', columnId, sessionId })
      .expect(200);

    expect((second.body as { id: string }).id).toBe(firstId);
  });

  it('does not rename a user-customized session title when linking via header', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, name: 'Custom Title Worker' });
    const customName = 'My hand-picked session title';
    const session = await createSession({
      agentId: agent.id as string,
      name: customName,
    });
    const sessionId = session.id as string;
    const columnId = await getFirstColumnId(projectId);

    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set(AGENT_HUB_SESSION_ID_HEADER, sessionId)
      .send({ title: 'Card title should not overwrite custom name', columnId })
      .expect(200);

    const sessRes = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect((sessRes.body as { name: string }).name).toBe(customName);
  });
});
