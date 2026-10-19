import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import config, { buildSpawnEnv } from './config.js';
import { initDb, getDb, getStmts } from './db.js';
import { initOrgsDb, getOrgsDb, setActiveOrgId } from './orgs.js';
import { createMembership } from './memberships-store.js';
import {
  initProjects,
  getProjects,
  getProjectsPath,
  reloadProjects,
  saveProjects,
  findAgent,
  getEnrichedAgent,
} from './project-model.js';
import {
  createBusinessOrganization,
  setBusinessOrganizationMember,
  removeBusinessOrganizationMember,
  attachBusinessOrganizationProject,
  detachBusinessOrganizationProject,
  archiveBusinessOrganization,
} from './business-organizations-store.js';
import {
  ensureOrganizationWorkspace,
  repairOrganizationWorkspaces,
  archiveOrganizationWorkspace,
  organizationWorkspaceId,
} from './organization-workspaces.js';
import { createOrganizationSession, organizationSessionCwd } from './organization-sessions.js';
import { appendOrganizationMemory, readOrganizationMemory } from './organization-memory.js';
import {
  prepareOrganizationTurn,
  resetOrganizationCapabilitiesForTests,
  issueOrganizationCapability,
  verifyOrganizationCapability,
  setOrganizationRevocationHandler,
} from './organization-capabilities.js';
import { isHubSystemProject, isInternalSystemProject } from '../shared/utils/hub.js';
import { canReadOrganizationWorkspaceEvent } from './business-organizations-access.js';
import { shouldDeliverBroadcast } from './broadcast-filter.js';
import { organizationSessionIdentity } from './organization-session-identity.js';
import { resolveProjectIdFromEvent } from './event-project-resolver.js';
import {
  userCanReadSession,
  userOwnsSession,
  type WsVisibilityStamp,
} from './session-ownership.js';
import createRuntimeRoutes from './routes/organization-runtime.js';
import createOrganizationsRoutes from './routes/organizations.js';
import createSessionRoutes from './routes/sessions.js';
import createDashboardRoutes from './routes/dashboard.js';
import createProjectRoutes from './routes/projects.js';
import { allAgents, findProject } from './project-model.js';
import type { RouteDeps } from './types.js';
import type { AuthenticatedRequest } from './auth.js';
import createChatHandler, { type ChatHandlerDeps } from './chat.js';
import { resolveSessionCliSpawnEnv } from './per-user-cli-spawn.js';
import type { ActiveChatProcess } from './active-chat-process.js';

vi.mock('./per-user-cli-spawn.js', () => ({
  EngineAuthRequiredError: class EngineAuthRequiredError extends Error {},
  resolveSessionCliSpawnEnv: vi.fn((opts) =>
    buildSpawnEnv(opts.cfg, { sessionId: opts.sessionId, userId: opts.ownerId }),
  ),
}));

