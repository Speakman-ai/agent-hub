/**
 * Product acceptance for Servers + organizations, driven through the HTTP routes in the order
 * a person uses them. It is the CI-gated twin of e2e/organizations/organization-workflow.spec.ts
 * (which drives the same journey through the web client but is not part of Finalize CI).
 *
 * Create two organizations, link one project to both and leave another independent,
 * customize agents (rename the Assistant, add one from scratch with a project subset, add one
 * from an optional template), check that the scoped agent's capability is refused outside its
 * scope, dispatch a project agent, check Computer defaults and isolation, check that a
 * restricted member sees nothing they can't already access, then unlink, archive and restart
 * without resurrection. No agent CLI runs: dispatched turns land in a mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authMiddleware, type AuthenticatedRequest } from '../auth.js';
import config from '../config.js';
import { initDb, getDb, getStmts } from '../db.js';
import { getOrgsDb, initOrgsDb, setActiveOrgId, setOrgsDbPathForTests } from '../orgs.js';
import { setAuthFilePathForTests } from '../auth-store.js';
import { findAgent, findProject, getProjects, setProjects } from '../project-model.js';
import { createMembership, getMembershipRole } from '../memberships-store.js';
import { addProjectMember } from '../project-members-store.js';
import { repairOrganizationWorkspaces } from '../organization-workspaces.js';
import {
  issueOrganizationCapability,
  organizationSessionAllowsTool,
  prepareOrganizationTurn,
  resetOrganizationCapabilitiesForTests,
} from '../organization-capabilities.js';
import { clearOrganizationContextCache } from '../organization-context.js';
import { stopOrganizationDispatchQueueForTests } from '../organization-dispatch.js';
import { initBackgroundAgentSessionHook } from '../background-agent-session.js';
import { resolveDesktopComputerIdentity } from '../desktop/desktop-computer-identity.js';
import { createProjectVisibilityGate } from '../project-visibility-middleware.js';
import createCapabilityRoutes from '../routes/organization-capabilities.js';
import createOrganizationContextRoutes from '../routes/organization-context.js';
import createOrganizationDispatchRoutes from '../routes/organization-dispatch.js';
import createOrganizationRuntimeRoutes from '../routes/organization-runtime.js';
import createOrganizationsRoutes from '../routes/organizations.js';
import createWikiRoutes from '../routes/wiki.js';
import { createPage } from '../wiki.js';
import type { Project, RouteDeps } from '../types.js';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('../orgs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orgs.js')>()),
  orgDataDir: (id: string) => path.join(fixture.directory, 'servers', id),
}));

// Real CLIs never run: every dispatched turn lands here.
const handleChat = vi.fn(async () => {});
const broadcast = vi.fn();
let dbPath: string;

function project(id: string, name: string): Project {
  return {
    id,
    name,
    cwd: config.dataDir,
    ahw: '',
    agents: [{ id: `${id}-dev`, name: `${name} Dev`, engine: 'claude-code' }],
  } as Project;
}

/** A Hub restart: in-memory grants and caches vanish, orgs.db reopens, startup repair runs. */
function restart(): void {
  resetOrganizationCapabilitiesForTests();
  clearOrganizationContextCache();
  setOrgsDbPathForTests(dbPath);
  initOrgsDb();
  setActiveOrgId('default');
  repairOrganizationWorkspaces('default');
}

function app() {
  const server = express();
  server.use(express.json());
  server.use(authMiddleware);
  // Stand-in for a signed-in human on this open-auth test server.
  server.use((req, _res, next) => {
    const user = req.get('x-test-user');
    if (user && !(req as AuthenticatedRequest).authOrganizationCapability)
      Object.assign(req, {
        authUserId: user,
        authOrgId: 'default',
        authRole: getMembershipRole(user, 'default') ?? 'User',
      });
    next();
  });
  const deps = {
    findProject,
    findAgent,
    config,
    stmts: getStmts(),
    broadcast,
  } as unknown as RouteDeps;
  server.use(createCapabilityRoutes());
  server.use('/api/projects/:projectId', createProjectVisibilityGate({ findProject }));
  server.use(createWikiRoutes(deps));
  server.use(createOrganizationRuntimeRoutes(deps));
  server.use(createOrganizationDispatchRoutes());
  server.use(createOrganizationContextRoutes());
  server.use(createOrganizationsRoutes(deps));
  server.use((_req, res) => res.status(418).json({ fellThrough: true }));
  return server;
}

