import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware, authenticateWsDetailed } from './auth.js';
import config, { buildSpawnEnv } from './config.js';
import { initDb, getDb, getStmts } from './db.js';
import { initOrgsDb, getOrgsDb, setActiveOrgId } from './orgs.js';
import { setProjects, findProject, findAgent } from './project-model.js';
import { createMembership } from './memberships-store.js';
import { createApiKey } from './api-keys-store.js';
import {
  createBusinessOrganization,
  attachBusinessOrganizationProject,
  detachBusinessOrganizationProject,
  archiveBusinessOrganization,
  setBusinessOrganizationMember,
  removeBusinessOrganizationMember,
} from './business-organizations-store.js';
import {
  issueOrganizationCapability,
  resetOrganizationCapabilitiesForTests,
  verifyOrganizationCapability,
  renewOrganizationCapability,
  prepareOrganizationTurn,
  setOrganizationRevocationHandler,
  sweepOrganizationCapabilities,
  organizationSessionAllowsTool,
  ORGANIZATION_CAPABILITY_TTL_MS,
  sanitizeOrganizationSpawnEnv,
} from './organization-capabilities.js';
import { createProjectVisibilityGate } from './project-visibility-middleware.js';
import { userOwnsSession, userCanReadSession } from './session-ownership.js';
import createCapabilityRoutes from './routes/organization-capabilities.js';
import createWikiRoutes from './routes/wiki.js';
import createArtifactsRoutes from './routes/artifacts.js';
import createSessionDispatchRoutes from './routes/session-dispatch.js';
import createSessionRoutes from './routes/sessions.js';
import { initBackgroundAgentSessionHook } from './background-agent-session.js';
import { createPage } from './wiki.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RouteDeps } from './types.js';
import type { AuthenticatedRequest } from './auth.js';
import { getProjectMode, defaultSessionUseWorktreeFlag } from './project-mode.js';
import { finalizeAllowedForProject } from './project-mode-guards.js';
import { ensureSpawnCredsForSession } from './spawn-creds-mint.js';
import { recoverActiveSessionsAfterSetup } from './spawn-creds-setup-recovery.js';
import { readSpawnCredsFile } from './spawn-creds-file.js';
import createChatHandler, { buildEnrichedPrompt, type ChatHandlerDeps } from './chat.js';
import { isReactChainCancelRequested, clearReactChainCancel } from './react-chain-cancel.js';
import { isHubSystemProject, isInternalSystemProject } from '../shared/utils/hub.js';
import { shouldDeliverBroadcast } from './broadcast-filter.js';
const run = promisify(execFile);
const handleChat = vi.fn(async () => {});
const stop = vi.fn();
let projects: Project[];
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createCapabilityRoutes());
  app.use('/api/projects/:projectId', createProjectVisibilityGate({ findProject }));
  const deps = {
    findProject,
    findAgent,
    config,
    stmts: getStmts(),
    broadcast: vi.fn(),
    handleChat,
  } as unknown as RouteDeps;
  app.use(createWikiRoutes(deps));
  app.use(createArtifactsRoutes(deps));
  app.use(createSessionDispatchRoutes(deps));
  app.get('/api/sessions/:sessionId', (req, res) => {
    if (!userCanReadSession(req as AuthenticatedRequest, String(req.params.sessionId))) {
      res.sendStatus(404);
      return;
    }
    res.json({ owner: (req as AuthenticatedRequest).authUserId });
  });
  app.use(createSessionRoutes(deps));
  // If auth ever falls through, these canaries expose the forbidden endpoint.
  app.use((_req, res) => res.json({ forbidden: true }));
  return app;
}
function mint() {
  prepareOrganizationTurn('org-session', true, workspace);
  return issueOrganizationCapability('org-session', 'person');
}

import type { IncomingMessage } from 'node:http';
import type { Project } from './types.js';