let organizationId: string;
const stop = vi.fn();
beforeEach(() => {
  resetOrganizationCapabilitiesForTests();
  initOrgsDb();
  getOrgsDb().exec('DELETE FROM business_organizations');
  setActiveOrgId('default');
  initDb(config.dataDir);
  writeFileSync(path.join(config.dataDir, 'projects.json'), '[]');
  initProjects(config.dataDir);
  for (const user of ['owner', 'member', 'stranger']) {
    getOrgsDb()
      .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(user, user, 'unused');
    createMembership(user, 'default', user === 'stranger' ? 'Admin' : 'User');
  }
  organizationId = createBusinessOrganization({
    serverId: 'default',
    name: 'Business',
    createdBy: 'owner',
  }).id;
  setBusinessOrganizationMember('default', organizationId, 'member', 'Member');
  setOrganizationRevocationHandler(stop);
  stop.mockClear();
});
afterEach(() => {
  resetOrganizationCapabilitiesForTests();
  vi.restoreAllMocks();
});
function session(userId = 'owner', orgId = organizationId) {
  const project = ensureOrganizationWorkspace('default', orgId);
  return createOrganizationSession({
    serverId: 'default',
    organizationId: orgId,
    agentId: project.agents[0].id,
    userId,
    stmts: getStmts(),
    config,
  });
}
function app(userId = 'owner', serverId = 'default') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req as AuthenticatedRequest, { authUserId: userId, authOrgId: serverId });
    next();
  });
  app.use(createOrganizationsRoutes({ broadcast: vi.fn() }));
  app.use(createRuntimeRoutes({ stmts: getStmts(), config, broadcast: vi.fn() }));
  const deps = {
    stmts: getStmts(),
    config,
    broadcast: vi.fn(),
    findAgent,
    findProject,
    getProjects,
    allAgents,
    getEnrichedAgent,
  } as unknown as RouteDeps;
  app.use(createSessionRoutes(deps));
  app.use(createDashboardRoutes(deps));
  app.use(createProjectRoutes(deps));
  return app;
}
const url = () => `/api/organizations/${organizationId}/agents`;

