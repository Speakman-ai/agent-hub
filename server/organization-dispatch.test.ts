import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware, type AuthenticatedRequest } from './auth.js';
import config from './config.js';
import { initDb, getDb, getStmts } from './db.js';
import { initOrgsDb, getOrgsDb, setActiveOrgId, getActiveOrgId } from './orgs.js';
import { setProjects, findProject, findAgent } from './project-model.js';
import { createMembership } from './memberships-store.js';
import {
  createBusinessOrganization,
  attachBusinessOrganizationProject,
  detachBusinessOrganizationProject,
} from './business-organizations-store.js';
import {
  issueOrganizationCapability,
  prepareOrganizationTurn,
  resetOrganizationCapabilitiesForTests,
  verifyOrganizationCapability,
  setOrganizationRevocationHandler,
  revokeOrganizationSession,
} from './organization-capabilities.js';
import {
  initBackgroundAgentSessionHook,
  resetBackgroundAgentSessionHook,
} from './background-agent-session.js';
import {
  drainOrganizationDispatchQueue,
  requestOrganizationDispatch,
  stopOrganizationDispatchQueueForTests,
  type OrganizationDispatchRow,
} from './organization-dispatch.js';
import { createProjectVisibilityGate } from './project-visibility-middleware.js';
import createOrganizationDispatchRoutes from './routes/organization-dispatch.js';
import createSessionDispatchRoutes from './routes/session-dispatch.js';
import createCapabilityRoutes from './routes/organization-capabilities.js';
import type { Project, RouteDeps } from './types.js';

// Real CLIs never run: the chat entry point the dispatcher kicks off is a mock.
const handleChat = vi.fn(async () => {});

// Fault injection: simulate the process dying just before or just after the session
// row is created, before the dispatch facade records the outcome.
const fault = vi.hoisted(() => ({ at: null as null | 'before-create' | 'after-create' }));
vi.mock('./background-agent-session.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./background-agent-session.js')>();
  return {
    ...real,
    dispatchBackgroundAgentSession: (
      ...args: Parameters<typeof real.dispatchBackgroundAgentSession>
    ) => {
      if (fault.at === 'before-create') throw new Error('process stopped');
      const result = real.dispatchBackgroundAgentSession(...args);
      if (fault.at === 'after-create') throw new Error('process stopped');
      return result;
    },
  };
});

let organizationId: string;
let workspace: Project;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  // Stand-in for JWT login in this open-auth test server.
  app.use((req, _res, next) => {
    const user = req.get('x-test-user');
    if (user && !(req as AuthenticatedRequest).authOrganizationCapability)
      Object.assign(req, { authUserId: user, authOrgId: 'default', authRole: 'User' });
    next();
  });
  app.use(createCapabilityRoutes());
  app.use('/api/projects/:projectId', createProjectVisibilityGate({ findProject }));
  const deps = { findProject, findAgent, config, stmts: getStmts() } as unknown as RouteDeps;
  app.use(createSessionDispatchRoutes(deps));
  app.use(createOrganizationDispatchRoutes());
  return app;
}

function mint(): string {
  prepareOrganizationTurn('org-session', true, workspace);
  return issueOrganizationCapability('org-session', 'person');
}

function rows(): OrganizationDispatchRow[] {
  return getDb()
    .prepare('SELECT * FROM organization_dispatch_requests ORDER BY created_at, id')
    .all() as OrganizationDispatchRow[];
}

function targetSessions(): Array<{ id: string; owner_user_id: string }> {
  return getDb()
    .prepare("SELECT id, owner_user_id FROM sessions WHERE agent_id = 'target'")
    .all() as Array<{ id: string; owner_user_id: string }>;
}

function finishTurn(sessionId: string): void {
  getDb()
    .prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'assistant', ?)")
    .run(`m-${sessionId}`, sessionId, 'done');
}

