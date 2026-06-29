import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../auth.js';
import type { Agent, EnrichedAgent, Project } from '../types.js';

vi.mock('../heartbeat.js', () => ({
  rescheduleHeartbeat: vi.fn(),
  runHeartbeat: vi.fn(async () => ({ id: 1, status: 'success', result: 'ok' })),
}));

vi.mock('../users-store.js', () => ({
  getUserById: vi.fn((id: string) => {
    const users: Record<string, { id: string; username: string }> = {
      'owner-a': { id: 'owner-a', username: 'owner@example.com' },
      'user-a': { id: 'user-a', username: 'alice@example.com' },
      'user-b': { id: 'user-b', username: 'bob@example.com' },
    };
    return users[id] ?? null;
  }),
}));

vi.mock('../orgs.js', () => ({
  getActiveOrgId: vi.fn(() => 'default'),
}));

vi.mock('../memberships-store.js', () => ({
  listMembersForOrg: vi.fn(() => [
    { userId: 'owner-a', username: 'owner@example.com', role: 'Owner', createdAt: '1' },
  ]),
}));

const { default: createHeartbeatRoutes } = await import('./heartbeats.js');
const { resetHeartbeatOwnerBackfillForTests } = await import('../heartbeat-ownership.js');

function makeAgent(overrides: Partial<Agent>): EnrichedAgent {
  return {
    id: 'agent-1',
    name: 'Agent',
    engine: 'claude-code',
    color: '#888',
    systemPrompt: '',
    heartbeat: {
      enabled: true,
      interval: '0 * * * *',
      prompt: 'check in',
      owner_user_id: null,
      shared: 0,
    },
    projectId: 'proj',
    projectName: 'Project',
    cwd: '/tmp',
    ahw: '/tmp/.ahw',
    workspace: '/tmp',
    ...overrides,
  };
}

function makeApp(
  opts: { userId?: string; role?: AuthenticatedRequest['authRole'] },
  rows: EnrichedAgent[],
  projectOverrides: Record<string, Partial<Project>> = {},
) {
  const saveProjects = vi.fn();
  const stmts = {
    getLatestHeartbeat: { get: vi.fn(() => null) },
    getHeartbeatState: { get: vi.fn(() => null) },
    getHeartbeatLogs: { all: vi.fn(() => []) },
    addHeartbeatLog: { run: vi.fn(() => ({ lastInsertRowid: 1 })) },
    getThreadBySource: { get: vi.fn(() => null) },
    getThreadEntries: { all: vi.fn(() => []) },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const authed = req as AuthenticatedRequest;
    if (opts.userId) authed.authUserId = opts.userId;
    if (opts.role) authed.authRole = opts.role;
    next();
  });
  app.use(
    createHeartbeatRoutes({
      allAgents: () => rows,
      findAgent: (id: string) => {
        const agent = rows.find((row) => row.id === id);
        if (!agent) return null;
        const projectId = agent.projectId ?? 'proj';
        return {
          agent,
          project: {
            id: projectId,
            name: projectId,
            cwd: '/tmp',
            ahw: '/tmp/.ahw',
            agents: rows.filter((row) => row.projectId === projectId),
            ...projectOverrides[projectId],
          },
        };
      },
      findProject: (id: string) => {
        const agents = rows.filter((row) => row.projectId === id);
        if (!agents.length && !projectOverrides[id]) return null;
        return {
          id,
          name: id,
          cwd: '/tmp',
          ahw: '/tmp/.ahw',
          agents,
          ...projectOverrides[id],
        };
      },
      getProjects: () => [
        {
          id: 'proj',
          name: 'proj',
          cwd: '/tmp',
          ahw: '/tmp/.ahw',
          agents: rows,
          ...projectOverrides.proj,
        },
      ],
      getEnrichedAgent: (id: string) => rows.find((row) => row.id === id) ?? null,
      saveProjects,
      stmts,
    } as never),
  );
  return { app, saveProjects, stmts };
}

