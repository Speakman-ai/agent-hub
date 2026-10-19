import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import config from './config.js';
import { initDb, getDb, getStmts } from './db.js';
import { initOrgsDb, getOrgsDb, setActiveOrgId } from './orgs.js';
import { createMembership } from './memberships-store.js';
import {
  findAgent,
  getProjects,
  initProjects,
  reloadProjects,
  setProjects,
} from './project-model.js';
import {
  attachBusinessOrganizationProject,
  createBusinessOrganization,
  setBusinessOrganizationMember,
} from './business-organizations-store.js';
import {
  ensureOrganizationWorkspace,
  repairOrganizationWorkspaces,
} from './organization-workspaces.js';
import {
  issueOrganizationCapability,
  organizationCapabilityAllows,
  organizationSessionAllowsTool,
  prepareOrganizationTurn,
  resetOrganizationCapabilitiesForTests,
  setOrganizationRevocationHandler,
  verifyOrganizationCapability,
} from './organization-capabilities.js';
import { ORGANIZATION_AGENT_TEMPLATES } from './organization-agent-templates.js';
import createRuntimeRoutes from './routes/organization-runtime.js';
import type { AuthenticatedRequest } from './auth.js';
import type { Project } from './types.js';

// No route here spawns a CLI; the guard in test/setup.ts would fail loudly if one did.
let organizationId: string;
const stop = vi.fn();
const broadcast = vi.fn();
const model = config.engineValidModels['claude-code'][0];

beforeEach(() => {
  resetOrganizationCapabilitiesForTests();
  initOrgsDb();
  getOrgsDb().exec('DELETE FROM business_organizations');
  setActiveOrgId('default');
  initDb(config.dataDir);
  initProjects(config.dataDir);
  for (const [user, role] of [
    ['owner', 'User'],
    ['admin', 'User'],
    ['member', 'User'],
    ['server-admin', 'Admin'],
  ] as const) {
    getOrgsDb()
      .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(user, user, 'unused');
    createMembership(user, 'default', role);
  }
  const shared = (id: string): Project => ({
    id,
    name: id,
    cwd: config.dataDir,
    ahw: '',
    agents: [],
  });
  setProjects([
    shared('alpha'),
    shared('beta'),
    shared('unlinked'),
    {
      ...shared('secret'),
      visibility: 'private',
      ownerUserId: 'owner',
    },
  ]);
  organizationId = createBusinessOrganization({
    serverId: 'default',
    name: 'Business',
    createdBy: 'owner',
  }).id;
  setBusinessOrganizationMember('default', organizationId, 'admin', 'Admin');
  setBusinessOrganizationMember('default', organizationId, 'member', 'Member');
  for (const id of ['alpha', 'beta', 'secret'])
    attachBusinessOrganizationProject('default', organizationId, id);
  ensureOrganizationWorkspace('default', organizationId);
  setOrganizationRevocationHandler(stop);
  stop.mockClear();
  broadcast.mockClear();
});
afterEach(() => {
  resetOrganizationCapabilitiesForTests();
  vi.restoreAllMocks();
});

function app(userId = 'owner') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req as AuthenticatedRequest, { authUserId: userId, authOrgId: 'default' });
    next();
  });
  app.use(createRuntimeRoutes({ stmts: getStmts(), config, broadcast }));
  return app;
}
const url = () => `/api/organizations/${organizationId}/agents`;
const workspace = () => ensureOrganizationWorkspace('default', organizationId);

async function create(body: object, userId = 'owner') {
  return (await request(app(userId)).post(url()).send(body).expect(201)).body.agent;
}
async function openSession(agentId: string, userId: string) {
  const res = await request(app(userId)).post(`${url()}/${agentId}/sessions`).send({}).expect(201);
  const id = res.body.session.id as string;
  prepareOrganizationTurn(id, true);
  return id;
}

