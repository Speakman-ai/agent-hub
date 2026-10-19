import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import config from './config.js';
import { initDb, getDb, getStmts } from './db.js';
import { initOrgsDb, getOrgsDb, setActiveOrgId } from './orgs.js';
import { setProjects, findProject, findAgent } from './project-model.js';
import { createMembership } from './memberships-store.js';
import {
  archiveBusinessOrganization,
  createBusinessOrganization,
  removeBusinessOrganizationMember,
  setBusinessOrganizationMember,
} from './business-organizations-store.js';
import {
  prepareOrganizationTurn,
  resetOrganizationCapabilitiesForTests,
  revokeOrganizationSession,
} from './organization-capabilities.js';
import { organizationWorkspaceId } from './organization-workspace-id.js';
import {
  agentComputerDenial,
  ownerComputerAllowed,
  sessionDesktopComputerIdentity,
} from './session-computer-access.js';
import { runComputerReActStep } from './desktop/computer-react.js';
import { desktopVmId } from './desktop/firecracker-desktop-runtime.js';
import type { DesktopComputerKey, DesktopRuntime } from './desktop/desktop-runtime.js';
import createSessionRoutes from './routes/sessions.js';
import type { Agent, Project, RouteDeps } from './types.js';

let organizationId: string;
let workspace: Project;
let assistant: Agent;

function seedSession(id: string, agentId: string, owner = 'person') {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sessions (id, agent_id, name, engine, model, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, agentId, 'Chat', 'claude-code', 'test', owner);
}

function fakeRuntime() {
  const calls: { op: string; key: DesktopComputerKey }[] = [];
  const runtime = {
    kind: 'container',
    ensureStarted: vi.fn(),
    stop: vi.fn(),
    destroy: vi.fn(),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
    screenshot: vi.fn(),
    viewFrame: vi.fn(),
    input: vi.fn(async (key: DesktopComputerKey) => {
      calls.push({ op: 'input', key });
    }),
    mapDisplayPort: vi.fn(),
    status: vi.fn(),
  } as unknown as DesktopRuntime;
  return { runtime, calls };
}

beforeEach(() => {
  resetOrganizationCapabilitiesForTests();
  initOrgsDb();
  setActiveOrgId('default');
  initDb(config.dataDir);
  for (const id of ['person', 'other'])
    getOrgsDb()
      .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(id, id, 'unused');
  createMembership('person', 'default', 'Owner');
  createMembership('other', 'default', 'User');
  organizationId = createBusinessOrganization({
    serverId: 'default',
    name: 'Group',
    createdBy: 'person',
  }).id;
  const id = organizationWorkspaceId('default', organizationId);
  assistant = {
    id: `${id}assistant`,
    name: 'Organization Assistant',
    engine: 'claude-code',
    computerToolEnabled: true,
    organizationScope: { enabled: true, tools: ['computer', 'approvals'], projects: 'all-linked' },
  } as Agent;
  workspace = {
    id,
    name: 'Group',
    cwd: config.dataDir,
    ahw: '',
    kind: 'system',
    organizationId,
    serverId: 'default',
    workspaceKind: 'organization',
    agents: [
      assistant,
      {
        id: `${id}agent_custom`,
        name: 'Finance',
        engine: 'claude-code',
        organizationScope: { enabled: true, tools: ['projects:read'], projects: [] },
      },
    ],
  } as Project;
  setProjects([
    workspace,
    { id: 'regular', name: 'Regular', cwd: config.dataDir, ahw: '', agents: [] } as Project,
  ]);
  seedSession('org-computer', assistant.id);
  seedSession('org-custom', `${id}agent_custom`);
  prepareOrganizationTurn('org-computer', true);
  prepareOrganizationTurn('org-custom', true);
});