describe('Organization workflow lifecycle', () => {
  it('hides runtime rows from project lists, dashboard activity and another user active-task snapshots', async () => {
    const row = session();
    const project = findAgent(row.agent_id)!.project;
    getDb()
      .prepare(
        `INSERT INTO active_tasks (session_id, message_id, agent_id, pid, prompt, streamed_output, engine, model, status, started_at)
      VALUES (?, 'org-msg', ?, 99999, 'Private priority', 'Private result', 'claude-code', NULL, 'running', datetime('now'))`,
      )
      .run(row.id, row.agent_id);
    const projects = await request(app('member')).get('/api/projects').expect(200);
    expect(JSON.stringify(projects.body)).not.toContain(project.id);
    expect((await request(app('member')).get('/api/active-tasks').expect(200)).body).toEqual([]);
    expect((await request(app('owner')).get('/api/active-tasks').expect(200)).body).toHaveLength(1);
    const dashboard = await request(app('member')).get('/api/orgs/default/dashboard').expect(200);
    expect(JSON.stringify(dashboard.body)).not.toContain(row.id);
    expect(JSON.stringify(dashboard.body)).not.toContain(row.agent_id);
    await request(app('member')).get(`/api/sessions/${row.id}`).expect(404);
    await request(app('owner')).get(`/api/sessions/${row.id}`).expect(200);
    await request(app('owner')).post(`/api/agents/${row.agent_id}/sessions`).send({}).expect(403);
    getDb().prepare('DELETE FROM active_tasks WHERE session_id = ?').run(row.id);
  });
  it('keeps retained active tasks private after agent removal and restart', async () => {
    const row = session('member');
    const project = findAgent(row.agent_id)!.project;
    getDb()
      .prepare(
        `INSERT INTO active_tasks (session_id, message_id, agent_id, pid, prompt, streamed_output, engine, model, status, started_at)
      VALUES (?, 'removed-agent-msg', ?, 99999, 'Private priority', 'Private result', 'claude-code', NULL, 'running', datetime('now'))`,
      )
      .run(row.id, row.agent_id);
    try {
      project.agents = [];
      saveProjects();
      expect(findAgent(row.agent_id)).toBeNull();
      expect((await request(app('owner')).get('/api/active-tasks').expect(200)).body).toEqual([]);
      expect((await request(app('stranger')).get('/api/active-tasks').expect(200)).body).toEqual(
        [],
      );
      expect((await request(app('member')).get('/api/active-tasks').expect(200)).body).toHaveLength(
        1,
      );

      reloadProjects(config.dataDir);
      repairOrganizationWorkspaces();
      resetOrganizationCapabilitiesForTests();
      expect(findAgent(row.agent_id)).toBeNull();
      expect((await request(app('owner')).get('/api/active-tasks').expect(200)).body).toEqual([]);
      expect((await request(app('member')).get('/api/active-tasks').expect(200)).body).toHaveLength(
        1,
      );

      const savedProjects = readFileSync(getProjectsPath(), 'utf8');
      const filterDeps = {
        resolveProjectId: resolveProjectIdFromEvent,
        findProject,
        getSessionOwner: (id: string) =>
          (getStmts().getSession.get(id) as { owner_user_id?: string | null } | undefined)
            ?.owner_user_id ?? null,
        getOrganizationSessionIdentity: organizationSessionIdentity,
        canReadOrganizationWorkspaceEvent,
      };
      const live = { type: 'text', sessionId: row.id, text: 'Private result' };
      const member = { userId: 'member', serverId: 'default' };
      expect(shouldDeliverBroadcast(live, member, filterDeps)).toBe(true);
      expect(
        shouldDeliverBroadcast(live, { userId: 'owner', serverId: 'default' }, filterDeps),
      ).toBe(false);
      writeFileSync(getProjectsPath(), '[]');
      reloadProjects(config.dataDir);
      expect((await request(app('member')).get('/api/active-tasks').expect(200)).body).toEqual([]);
      const stamps: Array<WsVisibilityStamp | undefined> = [
        undefined,
        { userId: null, localBypass: true },
        { userId: 'stranger', serverId: 'default', role: 'Owner' },
        member,
      ];
      for (const stamp of stamps) {
        expect(shouldDeliverBroadcast(live, stamp, filterDeps)).toBe(false);
        expect(shouldDeliverBroadcast({ sessionId: row.id }, stamp, filterDeps)).toBe(false);
      }
      writeFileSync(getProjectsPath(), savedProjects);
      reloadProjects(config.dataDir);

      removeBusinessOrganizationMember('default', organizationId, 'member');
      expect((await request(app('member')).get('/api/active-tasks').expect(200)).body).toEqual([]);
    } finally {
      getDb().prepare('DELETE FROM active_tasks WHERE session_id = ?').run(row.id);
    }
  });
  it('denies session HTTP reads and writes once the owner leaves the organization or switches Server', async () => {
    const row = session('member');
    getStmts().addMessage.run(
      'org-private-msg',
      row.id,
      'user',
      'Private transcript',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    const messages = `/api/sessions/${row.id}/messages?paginated=1`;
    const member = app('member');
    await request(member).get(`/api/sessions/${row.id}`).expect(200);
    expect(JSON.stringify((await request(member).get(messages).expect(200)).body)).toContain(
      'Private transcript',
    );

    const otherServer = app('member', 'other-server');
    await request(otherServer).get(`/api/sessions/${row.id}`).expect(404);
    await request(otherServer).get(messages).expect(404);
    expect(userOwnsSession({ authUserId: 'member', authOrgId: 'other-server' }, row.id)).toBe(
      false,
    );

    removeBusinessOrganizationMember('default', organizationId, 'member');
    await request(member).get(url()).expect(404);
    await request(member).get(`/api/sessions/${row.id}`).expect(404);
    const denied = await request(member).get(messages).expect(404);
    expect(JSON.stringify(denied.body)).not.toContain('Private transcript');
    await request(member).patch(`/api/sessions/${row.id}`).send({ name: 'Renamed' }).expect(404);
    expect(userOwnsSession({ authUserId: 'member', authOrgId: 'default' }, row.id)).toBe(false);
    expect(userCanReadSession({ authUserId: 'member', authOrgId: 'default' }, row.id)).toBe(false);
  });
  it('runs a mocked CLI in the owner context without Git worktrees or shared memory', async () => {
    const row = session('member');
    const output = path.join(config.dataDir, 'organization-spawn-record.txt');
    const bin = path.join(config.dataDir, 'organization-cli-stub.sh');
    writeFileSync(
      bin,
      `#!/bin/sh\npwd > '${output}'\nprintf '%s\\n' "$HOME" "$AGENT_HUB_CREDENTIAL_SCOPE" >> '${output}'\ncat >/dev/null 2>&1\nprintf '%s\\n' '{"type":"result","result":"Mock organization response"}'\n`,
    );
    chmodSync(bin, 0o755);
    const activeProcesses = new Map<string, ActiveChatProcess>();
    const ensureWorktree = vi.fn();
    const autoCommitAndPR = vi.fn();
    const broadcast = vi.fn();
    const { handleChat } = createChatHandler({
      broadcast,
      findAgent,
      getEnrichedAgent,
      activeProcesses,
      autonomousProjects: new Set(),
      getClaudeBin: () => bin,
      getCursorBin: () => bin,
      getGeminiBin: () => bin,
      getCodexBin: () => bin,
      getGrokBin: () => bin,
      uploadsDir: config.dataDir,
      resolveSlashSkill: vi.fn(),
      ensureWorktree,
      autoCommitAndPR,
      drainQueue: vi.fn(),
      tryAutonomousDispatch: vi.fn(),
    } as unknown as ChatHandlerDeps);
    await handleChat(null, {
      type: 'chat',
      agentId: row.agent_id,
      sessionId: row.id,
      content: 'Track priorities',
    });
    await vi.waitFor(() => expect(existsSync(output)).toBe(true), { timeout: 10000 });
    await vi.waitFor(() => expect(activeProcesses.size).toBe(0), { timeout: 10000 });
    expect(vi.mocked(resolveSessionCliSpawnEnv)).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'member', credsOwnerId: 'member', sessionId: row.id }),
    );
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    expect(lines[0]).toBe(organizationSessionCwd(row.id));
    expect(lines[1]).toContain('member');
    expect(lines[2]).toBe('organization');
    expect(ensureWorktree).not.toHaveBeenCalled();
    expect(autoCommitAndPR).not.toHaveBeenCalled();
    expect(broadcast.mock.calls.some(([event]) => event.type === 'error')).toBe(false);
  });
  it('seeds exactly one Assistant on API creation with Computer preference but no work or Git', async () => {
    const result = await request(app())
      .post('/api/organizations')
      .send({ name: 'New group' })
      .expect(201);
    const project = getProjects().find((p) => p.organizationId === result.body.organization.id)!;
    expect(project.agents).toHaveLength(1);
    expect(project.agents[0]).toMatchObject({
      name: 'Organization Assistant',
      isDev: false,
      computerToolEnabled: true,
      organizationScope: { enabled: true, projects: 'all-linked' },
    });
    expect(project.agents[0].systemPrompt).toMatch(
      /priorities.*summarize.*coordinate.*dispatch.*follow up/,
    );
    expect(project.agents[0].heartbeat).toBeUndefined();
    expect(isHubSystemProject(project)).toBe(false);
    expect(isInternalSystemProject(project)).toBe(true);
    expect(existsSync(path.join(project.cwd, '.git'))).toBe(false);
    expect(getStmts().getSessions.all(project.agents[0].id)).toEqual([]);
    expect(() => attachBusinessOrganizationProject('default', organizationId, project.id)).toThrow(
      'Project not found',
    );
  });
  it('preserves stable identity and every customization through repair and reload', () => {
    const project = ensureOrganizationWorkspace('default', organizationId);
    const agent = project.agents[0];
    Object.assign(agent, {
      name: 'My planner',
      systemPrompt: 'Custom shared context',
      model: 'custom-model',
      computerToolEnabled: false,
      organizationScope: { enabled: false, projects: [], tools: [] },
    });
    saveProjects();
    const saved = JSON.parse(readFileSync(getProjectsPath(), 'utf8'));
    rmSync(project.cwd, { recursive: true });
    reloadProjects(config.dataDir);
    repairOrganizationWorkspaces();
    repairOrganizationWorkspaces();
    expect(ensureOrganizationWorkspace('default', organizationId).agents).toEqual([agent]);
    expect(JSON.parse(readFileSync(getProjectsPath(), 'utf8'))).toEqual(saved);
    expect(existsSync(project.cwd)).toBe(true);
    expect(getProjects().filter((p) => p.organizationId === organizationId)).toHaveLength(1);
  });
  it('never recreates an archived, disabled or intentionally removed Assistant', () => {
    const project = ensureOrganizationWorkspace('default', organizationId);
    const id = project.agents[0].id;
    project.agents[0].organizationScope!.archivedAt = new Date().toISOString();
    saveProjects();
    reloadProjects(config.dataDir);
    repairOrganizationWorkspaces();
    expect(
      ensureOrganizationWorkspace('default', organizationId).agents[0].organizationScope!
        .archivedAt,
    ).toBeTruthy();
    const repaired = ensureOrganizationWorkspace('default', organizationId);
    repaired.agents = [];
    saveProjects();
    reloadProjects(config.dataDir);
    repairOrganizationWorkspaces();
    expect(ensureOrganizationWorkspace('default', organizationId)).toMatchObject({
      organizationAssistantId: id,
      agents: [],
    });
  });
  it('retains private history and denies credential fallback after an agent is removed and the process restarts', async () => {
    const row = session();
    const project = findAgent(row.agent_id)!.project;
    project.agents = [];
    saveProjects();
    reloadProjects(config.dataDir);
    repairOrganizationWorkspaces();
    resetOrganizationCapabilitiesForTests();
    expect(userCanReadSession({ authUserId: 'stranger', authRole: 'Admin' }, row.id)).toBe(false);
    expect(userCanReadSession({ authUserId: 'owner', authOrgId: 'default' }, row.id)).toBe(true);
    expect(() => buildSpawnEnv(config, { sessionId: row.id, userId: 'owner' })).toThrow(
      'Organization session unavailable',
    );
    expect(getProjects().find((p) => p.id === project.id)!.agents).toEqual([]);
    await request(app()).get(`/api/sessions/${row.id}/organization-memory`).expect(404);
    expect(resolveProjectIdFromEvent({ type: 'session-updated', session: { id: row.id } })).toBe(
      project.id,
    );
    const dashboard = await request(app('stranger')).get('/api/orgs/default/dashboard').expect(200);
    expect(JSON.stringify(dashboard.body)).not.toContain(row.id);
  });
  it('uses the same session runtime for arbitrary organization agent identities with an empty scope', async () => {
    const project = ensureOrganizationWorkspace('default', organizationId);
    const custom = {
      id: 'custom-stable-id',
      name: 'CEO',
      engine: 'claude-code',
      systemPrompt: 'Custom instructions',
      organizationScope: { enabled: true, projects: [] as string[], tools: [] },
    };
    project.agents.push(custom);
    saveProjects();
    const result = await request(app('member'))
      .post(`${url()}/${custom.id}/sessions`)
      .send({})
      .expect(201);
    prepareOrganizationTurn(result.body.session.id, true);
    const grant = verifyOrganizationCapability(
      issueOrganizationCapability(result.body.session.id, 'member'),
    );
    expect(grant).toMatchObject({
      agentId: custom.id,
      projectIds: [],
      tools: [],
      userId: 'member',
    });
    expect(result.body.agent.computerToolEnabled).toBeUndefined();
    repairOrganizationWorkspaces();
    expect(project.agents).toHaveLength(2);
  });
  it('creates separate user-owned chats and isolates files by user, organization and Server', () => {
    const one = session(),
      two = session('member');
    const otherOrg = createBusinessOrganization({
      serverId: 'default',
      name: 'Other',
      createdBy: 'owner',
    }).id;
    const other = session('owner', otherOrg);
    for (const row of [one, two, other]) prepareOrganizationTurn(row.id, true);
    expect(one).toMatchObject({
      owner_user_id: 'owner',
      use_worktree: 0,
      session_mode: 'consult',
      worktree_path: null,
    });
    const paths = [one, two, other].map((row) => organizationSessionCwd(row.id));
    expect(new Set(paths).size).toBe(3);
    paths.forEach((cwd) => expect(existsSync(cwd)).toBe(true));
    expect(organizationWorkspaceId('server-1', organizationId)).not.toBe(
      organizationWorkspaceId('server-2', organizationId),
    );
    expect(userCanReadSession({ authUserId: 'member', authRole: 'Admin' }, one.id)).toBe(false);
    expect(userCanReadSession({ authUserId: 'owner', authOrgId: 'default' }, one.id)).toBe(true);
  });
  it('filters private memory by project provenance and rotates cwd on revocation and restart', () => {
    const project = ensureOrganizationWorkspace('default', organizationId);
    getProjects().push({ id: 'linked', name: 'Linked', cwd: config.dataDir, ahw: '', agents: [] });
    saveProjects();
    attachBusinessOrganizationProject('default', organizationId, 'linked');
    const one = session(),
      two = session('member');
    prepareOrganizationTurn(one.id, true);
    prepareOrganizationTurn(two.id, true);
    const cwd = organizationSessionCwd(one.id);
    writeFileSync(path.join(cwd, 'MEMORY.md'), 'old access context');
    appendOrganizationMemory(one.id, {
      projectId: 'linked',
      sourceRecord: 'wiki/plan',
      content: 'Priority',
    });
    expect(readOrganizationMemory(one.id)[0]).toMatchObject({
      content: 'Priority',
      organizationId,
      projectId: 'linked',
      sourceRecord: 'wiki/plan',
      serverId: 'default',
    });
    expect(readOrganizationMemory(two.id)).toEqual([]);
    const token = issueOrganizationCapability(one.id, 'owner');
    detachBusinessOrganizationProject('default', organizationId, 'linked');
    expect(verifyOrganizationCapability(token)).toBeNull();
    expect(stop).toHaveBeenCalledWith(one.id);
    expect(() => prepareOrganizationTurn(one.id, false)).toThrow();
    prepareOrganizationTurn(one.id, true);
    expect(readOrganizationMemory(one.id)).toEqual([]);
    expect(organizationSessionCwd(one.id)).not.toBe(cwd);
    attachBusinessOrganizationProject('default', organizationId, 'linked');
    prepareOrganizationTurn(one.id, true);
    expect(organizationSessionCwd(one.id)).not.toBe(cwd);
    const beforeRestart = organizationSessionCwd(one.id);
    resetOrganizationCapabilitiesForTests();
    prepareOrganizationTurn(one.id, true);
    expect(organizationSessionCwd(one.id)).not.toBe(beforeRestart);
    project.agents[0].organizationScope!.projects = [];
    saveProjects();
    prepareOrganizationTurn(one.id, true);
    expect(readOrganizationMemory(one.id)).toEqual([]);
  });
  it('enforces ownership and authorized provenance on memory HTTP reads and writes', async () => {
    getProjects().push({
      id: 'memory-source',
      name: 'Source',
      cwd: config.dataDir,
      ahw: '',
      agents: [],
    });
    saveProjects();
    attachBusinessOrganizationProject('default', organizationId, 'memory-source');
    const row = session();
    prepareOrganizationTurn(row.id, true);
    const endpoint = `/api/sessions/${row.id}/organization-memory`;
    await request(app())
      .post(endpoint)
      .send({ projectId: 'memory-source', sourceRecord: 'wiki/plan', content: 'Private note' })
      .expect(201);
    expect((await request(app()).get(endpoint).expect(200)).body.memories).toHaveLength(1);
    await request(app('member')).get(endpoint).expect(404);
    await request(app('stranger'))
      .post(endpoint)
      .send({ projectId: 'memory-source', sourceRecord: 'wiki/plan', content: 'Injected' })
      .expect(404);
    await request(app())
      .post(endpoint)
      .send({ projectId: 'unlinked', sourceRecord: 'wiki/plan', content: 'Untrusted' })
      .expect(404);
    await request(app()).post(endpoint).send({ content: 'No provenance' }).expect(400);
    detachBusinessOrganizationProject('default', organizationId, 'memory-source');
    prepareOrganizationTurn(row.id, true);
    expect((await request(app()).get(endpoint).expect(200)).body.memories).toEqual([]);
  });
  it('archives the workspace and stops running access while retaining owner history', () => {
    const one = session();
    prepareOrganizationTurn(one.id, true);
    const token = issueOrganizationCapability(one.id, 'owner');
    archiveBusinessOrganization('default', organizationId);
    archiveOrganizationWorkspace('default', organizationId);
    repairOrganizationWorkspaces();
    expect(verifyOrganizationCapability(token)).toBeNull();
    expect(stop).toHaveBeenCalledWith(one.id);
    expect(findAgent(one.agent_id)!.project.archivedAt).toBeTruthy();
    expect(getStmts().getSession.get(one.id)).toBeTruthy();
    expect(userCanReadSession({ authUserId: 'owner', authOrgId: 'default' }, one.id)).toBe(true);
    expect(() => session()).toThrow();
  });
  it('delivers live organization chat only to its current owner/member, with no admin bypass', () => {
    const row = session();
    const project = findAgent(row.agent_id)!.project;
    const deps = {
      resolveProjectId: () => project.id,
      findProject: () => project,
      getSessionOwner: () => 'owner',
      canReadOrganizationWorkspaceEvent,
    };
    const event = { type: 'text', sessionId: row.id, text: 'private' };
    expect(shouldDeliverBroadcast(event, { userId: 'owner', serverId: 'default' }, deps)).toBe(
      true,
    );
    expect(shouldDeliverBroadcast(event, { userId: 'member', serverId: 'default' }, deps)).toBe(
      false,
    );
    expect(
      shouldDeliverBroadcast(
        event,
        { userId: 'stranger', serverId: 'default', role: 'Admin' },
        deps,
      ),
    ).toBe(false);
    expect(shouldDeliverBroadcast(event, { userId: 'owner', serverId: 'other' }, deps)).toBe(false);
    archiveBusinessOrganization('default', organizationId);
    expect(shouldDeliverBroadcast(event, { userId: 'owner', serverId: 'default' }, deps)).toBe(
      false,
    );
  });
  it('authorizes editing and session creation and keeps archived identities through API repair', async () => {
    const roster = await request(app()).get(url()).expect(200);
    const id = roster.body.agents[0].id;
    await request(app('member')).patch(`${url()}/${id}`).send({ name: 'No' }).expect(403);
    await request(app())
      .patch(`${url()}/${id}`)
      .send({ name: 'Coordinator', systemPrompt: 'Our shared plan' })
      .expect(200);
    const created = await request(app('member'))
      .post(`${url()}/${id}/sessions`)
      .send({})
      .expect(201);
    expect(created.body.session).toMatchObject({
      owner_user_id: 'member',
      agent_id: id,
      use_worktree: 0,
    });
    await request(app('stranger')).post(`${url()}/${id}/sessions`).send({}).expect(404);
    await request(app()).patch(`${url()}/${id}`).send({ archived: true }).expect(200);
    await request(app()).post(`${url()}/${id}/sessions`).send({}).expect(404);
    expect((await request(app('member')).get(url()).expect(200)).body.agents).toEqual([]);
    repairOrganizationWorkspaces();
    expect((await request(app()).get(url()).expect(200)).body.agents).toHaveLength(1);
    expect(
      getDb()
        .prepare('SELECT owner_user_id FROM sessions WHERE id = ?')
        .get(created.body.session.id),
    ).toEqual({ owner_user_id: 'member' });
  });
});