describe('heartbeat ownership and shared visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHeartbeatOwnerBackfillForTests();
  });

  it('does not backfill owners during reads and leaves empty placeholders claimable', async () => {
    const rows = [
      makeAgent({ id: 'legacy-configured' }),
      makeAgent({
        id: 'empty-placeholder',
        name: 'empty placeholder',
        heartbeat: {
          enabled: false,
          interval: '',
          prompt: '',
          owner_user_id: null,
          shared: 0,
        },
      }),
    ];
    const { app, saveProjects } = makeApp({ userId: 'user-a', role: 'User' }, rows);

    const res = await request(app).get('/api/heartbeats').expect(200);

    expect(rows[0].heartbeat?.owner_user_id).toBeNull();
    expect(rows[0].heartbeat?.shared).toBe(0);
    expect(rows[1].heartbeat?.owner_user_id).toBeNull();
    expect(res.body.map((row: { agentId: string }) => row.agentId)).not.toContain(
      'legacy-configured',
    );
    expect(res.body.map((row: { agentId: string }) => row.agentId)).toContain('empty-placeholder');
    expect(
      res.body.find((row: { agentId: string }) => row.agentId === 'empty-placeholder'),
    ).toMatchObject({
      owner_user_id: null,
      can_manage: true,
    });
    expect(saveProjects).not.toHaveBeenCalled();
  });

  it('lists owned private heartbeats plus shared heartbeats, hiding other private heartbeats', async () => {
    const rows = [
      makeAgent({
        id: 'mine',
        name: 'mine',
        heartbeat: {
          enabled: true,
          interval: '0 * * * *',
          prompt: 'mine',
          owner_user_id: 'user-a',
          shared: 0,
        },
      }),
      makeAgent({
        id: 'shared',
        name: 'shared by bob',
        heartbeat: {
          enabled: true,
          interval: '0 * * * *',
          prompt: 'shared',
          owner_user_id: 'user-b',
          shared: 1,
        },
      }),
      makeAgent({
        id: 'private',
        name: 'private by bob',
        heartbeat: {
          enabled: true,
          interval: '0 * * * *',
          prompt: 'private',
          owner_user_id: 'user-b',
          shared: 0,
        },
      }),
    ];
    const { app } = makeApp({ userId: 'user-a', role: 'User' }, rows);

    const res = await request(app).get('/api/heartbeats').expect(200);

    expect(res.body.map((row: { agentName: string }) => row.agentName)).toEqual([
      'mine',
      'shared by bob',
    ]);
    expect(res.body[0]).toMatchObject({
      owner_user_id: 'user-a',
      owner_username: 'alice@example.com',
      shared: 0,
      can_manage: true,
    });
    expect(res.body[1]).toMatchObject({
      owner_user_id: 'user-b',
      owner_username: 'bob@example.com',
      shared: 1,
      can_manage: false,
    });
  });

  it('rejects mutation of another user shared heartbeat', async () => {
    const rows = [
      makeAgent({
        id: 'shared',
        heartbeat: {
          enabled: true,
          interval: '0 * * * *',
          prompt: 'shared',
          owner_user_id: 'user-b',
          shared: 1,
        },
      }),
    ];
    const { app } = makeApp({ userId: 'user-a', role: 'User' }, rows);

    await request(app).put('/api/heartbeats/shared').send({ shared: false }).expect(403);
  });

  it('allows org Owners to flip another user heartbeat shared flag', async () => {
    const rows = [
      makeAgent({
        id: 'private',
        heartbeat: {
          enabled: true,
          interval: '0 * * * *',
          prompt: 'private',
          owner_user_id: 'user-b',
          shared: 0,
        },
      }),
    ];
    const { app } = makeApp({ userId: 'owner-a', role: 'Owner' }, rows);

    const res = await request(app)
      .put('/api/heartbeats/private')
      .send({ shared: true })
      .expect(200);

    expect(res.body).toMatchObject({
      agentId: 'private',
      owner_user_id: 'user-b',
      shared: 1,
      can_manage: true,
    });
    expect(rows[0].heartbeat?.shared).toBe(1);
  });

  it('does not expose shared heartbeats from projects the caller cannot view', async () => {
    const rows = [
      makeAgent({
        id: 'private-shared',
        projectId: 'private-proj',
        heartbeat: {
          enabled: true,
          interval: '0 * * * *',
          prompt: 'private shared',
          owner_user_id: 'user-b',
          shared: 1,
        },
      }),
    ];
    const { app } = makeApp({ userId: 'user-a', role: 'User' }, rows, {
      'private-proj': { visibility: 'private', ownerUserId: 'user-b' },
    });

    const list = await request(app).get('/api/heartbeats').expect(200);
    expect(list.body).toEqual([]);
    const state = await request(app).get('/api/heartbeats/state').expect(200);
    expect(state.body).toEqual([]);
    await request(app).get('/api/heartbeats/private-shared/logs').expect(404);
    await request(app).get('/api/heartbeats/private-shared/thread').expect(404);
    await request(app).put('/api/heartbeats/private-shared').send({ shared: false }).expect(404);
    await request(app).post('/api/heartbeats/private-shared/run').expect(404);
  });

  it('resolves project visibility for heartbeat rows that lack projectId', async () => {
    const rows = [
      makeAgent({
        id: 'plain-agent',
        projectId: undefined,
        heartbeat: {
          enabled: true,
          interval: '0 * * * *',
          prompt: 'plain',
          owner_user_id: 'user-a',
          shared: 0,
        },
      }),
    ];
    const { app } = makeApp({ userId: 'user-a', role: 'User' }, rows);

    const res = await request(app).get('/api/heartbeats').expect(200);

    expect(res.body.map((row: { agentId: string }) => row.agentId)).toEqual(['plain-agent']);
  });

  it('does not let an org Owner implicitly claim an unowned heartbeat placeholder', async () => {
    const rows = [
      makeAgent({
        id: 'empty-placeholder',
        heartbeat: {
          enabled: false,
          interval: '',
          prompt: '',
          owner_user_id: null,
          shared: 0,
        },
      }),
    ];
    const { app } = makeApp({ userId: 'owner-a', role: 'Owner' }, rows);

    const res = await request(app)
      .put('/api/heartbeats/empty-placeholder')
      .send({ shared: true })
      .expect(200);

    expect(res.body).toMatchObject({
      agentId: 'empty-placeholder',
      owner_user_id: null,
      shared: 1,
      can_manage: true,
    });
    expect(rows[0].heartbeat?.owner_user_id).toBeNull();
    expect(rows[0].heartbeat?.shared).toBe(1);
  });

  it('assigns the org Owner when an Owner updates an unowned configured heartbeat', async () => {
    const rows = [
      makeAgent({
        id: 'configured-unowned',
        heartbeat: {
          enabled: true,
          interval: '0 * * * *',
          prompt: 'configured',
          owner_user_id: null,
          shared: 0,
        },
      }),
    ];
    const { app } = makeApp({ userId: 'owner-a', role: 'Owner' }, rows);

    const res = await request(app)
      .put('/api/heartbeats/configured-unowned')
      .send({ prompt: 'updated' })
      .expect(200);

    expect(res.body).toMatchObject({
      agentId: 'configured-unowned',
      owner_user_id: 'owner-a',
      can_manage: true,
    });
    expect(rows[0].heartbeat?.owner_user_id).toBe('owner-a');
  });
});