let organizationId: string;
let workspace: Project;
beforeEach(() => {
  resetOrganizationCapabilitiesForTests();
  initOrgsDb();
  setActiveOrgId('default');
  initDb(config.dataDir);
  getOrgsDb()
    .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run('person', 'person', 'unused');
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
        organizationScope: { enabled: true, tools: ['projects:read'], projects: 'all-linked' },
      },
    ],
  } as Project;
  projects = [
    workspace,
    {
      id: 'linked',
      name: 'Allowed',
      cwd: config.dataDir,
      ahw: '',
      agents: [{ id: 'target', name: 'Dev', engine: 'claude-code' }],
    },
    { id: 'unrelated', name: 'Independent', cwd: config.dataDir, ahw: '', agents: [] },
    {
      id: 'private',
      name: 'Secret',
      cwd: config.dataDir,
      ahw: '',
      visibility: 'private',
      ownerUserId: 'someone-else',
      agents: [],
    },
  ];
  setProjects(projects);
  attachBusinessOrganizationProject('default', organizationId, 'linked');
  attachBusinessOrganizationProject('default', organizationId, 'private');
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sessions (id, agent_id, name, engine, model, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('org-session', 'org-agent', 'Chat', 'claude-code', 'test', 'person');
  prepareOrganizationTurn('org-session', true);
  setOrganizationRevocationHandler(stop);
  stop.mockClear();
  handleChat.mockClear();
  initBackgroundAgentSessionHook({ stmts: getStmts(), config, handleChat, broadcast: vi.fn() });
});
afterEach(() => {
  setActiveOrgId('default');
  clearReactChainCancel('org-session');
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('organization capability regressions', () => {
  it('keeps organization history private even from Server administrators and bypass callers', () => {
    for (const claims of [
      { authUserId: 'another', authRole: 'Owner' as const },
      { authUserId: 'another', authRole: 'Admin' as const },
      { authViaApiKey: true },
      { authLocalOrgBypass: true },
    ]) {
      expect(userCanReadSession(claims, 'org-session')).toBe(false);
      expect(userOwnsSession(claims, 'org-session')).toBe(false);
    }
    expect(userCanReadSession({ authUserId: 'person' }, 'org-session')).toBe(true);
    archiveBusinessOrganization('default', organizationId);
    expect(userCanReadSession({ authUserId: 'person' }, 'org-session')).toBe(true);
  });
  it('does not broadcast organization chat content to another user or an anonymous bypass', () => {
    const deps = {
      resolveProjectId: () => workspace.id,
      findProject: () => workspace,
      getSessionOwner: () => 'person',
    };
    const event = { type: 'text', sessionId: 'org-session', text: 'private result' };
    expect(shouldDeliverBroadcast(event, { userId: 'another', role: 'Owner' }, deps)).toBe(false);
    expect(shouldDeliverBroadcast(event, { userId: null, localBypass: true }, deps)).toBe(false);
    expect(shouldDeliverBroadcast(event, undefined, deps)).toBe(false);
  });
  it('never injects the global key into an organization session', () => {
    const env = buildSpawnEnv(
      { ...config, apiKey: 'global-secret' },
      { sessionId: 'org-session', userId: 'person' },
    );
    expect(env.AGENT_HUB_API_KEY).toMatch(/^ahorg_/);
    expect(env.AGENT_HUB_API_KEY).not.toBe('global-secret');
  });
  it('rejects a forged capability before the no-auth bypass', async () => {
    const app = express();
    app.use(authMiddleware);
    app.get('/api/config', (_req, res) => res.json({ secret: true }));
    await request(app).get('/api/config').set('X-API-Key', 'ahorg_forged').expect(401);
  });
  it('does not allow capability WebSocket subscriptions through the local/no-auth bypass', () => {
    expect(
      authenticateWsDetailed({
        url: '/?apiKey=ahorg_forged',
        headers: { host: 'localhost' },
      } as IncomingMessage).ok,
    ).toBe(false);
  });
});

describe('direct organization capability requests', () => {
  it('reads an allowed project wiki through real routes and returns only scoped context', async () => {
    createPage('linked', {
      title: 'Scoped knowledge',
      content: 'Allowed content',
      category: 'architecture',
    });
    const token = mint();
    const app = makeApp();
    const wiki = await request(app)
      .get('/api/projects/linked/wiki')
      .set('X-API-Key', token)
      .expect(200);
    expect(wiki.body.some((page: { title: string }) => page.title === 'Scoped knowledge')).toBe(
      true,
    );
    const context = await request(app)
      .get(`/api/organizations/${organizationId}/capability-context`)
      .set('X-API-Key', token)
      .expect(200);
    expect(context.body.projects.map((project: { id: string }) => project.id)).toEqual(['linked']);
    expect(context.body.projects[0].agents).toEqual([{ id: 'target', name: 'Dev' }]);
    expect(context.body.serverId).toBe('default');
    expect(context.headers['cache-control']).toBe('no-store');
    expect(context.body).not.toHaveProperty('total');
  });

  it.each([
    '/api/config',
    '/api/auth/me',
    '/api/servers',
    '/api/organizations',
    '/api/projects/unrelated/wiki',
    '/api/projects/private/wiki',
    '/api/projects/org-workspace/wiki',
    '/api/projects/linked',
    '/api/projects/linked/user-settings',
    '/api/projects/linked/wiki-files',
    '/api/agents',
    '/api/sessions/other',
    '/api/sessions/other/credential-requests/login/consume',
    '/api/sessions/org-session/credential-requests/login/consume',
    '/api/organizations/other/capability-context',
    '/api/organizations/other/members',
    '/api/projects/linked/wiki%2f..%2fuser-settings',
  ])('denies %s even with a spoofed owner session header', async (url) => {
    await request(makeApp())
      .get(url)
      .set('X-API-Key', mint())
      .set('X-Agent-Hub-Session-Id', 'owner-session')
      .set('X-User-Id', 'owner')
      .expect(403);
  });

  it('uses capability identity even with a competing global key and forged owner headers', async () => {
    const token = mint();
    const response = await request(makeApp())
      .get('/api/sessions/org-session')
      .set('Authorization', `Bearer ${token}`)
      .set('X-API-Key', 'global-secret')
      .set('X-Agent-Hub-Session-Id', 'someone-else')
      .expect(200);
    expect(response.body.owner).toBe('person');
    await request(makeApp())
      .get('/api/config')
      .set('Authorization', 'Bearer unrelated')
      .set('X-API-Key', token)
      .expect(403);
  });

  it('denies artifact listing even with permission, and requires permission for uploads', async () => {
    await request(makeApp())
      .post('/api/sessions/org-session/artifacts')
      .set('X-API-Key', mint())
      .set('Content-Type', 'text/plain')
      .send('Unauthorized deliverable')
      .expect(403);
    workspace.agents[0].organizationScope!.tools.push('artifacts');
    const token = mint();
    await request(makeApp())
      .get('/api/sessions/org-session/artifacts')
      .set('X-API-Key', token)
      .expect(403);
    await request(makeApp())
      .get('/api/sessions/other/artifacts')
      .set('X-API-Key', token)
      .expect(403);
  });

  it.each(['get', 'head'] as const)(
    'denies %s artifact reads after unlink and a fresh turn, preserving owner access',
    async (method) => {
      const oldApiKey = config.apiKey;
      const oldBucket = config.artifactsBucket;
      config.apiKey = 'test-global-key';
      config.artifactsBucket = null;
      vi.stubEnv('AGENT_HUB_MODE', 'server');
      try {
        workspace.agents[0].organizationScope!.tools.push('artifacts');
        const oldCapability = mint();
        const ownerToken = createApiKey('person', 'Artifact history access').token;
        const app = makeApp();
        const secret = 'Confidential linked project result';
        const upload = await request(app)
          .post('/api/sessions/org-session/artifacts')
          .set('X-API-Key', oldCapability)
          .set('Content-Type', 'text/plain')
          .set('X-Filename', 'linked-project-result.txt')
          .send(secret)
          .expect(200);

        detachBusinessOrganizationProject('default', organizationId, 'linked');
        expect(verifyOrganizationCapability(oldCapability)).toBeNull();
        prepareOrganizationTurn('org-session', true, workspace);
        const freshCapability = issueOrganizationCapability('org-session', 'person');
        expect(verifyOrganizationCapability(freshCapability)).toMatchObject({
          projectIds: [],
          tools: ['artifacts', 'projects:read'],
        });

        const ownerList = await request(app)
          .get('/api/sessions/org-session/artifacts')
          .set('X-API-Key', ownerToken)
          .expect(200);
        expect(ownerList.body.artifacts).toContainEqual(
          expect.objectContaining({ id: upload.body.id }),
        );
        await request(app)
          .get(upload.body.url + '?download=1')
          .set('X-API-Key', ownerToken)
          .expect(200, secret);

        // Bytes, presigned redirects, and metadata must all stay out of fresh context.
        for (const url of [
          upload.body.url,
          upload.body.url + '?download=1',
          upload.body.url + '?redirect=1',
          '/api/sessions/org-session/artifacts',
        ]) {
          await request(app)[method](url).set('X-API-Key', freshCapability).expect(403);
        }
        // Deliverables remain supported in the new authorization context.
        await request(app)
          .post('/api/sessions/org-session/artifacts')
          .set('X-API-Key', freshCapability)
          .set('Content-Type', 'text/plain')
          .send('New turn deliverable')
          .expect(200);
      } finally {
        config.apiKey = oldApiKey;
        config.artifactsBucket = oldBucket;
      }
    },
  );

  it('requires explicit target and dispatch permission; forbids automation escalation', async () => {
    await request(makeApp())
      .post('/api/projects/linked/sessions/dispatch')
      .set('X-API-Key', mint())
      .send({ agentId: 'target', prompt: 'Do work' })
      .expect(403);
    workspace.agents[0].organizationScope!.tools.push('dispatch');
    const token = mint();
    for (const body of [
      { prompt: 'Do work' },
      { agentId: 'target', prompt: 'Do work', mode: 'merge' },
      { agentId: 'target', prompt: 'Do work', engine: 'codex-cli' },
    ]) {
      await request(makeApp())
        .post('/api/projects/linked/sessions/dispatch')
        .set('X-API-Key', token)
        .send(body)
        .expect(403);
    }
    await request(makeApp())
      .post('/api/projects/unrelated/sessions/dispatch')
      .set('X-API-Key', token)
      .send({ agentId: 'target', prompt: 'Do work' })
      .expect(403);
    expect(handleChat).not.toHaveBeenCalled();
    const result = await request(makeApp())
      .post('/api/projects/linked/sessions/dispatch')
      .set('X-API-Key', token)
      .set('X-Agent-Hub-Session-Id', 'spoofed-owner')
      .send({ agentId: 'target', prompt: 'Do work' })
      .expect(201);
    expect(getStmts().getSession.get(result.body.sessionId)).toMatchObject({
      owner_user_id: 'person',
      agent_id: 'target',
      finalize_automation: 'manual',
    });
  });

  it.each([
    ['get', ''],
    ['get', '?paginated=1&limit=40'],
    ['head', ''],
  ] as const)(
    'denies %s history%s after unlink and a fresh user turn, preserving owner access',
    async (method, query) => {
      const oldApiKey = config.apiKey;
      config.apiKey = 'test-global-key';
      vi.stubEnv('AGENT_HUB_MODE', 'server');
      try {
        const ownerToken = createApiKey('person', 'History access').token;
        const oldCapability = mint();
        getDb()
          .prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)')
          .run('project-history', 'org-session', 'assistant', 'Confidential linked project result');
        getDb()
          .prepare('UPDATE sessions SET engine_session_id = ? WHERE id = ?')
          .run('old-cli-context', 'org-session');

        detachBusinessOrganizationProject('default', organizationId, 'linked');
        expect(verifyOrganizationCapability(oldCapability)).toBeNull();
        prepareOrganizationTurn('org-session', true, workspace);
        const freshCapability = issueOrganizationCapability('org-session', 'person');
        expect(verifyOrganizationCapability(freshCapability)?.projectIds).not.toContain('linked');
        expect(getStmts().getSession.get('org-session')).toMatchObject({ engine_session_id: null });

        const app = makeApp();
        // The owner's retained transcript is readable through the real history route.
        const ownerHistory = await request(app)
          .get('/api/sessions/org-session/messages' + query)
          .set('X-API-Key', ownerToken)
          .expect(200);
        expect(ownerHistory.body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: 'Confidential linked project result' }),
          ]),
        );
        await request(app)
          [method]('/api/sessions/org-session/messages' + query)
          .set('X-API-Key', freshCapability)
          .set('X-Agent-Hub-Session-Id', 'org-session')
          .expect(403);
      } finally {
        config.apiKey = oldApiKey;
      }
    },
  );

  it('rotates via the renewal endpoint and invalidates the old token', async () => {
    const token = mint();
    const response = await request(makeApp())
      .post('/api/sessions/org-session/organization-capability/renew')
      .set('X-API-Key', token)
      .expect(200);
    expect(response.body.token).not.toBe(token);
    expect(verifyOrganizationCapability(token)).toBeNull();
    expect(verifyOrganizationCapability(response.body.token)?.userId).toBe('person');
    await request(makeApp())
      .post('/api/sessions/other/organization-capability/renew')
      .set('X-API-Key', response.body.token)
      .expect(403);
  });

  it('keeps capability ownership strict even when no auth is configured', () => {
    const grant = verifyOrganizationCapability(mint())!;
    const caller = {
      authUserId: 'person',
      authRole: 'Owner' as const,
      authViaApiKey: true,
      authOrganizationCapability: grant,
    };
    expect(userOwnsSession(caller, 'org-session')).toBe(true);
    expect(userOwnsSession(caller, 'other')).toBe(false);
    expect(userCanReadSession(caller, 'other')).toBe(false);
  });
});

