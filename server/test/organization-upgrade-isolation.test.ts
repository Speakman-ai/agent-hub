/**
 * Cross-feature regression gate for Servers + organizations: legacy upgrade, then
 * organization membership, archive, project removal/deletion and capability renewal while
 * organization sessions are live. Each module has its own unit tests; this file checks the
 * features together against one fixture. No CLI or desktop backend runs: chat dispatch goes
 * to a mock and Computer identity is resolved without a runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authMiddleware, type AuthenticatedRequest } from '../auth.js';
import config from '../config.js';
import { initDb, getDb, getStmts } from '../db.js';
import {
  getActiveOrgId,
  getAllOrgs,
  getOrgsDb,
  initOrgsDb,
  orgDataDir,
  setActiveOrgId,
  setOrgsDbPathForTests,
} from '../orgs.js';
import { setAuthFilePathForTests } from '../auth-store.js';
import {
  findAgent,
  findProject,
  getProjects,
  listProjectsForServer,
  saveProjects,
  setProjects,
} from '../project-model.js';
import { createMembership, getMembershipRole } from '../memberships-store.js';
import { addProjectMember } from '../project-members-store.js';
import { createApiKey, verifyApiKey } from '../api-keys-store.js';
import { createOrgTodo, listOrgTodos } from '../org-todos-store.js';
import {
  archiveBusinessOrganization,
  attachBusinessOrganizationProject,
  createBusinessOrganization,
  detachBusinessOrganizationProject,
  listBusinessOrganizationProjectLinks,
  listBusinessOrganizations,
  listBusinessOrganizationsForProject,
  removeBusinessOrganizationMember,
  setBusinessOrganizationMember,
} from '../business-organizations-store.js';
import {
  canAccessOrganizationHistory,
  canReadOrganizationEvent,
  resolveOrganizationCaller,
} from '../business-organizations-access.js';
import {
  archiveOrganizationWorkspace,
  ensureOrganizationWorkspace,
  repairOrganizationWorkspaces,
} from '../organization-workspaces.js';
import { createOrganizationAgent, updateOrganizationAgent } from '../organization-agents.js';
import {
  currentOrganizationAuthority,
  isOrganizationWorkspace,
  issueOrganizationCapability,
  organizationSessionAllowsTool,
  organizationSessionWorkspace,
  prepareOrganizationTurn,
  renewOrganizationCapability,
  resetOrganizationCapabilitiesForTests,
  setOrganizationRevocationHandler,
  verifyOrganizationCapability,
} from '../organization-capabilities.js';
import { createOrganizationSession } from '../organization-sessions.js';
import { appendOrganizationMemory, readOrganizationMemory } from '../organization-memory.js';
import { clearOrganizationContextCache } from '../organization-context.js';
import { stopOrganizationDispatchQueueForTests } from '../organization-dispatch.js';
import { initBackgroundAgentSessionHook } from '../background-agent-session.js';
import { deleteProjectScopedRows } from '../project-owner-cascade.js';
import { organizationWorkspaceId } from '../organization-workspace-id.js';
import { resolveDesktopComputerIdentity } from '../desktop/desktop-computer-identity.js';
import { createDesktopComputersStore } from '../desktop/desktop-computers-store.js';
import { desktopVmId } from '../desktop/firecracker-desktop-runtime.js';
import { getBrowserProfile, getOrCreateBrowserProfile } from '../browser-profiles-store.js';
import { withBrowserProfile } from '../browser-agent-settings.js';
import { shouldDeliverBroadcast } from '../broadcast-filter.js';
import { userCanReadSession } from '../session-ownership.js';
import { createProjectVisibilityGate } from '../project-visibility-middleware.js';
import { HUB_PROJECT_ID, isHubSystemProject } from '../../shared/utils/hub.js';
import createCapabilityRoutes from '../routes/organization-capabilities.js';
import createOrganizationContextRoutes from '../routes/organization-context.js';
import createOrganizationDispatchRoutes from '../routes/organization-dispatch.js';
import createSessionDispatchRoutes from '../routes/session-dispatch.js';
import createWikiRoutes from '../routes/wiki.js';
import { createPage } from '../wiki.js';
import type { Agent, Project, RouteDeps } from '../types.js';

// Inactive Server registries live under the test's temp root, never the real HOME.
const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('../orgs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orgs.js')>()),
  orgDataDir: (id: string) => path.join(fixture.directory, 'servers', id),
}));

// Real CLIs never run: every dispatched or started turn lands here.
const handleChat = vi.fn(async () => {});
const stopped = vi.fn();

let dbPath: string;

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: `Project ${id}`,
    cwd: config.dataDir,
    ahw: '',
    agents: [{ id: `${id}-dev`, name: `${id} dev`, engine: 'claude-code' }],
    ...extra,
  } as Project;
}

function seedUsers(): void {
  const db = getOrgsDb();
  db.exec(`
    INSERT OR IGNORE INTO orgs (id, name, mode, color, position) VALUES ('acme', 'Acme Server', 'local', '#ff0000', 1);
    INSERT OR IGNORE INTO orgs (id, name, mode, remote_url, api_key, position)
      VALUES ('remote', 'Remote Server', 'remote', 'https://hub.example.test', 'ahub_saved_remote_key', 2);
  `);
  for (const user of ['ana', 'bob', 'cara'])
    db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(
      user,
      user,
      'unused',
    );
  createMembership('ana', 'default', 'Owner');
  createMembership('bob', 'default', 'User');
  createMembership('cara', 'default', 'Admin');
  createMembership('ana', 'acme', 'Owner');
}

function writeServerRegistry(serverId: string, projects: Project[]): string {
  const file = path.join(orgDataDir(serverId), 'projects.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(projects, null, 2) + '\n');
  return file;
}

function seedSession(id: string, agentId: string, owner: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sessions (id, agent_id, name, engine, model, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, agentId, id, 'claude-code', 'test', owner);
}

function mint(sessionId: string, userId: string): string {
  prepareOrganizationTurn(sessionId, true);
  return issueOrganizationCapability(sessionId, userId);
}

/** Simulate a Hub restart: in-memory grants vanish and orgs.db is reopened from disk. */
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
  server.use(createCapabilityRoutes());
  server.use('/api/projects/:projectId', createProjectVisibilityGate({ findProject }));
  const deps = { findProject, findAgent, config, stmts: getStmts() } as unknown as RouteDeps;
  server.use(createWikiRoutes(deps));
  server.use(createSessionDispatchRoutes(deps));
  server.use(createOrganizationDispatchRoutes());
  server.use(createOrganizationContextRoutes());
  // A request that falls through every guard must never look like success.
  server.use((_req, res) => res.status(418).json({ fellThrough: true }));
  return server;
}