beforeEach(() => {
  fixture.directory = mkdtempSync(path.join(os.tmpdir(), 'org-acceptance-'));
  dbPath = path.join(fixture.directory, 'orgs.db');
  setAuthFilePathForTests(path.join(fixture.directory, 'auth.json'));
  setOrgsDbPathForTests(dbPath);
  resetOrganizationCapabilitiesForTests();
  clearOrganizationContextCache();
  initOrgsDb();
  setActiveOrgId('default');
  initDb(config.dataDir);
  for (const table of ['organization_dispatch_requests', 'messages', 'sessions', 'wiki_pages'])
    getDb().prepare(`DELETE FROM ${table}`).run();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 503 })),
  );
  handleChat.mockClear();
  broadcast.mockClear();
  initBackgroundAgentSessionHook({ stmts: getStmts(), config, handleChat, broadcast: vi.fn() });

  const db = getOrgsDb();
  for (const user of ['ana', 'bob', 'cara'])
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
      user,
      `${user}@example.test`,
      'unused',
    );
  createMembership('ana', 'default', 'Owner');
  createMembership('bob', 'default', 'User');
  createMembership('cara', 'default', 'User');
  setProjects([
    project('storefront', 'Shared Storefront'),
    project('ledger', 'Restricted Ledger'),
    project('tools', 'Independent Tools'),
  ]);
  // The ledger is members-only (ana); the other projects stay open to the Server.
  db.prepare('INSERT INTO project_member_restrictions (project_id) VALUES (?)').run('ledger');
  addProjectMember('ledger', 'ana', 'ana');
  createPage('ledger', { title: 'Ledger plan', content: 'Confidential budget' });
  createPage('storefront', { title: 'Storefront plan', content: 'Open roadmap' });
});

afterEach(() => {
  stopOrganizationDispatchQueueForTests();
  vi.unstubAllGlobals();
  setActiveOrgId('default');
  setProjects([]);
  setOrgsDbPathForTests(null);
  setAuthFilePathForTests(null);
  rmSync(fixture.directory, { recursive: true, force: true });
});