describe('revocation and current authority', () => {
  it.each([
    'membership',
    'archive',
    'unlink',
    'acl',
    'disabled',
    'agent-archive',
    'tools',
    'scope',
    'owner',
    'server',
    'identity',
  ])('revokes existing and renewable credentials after %s changes', (change) => {
    const token = mint();
    const scope = workspace.agents[0].organizationScope!;
    getDb()
      .prepare('UPDATE sessions SET engine_session_id = ? WHERE id = ?')
      .run('old-context', 'org-session');
    if (change === 'membership') {
      getOrgsDb()
        .prepare(
          'DELETE FROM business_organization_members WHERE server_id = ? AND organization_id = ?',
        )
        .run('default', organizationId);
    } else if (change === 'archive') archiveBusinessOrganization('default', organizationId);
    else if (change === 'unlink')
      detachBusinessOrganizationProject('default', organizationId, 'linked');
    else if (change === 'acl') {
      projects[1].visibility = 'private';
      projects[1].ownerUserId = 'elsewhere';
    } else if (change === 'disabled') scope.enabled = false;
    else if (change === 'agent-archive') scope.archivedAt = new Date().toISOString();
    else if (change === 'tools') scope.tools = [];
    else if (change === 'scope') scope.projects = [];
    else if (change === 'owner')
      getDb().prepare('UPDATE sessions SET owner_user_id = NULL WHERE id = ?').run('org-session');
    else if (change === 'server') workspace.serverId = 'foreign';
    else if (change === 'identity')
      getOrgsDb().prepare('DELETE FROM users WHERE id = ?').run('person');
    expect(verifyOrganizationCapability(token)).toBeNull();
    expect(renewOrganizationCapability(token)).toBeNull();
    expect(stop).toHaveBeenCalledWith('org-session');
    expect(getStmts().getSession.get('org-session')).toMatchObject({ engine_session_id: null });
    expect(() => prepareOrganizationTurn('org-session', false)).toThrow();
  });

  it('stops an idle running turn when the periodic current-access check detects narrowing', () => {
    vi.useFakeTimers();
    mint();
    workspace.agents[0].organizationScope!.projects = [];
    sweepOrganizationCapabilities();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(organizationSessionAllowsTool('org-session', 'wiki')).toBe(false);
    prepareOrganizationTurn('org-session', true);
    const next = verifyOrganizationCapability(mint())!;
    expect(next.projectIds).toEqual([]);
  });

  it('expires credentials and refuses renewal after the short lifetime', () => {
    vi.useFakeTimers();
    const token = mint();
    vi.setSystemTime(Date.now() + ORGANIZATION_CAPABILITY_TTL_MS + 1);
    expect(verifyOrganizationCapability(token)).toBeNull();
    expect(renewOrganizationCapability(token)).toBeNull();
  });

  it('renaming a role cannot grant scope and host actions enforce permissions', () => {
    workspace.agents[0].role = 'Owner';
    workspace.agents[0].name = 'CEO';
    workspace.agents[0].organizationScope!.projects = [];
    const grant = verifyOrganizationCapability(mint())!;
    expect(grant.projectIds).toEqual([]);
    expect(organizationSessionAllowsTool('org-session', 'computer')).toBe(false);
    expect(organizationSessionAllowsTool('org-session', 'terminal')).toBe(false);
    workspace.agents[0].organizationScope!.tools.push('computer');
    sweepOrganizationCapabilities();
    prepareOrganizationTurn('org-session', true);
    expect(organizationSessionAllowsTool('org-session', 'computer')).toBe(true);
  });
});