const post = (token: string, body: Record<string, unknown>) =>
  request(makeApp())
    .post(`/api/organizations/${organizationId}/dispatches`)
    .set('X-API-Key', token)
    .send(body);

const task = (key: string, extra: Record<string, unknown> = {}) => ({
  projectId: 'linked',
  agentId: 'target',
  prompt: 'Fix the login bug',
  idempotencyKey: key,
  ...extra,
});

beforeEach(() => {
  resetOrganizationCapabilitiesForTests();
  initOrgsDb();
  setActiveOrgId('default');
  initDb(config.dataDir);
  for (const user of ['person', 'another']) {
    getOrgsDb()
      .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(user, user, 'unused');
  }
  createMembership('person', 'default', 'Owner');
  organizationId = createBusinessOrganization({
    serverId: 'default',
    name: 'Group',
    createdBy: 'person',
  }).id;
  workspace = {
    id: 'org-workspace',
    name: 'Group workspace',
    cwd: config.dataDir,
    ahw: '',
    kind: 'system',
    organizationId,
    serverId: 'default',
    workspaceKind: 'organization',
    agents: [
      {
        id: 'org-agent',
        name: 'Assistant',
        engine: 'claude-code',
        organizationScope: {
          enabled: true,
          tools: ['projects:read', 'dispatch'],
          projects: 'all-linked',
        },
      },
    ],
  } as Project;
  setProjects([
    workspace,
    {
      id: 'linked',
      name: 'Allowed',
      cwd: config.dataDir,
      ahw: '',
      agents: [
        { id: 'target', name: 'Dev', engine: 'claude-code' },
        { id: 'off', name: 'Paused', engine: 'claude-code', active: false },
        { id: 'checker', name: 'Reviewer', engine: 'claude-code', role: 'reviewer' },
      ],
    },
    {
      id: 'second',
      name: 'Also linked',
      cwd: config.dataDir,
      ahw: '',
      agents: [{ id: 'second-dev', name: 'Dev 2', engine: 'claude-code' }],
    },
    {
      id: 'unrelated',
      name: 'Independent',
      cwd: config.dataDir,
      ahw: '',
      agents: [{ id: 'free', name: 'Free', engine: 'claude-code' }],
    },
    {
      id: 'private',
      name: 'Secret',
      cwd: config.dataDir,
      ahw: '',
      visibility: 'private',
      ownerUserId: 'someone-else',
      agents: [{ id: 'hidden', name: 'Hidden', engine: 'claude-code' }],
    },
  ] as Project[]);
  attachBusinessOrganizationProject('default', organizationId, 'linked');
  attachBusinessOrganizationProject('default', organizationId, 'second');
  attachBusinessOrganizationProject('default', organizationId, 'private');
  const db = getDb();
  db.prepare('DELETE FROM organization_dispatch_requests').run();
  db.prepare("DELETE FROM sessions WHERE agent_id IN ('target', 'second-dev', 'free')").run();
  db.prepare(
    'INSERT OR REPLACE INTO sessions (id, agent_id, name, engine, model, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('org-session', 'org-agent', 'Chat', 'claude-code', 'test', 'person');
  setOrganizationRevocationHandler(() => {});
  handleChat.mockClear();
  initBackgroundAgentSessionHook({ stmts: getStmts(), config, handleChat, broadcast: vi.fn() });
});

afterEach(() => {
  fault.at = null;
  stopOrganizationDispatchQueueForTests();
  setActiveOrgId('default');
  vi.unstubAllEnvs();
});

describe('organization dispatch facade', () => {
  it('starts the target agent as the acting user and records provenance', async () => {
    const res = await post(mint(), task('k1')).expect(201);
    expect(res.body).toMatchObject({
      status: 'accepted',
      serverId: 'default',
      organizationId,
      organizationAgentId: 'org-agent',
      initiatingSessionId: 'org-session',
      actingUserId: 'person',
      projectId: 'linked',
      agentId: 'target',
      replayed: false,
    });
    expect(res.body.ref).toContain(`session:${res.body.sessionId}`);
    expect(res.body.resultPath).toBe(
      `/api/organizations/${organizationId}/context/projects/linked/sessions/${res.body.sessionId}`,
    );
    expect(getStmts().getSession.get(res.body.sessionId)).toMatchObject({
      owner_user_id: 'person',
      agent_id: 'target',
      finalize_automation: 'manual',
    });
    expect(handleChat).toHaveBeenCalledTimes(1);
    expect(handleChat.mock.calls[0]).toEqual([
      null,
      expect.objectContaining({ agentId: 'target', content: 'Fix the login bug' }),
    ]);
    expect(rows()).toEqual([
      expect.objectContaining({
        id: res.body.requestId,
        status: 'accepted',
        target_session_id: res.body.sessionId,
        workspace_id: 'org-workspace',
        idempotency_key: 'k1',
      }),
    ]);
    expect(getActiveOrgId()).toBe('default');
  });

  it('returns the same session for an identical retry and rejects a conflicting payload', async () => {
    const token = mint();
    const first = await post(token, task('same')).expect(201);
    const retry = await post(token, task('same')).expect(200);
    expect(retry.body).toMatchObject({
      requestId: first.body.requestId,
      sessionId: first.body.sessionId,
      replayed: true,
    });
    const conflict = await post(token, task('same', { prompt: 'Something else' })).expect(409);
    expect(conflict.body.code).toBe('idempotency_conflict');
    expect(targetSessions()).toHaveLength(1);
    expect(handleChat).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });

  it('gives clear outcomes for missing, inaccessible, disabled and ineligible targets', async () => {
    const token = mint();
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ agentId: 'nobody' }, 404, 'agent_not_found'],
      [{ agentId: 'off' }, 422, 'agent_disabled'],
      [{ agentId: 'checker' }, 422, 'agent_ineligible'],
      [{ projectId: 'unrelated', agentId: 'free' }, 404, 'target_not_found'],
      [{ projectId: 'private', agentId: 'hidden' }, 404, 'target_not_found'],
      [{ projectId: 'org-workspace', agentId: 'org-agent' }, 404, 'target_not_found'],
    ];
    for (const [i, [extra, status, code]] of cases.entries()) {
      const res = await post(token, task(`bad-${i}`, extra)).expect(status);
      expect(res.body).toMatchObject({ code, dispatch: { status: 'rejected', code } });
    }
    expect(handleChat).not.toHaveBeenCalled();
    expect(rows().map((r) => r.status)).toEqual(Array(cases.length).fill('rejected'));
  });

  it('never names the target agent of a refused request', async () => {
    // 'private' is linked but owned by someone else; 'unrelated' is not linked at all.
    const refused: Array<[string, Record<string, unknown>]> = [
      ['leak-private', { projectId: 'private', agentId: 'hidden' }],
      ['leak-unlinked', { projectId: 'unrelated', agentId: 'free' }],
    ];
    for (const [key, extra] of refused) {
      const viaAgent = await post(mint(), task(key, extra)).expect(404);
      expect(viaAgent.body.dispatch.agentName).toBeNull();
      const viaMember = await request(makeApp())
        .post(`/api/organizations/${organizationId}/sessions/org-session/dispatches`)
        .set('x-test-user', 'person')
        .send(task(`${key}-member`, extra))
        .expect(404);
      expect(viaMember.body.dispatch.agentName).toBeNull();
      // A retry of the same key re-evaluates in place and stays silent too.
      const retry = await post(mint(), task(key, extra)).expect(404);
      expect(retry.body.dispatch.agentName).toBeNull();
      for (const body of [viaAgent.body, viaMember.body, retry.body])
        expect(JSON.stringify(body)).not.toMatch(/Hidden|"Free"/);
    }
  });

  it('rejects disabled dispatch tools and out-of-scope targets the user can otherwise access', async () => {
    const scope = workspace.agents[0].organizationScope!;
    scope.tools = ['projects:read'];
    const noTool = await post(mint(), task('t1')).expect(403);
    expect(noTool.body.code).toBe('dispatch_not_permitted');

    scope.tools = ['projects:read', 'dispatch'];
    scope.projects = ['second'];
    const outside = await post(mint(), task('t2')).expect(404);
    expect(outside.body.code).toBe('target_not_found');
    // The template/name of the source agent grants nothing either.
    workspace.agents[0].name = 'CEO';
    workspace.agents[0].role = 'lead';
    await post(mint(), task('t3')).expect(404);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('refuses an archived or disabled source agent', async () => {
    const token = mint();
    workspace.agents[0].organizationScope!.archivedAt = '2026-10-19T00:00:00Z';
    await post(token, task('arch')).expect(401);
    delete workspace.agents[0].organizationScope!.archivedAt;
    workspace.agents[0].organizationScope!.enabled = false;
    await post(token, task('off')).expect(401);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('re-evaluates a rejected attempt in place when access is granted', async () => {
    workspace.agents[0].organizationScope!.projects = ['second'];
    await post(mint(), task('later')).expect(404);
    workspace.agents[0].organizationScope!.projects = 'all-linked';
    const res = await post(mint(), task('later')).expect(201);
    expect(rows()).toEqual([
      expect.objectContaining({ id: res.body.requestId, status: 'accepted', attempts: 2 }),
    ]);
  });

  it('records a failed start and retries it without duplicating', async () => {
    resetBackgroundAgentSessionHook();
    const token = mint();
    const failed = await post(token, task('hook')).expect(503);
    expect(failed.body.dispatch).toMatchObject({ status: 'failed', code: 'no_hook' });
    initBackgroundAgentSessionHook({ stmts: getStmts(), config, handleChat, broadcast: vi.fn() });
    const ok = await post(token, task('hook')).expect(201);
    expect(ok.body.requestId).toBe(failed.body.dispatch.requestId);
    expect(targetSessions()).toHaveLength(1);
  });

  it('records a failed first turn on the request', async () => {
    handleChat.mockRejectedValueOnce(new Error('engine missing'));
    const token = mint();
    const res = await post(token, task('kick')).expect(201);
    await vi.waitFor(() => expect(rows()[0]).toMatchObject({ status: 'failed' }));
    expect(rows()[0]).toMatchObject({
      outcome_code: 'kickoff_failed',
      target_session_id: res.body.sessionId,
    });
    // The session exists and stays the user's; a retry never starts another one.
    const retry = await post(token, task('kick')).expect(200);
    expect(retry.body).toMatchObject({ status: 'failed', sessionId: res.body.sessionId });
    expect(targetSessions()).toHaveLength(1);
  });
});

describe('busy targets and the queue', () => {
  it('queues behind a busy target and runs once it is free', async () => {
    const token = mint();
    const first = await post(token, task('a')).expect(201);
    const queued = await post(token, task('b')).expect(202);
    expect(queued.body).toMatchObject({ status: 'queued', code: 'target_busy', sessionId: null });
    // Other targets are not affected.
    await post(token, task('c', { projectId: 'second', agentId: 'second-dev' })).expect(201);
    // An identical retry of the queued request stays queued.
    const retry = await post(token, task('b')).expect(202);
    expect(retry.body).toMatchObject({ requestId: queued.body.requestId, replayed: true });

    drainOrganizationDispatchQueue();
    expect(rows().find((r) => r.id === queued.body.requestId)?.status).toBe('queued');

    finishTurn(first.body.sessionId);
    drainOrganizationDispatchQueue();
    const ran = rows().find((r) => r.id === queued.body.requestId)!;
    expect(ran).toMatchObject({ status: 'accepted' });
    expect(getStmts().getSession.get(ran.target_session_id!)).toMatchObject({
      owner_user_id: 'person',
      agent_id: 'target',
    });
    expect(targetSessions()).toHaveLength(2);

    const status = await request(makeApp())
      .get(`/api/organizations/${organizationId}/dispatches/${queued.body.requestId}`)
      .set('X-API-Key', token)
      .expect(200);
    expect(status.body).toMatchObject({ status: 'accepted', sessionId: ran.target_session_id });
  });

  it('revokes a queued request after an unlink and keeps accepted sessions with their owner', async () => {
    const token = mint();
    const first = await post(token, task('a')).expect(201);
    const queued = await post(token, task('b')).expect(202);
    detachBusinessOrganizationProject('default', organizationId, 'linked');
    finishTurn(first.body.sessionId);
    drainOrganizationDispatchQueue();
    expect(rows().find((r) => r.id === queued.body.requestId)).toMatchObject({
      status: 'revoked',
      outcome_code: 'access_revoked',
      target_session_id: null,
    });
    expect(targetSessions()).toEqual([{ id: first.body.sessionId, owner_user_id: 'person' }]);
    // The capability was revoked with the access change: no new requests.
    await post(token, task('c')).expect(401);
    await post(mint(), task('c')).expect(404);
  });

  it('revokes a queued request after unlink and relink (new link generation)', async () => {
    const token = mint();
    const first = await post(token, task('a')).expect(201);
    const queued = await post(token, task('b')).expect(202);
    detachBusinessOrganizationProject('default', organizationId, 'linked');
    attachBusinessOrganizationProject('default', organizationId, 'linked');
    finishTurn(first.body.sessionId);
    drainOrganizationDispatchQueue();
    expect(rows().find((r) => r.id === queued.body.requestId)?.status).toBe('revoked');
  });

  it('revokes a queued request when the dispatch tool is removed', async () => {
    const token = mint();
    const first = await post(token, task('a')).expect(201);
    const queued = await post(token, task('b')).expect(202);
    workspace.agents[0].organizationScope!.tools = ['projects:read'];
    finishTurn(first.body.sessionId);
    drainOrganizationDispatchQueue();
    expect(rows().find((r) => r.id === queued.body.requestId)?.status).toBe('revoked');
  });

  it('never drains another Server and never switches the active Server', async () => {
    const token = mint();
    await post(token, task('a')).expect(201);
    const queued = await post(token, task('b')).expect(202);
    getDb()
      .prepare("UPDATE organization_dispatch_requests SET server_id = 'elsewhere' WHERE id = ?")
      .run(queued.body.requestId);
    drainOrganizationDispatchQueue();
    expect(rows().find((r) => r.id === queued.body.requestId)?.status).toBe('queued');
    expect(getActiveOrgId()).toBe('default');
  });
});

describe('status lookup', () => {
  it('limits capability reads to the initiating session, even for the same user', async () => {
    getDb()
      .prepare(
        'INSERT OR REPLACE INTO sessions (id, agent_id, name, engine, model, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('org-session-2', 'org-agent', 'Other chat', 'claude-code', 'test', 'person');
    const own = mint();
    const res = await post(own, task('mine')).expect(201);
    prepareOrganizationTurn('org-session-2', true, workspace);
    const other = issueOrganizationCapability('org-session-2', 'person');
    const path = `/api/organizations/${organizationId}/dispatches/${res.body.requestId}`;

    await request(makeApp()).get(path).set('X-API-Key', other).expect(404);
    const list = await request(makeApp())
      .get(`/api/organizations/${organizationId}/dispatches`)
      .set('X-API-Key', other)
      .expect(200);
    expect(list.body.dispatches).toEqual([]);
    // The initiating session and the user's own login still see it.
    await request(makeApp()).get(path).set('X-API-Key', own).expect(200);
    await request(makeApp()).get(path).set('x-test-user', 'person').expect(200);
  });

  it('is visible to the acting user and hidden from others or after access loss', async () => {
    const token = mint();
    const res = await post(token, task('s')).expect(201);
    const path = `/api/organizations/${organizationId}/dispatches/${res.body.requestId}`;
    await request(makeApp()).get(path).set('x-test-user', 'person').expect(200);
    await request(makeApp()).get(path).set('x-test-user', 'another').expect(404);
    const list = await request(makeApp())
      .get(`/api/organizations/${organizationId}/dispatches`)
      .set('X-API-Key', token)
      .expect(200);
    expect(list.body.dispatches.map((d: { requestId: string }) => d.requestId)).toEqual([
      res.body.requestId,
    ]);

    detachBusinessOrganizationProject('default', organizationId, 'linked');
    await request(makeApp()).get(path).set('x-test-user', 'person').expect(404);
    // The target session itself stays the user's own session.
    expect(getStmts().getSession.get(res.body.sessionId)).toMatchObject({
      owner_user_id: 'person',
    });
  });

  it('rejects the facade without an organization capability', async () => {
    await request(makeApp())
      .post(`/api/organizations/${organizationId}/dispatches`)
      .set('x-test-user', 'person')
      .send(task('x'))
      .expect(403);
    expect(handleChat).not.toHaveBeenCalled();
  });
});

describe('project dispatch route with an organization capability', () => {
  it('goes through the facade, recording provenance and honoring Idempotency-Key', async () => {
    const token = mint();
    const send = () =>
      request(makeApp())
        .post('/api/projects/linked/sessions/dispatch')
        .set('X-API-Key', token)
        .set('Idempotency-Key', 'route-key')
        .send({ agentId: 'target', prompt: 'Do work' });
    const first = await send().expect(201);
    const retry = await send().expect(200);
    expect(retry.body.sessionId).toBe(first.body.sessionId);
    expect(rows()).toEqual([
      expect.objectContaining({ idempotency_key: 'route-key', status: 'accepted' }),
    ]);
    expect(targetSessions()).toHaveLength(1);
  });
});

describe('interrupted starts', () => {
  const crash = (at: 'before-create' | 'after-create') => {
    const grant = verifyOrganizationCapability(mint())!;
    fault.at = at;
    expect(() => requestOrganizationDispatch(grant, organizationId, task('crash'))).toThrow(
      'process stopped',
    );
    fault.at = null;
    // Restart: in-memory grants are gone, only durable state remains.
    resetOrganizationCapabilitiesForTests();
  };

  it('never starts a second session when the process stops after creating one', async () => {
    crash('after-create');
    const sessions = targetSessions();
    expect(sessions).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: 'starting', target_session_id: sessions[0]!.id });

    drainOrganizationDispatchQueue();
    drainOrganizationDispatchQueue();
    expect(rows()[0]).toMatchObject({
      status: 'failed',
      outcome_code: 'interrupted',
      target_session_id: sessions[0]!.id,
    });
    expect(targetSessions()).toEqual(sessions);
    expect(handleChat).toHaveBeenCalledTimes(1);

    const retry = await post(mint(), task('crash')).expect(200);
    expect(retry.body).toMatchObject({ replayed: true, sessionId: sessions[0]!.id });
    expect(targetSessions()).toHaveLength(1);
  });

  it('settles as accepted when the interrupted session had already sent its task', () => {
    crash('after-create');
    const [session] = targetSessions();
    getDb()
      .prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', ?)")
      .run(`u-${session!.id}`, session!.id, 'Fix the login bug');
    drainOrganizationDispatchQueue();
    expect(rows()[0]).toMatchObject({ status: 'accepted', target_session_id: session!.id });
    expect(targetSessions()).toHaveLength(1);
  });

  it('starts under the reserved id when the process stopped before creating the session', () => {
    crash('before-create');
    const reserved = rows()[0]!;
    expect(reserved).toMatchObject({ status: 'starting' });
    expect(targetSessions()).toHaveLength(0);

    drainOrganizationDispatchQueue();
    expect(rows()[0]).toMatchObject({
      status: 'accepted',
      target_session_id: reserved.target_session_id,
    });
    expect(targetSessions()).toEqual([{ id: reserved.target_session_id, owner_user_id: 'person' }]);
  });

  it('revokes an unstarted reservation whose access was lost meanwhile', () => {
    crash('before-create');
    detachBusinessOrganizationProject('default', organizationId, 'linked');
    drainOrganizationDispatchQueue();
    expect(rows()[0]).toMatchObject({ status: 'revoked', target_session_id: null });
    expect(targetSessions()).toHaveLength(0);
  });
});

describe('dispatch from the signed-in member', () => {
  const memberPost = (user: string, body: Record<string, unknown>, session = 'org-session') =>
    request(makeApp())
      .post(`/api/organizations/${organizationId}/sessions/${session}/dispatches`)
      .set('x-test-user', user)
      .send(body);

  it('dispatches from the caller’s own organization chat, once per idempotency key', async () => {
    const first = await memberPost('person', task('ui-1')).expect(201);
    expect(first.body).toMatchObject({
      status: 'accepted',
      initiatingSessionId: 'org-session',
      organizationAgentId: 'org-agent',
      actingUserId: 'person',
      projectId: 'linked',
      agentId: 'target',
      agentName: 'Dev',
    });
    // A double tap or network retry sends the same key: same request, no second session.
    const retry = await memberPost('person', task('ui-1')).expect(200);
    expect(retry.body).toMatchObject({
      requestId: first.body.requestId,
      sessionId: first.body.sessionId,
      replayed: true,
    });
    expect(targetSessions()).toHaveLength(1);
    expect(handleChat).toHaveBeenCalledTimes(1);
    const list = await request(makeApp())
      .get(`/api/organizations/${organizationId}/dispatches`)
      .set('x-test-user', 'person')
      .expect(200);
    expect(list.body.dispatches.map((d: { requestId: string }) => d.requestId)).toEqual([
      first.body.requestId,
    ]);
    expect(list.body.dispatches[0].agentName).toBe('Dev');
  });

  it('is not blocked by a lapsed agent CLI credential', async () => {
    const token = mint();
    revokeOrganizationSession('org-session');
    expect(verifyOrganizationCapability(token)).toBeNull();
    await memberPost('person', task('after-revoke')).expect(201);
  });

  it('hides chats the caller does not own and other organizations', async () => {
    const other = await memberPost('another', task('stolen')).expect(404);
    expect(other.body.code).toBe('session_not_found');
    await memberPost('person', task('missing'), 'no-such-session').expect(404);
    await request(makeApp())
      .post(`/api/organizations/not-this-org/sessions/org-session/dispatches`)
      .set('x-test-user', 'person')
      .send(task('wrong-org'))
      .expect(404);
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('applies the agent’s tools and project scope and current links', async () => {
    const scope = workspace.agents[0].organizationScope!;
    scope.tools = ['projects:read'];
    const noTool = await memberPost('person', task('m1')).expect(403);
    expect(noTool.body.code).toBe('dispatch_not_permitted');
    scope.tools = ['projects:read', 'dispatch'];
    detachBusinessOrganizationProject('default', organizationId, 'linked');
    const unlinked = await memberPost('person', task('m2')).expect(404);
    expect(unlinked.body.code).toBe('target_not_found');
    await memberPost('person', task('m3', { projectId: 'private', agentId: 'hidden' })).expect(404);
    scope.archivedAt = '2026-10-19T00:00:00Z';
    await memberPost('person', task('m4', { projectId: 'second', agentId: 'second-dev' })).expect(
      404,
    );
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('refuses organization capabilities on the member route', async () => {
    await request(makeApp())
      .post(`/api/organizations/${organizationId}/sessions/org-session/dispatches`)
      .set('X-API-Key', mint())
      .send(task('cap'))
      .expect((res) => expect([401, 403]).toContain(res.status));
    expect(handleChat).not.toHaveBeenCalled();
  });
});