describe('organization product acceptance', () => {
  it('runs the full journey and keeps every boundary', async () => {
    const server = app();
    const as = (user: string) => ({
      get: (url: string) => request(server).get(url).set('x-test-user', user),
      post: (url: string) => request(server).post(url).set('x-test-user', user),
      put: (url: string) => request(server).put(url).set('x-test-user', user),
      patch: (url: string) => request(server).patch(url).set('x-test-user', user),
      delete: (url: string) => request(server).delete(url).set('x-test-user', user),
    });
    const ana = as('ana');
    const bob = as('bob');
    const cara = as('cara');

    // No organization exists until someone creates one.
    expect((await ana.get('/api/organizations').expect(200)).body).toEqual({ organizations: [] });
    const northwind = (await ana.post('/api/organizations').send({ name: 'Northwind' }).expect(201))
      .body.organization.id as string;
    const contoso = (await ana.post('/api/organizations').send({ name: 'Contoso' }).expect(201))
      .body.organization.id as string;
    const org = (id: string) => `/api/organizations/${id}`;

    // Link the storefront to both, the ledger to Northwind; tools stays independent.
    for (const [id, projectId] of [
      [northwind, 'storefront'],
      [northwind, 'ledger'],
      [contoso, 'storefront'],
    ])
      await ana.put(`${org(id)}/projects/${projectId}`).expect(200);
    // Repeating a link is idempotent.
    await ana.put(`${org(contoso)}/projects/storefront`).expect(200);
    const linked = async (id: string) =>
      (await ana.get(`${org(id)}/projects`).expect(200)).body.projects
        .map((p: { id: string }) => p.id)
        .sort();
    expect(await linked(northwind)).toEqual(['ledger', 'storefront']);
    expect(await linked(contoso)).toEqual(['storefront']);
    // Linking never moves or copies a project.
    expect(
      getProjects()
        .filter((p) => !p.workspaceKind)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['ledger', 'storefront', 'tools']);

    // Exactly one Assistant per organization, Computer on, all linked projects.
    const roster = async (id: string, user = ana) =>
      (await user.get(`${org(id)}/agents`).expect(200)).body.agents as Array<{
        id: string;
        name: string;
        isAssistant?: boolean;
        computerToolEnabled?: boolean;
        effectiveProjectIds?: string[];
        organizationScope: { tools: string[]; projects: unknown; archivedAt?: string | null };
      }>;
    for (const id of [northwind, contoso]) {
      const agents = await roster(id);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        name: 'Organization Assistant',
        isAssistant: true,
        computerToolEnabled: true,
        organizationScope: { projects: 'all-linked' },
      });
    }
    const assistant = (await roster(northwind))[0];
    expect(assistant.effectiveProjectIds?.sort()).toEqual(['ledger', 'storefront']);

    // Rename the Assistant; its identity stays.
    const renamed = await ana
      .patch(`${org(northwind)}/agents/${assistant.id}`)
      .send({ name: 'Chief of Staff', systemPrompt: 'Keep priorities current.' })
      .expect(200);
    expect(renamed.body.agent).toMatchObject({ id: assistant.id, name: 'Chief of Staff' });

    // A custom agent from scratch, limited to the storefront.
    const tracker = (
      await ana
        .post(`${org(northwind)}/agents`)
        .send({
          name: 'Release Tracker',
          tools: ['projects:read', 'dispatch'],
          projects: ['storefront'],
        })
        .expect(201)
    ).body.agent;
    expect(tracker).toMatchObject({
      computerToolEnabled: false,
      effectiveProjectIds: ['storefront'],
    });
    // An optional template copies instructions only: no tools, projects or Computer.
    const finance = (
      await ana
        .post(`${org(northwind)}/agents`)
        .send({ templateId: 'finance' })
        .expect(201)
    ).body.agent;
    expect(finance).toMatchObject({
      name: 'Finance',
      computerToolEnabled: false,
      organizationScope: { tools: ['projects:read'] },
      organizationTemplate: { id: 'finance' },
    });
    expect(finance.systemPrompt).toMatch(/budgets/);
    expect(await roster(northwind)).toHaveLength(3);

    // The scoped agent's own capability: in-scope reads work, everything else is refused.
    const trackerChat = (
      await ana
        .post(`${org(northwind)}/agents/${tracker.id}/sessions`)
        .send({})
        .expect(201)
    ).body.session.id as string;
    prepareOrganizationTurn(trackerChat, true);
    const capability = issueOrganizationCapability(trackerChat, 'ana');
    const asAgent = (req: request.Test) => req.set('X-API-Key', capability);
    await asAgent(
      request(server).get(`${org(northwind)}/context/projects/storefront/cards`),
    ).expect(200);
    const overview = await asAgent(request(server).get(`${org(northwind)}/context`)).expect(200);
    expect(JSON.stringify(overview.body)).not.toContain('ledger');
    await asAgent(request(server).get(`${org(northwind)}/context/projects/ledger/wiki`)).expect(
      404,
    );
    const outOfScope = await asAgent(request(server).post(`${org(northwind)}/dispatches`)).send({
      projectId: 'ledger',
      agentId: 'ledger-dev',
      prompt: 'Read the budget',
      idempotencyKey: 'out-of-scope',
    });
    expect([403, 404]).toContain(outOfScope.status);
    const projectApi = await asAgent(request(server).get('/api/projects/ledger/wiki'));
    expect([401, 403, 404]).toContain(projectApi.status);
    expect(JSON.stringify(projectApi.body)).not.toContain('Confidential');
    // Organization management is not an agent operation.
    const manage = await asAgent(request(server).post('/api/organizations')).send({ name: 'X' });
    expect([401, 403]).toContain(manage.status);
    expect(organizationSessionAllowsTool(trackerChat, 'computer')).toBe(false);
    expect(handleChat).not.toHaveBeenCalled();

    // Dispatch a project agent from the signed-in owner's Assistant chat.
    const assistantChat = (
      await ana
        .post(`${org(northwind)}/agents/${assistant.id}/sessions`)
        .send({})
        .expect(201)
    ).body.session.id as string;
    const task = {
      projectId: 'storefront',
      agentId: 'storefront-dev',
      prompt: 'Summarize open storefront cards',
      idempotencyKey: 'summary-1',
    };
    const accepted = await ana
      .post(`${org(northwind)}/sessions/${assistantChat}/dispatches`)
      .send(task);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({
      status: 'accepted',
      organizationAgentId: assistant.id,
      initiatingSessionId: assistantChat,
      actingUserId: 'ana',
      projectId: 'storefront',
      agentId: 'storefront-dev',
    });
    // A retry returns the same target session instead of starting another.
    const retry = await ana
      .post(`${org(northwind)}/sessions/${assistantChat}/dispatches`)
      .send(task);
    expect(retry.body.sessionId).toBe(accepted.body.sessionId);
    expect(handleChat).toHaveBeenCalledTimes(1);
    expect(getStmts().getSession.get(accepted.body.sessionId)).toMatchObject({
      agent_id: 'storefront-dev',
      owner_user_id: 'ana',
    });
    await ana.get(accepted.body.statusPath).expect(200);

    // Computer: allowed for the Assistant, private per user, stable across the rename.
    expect(organizationSessionAllowsTool(assistantChat, 'computer')).toBe(true);
    const workspace = findAgent(assistant.id)!.project;
    const desktop = (userId: string, agentId: string) =>
      resolveDesktopComputerIdentity({
        ownerUserId: userId,
        agentId,
        project: workspace,
        serverId: 'default',
      });
    const anaDesktop = desktop('ana', assistant.id);
    expect(anaDesktop.ok).toBe(true);
    expect(desktop('bob', assistant.id)).not.toEqual(anaDesktop);
    expect(desktop('ana', finance.id)).not.toEqual(anaDesktop);

    // A Member without ledger access sees the storefront only, and no other organization.
    await ana
      .put(`${org(northwind)}/members/bob`)
      .send({ role: 'Member' })
      .expect(200);
    expect(
      (await bob.get('/api/organizations').expect(200)).body.organizations.map(
        (o: { name: string }) => o.name,
      ),
    ).toEqual(['Northwind']);
    const bobAssistant = (await roster(northwind, bob)).find((a) => a.id === assistant.id)!;
    expect(bobAssistant.effectiveProjectIds).toEqual(['storefront']);
    await bob.get(`${org(northwind)}/context/projects/ledger/wiki`).expect(404);
    const bobOverview = await bob.get(`${org(northwind)}/context`).expect(200);
    expect(JSON.stringify(bobOverview.body)).not.toContain('Confidential');
    expect(JSON.stringify(bobOverview.body)).not.toContain('"ledger"');
    await bob.get(org(contoso)).expect(404);
    await bob.get(`${org(contoso)}/agents`).expect(404);
    await bob
      .post(`${org(northwind)}/agents`)
      .send({ templateId: 'ceo' })
      .expect(403);
    // The owner's dispatches and chats stay private to the owner.
    expect((await bob.get(`${org(northwind)}/dispatches`).expect(200)).body.dispatches).toEqual([]);
    expect((await bob.get(`${org(northwind)}/sessions`).expect(200)).body.sessions).toEqual([]);
    await bob
      .post(`${org(northwind)}/sessions/${assistantChat}/dispatches`)
      .send({ ...task, idempotencyKey: 'bob' })
      .expect(404);
    // A Server user outside the organization gets nothing.
    await cara.get(org(northwind)).expect(404);
    expect((await cara.get('/api/organizations').expect(200)).body.organizations).toEqual([]);

    // Unlink from Northwind: Contoso keeps its link and the project and its session survive.
    await ana.delete(`${org(northwind)}/projects/storefront`).expect(200);
    expect(await linked(northwind)).toEqual(['ledger']);
    expect(await linked(contoso)).toEqual(['storefront']);
    expect(findProject('storefront')).toBeTruthy();
    expect(getStmts().getSession.get(accepted.body.sessionId)).toMatchObject({
      owner_user_id: 'ana',
    });
    const afterUnlink = await ana
      .post(`${org(northwind)}/sessions/${assistantChat}/dispatches`)
      .send({ ...task, idempotencyKey: 'after-unlink' });
    expect([403, 404]).toContain(afterUnlink.status);

    // Archive a custom agent and the Contoso Assistant, then restart twice.
    await ana
      .patch(`${org(northwind)}/agents/${tracker.id}`)
      .send({ archived: true })
      .expect(200);
    const contosoAssistant = (await roster(contoso))[0];
    await ana
      .patch(`${org(contoso)}/agents/${contosoAssistant.id}`)
      .send({ archived: true })
      .expect(200);
    restart();
    restart();
    const active = (agents: Awaited<ReturnType<typeof roster>>) =>
      agents.filter((a) => !a.organizationScope.archivedAt).map((a) => a.name);
    expect(active(await roster(contoso))).toEqual([]);
    expect(await roster(contoso)).toHaveLength(1);
    expect(active(await roster(northwind)).sort()).toEqual(['Chief of Staff', 'Finance']);
    expect(organizationSessionAllowsTool(trackerChat, 'computer')).toBe(false);
    const archivedChat = await ana.post(`${org(northwind)}/agents/${tracker.id}/sessions`).send({});
    expect(archivedChat.status).toBeGreaterThanOrEqual(400);
    // The archived agent's chat stays in its owner's history.
    const history = (await ana.get(`${org(northwind)}/sessions`).expect(200)).body.sessions;
    expect(history.find((c: { id: string }) => c.id === trackerChat)).toMatchObject({
      agentAvailable: false,
    });

    // Archive Contoso: projects and Northwind are unaffected.
    await ana.delete(org(contoso)).expect(200);
    expect(
      (await ana.get('/api/organizations').expect(200)).body.organizations.map(
        (o: { name: string }) => o.name,
      ),
    ).toEqual(['Northwind']);
    expect(findProject('storefront')).toBeTruthy();
    expect(findProject('tools')).toBeTruthy();
    expect(await linked(northwind)).toEqual(['ledger']);
  });
});