describe('spawn and shell wrapper isolation', () => {
  it('fails closed on missing or mismatched identity and malformed scope', () => {
    expect(() => buildSpawnEnv(config, { sessionId: 'org-session' })).toThrow();
    expect(() => buildSpawnEnv(config, { sessionId: 'org-session', userId: 'other' })).toThrow();
    delete workspace.agents[0].organizationScope;
    expect(() => buildSpawnEnv(config, { sessionId: 'org-session', userId: 'person' })).toThrow();
  });

  it('strips inherited privileged credentials and host provider keys', () => {
    for (const key of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'DEV_HUB_API_KEY',
      'DATABASE_PASSWORD',
      'DATABASE_URL',
      'SDK_CONFIG_FILE',
      'GIT_CONFIG_VALUE_0',
    ])
      vi.stubEnv(key, 'host-secret');
    const env = buildSpawnEnv(
      { ...config, apiKey: 'global-secret', geminiApiKey: 'host-gemini', xaiApiKey: 'host-xai' },
      {
        sessionId: 'org-session',
        userId: 'person',
        engine: 'grok-cli',
        userOverride: { anthropicApiKey: 'personal-key' },
      },
    );
    for (const key of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'DEV_HUB_API_KEY',
      'DATABASE_PASSWORD',
      'DATABASE_URL',
      'SDK_CONFIG_FILE',
      'GIT_CONFIG_VALUE_0',
      'AGENT_HUB_DATA_DIR',
      'GEMINI_API_KEY',
      'XAI_API_KEY',
    ])
      expect(env[key]).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('personal-key');
    expect(env.AGENT_HUB_CREDENTIAL_SCOPE).toBe('organization');
    expect(env.HOME).toContain('per-user-creds/person/home');
    expect(() =>
      sanitizeOrganizationSpawnEnv({ ...env, AGENT_HUB_API_KEY: 'global-secret' }),
    ).toThrow();
  });

  it('retains regular session global-key behavior', () => {
    expect(
      buildSpawnEnv({ ...config, apiKey: 'regular-global' }, { sessionId: 'ordinary' })
        .AGENT_HUB_API_KEY,
    ).toBe('regular-global');
  });

  it('keeps organization workspaces distinct from Hub and rejects internal project access', async () => {
    expect(isHubSystemProject(workspace)).toBe(false);
    expect(isInternalSystemProject(workspace)).toBe(true);
    expect(() =>
      attachBusinessOrganizationProject('default', organizationId, workspace.id),
    ).toThrow('Project not found');
    await request(makeApp()).get('/api/projects/org-workspace/wiki').expect(404);
  });

  it('executes the real shell wrapper with a scoped token and refuses config fallback', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'org-wrapper-'));
    mkdirSync(path.join(directory, '.agent-hub/data'), { recursive: true });
    writeFileSync(
      path.join(directory, '.agent-hub/data/config.json'),
      JSON.stringify({ apiKey: 'host-secret' }),
    );
    const server = makeApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const script = path.resolve('default-skills/agent-hub/scripts/ah-api.sh');
    const env = {
      ...process.env,
      HOME: directory,
      AGENT_HUB_DATA_DIR: directory,
      AGENT_HUB_URL: `http://127.0.0.1:${address.port}`,
      AGENT_HUB_SESSION_ID: 'owner-spoof',
      AGENT_HUB_CREDENTIAL_SCOPE: 'organization',
      AGENT_HUB_API_KEY: mint(),
    };
    try {
      const allowed = await run('bash', [script, 'GET', '/api/projects/linked/wiki'], { env });
      expect(Array.isArray(JSON.parse(allowed.stdout))).toBe(true);
      await expect(run('bash', [script, 'GET', '/api/config'], { env })).rejects.toMatchObject({
        code: 22,
      });
      await expect(
        run('bash', [script, 'GET', '/api/projects/linked/wiki'], {
          env: { ...env, AGENT_HUB_API_KEY: '' },
        }),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('runtime boundaries', () => {
  it('cannot revive an old grant by unlinking and immediately relinking a project', () => {
    const token = mint();
    detachBusinessOrganizationProject('default', organizationId, 'linked');
    attachBusinessOrganizationProject('default', organizationId, 'linked');
    expect(verifyOrganizationCapability(token)).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => prepareOrganizationTurn('org-session', false)).toThrow();
  });

  it('cannot revive membership credentials by removing and immediately readding the member', () => {
    getOrgsDb()
      .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run('second-owner', 'second-owner', 'unused');
    createMembership('second-owner', 'default', 'User');
    setBusinessOrganizationMember('default', organizationId, 'second-owner', 'Owner');
    const token = mint();
    removeBusinessOrganizationMember('default', organizationId, 'person');
    setBusinessOrganizationMember('default', organizationId, 'person', 'Owner');
    expect(verifyOrganizationCapability(token)).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('cannot issue global credentials after the organization session row disappears', () => {
    buildSpawnEnv(config, { sessionId: 'org-session', userId: 'person' });
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run('org-session');
    expect(() =>
      buildSpawnEnv(
        { ...config, apiKey: 'host-secret' },
        { sessionId: 'org-session', userId: 'person' },
      ),
    ).toThrow();
    expect(organizationSessionAllowsTool('org-session', 'wiki')).toBe(false);
  });

  it('does not mint unrestricted recovery keys for organization sessions', () => {
    ensureSpawnCredsForSession({
      sessionId: 'org-session',
      ownerUserId: 'person',
      cfg: { ...config, apiKey: null },
    });
    expect(readSpawnCredsFile('org-session', config.dataDir)).toBeNull();
    recoverActiveSessionsAfterSetup({
      db: getDb(),
      dataDir: config.dataDir,
      ownerUserId: 'person',
    });
    expect(readSpawnCredsFile('org-session', config.dataDir)).toBeNull();
  });

  it('forces internal organization workspaces into non-shipping, worktree-free mode', () => {
    workspace.mode = 'dev';
    expect(getProjectMode(workspace)).toBe('workflow');
    expect(defaultSessionUseWorktreeFlag(workspace)).toBe(0);
    expect(finalizeAllowedForProject(workspace)).toBe(false);
  });

  it('builds bounded authorized prompts without shared workspace memory', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'org-memory-'));
    workspace.ahw = directory;
    writeFileSync(path.join(directory, 'MEMORY.md'), 'OTHER USER PRIVATE PROJECT CONTENT');
    workspace.agents[0].systemPrompt = 'Deliberately shared instructions';
    prepareOrganizationTurn('org-session', true, workspace);
    try {
      const prompt = buildEnrichedPrompt(workspace, workspace.agents[0], {
        sessionId: 'org-session',
      });
      expect(prompt).toContain('Deliberately shared instructions');
      expect(prompt).toContain(`/api/organizations/${organizationId}/capability-context`);
      expect(prompt).not.toContain('OTHER USER PRIVATE PROJECT CONTENT');
      expect(() => buildEnrichedPrompt(workspace, workspace.agents[0])).toThrow('session identity');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it('stops the actual registered process handle and cancels queued continuations on access loss', () => {
  const kill = vi.fn();
  const broadcast = vi.fn();
  createChatHandler({
    activeProcesses: new Map([['org-session', { kill }]]),
    broadcast,
    stmts: getStmts(),
    config,
    findAgent,
  } as unknown as ChatHandlerDeps);
  mint();
  detachBusinessOrganizationProject('default', organizationId, 'linked');
  expect(kill).toHaveBeenCalledWith('SIGTERM');
  expect(isReactChainCancelRequested('org-session')).toBe(true);
  expect(broadcast).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error', sessionId: 'org-session' }),
  );
});

it('binds identical session IDs to their Server and never revives a token after switching', () => {
  const old = mint();
  getOrgsDb().prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('other', 'Other')").run();
  createMembership('person', 'other', 'Owner');
  const other = createBusinessOrganization({
    serverId: 'other',
    name: 'Other group',
    createdBy: 'person',
  });
  setActiveOrgId('other');
  workspace.serverId = 'other';
  workspace.organizationId = other.id;
  setProjects([workspace]);
  prepareOrganizationTurn('org-session', true, workspace);
  const next = mint();
  expect(verifyOrganizationCapability(old)).toBeNull();
  expect(verifyOrganizationCapability(next)).toMatchObject({
    serverId: 'other',
    organizationId: other.id,
    sessionId: 'org-session',
  });
  expect(verifyOrganizationCapability(next)).not.toBeNull();
});

it('does not stop a new turn when an older credential expires', () => {
  vi.useFakeTimers();
  const old = mint();
  vi.setSystemTime(Date.now() + ORGANIZATION_CAPABILITY_TTL_MS / 2);
  const current = mint();
  vi.setSystemTime(Date.now() + ORGANIZATION_CAPABILITY_TTL_MS / 2 + 1);
  sweepOrganizationCapabilities();
  expect(verifyOrganizationCapability(old)).toBeNull();
  expect(verifyOrganizationCapability(current)).not.toBeNull();
  expect(stop).not.toHaveBeenCalled();
});

it('rebuilds saved CLI context when no live authorization snapshot survived a restart', () => {
  const previousToken = mint();
  resetOrganizationCapabilitiesForTests();
  expect(verifyOrganizationCapability(previousToken)).toBeNull();
  issueOrganizationCapability('org-session', 'person'); // A shell credential cannot certify saved CLI context.
  getDb()
    .prepare(
      'UPDATE sessions SET engine_session_id = ?, fork_from_engine_session_id = ?, pending_skill_context = ? WHERE id = ?',
    )
    .run('old-cli', 'old-fork', 'old-project-context', 'org-session');
  expect(() => prepareOrganizationTurn('org-session', false, workspace)).toThrow('new message');
  prepareOrganizationTurn('org-session', true, workspace);
  expect(getStmts().getSession.get('org-session')).toMatchObject({
    engine_session_id: null,
    fork_from_engine_session_id: null,
    pending_skill_context: null,
  });
});