describe('organization agent computer identity', () => {
  it('keys the desktop by the Server-qualified workspace and keeps it across a rename', () => {
    const before = sessionDesktopComputerIdentity('person', assistant.id, workspace);
    expect(before).toEqual({
      ok: true,
      key: { userId: 'person', agentId: assistant.id, projectId: workspace.id },
    });
    assistant.name = 'Chief of Staff';
    const after = sessionDesktopComputerIdentity('person', assistant.id, workspace);
    expect(after).toEqual(before);
  });

  it('refuses a workspace that belongs to another Server partition', () => {
    setActiveOrgId('second');
    const r = sessionDesktopComputerIdentity('person', assistant.id, workspace);
    expect(r.ok).toBe(false);
  });

  it('gives each user and organization agent its own disk', () => {
    const keys = [
      sessionDesktopComputerIdentity('person', assistant.id, workspace),
      sessionDesktopComputerIdentity('other', assistant.id, workspace),
      sessionDesktopComputerIdentity('person', `${workspace.id}agent_custom`, workspace),
    ].map((r) => (r.ok ? desktopVmId(r.key) : null));
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('organization agent computer authorization', () => {
  it('allows the Assistant and refuses a custom agent whose scope lacks Computer', () => {
    expect(agentComputerDenial('org-computer')).toBeNull();
    expect(agentComputerDenial('org-custom')).toMatch(/not authorized/);
    expect(ownerComputerAllowed('org-custom')).toBe(false);
    // Regular project sessions are unaffected.
    seedSession('regular-session', 'nope');
    expect(agentComputerDenial('regular-session')).toBeNull();
  });

  it('denies future operations after the agent is archived or disabled', () => {
    assistant.organizationScope!.archivedAt = '2026-10-19T00:00:00Z';
    expect(agentComputerDenial('org-computer')).not.toBeNull();
    expect(ownerComputerAllowed('org-computer')).toBe(false);
    delete assistant.organizationScope!.archivedAt;
    assistant.organizationScope!.enabled = false;
    expect(ownerComputerAllowed('org-computer')).toBe(false);
  });

  it('denies after the organization is archived or the member is removed', () => {
    setBusinessOrganizationMember('default', organizationId, 'other', 'Owner');
    removeBusinessOrganizationMember('default', organizationId, 'person');
    expect(ownerComputerAllowed('org-computer')).toBe(false);
    setBusinessOrganizationMember('default', organizationId, 'person', 'Owner');
    expect(ownerComputerAllowed('org-computer')).toBe(true);
    archiveBusinessOrganization('default', organizationId);
    expect(ownerComputerAllowed('org-computer')).toBe(false);
  });

  it('keeps owner access after the CLI credential lapses, but not agent access', () => {
    revokeOrganizationSession('org-computer');
    expect(agentComputerDenial('org-computer')).not.toBeNull();
    expect(ownerComputerAllowed('org-computer')).toBe(true);
  });

  it('never boots a desktop for a revoked agent and stops input revoked during approval', async () => {
    const { runtime, calls } = fakeRuntime();
    const resolveRuntime = vi.fn(() => runtime);
    const key = { userId: 'person', agentId: assistant.id, projectId: workspace.id };
    const ctx = {
      sessionId: 'org-computer',
      ownerUserId: 'person',
      agentId: assistant.id,
      projectId: workspace.id,
      key,
    };
    const authorize = () => agentComputerDenial('org-computer');

    // Access is revoked while the human is deciding on the approval.
    const gate = vi.fn(async () => {
      assistant.organizationScope!.tools = ['approvals'];
      return { proceed: true as const };
    });
    const r = await runComputerReActStep({ op: 'click', x: 10, y: 10, button: 'left' }, ctx, {
      resolveRuntime,
      gate,
      authorize,
    });
    expect(r.hostExit).toBe(2);
    expect(r.haltRemaining).toBeTruthy();
    expect(calls).toEqual([]);

    resolveRuntime.mockClear();
    const denied = await runComputerReActStep({ op: 'screenshot' }, ctx, {
      resolveRuntime,
      authorize,
    });
    expect(denied.hostExit).toBe(2);
    expect(resolveRuntime).not.toHaveBeenCalled();
  });

  it('refuses an op revoked while the runtime was resolving, with and without a gate', async () => {
    const key = { userId: 'person', agentId: assistant.id, projectId: workspace.id };
    const ctx = {
      sessionId: 'org-computer',
      ownerUserId: 'person',
      agentId: assistant.id,
      projectId: workspace.id,
      key,
    };
    const authorize = () => agentComputerDenial('org-computer');
    for (const withGate of [false, true]) {
      assistant.organizationScope!.tools = ['computer', 'approvals'];
      const { runtime, calls } = fakeRuntime();
      // Revocation lands while resolution is pending.
      const resolveRuntime = vi.fn(async () => {
        assistant.organizationScope!.tools = ['approvals'];
        return runtime;
      });
      const gate = vi.fn(async (_op: unknown, probe: (c: string) => Promise<unknown>) => {
        await probe('xdotool getactivewindow');
        return { proceed: true as const };
      });
      const r = await runComputerReActStep({ op: 'click', x: 1, y: 1, button: 'left' }, ctx, {
        resolveRuntime,
        authorize,
        ...(withGate ? { gate } : {}),
      });
      expect(r.hostExit).toBe(2);
      expect(r.hostDetail).toBe('computer_denied');
      expect(calls).toEqual([]);
      expect(runtime.exec).not.toHaveBeenCalled();
      expect(gate).not.toHaveBeenCalled();
    }
  });

  it('keeps chat usable when no desktop backend is available', async () => {
    const r = await runComputerReActStep(
      { op: 'screenshot' },
      {
        sessionId: 'org-computer',
        ownerUserId: 'person',
        agentId: assistant.id,
        projectId: workspace.id,
        key: { userId: 'person', agentId: assistant.id, projectId: workspace.id },
      },
      {
        resolveRuntime: () => {
          throw new Error('No desktop runtime is available on this host');
        },
        authorize: () => agentComputerDenial('org-computer'),
      },
    );
    expect(r.hostExit).toBe(1);
    expect(r.markdown).toMatch(/No desktop runtime/);
  });
});

describe('PUT /api/sessions/:sessionId/computer-tool for organization sessions', () => {
  function app() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      Object.assign(req, { authUserId: 'person', authOrgId: 'default', authRole: 'Owner' });
      next();
    });
    a.use(
      createSessionRoutes({
        findProject,
        findAgent,
        config,
        stmts: getStmts(),
        broadcast: vi.fn(),
      } as unknown as RouteDeps),
    );
    return a;
  }

  it('refuses to turn Computer on outside the agent scope but always allows off', async () => {
    await request(app())
      .put('/api/sessions/org-custom/computer-tool')
      .send({ enabled: true })
      .expect(403);
    const off = await request(app())
      .put('/api/sessions/org-custom/computer-tool')
      .send({ enabled: false })
      .expect(200);
    expect(off.body.computer_tool_enabled).toBe(0);
  });

  it('lets the session switch override the Assistant default off and back on', async () => {
    const off = await request(app())
      .put('/api/sessions/org-computer/computer-tool')
      .send({ enabled: false })
      .expect(200);
    expect(off.body.computer_tool_enabled).toBe(0);
    const on = await request(app())
      .put('/api/sessions/org-computer/computer-tool')
      .send({ enabled: true })
      .expect(200);
    expect(on.body.computer_tool_enabled).toBe(1);
  });
});
