/**
 * A person turning an orchestrated epic (or one of its phases) on starts the
 * epic's Orchestrate manager through the real app: real SQLite, the real
 * EpicManager lookup, and the real launch-settings store.
 */
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from 'vitest';
import { getRequest, createProject, createAgent } from './helpers.js';
import { getDb } from '../db.js';
import { getEpicManager, type EpicManager } from '../epic-manager.js';
import { OrchestrateLaunchStore } from '../orchestrate-launch-store.js';

const OPERATOR = 'operator-user';

vi.mock('../session-ownership.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../session-ownership.js')>();
  return { ...real, resolveOwnerUserId: () => OPERATOR };
});

let request: supertest.Agent;
let kickoff: MockInstance<EpicManager['kickoff']>;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

beforeEach(() => {
  const manager = getEpicManager();
  if (!manager) throw new Error('epic manager not attached');
  // Kickoff briefs the manager over chat; the session state is what's under test.
  kickoff = vi.spyOn(manager, 'kickoff').mockReturnValue(null);
  kickoff.mockClear();
});

async function orchestratedProject(): Promise<{ projectId: string; agentId: string }> {
  const projectId = (await createProject()).id as string;
  await request.patch(`/api/projects/${projectId}`).send({ orchestratedEpics: true }).expect(200);
  const agentId = (await createAgent({ projectId, role: 'dev' })).id as string;
  return { projectId, agentId };
}

async function createEpic(projectId: string, name: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/board/epics`)
    .send({ name, description: '', color: '#6366F1' })
    .expect(200);
  return (res.body as { id: string }).id;
}

function epicRow(epicId: string): { manager_session_id: string | null; autonomous: number } {
  return getDb()
    .prepare('SELECT manager_session_id, autonomous FROM kanban_epics WHERE id = ?')
    .get(epicId) as { manager_session_id: string | null; autonomous: number };
}

function orchestrateSessions(epicId: string): Array<{
  id: string;
  agent_id: string;
  owner_user_id: string | null;
  session_mode: string;
}> {
  return getDb()
    .prepare(
      "SELECT id, agent_id, owner_user_id, session_mode FROM sessions WHERE linked_epic_id = ? AND session_mode = 'orchestrate' AND deleted_at IS NULL",
    )
    .all(epicId) as Array<{
    id: string;
    agent_id: string;
    owner_user_id: string | null;
    session_mode: string;
  }>;
}

function expectStartedManager(epicId: string, agentId: string): string {
  const sessions = orchestrateSessions(epicId);
  expect(sessions).toHaveLength(1);
  const [session] = sessions;
  expect(session.agent_id).toBe(agentId);
  expect(session.owner_user_id).toBe(OPERATOR);
  expect(epicRow(epicId).manager_session_id).toBe(session.id);
  expect(new OrchestrateLaunchStore(getDb()).getSettings(session.id)).toMatchObject({
    mode: 'manual',
    autoStart: true,
  });
  expect(getEpicManager()!.hasLiveManager(epicId)).toBe(true);
  return session.id;
}

describe('starting the epic manager', () => {
  it('turning an epic on creates one manager and reuses it on the next start', async () => {
    const { projectId, agentId } = await orchestratedProject();
    const epicId = await createEpic(projectId, 'Enable Epic');
    const put = (autonomous: number) =>
      request
        .put(`/api/projects/${projectId}/board/epics/${epicId}`)
        .send({ autonomous })
        .expect(200);

    await put(1);
    const managerId = expectStartedManager(epicId, agentId);
    expect(kickoff).toHaveBeenCalledTimes(1);

    await put(0);
    await put(1);
    expect(expectStartedManager(epicId, agentId)).toBe(managerId);
    expect(kickoff).toHaveBeenCalledTimes(2);
  });

  it('running a phase creates one manager and reuses it on the next run', async () => {
    const { projectId, agentId } = await orchestratedProject();
    const epicId = await createEpic(projectId, 'Phase Epic');
    const phaseRes = await request
      .post(`/api/projects/${projectId}/board/phases`)
      .send({ epicId, name: 'Phase 1', description: '' })
      .expect(200);
    const phaseId = (phaseRes.body as { id: string }).id;
    await request
      .put(`/api/projects/${projectId}/board/phases/${phaseId}`)
      .send({ autonomous: 1 })
      .expect(200);

    await request.post(`/api/projects/${projectId}/board/phases/${phaseId}/run`).expect(200);
    const managerId = expectStartedManager(epicId, agentId);

    await request.post(`/api/projects/${projectId}/board/phases/${phaseId}/stop`).expect(200);
    await request.post(`/api/projects/${projectId}/board/phases/${phaseId}/run`).expect(200);
    expect(expectStartedManager(epicId, agentId)).toBe(managerId);
    expect(kickoff).toHaveBeenCalledTimes(2);
  });

  it('refuses to turn on an epic from another project through this project URL', async () => {
    const own = await orchestratedProject();
    const foreign = await orchestratedProject();
    const foreignEpic = await createEpic(foreign.projectId, 'Foreign Epic');
    const sessionsBefore = (
      getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    ).n;

    await request
      .put(`/api/projects/${own.projectId}/board/epics/${foreignEpic}`)
      .send({ autonomous: 1 })
      .expect(404);

    expect(epicRow(foreignEpic)).toMatchObject({ manager_session_id: null, autonomous: 0 });
    expect(orchestrateSessions(foreignEpic)).toHaveLength(0);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(
      sessionsBefore,
    );
    expect(kickoff).not.toHaveBeenCalled();
  });
});