describe('organization agent lifecycle', () => {
  it('creates custom agents with distinct stable identities, least-privilege defaults and Computer off', async () => {
    const one = await create({ name: 'Planner' });
    const two = await create({ name: 'Planner' });
    expect(one.id).not.toBe(two.id);
    expect(one).toMatchObject({
      name: 'Planner',
      engine: 'claude-code',
      computerToolEnabled: false,
      isAssistant: false,
      organizationScope: {
        enabled: true,
        archivedAt: null,
        projects: 'all-linked',
        tools: ['projects:read'],
      },
    });
    expect(one.organizationTemplate).toBeUndefined();
    expect(findAgent(one.id)!.project.id).toBe(workspace().id);
    // Fresh agents never start a session, heartbeat or desktop.
    expect(getStmts().getSessions.all(one.id)).toEqual([]);
    expect(findAgent(one.id)!.agent.heartbeat).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'organization_updated',
        action: 'agent_created',
        agentId: one.id,
      }),
    );
    // Restart preserves both identities and does not add or reseed anything.
    reloadProjects(config.dataDir);
    repairOrganizationWorkspaces();
    expect(workspace().agents.map((a) => a.id)).toEqual([
      workspace().organizationAssistantId,
      one.id,
      two.id,
    ]);
  });

  it('copies template instructions only, never tools, projects or Computer, and keeps role names descriptive', async () => {
    const templates = (
      await request(app('member'))
        .get(`/api/organizations/${organizationId}/agent-templates`)
        .expect(200)
    ).body.templates;
    expect(templates.map((t: { label: string }) => t.label)).toEqual([
      'CEO',
      'Finance',
      'Operations',
      'Technical Lead',
      'Marketing',
    ]);
    const finance = ORGANIZATION_AGENT_TEMPLATES.find((t) => t.id === 'finance')!;
    const agent = await create({ templateId: 'finance', tools: [] });
    expect(agent).toMatchObject({
      name: 'Finance',
      systemPrompt: finance.instructions,
      computerToolEnabled: false,
      organizationTemplate: { id: 'finance', version: finance.version },
      organizationScope: { tools: [], projects: 'all-linked' },
    });
    expect(findAgent(agent.id)!.agent.role).toBeUndefined();
    // Customizations survive; a template is never re-applied over an existing agent.
    await request(app())
      .patch(`${url()}/${agent.id}`)
      .send({ name: 'Money', systemPrompt: 'Ours' })
      .expect(200);
    reloadProjects(config.dataDir);
    repairOrganizationWorkspaces();
    expect(findAgent(agent.id)!.agent).toMatchObject({ name: 'Money', systemPrompt: 'Ours' });

    await request(app()).post(url()).send({ templateId: 'cfo' }).expect(400);
    await request(app()).post(url()).send({}).expect(400);
  });

  it('validates engine, model, tools and the Computer preference', async () => {
    await request(app()).post(url()).send({ name: 'X', engine: 'nope' }).expect(400);
    await request(app()).post(url()).send({ name: 'X', model: 'not-a-model' }).expect(400);
    await request(app())
      .post(url())
      .send({ name: 'X', tools: ['root'] })
      .expect(400);
    await request(app()).post(url()).send({ name: 'X', role: 'lead' }).expect(400);
    await request(app()).post(url()).send({ name: 'X', computerToolEnabled: true }).expect(400);
    const agent = await create({
      name: 'Desk',
      tools: ['computer'],
      computerToolEnabled: true,
      model,
    });
    expect(agent).toMatchObject({ computerToolEnabled: true, model });
    await request(app()).patch(`${url()}/${agent.id}`).send({ engine: 'codex-cli' }).expect(400);
    await request(app()).patch(`${url()}/${agent.id}`).send({ model: 'not-a-model' }).expect(400);
    // Removing the permission clears the dangling preference.
    const patched = await request(app())
      .patch(`${url()}/${agent.id}`)
      .send({ tools: ['web'] })
      .expect(200);
    expect(patched.body.agent).toMatchObject({
      computerToolEnabled: false,
      organizationScope: { tools: ['web'] },
    });
  });

  it('restricts configuration to organization and Server administrators', async () => {
    await request(app('member')).post(url()).send({ name: 'Mine' }).expect(403);
    const agent = await create({ name: 'Shared' }, 'admin');
    await create({ name: 'Server side' }, 'server-admin');
    await request(app('member'))
      .patch(`${url()}/${agent.id}`)
      .send({ tools: ['dispatch', 'computer'], projects: 'all-linked' })
      .expect(403);
    await request(app('member')).patch(`${url()}/${agent.id}`).send({ enabled: true }).expect(403);
    expect(findAgent(agent.id)!.agent.organizationScope!.tools).toEqual(['projects:read']);
    // Members can read and use permitted agents.
    await request(app('member')).get(`${url()}/${agent.id}`).expect(200);
    await openSession(agent.id, 'member');
  });

  it('intersects all-linked, explicit and empty scopes with the acting user ACL', async () => {
    const all = await create({ name: 'All' });
    const subset = await create({ name: 'Subset', projects: ['alpha', 'secret'] });
    const empty = await create({ name: 'Empty', projects: [] });
    // Members cannot see the private project, so it never appears in their responses.
    const memberView = (await request(app('member')).get(`${url()}/${subset.id}`).expect(200)).body
      .agent;
    expect(memberView.organizationScope.projects).toEqual(['alpha']);
    expect(memberView.effectiveProjectIds).toEqual(['alpha']);
    expect(subset.effectiveProjectIds).toEqual(['alpha', 'secret']);

    const scopes: Record<string, string[]> = {};
    for (const [agent, user] of [
      [all, 'owner'],
      [all, 'member'],
      [subset, 'owner'],
      [subset, 'member'],
      [empty, 'owner'],
    ] as const) {
      const session = await openSession(agent.id, user);
      scopes[`${agent.name}:${user}`] = verifyOrganizationCapability(
        issueOrganizationCapability(session, user),
      )!.projectIds;
    }
    expect(scopes).toEqual({
      'All:owner': ['alpha', 'beta', 'secret'],
      'All:member': ['alpha', 'beta'],
      'Subset:owner': ['alpha', 'secret'],
      'Subset:member': ['alpha'],
      'Empty:owner': [],
    });
  });

  it('rejects scope IDs that are unlinked, foreign, hidden or invisible to the administrator', async () => {
    for (const projects of [['unlinked'], ['missing'], [workspace().id]])
      await request(app()).post(url()).send({ name: 'X', projects }).expect(400);
    // The private project is linked but this administrator cannot see it.
    const res = await request(app('admin'))
      .post(url())
      .send({ name: 'X', projects: ['secret'] })
      .expect(400);
    expect(res.body.error).toBe('Unknown or inaccessible project in scope');
  });

  it('honors tool settings for dispatch, Computer and host actions', async () => {
    const reader = await create({ name: 'Reader' });
    const worker = await create({
      name: 'Worker',
      tools: ['projects:read', 'dispatch', 'computer'],
      computerToolEnabled: true,
    });
    const readerSession = await openSession(reader.id, 'owner');
    const workerSession = await openSession(worker.id, 'owner');
    const readerGrant = verifyOrganizationCapability(
      issueOrganizationCapability(readerSession, 'owner'),
    )!;
    const workerGrant = verifyOrganizationCapability(
      issueOrganizationCapability(workerSession, 'owner'),
    )!;
    const dispatch = '/api/projects/alpha/sessions/dispatch';
    expect(organizationCapabilityAllows(readerGrant, 'POST', dispatch)).toBe(false);
    expect(organizationCapabilityAllows(workerGrant, 'POST', dispatch)).toBe(true);
    expect(organizationSessionAllowsTool(readerSession, 'computer')).toBe(false);
    expect(organizationSessionAllowsTool(workerSession, 'computer')).toBe(true);
    // A per-session Computer override cannot exceed the agent's tool permission.
    getDb()
      .prepare('UPDATE sessions SET computer_tool_enabled = 1 WHERE id = ?')
      .run(readerSession);
    expect(organizationSessionAllowsTool(readerSession, 'computer')).toBe(false);
  });

  it('revokes capabilities, stops turns and forces fresh context when configuration narrows', async () => {
    const agent = await create({ name: 'Worker', tools: ['projects:read', 'dispatch'] });
    const session = await openSession(agent.id, 'owner');
    getDb().prepare("UPDATE sessions SET engine_session_id = 'cached' WHERE id = ?").run(session);
    const token = issueOrganizationCapability(session, 'owner');
    await request(app())
      .patch(`${url()}/${agent.id}`)
      .send({ tools: ['projects:read'], projects: ['alpha'] })
      .expect(200);
    expect(stop).toHaveBeenCalledWith(session);
    expect(verifyOrganizationCapability(token)).toBeNull();
    expect(() => prepareOrganizationTurn(session, false)).toThrow('Organization access changed');
    expect(
      getDb().prepare('SELECT engine_session_id FROM sessions WHERE id = ?').get(session),
    ).toEqual({ engine_session_id: null });
    // A new user turn rebuilds context with the narrowed scope.
    prepareOrganizationTurn(session, true);
    expect(
      verifyOrganizationCapability(issueOrganizationCapability(session, 'owner')),
    ).toMatchObject({ tools: ['projects:read'], projectIds: ['alpha'] });
  });

  it('edits name, prompt and model without losing history', async () => {
    const agent = await create({ name: 'Writer' });
    const session = await openSession(agent.id, 'member');
    getStmts().addMessage.run(
      'm1',
      session,
      'user',
      'hello',
      'claude-code',
      model,
      null,
      null,
      null,
      null,
      null,
    );
    await request(app())
      .patch(`${url()}/${agent.id}`)
      .send({ name: 'Editor', systemPrompt: 'New brief', model })
      .expect(200);
    expect(findAgent(agent.id)!.agent).toMatchObject({ id: agent.id, name: 'Editor', model });
    expect(getStmts().getMessages.all(session)).toHaveLength(1);
    prepareOrganizationTurn(session, true);
    await request(app('member')).post(`${url()}/${agent.id}/sessions`).send({}).expect(201);
  });

  it('disables and archives with retained history and no resurrection on restart', async () => {
    const agent = await create({ name: 'Temp' });
    const session = await openSession(agent.id, 'member');
    const token = issueOrganizationCapability(session, 'member');
    await request(app()).patch(`${url()}/${agent.id}`).send({ enabled: false }).expect(200);
    expect(stop).toHaveBeenCalledWith(session);
    expect(verifyOrganizationCapability(token)).toBeNull();
    await request(app('member')).get(`${url()}/${agent.id}`).expect(404);
    await request(app('member')).post(`${url()}/${agent.id}/sessions`).send({}).expect(404);
    await request(app()).patch(`${url()}/${agent.id}`).send({ enabled: true }).expect(200);
    await request(app('member')).get(`${url()}/${agent.id}`).expect(200);

    // The default Assistant uses the same lifecycle.
    const assistantId = workspace().organizationAssistantId!;
    for (const id of [agent.id, assistantId])
      await request(app()).patch(`${url()}/${id}`).send({ archived: true }).expect(200);
    reloadProjects(config.dataDir);
    repairOrganizationWorkspaces();
    const roster = (await request(app()).get(url()).expect(200)).body.agents;
    expect(roster.map((a: { id: string }) => a.id)).toEqual([assistantId, agent.id]);
    expect(
      roster.every(
        (a: { organizationScope: { archivedAt: string } }) => a.organizationScope.archivedAt,
      ),
    ).toBe(true);
    expect((await request(app('member')).get(url()).expect(200)).body.agents).toEqual([]);
    expect(getDb().prepare('SELECT owner_user_id FROM sessions WHERE id = ?').get(session)).toEqual(
      { owner_user_id: 'member' },
    );
    expect(() => prepareOrganizationTurn(session, true)).toThrow(
      'Organization session unavailable',
    );
  });

  it('renames and configures the default Assistant without changing its identity', async () => {
    const id = workspace().organizationAssistantId!;
    const res = await request(app())
      .patch(`${url()}/${id}`)
      .send({ name: 'Chief of staff', tools: ['projects:read'], projects: [] })
      .expect(200);
    expect(res.body.agent).toMatchObject({
      id,
      name: 'Chief of staff',
      isAssistant: true,
      computerToolEnabled: false,
      organizationScope: { projects: [], tools: ['projects:read'] },
    });
    repairOrganizationWorkspaces();
    expect(workspace().agents).toHaveLength(1);
  });

  it('keeps workspaces from other organizations unreachable', async () => {
    const other = createBusinessOrganization({
      serverId: 'default',
      name: 'Other',
      createdBy: 'owner',
    }).id;
    const foreign = ensureOrganizationWorkspace('default', other).agents[0].id;
    await request(app()).get(`${url()}/${foreign}`).expect(404);
    await request(app()).patch(`${url()}/${foreign}`).send({ name: 'Hijack' }).expect(404);
    expect(getProjects().find((p) => p.organizationId === other)!.agents[0].name).toBe(
      'Organization Assistant',
    );
  });
});

describe('organization chat history', () => {
  it("lists only the caller's own chats and keeps them after the agent is archived", async () => {
    const agent = await create({ name: 'Marketing', templateId: 'marketing' });
    const mine = await openSession(agent.id, 'member');
    await openSession(agent.id, 'admin');
    const list = async (userId: string) =>
      (await request(app(userId)).get(`/api/organizations/${organizationId}/sessions`).expect(200))
        .body.sessions;
    expect((await list('member')).map((s: { id: string }) => s.id)).toEqual([mine]);
    await request(app('owner')).patch(`${url()}/${agent.id}`).send({ archived: true }).expect(200);
    expect(await list('member')).toEqual([
      expect.objectContaining({ id: mine, agentName: 'Marketing', agentAvailable: false }),
    ]);
    await request(app('outsider')).get(`/api/organizations/${organizationId}/sessions`).expect(404);
  });
});