function delivered(event: Record<string, unknown>, userId: string): boolean {
  return shouldDeliverBroadcast(
    event,
    { userId, serverId: 'default', role: getMembershipRole(userId, 'default') ?? 'User' },
    {
      resolveProjectId: () => null,
      findProject: () => null,
      getSessionOwner: () => null,
      canReadOrganizationEvent,
    },
  );
}

beforeEach(() => {
  fixture.directory = mkdtempSync(path.join(os.tmpdir(), 'org-upgrade-isolation-'));
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
  // Wiki writes try to embed pages; keep that off the network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 503 })),
  );
  setOrganizationRevocationHandler(stopped);
  stopped.mockClear();
  handleChat.mockClear();
  initBackgroundAgentSessionHook({ stmts: getStmts(), config, handleChat, broadcast: vi.fn() });
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

describe('legacy upgrade', () => {
  it('keeps saved Servers, roles, restrictions, shared Todos, push targets, Computers and logins, and creates no organization', () => {
    // A database from before business organizations existed.
    getOrgsDb().exec(`
      DROP TABLE business_organization_archived_members;
      DROP TABLE business_organization_members;
      DROP TABLE business_organization_projects;
      DROP TABLE business_organizations;
    `);
    seedUsers();
    setActiveOrgId('acme');
    addProjectMember('restricted', 'bob', 'ana');
    const login = createApiKey('bob', 'Phone login').token;
    createOrgTodo({ orgId: 'default', title: 'Server-wide task', createdByUserId: 'ana' });
    createOrgTodo({ orgId: 'acme', title: 'Acme task', createdByUserId: 'ana' });
    getOrgsDb()
      .prepare(
        `INSERT INTO desktop_computers (user_id, agent_id, project_id, kind, vm_id, slot)
         VALUES ('ana', 'shared-dev', 'shared', 'firecracker', 'vm-legacy', 7),
                ('ana', 'acme-only-dev', 'acme-only', 'container', 'vm-acme', NULL),
                ('ana', 'acme-only-dev', 'acme-only', 'firecracker', 'vm-acme-fc', 8)`,
      )
      .run();
    // A saved browser login for a project that only the Acme Server has today. The row
    // records no Server, so nothing proves Acme created it.
    const acmeLogin = getOrCreateBrowserProfile({
      userId: 'ana',
      agentId: 'acme-only-dev',
      projectId: 'acme-only',
    });
    getDb().prepare("DELETE FROM device_tokens WHERE token = 'legacy-push-token'").run();
    getDb()
      .prepare(
        "INSERT INTO device_tokens (token, platform, user_id, server_url) VALUES ('legacy-push-token', 'ios', 'bob', 'https://hub.example.test')",
      )
      .run();
    // Existing chat history: a user-owned project session and an unowned legacy one.
    seedSession('legacy-owned', 'shared-dev', 'bob');
    seedSession('legacy-unowned', 'solo-dev', 'ana');
    getDb().prepare('UPDATE sessions SET owner_user_id = NULL WHERE id = ?').run('legacy-unowned');
    const addMessage = getDb().prepare(
      'INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)',
    );
    addMessage.run('legacy-m1', 'legacy-owned', 'user', 'Ship the login fix');
    addMessage.run('legacy-m2', 'legacy-owned', 'assistant', 'Done, see PR');
    addMessage.run('legacy-m3', 'legacy-unowned', 'user', 'Old unowned chat');
    // Acme is active, so its registry is the in-memory one. The default Server's registry
    // shares the 'shared' project id with Acme.
    const activeProjects = [
      project('shared'),
      project('restricted'),
      project('solo'),
      project('acme-only'),
    ];
    setProjects(activeProjects);
    const defaultRegistry = writeServerRegistry('default', [
      project('shared', { name: 'Default shared' }),
    ]);
    const defaultRegistryBefore = readFileSync(defaultRegistry, 'utf8');

    const tables = [
      'orgs',
      'active_org',
      'users',
      'memberships',
      'project_members',
      'project_member_restrictions',
      'org_todos',
      'desktop_computers',
      'api_keys',
    ];
    const snapshot = () =>
      Object.fromEntries(
        tables.map((table) => [
          table,
          getOrgsDb().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      );
    const before = snapshot();
    const history = () => ({
      sessions: getDb()
        .prepare("SELECT * FROM sessions WHERE id LIKE 'legacy-%' ORDER BY id")
        .all(),
      messages: getDb()
        .prepare("SELECT * FROM messages WHERE session_id LIKE 'legacy-%' ORDER BY id")
        .all(),
    });
    const historyBefore = history();
    const pushBefore = getDb()
      .prepare("SELECT * FROM device_tokens WHERE token = 'legacy-push-token'")
      .all();

    // Upgrade: reopen with the current schema and run startup repair on every local Server.
    setOrgsDbPathForTests(dbPath);
    initOrgsDb();
    initDb(config.dataDir);
    for (const server of getAllOrgs())
      if (server.mode === 'local') repairOrganizationWorkspaces(server.id);

    // Rows that the new tables add (none here) must not change any legacy row.
    const after = snapshot();
    expect(after.orgs).toEqual(before.orgs);
    expect(after.active_org).toEqual(before.active_org);
    expect(after.users).toEqual(before.users);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.project_members).toEqual(before.project_members);
    expect(after.project_member_restrictions).toEqual(before.project_member_restrictions);
    expect(after.org_todos).toEqual(before.org_todos);
    // Legacy Computers carry no Server provenance: none is moved, renamed or deleted.
    expect(after.desktop_computers).toEqual(before.desktop_computers);
    expect(after.api_keys).toEqual(before.api_keys);
    expect(getActiveOrgId()).toBe('acme');
    expect(
      getAllOrgs().map(({ id, mode, remote_url, api_key }) => [id, mode, remote_url, api_key]),
    ).toEqual(
      expect.arrayContaining([
        ['default', 'local', '', ''],
        ['acme', 'local', '', ''],
        ['remote', 'remote', 'https://hub.example.test', 'ahub_saved_remote_key'],
      ]),
    );
    expect(
      getDb().prepare("SELECT * FROM device_tokens WHERE token = 'legacy-push-token'").all(),
    ).toEqual(pushBefore);
    expect(verifyApiKey(login)).toMatchObject({ userId: 'bob' });
    // History survives with its project/agent association and ownership, and stays a
    // regular project chat rather than becoming an organization session.
    expect(history()).toEqual(historyBefore);
    expect(history().sessions).toEqual([
      expect.objectContaining({ id: 'legacy-owned', agent_id: 'shared-dev', owner_user_id: 'bob' }),
      expect.objectContaining({ id: 'legacy-unowned', agent_id: 'solo-dev', owner_user_id: null }),
    ]);
    expect(history().messages.map((m) => (m as { content: string }).content)).toEqual([
      'Ship the login fix',
      'Done, see PR',
      'Old unowned chat',
    ]);
    expect(findAgent('shared-dev')?.project.id).toBe('shared');
    expect(organizationSessionWorkspace('legacy-owned')).toBeNull();
    expect(userCanReadSession({ authUserId: 'bob', authOrgId: 'acme' }, 'legacy-owned')).toBe(true);
    expect(currentOrganizationAuthority('legacy-owned')).toBeNull();
    expect(listOrgTodos('default').map((todo) => todo.title)).toEqual(['Server-wide task']);
    expect(listOrgTodos('acme').map((todo) => todo.title)).toEqual(['Acme task']);
    expect(getOrgsDb().pragma('foreign_key_check')).toEqual([]);

    // No implicit organizations, links or hidden workspaces on any Server.
    for (const table of [
      'business_organizations',
      'business_organization_projects',
      'business_organization_members',
      'business_organization_archived_members',
    ])
      expect(getOrgsDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(getProjects()).toEqual(activeProjects);
    expect(readFileSync(defaultRegistry, 'utf8')).toBe(defaultRegistryBefore);

    // Existing Computers and logins are found again under the upgraded keys.
    const keyOn = (serverId: string, agentId: string, projectId: string) => {
      const identity = resolveDesktopComputerIdentity({
        ownerUserId: 'ana',
        agentId,
        project: project(projectId),
        serverId,
      });
      if (!identity.ok) throw new Error(identity.reason);
      return identity.key;
    };
    const computers = createDesktopComputersStore();
    expect(
      computers.listForKey(keyOn('default', 'shared-dev', 'shared')).map((r) => r.vmId),
    ).toEqual(['vm-legacy']);
    // Unattributed legacy data stays in the default partition, retained and reachable there,
    // and is never handed to another Server because a project with that id exists there.
    expect(
      computers.listForKey(keyOn('default', 'acme-only-dev', 'acme-only')).map((r) => r.vmId),
    ).toEqual(['vm-acme', 'vm-acme-fc']);
    expect(getBrowserProfile(keyOn('default', 'acme-only-dev', 'acme-only'))?.id).toBe(
      acmeLogin.id,
    );
    expect(computers.listForKey(keyOn('acme', 'acme-only-dev', 'acme-only'))).toEqual([]);
    expect(getBrowserProfile(keyOn('acme', 'acme-only-dev', 'acme-only'))).toBeNull();
    expect(computers.listForKey(keyOn('acme', 'shared-dev', 'shared'))).toEqual([]);
  });

  it("never transfers a deleted project's Computer or login to a reused id on another Server", () => {
    seedUsers();
    const reused = project('p');
    setProjects([reused]);
    writeServerRegistry('acme', []);
    const legacy = resolveDesktopComputerIdentity({
      ownerUserId: 'ana',
      agentId: 'p-dev',
      project: reused,
      serverId: 'default',
    });
    if (!legacy.ok) throw new Error(legacy.reason);
    const login = getOrCreateBrowserProfile(legacy.key);
    getOrgsDb()
      .prepare(
        `INSERT INTO desktop_computers (user_id, agent_id, project_id, kind, vm_id)
         VALUES (?, ?, ?, 'container', 'vm-default-p')`,
      )
      .run(legacy.key.userId, legacy.key.agentId, legacy.key.projectId);
    const rows = () => ({
      computers: getOrgsDb().prepare('SELECT * FROM desktop_computers ORDER BY rowid').all(),
      profiles: getOrgsDb().prepare('SELECT * FROM browser_profiles ORDER BY rowid').all(),
    });
    const startup = () => {
      setOrgsDbPathForTests(dbPath);
      initOrgsDb();
      for (const server of getAllOrgs())
        if (server.mode === 'local') repairOrganizationWorkspaces(server.id);
    };
    const original = rows();

    // Delete 'p' on the default Server (its saved login is retained), restart, then an
    // unrelated project reuses the id on Acme with the same user and agent ids.
    deleteProjectScopedRows(getStmts(), reused);
    setProjects([]);
    startup();
    writeServerRegistry('acme', [project('p', { name: 'Unrelated Acme project' })]);
    startup();
    startup();

    expect(rows()).toEqual(original);
    const onAcme = resolveDesktopComputerIdentity({
      ownerUserId: 'ana',
      agentId: 'p-dev',
      project: listProjectsForServer('acme').find((candidate) => candidate.id === 'p')!,
      serverId: 'acme',
    });
    if (!onAcme.ok) throw new Error(onAcme.reason);
    expect(onAcme.key.projectId).not.toBe(legacy.key.projectId);
    expect(getBrowserProfile(onAcme.key)).toBeNull();
    expect(createDesktopComputersStore().listForKey(onAcme.key)).toEqual([]);
    expect(getBrowserProfile(legacy.key)?.id).toBe(login.id);
  });
});

describe('two organizations sharing a project with live sessions', () => {
  let orgA: string;
  let orgB: string;
  let workspaceA: Project;
  let workspaceB: Project;
  let assistantA: string;
  let assistantB: string;
  const sid: Record<string, string> = {};
  /** Organization chats go through the real creation path, which records their identity. */
  function orgSession(label: string, organizationId: string, agentId: string, userId: string) {
    sid[label] = createOrganizationSession({
      serverId: 'default',
      organizationId,
      agentId,
      userId,
      stmts: getStmts(),
      config,
      name: label,
    }).id;
  }

  beforeEach(() => {
    seedUsers();
    getOrgsDb()
      .prepare('INSERT INTO project_member_restrictions (project_id) VALUES (?)')
      .run('restricted');
    setProjects([
      project('shared'),
      project('restricted'),
      project('solo'),
      project(HUB_PROJECT_ID, { kind: 'system', name: 'Hub' }),
    ]);
    writeServerRegistry('acme', [project('shared', { name: 'Acme shared' })]);
    orgA = createBusinessOrganization({ serverId: 'default', name: 'Alpha', createdBy: 'ana' }).id;
    orgB = createBusinessOrganization({ serverId: 'default', name: 'Beta', createdBy: 'ana' }).id;
    setBusinessOrganizationMember('default', orgA, 'bob', 'Member');
    workspaceA = ensureOrganizationWorkspace('default', orgA);
    workspaceB = ensureOrganizationWorkspace('default', orgB);
    assistantA = workspaceA.organizationAssistantId!;
    assistantB = workspaceB.organizationAssistantId!;
    for (const id of [orgA, orgB]) attachBusinessOrganizationProject('default', id, 'shared');
    attachBusinessOrganizationProject('default', orgA, 'restricted');
    orgSession('a-ana', orgA, assistantA, 'ana');
    orgSession('a-bob', orgA, assistantA, 'bob');
    orgSession('b-ana', orgB, assistantB, 'ana');
    createPage('restricted', { title: 'Restricted plan', content: 'Confidential roadmap' });
    createPage('shared', { title: 'Shared plan', content: 'Open roadmap' });
  });

  it('seeds exactly one Assistant per organization and keeps links stable across restart', () => {
    for (const workspace of [workspaceA, workspaceB]) {
      expect(workspace.agents).toHaveLength(1);
      expect(workspace.agents[0]).toMatchObject({
        name: 'Organization Assistant',
        computerToolEnabled: true,
        organizationScope: { projects: 'all-linked', enabled: true },
      });
    }
    const linksA = listBusinessOrganizationProjectLinks('default', orgA);
    const linksB = listBusinessOrganizationProjectLinks('default', orgB);
    // The same project gets an independent link generation in each organization.
    expect(linksA.get('shared')).not.toBe(linksB.get('shared'));

    restart();
    restart();
    for (const id of [orgA, orgB]) {
      const workspace = getProjects().filter(
        (p) => p.workspaceKind === 'organization' && p.organizationId === id,
      );
      expect(workspace).toHaveLength(1);
      expect(workspace[0].agents).toHaveLength(1);
    }
    expect(listBusinessOrganizationProjectLinks('default', orgA)).toEqual(linksA);
    expect(listBusinessOrganizationProjectLinks('default', orgB)).toEqual(linksB);
    expect(
      listBusinessOrganizationsForProject('default', 'shared')
        .map((o) => o.id)
        .sort(),
    ).toEqual([orgA, orgB].sort());
    expect(listBusinessOrganizationsForProject('default', 'solo')).toEqual([]);
    // Organization workspaces never appear as user projects or as the Hub.
    expect(isHubSystemProject(workspaceA)).toBe(false);
    expect(isOrganizationWorkspace(findProject(HUB_PROJECT_ID))).toBe(false);
  });

  it('fails closed on forbidden reads via direct API, websocket, context, memory and dispatch', async () => {
    expect(currentOrganizationAuthority(sid['a-ana'])?.projectIds).toEqual([
      'restricted',
      'shared',
    ]);
    expect(currentOrganizationAuthority(sid['a-bob'])?.projectIds).toEqual(['shared']);
    expect(currentOrganizationAuthority(sid['b-ana'])?.projectIds).toEqual(['shared']);

    const bob = mint(sid['a-bob'], 'bob');
    const server = app();
    // Direct project API.
    await request(server).get('/api/projects/shared/wiki').set('X-API-Key', bob).expect(200);
    for (const id of ['restricted', 'solo', workspaceB.id, HUB_PROJECT_ID]) {
      const res = await request(server).get(`/api/projects/${id}/wiki`).set('X-API-Key', bob);
      expect([401, 403, 404]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain('Confidential');
    }
    // Organization context (the cached overview included) never names the restricted project.
    const overview = await request(server)
      .get(`/api/organizations/${orgA}/context`)
      .set('X-API-Key', bob)
      .expect(200);
    expect(JSON.stringify(overview.body)).not.toContain('restricted');
    await request(server)
      .get(`/api/organizations/${orgA}/context/projects/restricted/wiki`)
      .set('X-API-Key', bob)
      .expect(404);
    const again = await request(server)
      .get(`/api/organizations/${orgA}/context`)
      .set('X-API-Key', bob)
      .expect(200);
    expect(JSON.stringify(again.body)).not.toContain('restricted');
    // Another organization's endpoints refuse the capability outright.
    const foreign = await request(server)
      .get(`/api/organizations/${orgB}/context`)
      .set('X-API-Key', bob);
    expect([401, 403, 404]).toContain(foreign.status);

    // Websocket delivery uses the same current-ACL rule.
    const event = { type: 'organization_updated', serverId: 'default', organizationId: orgA };
    expect(delivered({ ...event, projectId: 'restricted' }, 'bob')).toBe(false);
    expect(delivered({ ...event, projectId: 'restricted' }, 'ana')).toBe(true);
    expect(delivered({ ...event, projectId: 'shared' }, 'bob')).toBe(true);
    // A Server Admin who is not a member may administer the organization, but never
    // reads a member's organization chat.
    expect(canReadOrganizationEvent({ ...event, projectId: 'shared' }, 'cara', 'default')).toBe(
      true,
    );
    expect(userCanReadSession({ authUserId: 'cara', authRole: 'Admin' }, sid['a-bob'])).toBe(false);

    // Prompt memory cannot be sourced from a project the user cannot see.
    expect(() =>
      appendOrganizationMemory(sid['a-bob'], {
        projectId: 'restricted',
        sourceRecord: 'wiki:restricted-plan',
        content: 'roadmap',
      }),
    ).toThrow();

    // Dispatch to a forbidden or unlinked project is rejected without starting a turn.
    for (const [projectId, agentId] of [
      ['restricted', 'restricted-dev'],
      ['solo', 'solo-dev'],
    ]) {
      const res = await request(server)
        .post(`/api/organizations/${orgA}/dispatches`)
        .set('X-API-Key', bob)
        .send({ projectId, agentId, prompt: 'Do it', idempotencyKey: `k-${projectId}` });
      expect(res.status).toBe(404);
    }
    expect(handleChat).not.toHaveBeenCalled();
    const ok = await request(server)
      .post(`/api/organizations/${orgA}/dispatches`)
      .set('X-API-Key', bob)
      .send({ projectId: 'shared', agentId: 'shared-dev', prompt: 'Do it', idempotencyKey: 'ok' })
      .expect(201);
    expect(getStmts().getSession.get(ok.body.sessionId)).toMatchObject({
      owner_user_id: 'bob',
      agent_id: 'shared-dev',
    });
  });

  it('revokes only the removed member, refuses renewal, and requires a fresh turn after re-adding', () => {
    const bob = mint(sid['a-bob'], 'bob');
    const anaA = mint(sid['a-ana'], 'ana');
    const anaB = mint(sid['b-ana'], 'ana');
    const renewed = renewOrganizationCapability(bob);
    expect(renewed).toBeTruthy();
    expect(verifyOrganizationCapability(bob)).toBeNull();

    removeBusinessOrganizationMember('default', orgA, 'bob');
    expect(stopped).toHaveBeenCalledWith(sid['a-bob']);
    expect(stopped).not.toHaveBeenCalledWith(sid['a-ana']);
    expect(verifyOrganizationCapability(renewed!)).toBeNull();
    expect(renewOrganizationCapability(renewed!)).toBeNull();
    expect(verifyOrganizationCapability(anaA)).toMatchObject({ userId: 'ana' });
    expect(verifyOrganizationCapability(anaB)).toMatchObject({ organizationId: orgB });
    expect(() => prepareOrganizationTurn(sid['a-bob'], true)).toThrow();
    const event = { type: 'organization_updated', serverId: 'default', organizationId: orgA };
    expect(delivered({ ...event, projectId: 'shared' }, 'bob')).toBe(false);
    expect(
      delivered(
        {
          type: 'organization_access_revoked',
          serverId: 'default',
          organizationId: orgA,
          userId: 'bob',
          reason: 'member_removed',
        },
        'bob',
      ),
    ).toBe(true);

    setBusinessOrganizationMember('default', orgA, 'bob', 'Member');
    expect(verifyOrganizationCapability(renewed!)).toBeNull();
    expect(() => prepareOrganizationTurn(sid['a-bob'], false)).toThrow(/new message/);
    expect(verifyOrganizationCapability(mint(sid['a-bob'], 'bob'))).toMatchObject({
      projectIds: ['shared'],
    });
  });

  it('unlinking from one organization leaves the other, and deletion cleans every link on this Server only', () => {
    const anaA = mint(sid['a-ana'], 'ana');
    const anaB = mint(sid['b-ana'], 'ana');
    appendOrganizationMemory(sid['b-ana'], {
      projectId: 'shared',
      sourceRecord: 'wiki:shared-plan',
      content: 'Beta follow-up',
    });
    const acmeOrg = createBusinessOrganization({
      serverId: 'acme',
      name: 'Acme group',
      createdBy: 'ana',
    }).id;
    attachBusinessOrganizationProject('acme', acmeOrg, 'shared');

    detachBusinessOrganizationProject('default', orgA, 'shared');
    expect(verifyOrganizationCapability(anaA)).toBeNull();
    expect(stopped).toHaveBeenCalledWith(sid['a-ana']);
    expect(verifyOrganizationCapability(anaB)).toMatchObject({ projectIds: ['shared'] });
    expect(readOrganizationMemory(sid['b-ana']).map((m) => m.content)).toEqual(['Beta follow-up']);
    expect(findProject('shared')).toBeTruthy();

    const shared = findProject('shared')!;
    deleteProjectScopedRows(getStmts(), shared);
    setProjects(getProjects().filter((p) => p.id !== 'shared'));
    expect(listBusinessOrganizationsForProject('default', 'shared')).toEqual([]);
    expect(verifyOrganizationCapability(anaB)).toBeNull();
    expect(stopped).toHaveBeenCalledWith(sid['b-ana']);
    // The other Server's project with the same ID keeps its link.
    expect(listBusinessOrganizationsForProject('acme', 'shared').map((o) => o.id)).toEqual([
      acmeOrg,
    ]);
    // A project recreated with the reused ID inherits no organization link or memory.
    setProjects([...getProjects(), project('shared')]);
    expect(listBusinessOrganizationsForProject('default', 'shared')).toEqual([]);
    expect(readOrganizationMemory.bind(null, sid['b-ana'])).toThrow();
    expect(verifyOrganizationCapability(mint(sid['b-ana'], 'ana'))).toMatchObject({
      projectIds: [],
    });
    expect(readOrganizationMemory(sid['b-ana'])).toEqual([]);
  });

  it('archiving one organization stops its sessions, survives restart and leaves the other working', async () => {
    const anaA = mint(sid['a-ana'], 'ana');
    const bobA = mint(sid['a-bob'], 'bob');
    const anaB = mint(sid['b-ana'], 'ana');
    archiveBusinessOrganization('default', orgA);
    archiveOrganizationWorkspace('default', orgA);
    expect(verifyOrganizationCapability(anaA)).toBeNull();
    expect(verifyOrganizationCapability(bobA)).toBeNull();
    expect(stopped).toHaveBeenCalledWith(sid['a-ana']);
    expect(stopped).toHaveBeenCalledWith(sid['a-bob']);
    expect(verifyOrganizationCapability(anaB)).toMatchObject({ projectIds: ['shared'] });
    const res = await request(app())
      .post(`/api/organizations/${orgA}/dispatches`)
      .set('X-API-Key', anaA)
      .send({ projectId: 'shared', agentId: 'shared-dev', prompt: 'x', idempotencyKey: 'arch' });
    expect([401, 403, 404]).toContain(res.status);
    expect(handleChat).not.toHaveBeenCalled();

    restart();
    expect(listBusinessOrganizations('default').map((o) => o.id)).toEqual([orgB]);
    const archived = getProjects().filter(
      (p) => p.workspaceKind === 'organization' && p.organizationId === orgA,
    );
    expect(archived).toHaveLength(1);
    expect(archived[0].archivedAt).toBeTruthy();
    expect(archived[0].agents.map((a) => a.id)).toEqual([assistantA]);
    expect(() => prepareOrganizationTurn(sid['a-ana'], true)).toThrow();
    // Archive-time members keep read access to their own history, nothing more.
    expect(canAccessOrganizationHistory(archived[0], 'ana', 'default')).toBe(true);
    expect(canAccessOrganizationHistory(archived[0], 'cara', 'default')).toBe(false);
    expect(listBusinessOrganizationProjectLinks('default', orgB).has('shared')).toBe(true);
    expect(verifyOrganizationCapability(mint(sid['b-ana'], 'ana'))).toMatchObject({
      projectIds: ['shared'],
    });
    // The member project itself was never touched.
    expect(findProject('shared')).toMatchObject({ id: 'shared', agents: [{ id: 'shared-dev' }] });
  });

  it('never recreates an archived Assistant, and names, templates and empty scopes grant nothing', async () => {
    const caller = resolveOrganizationCaller('default', 'ana')!;
    const ceo = createOrganizationAgent(caller, workspaceB, config, {
      templateId: 'ceo',
      name: 'Owner Admin',
      projects: [],
    });
    expect(ceo.organizationScope).toMatchObject({ projects: [], tools: ['projects:read'] });
    expect(ceo.computerToolEnabled).toBe(false);
    orgSession('b-ceo', orgB, ceo.id, 'ana');
    const ceoToken = mint(sid['b-ceo'], 'ana');
    expect(verifyOrganizationCapability(ceoToken)).toMatchObject({ projectIds: [] });
    const server = app();
    const overview = await request(server)
      .get(`/api/organizations/${orgB}/context`)
      .set('X-API-Key', ceoToken)
      .expect(200);
    expect(JSON.stringify(overview.body)).not.toContain('Open roadmap');
    expect(JSON.stringify(overview.body)).not.toMatch(/"shared"/);
    await request(server)
      .get(`/api/organizations/${orgB}/context/projects/shared/wiki`)
      .set('X-API-Key', ceoToken)
      .expect(404);
    await request(server).get('/api/projects/shared/wiki').set('X-API-Key', ceoToken).expect(403);
    const dispatch = await request(server)
      .post(`/api/organizations/${orgB}/dispatches`)
      .set('X-API-Key', ceoToken)
      .send({ projectId: 'shared', agentId: 'shared-dev', prompt: 'x', idempotencyKey: 'ceo' });
    expect([403, 404]).toContain(dispatch.status);
    expect(handleChat).not.toHaveBeenCalled();

    // Scope and tool edits on the Assistant revoke its current grant.
    const assistant = workspaceB.agents.find((a) => a.id === assistantB) as Agent;
    const before = mint(sid['b-ana'], 'ana');
    updateOrganizationAgent(caller, workspaceB, assistant, config, {
      tools: ['projects:read'],
    });
    expect(verifyOrganizationCapability(before)).toBeNull();
    expect(stopped).toHaveBeenCalledWith(sid['b-ana']);
    expect(assistant.computerToolEnabled).toBe(false);
    const narrowed = mint(sid['b-ana'], 'ana');
    updateOrganizationAgent(caller, workspaceB, assistant, config, { projects: [] });
    expect(verifyOrganizationCapability(narrowed)).toBeNull();
    expect(verifyOrganizationCapability(mint(sid['b-ana'], 'ana'))).toMatchObject({
      projectIds: [],
    });

    // An intentionally archived Assistant stays archived and is not reseeded.
    updateOrganizationAgent(caller, workspaceB, assistant, config, { archived: true });
    restart();
    const reloaded = getProjects().find((p) => p.id === workspaceB.id)!;
    expect(reloaded.agents.filter((a) => a.id === assistantB)).toHaveLength(1);
    expect(reloaded.agents.find((a) => a.id === assistantB)?.organizationScope?.archivedAt).toBe(
      assistant.organizationScope?.archivedAt,
    );
    expect(reloaded.agents).toHaveLength(2);
    expect(() => prepareOrganizationTurn(sid['b-ana'], true)).toThrow();

    // A roster emptied on purpose stays empty: the persisted Assistant ID is a tombstone.
    const alpha = getProjects().find((p) => p.id === workspaceA.id)!;
    alpha.agents = [];
    saveProjects();
    restart();
    const emptied = getProjects().find((p) => p.id === workspaceA.id)!;
    expect(emptied.agents).toEqual([]);
    expect(emptied.organizationAssistantId).toBe(assistantA);
    expect(() => prepareOrganizationTurn(sid['a-ana'], true)).toThrow();
  });

  it('keeps Computer profiles distinct across Servers, users, organizations and agents', () => {
    // Identical organization IDs in two Server partitions.
    getOrgsDb()
      .prepare('INSERT INTO business_organizations (server_id, id, name) VALUES (?, ?, ?)')
      .run('acme', orgA, 'Alpha on Acme');
    const acmeWorkspace = ensureOrganizationWorkspace('acme', orgA);
    expect(acmeWorkspace.id).toBe(organizationWorkspaceId('acme', orgA));
    expect(acmeWorkspace.id).not.toBe(workspaceA.id);
    expect(listProjectsForServer('acme').some((p) => p.id === acmeWorkspace.id)).toBe(true);
    expect(getProjects().some((p) => p.id === acmeWorkspace.id)).toBe(false);

    const key = (owner: string, agentId: string, workspace: Project, serverId = 'default') => {
      const result = resolveDesktopComputerIdentity({
        ownerUserId: owner,
        agentId,
        project: workspace,
        serverId,
      });
      return result.ok ? JSON.stringify(result.key) : null;
    };
    const keys = [
      key('ana', assistantA, workspaceA),
      key('bob', assistantA, workspaceA),
      key('ana', assistantB, workspaceB),
      key('ana', acmeWorkspace.organizationAssistantId!, acmeWorkspace, 'acme'),
    ];
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    // A workspace cannot borrow its desktop from another Server partition or organization.
    expect(key('ana', assistantA, workspaceA, 'acme')).toBeNull();
    expect(key('ana', assistantA, { ...workspaceA, organizationId: orgB })).toBeNull();
    expect(key('ana', assistantA, workspaceB)).toBeNull();
    // Regular projects: identical user, agent and project ids on two Servers never share a
    // disk, VM or browser login. The default Server keeps its legacy key.
    const acmeShared = listProjectsForServer('acme').find((p) => p.id === 'shared')!;
    const onDefault = resolveDesktopComputerIdentity({
      ownerUserId: 'ana',
      agentId: 'shared-dev',
      project: findProject('shared')!,
      serverId: 'default',
    });
    const onAcme = resolveDesktopComputerIdentity({
      ownerUserId: 'ana',
      agentId: 'shared-dev',
      project: acmeShared,
      serverId: 'acme',
    });
    if (!onDefault.ok || !onAcme.ok) throw new Error('identity refused');
    expect(onDefault.key).toEqual({ userId: 'ana', agentId: 'shared-dev', projectId: 'shared' });
    expect(onAcme.key.projectId).not.toBe('shared');
    expect(desktopVmId(onAcme.key)).not.toBe(desktopVmId(onDefault.key));
    const defaultLogin = getOrCreateBrowserProfile(onDefault.key);
    const acmeLogin = getOrCreateBrowserProfile(onAcme.key);
    expect(acmeLogin.id).not.toBe(defaultLogin.id);
    // The browser tool and approval gates derive the same per-Server profile key.
    expect(
      withBrowserProfile({} as never, {
        ownerUserId: 'ana',
        agentId: 'shared-dev',
        projectId: 'shared',
      }).profile,
    ).toEqual(onDefault.key);
    // A forged id that already carries a Server tag cannot alias another Server's key.
    expect(
      resolveDesktopComputerIdentity({
        ownerUserId: 'ana',
        agentId: 'shared-dev',
        project: { id: onAcme.key.projectId },
        serverId: 'default',
      }).ok,
    ).toBe(false);
    expect(getActiveOrgId()).toBe('default');
  });

  it('keeps regular project dispatch and the Hub compatible next to organizations', async () => {
    const server = app();
    const res = await request(server)
      .post('/api/projects/solo/sessions/dispatch')
      .set('x-test-user', 'bob')
      .send({ prompt: 'Regular task', agentId: 'solo-dev' })
      .expect(201);
    expect(getStmts().getSession.get(res.body.sessionId)).toMatchObject({
      owner_user_id: 'bob',
      agent_id: 'solo-dev',
    });
    expect(handleChat).toHaveBeenCalledTimes(1);
    // The organization workspace and the Hub are not dispatch targets.
    for (const id of [workspaceA.id, HUB_PROJECT_ID])
      await request(server)
        .post(`/api/projects/${id}/sessions/dispatch`)
        .set('x-test-user', 'ana')
        .send({ prompt: 'x' })
        .expect(404);
    // A human login cannot use the capability-only organization facade.
    const human = await request(server)
      .post(`/api/organizations/${orgA}/dispatches`)
      .set('x-test-user', 'ana')
      .send({ projectId: 'shared', agentId: 'shared-dev', prompt: 'x', idempotencyKey: 'h' });
    expect([401, 403]).toContain(human.status);
    expect(handleChat).toHaveBeenCalledTimes(1);
    // The Hub singleton is still found by its predicate; organization workspaces are not.
    expect(
      getProjects()
        .filter(isHubSystemProject)
        .map((p) => p.id),
    ).toEqual([HUB_PROJECT_ID]);
    // A Hub assistant chat keeps the regular (non-organization) runtime and tool policy.
    seedSession('hub-ana', `${HUB_PROJECT_ID}-dev`, 'ana');
    expect(organizationSessionWorkspace('hub-ana')).toBeNull();
    expect(organizationSessionAllowsTool('hub-ana', 'computer')).toBe(true);
    expect(currentOrganizationAuthority('hub-ana')).toBeNull();
  });
});
