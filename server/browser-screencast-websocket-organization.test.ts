import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import config from './config.js';
import { initDb, getDb } from './db.js';
import { initOrgsDb, getOrgsDb, setActiveOrgId } from './orgs.js';
import { setProjects } from './project-model.js';
import { createMembership } from './memberships-store.js';
import {
  createBusinessOrganization,
  removeBusinessOrganizationMember,
  setBusinessOrganizationMember,
} from './business-organizations-store.js';
import { resetOrganizationCapabilitiesForTests } from './organization-capabilities.js';
import { organizationWorkspaceId } from './organization-workspace-id.js';
import {
  attachBrowserScreencastWebSocket,
  type BrowserScreencastFeedHost,
  type BrowserScreencastWebSocketHandle,
} from './browser-screencast-websocket.js';
import type { WsAuthResult } from './auth.js';
import type { Agent, Project } from './types.js';

// Uses the real organization-session ownership predicate (no userOwnsSession
// stub) so the transport is checked against the same boundary REST enforces.

let organizationId: string;
const SESSION = 'org-browser';

const feedHost = {
  attach: () => () => {},
  input: async () => ({ ok: true as const }),
  navigate: async () => ({ ok: true as const }),
} as unknown as BrowserScreencastFeedHost;

const open: { server: Server; handle: BrowserScreencastWebSocketHandle }[] = [];

async function upgradeStatus(auth: WsAuthResult): Promise<number> {
  const server = createServer();
  const handle = attachBrowserScreencastWebSocket(server, {
    feedHost,
    sessionExists: (id) => id === SESSION,
    authenticate: () => auth,
    logger: { warn: () => {} },
  });
  open.push({ server, handle });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${SESSION}/browser/ws`);
    ws.once('open', () => {
      ws.close();
      resolve(101);
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.once('error', () => {});
  });
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
  const assistant = {
    id: `${id}assistant`,
    name: 'Organization Assistant',
    engine: 'claude-code',
    computerToolEnabled: true,
    organizationScope: { enabled: true, tools: ['computer', 'approvals'], projects: 'all-linked' },
  } as Agent;
  setProjects([
    {
      id,
      name: 'Group',
      cwd: config.dataDir,
      ahw: '',
      kind: 'system',
      organizationId,
      serverId: 'default',
      workspaceKind: 'organization',
      agents: [assistant],
    } as Project,
  ]);
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sessions (id, agent_id, name, engine, model, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(SESSION, assistant.id, 'Chat', 'claude-code', 'test', 'person');
});

afterEach(async () => {
  for (const { server, handle } of open.splice(0)) {
    handle.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('agent browser WebSocket for organization sessions', () => {
  it('connects the member who owns the session on its Server', async () => {
    expect(
      await upgradeStatus({ ok: true, userId: 'person', orgId: 'default', role: 'Owner' }),
    ).toBe(101);
  });

  it('refuses the owner after removal from the organization', async () => {
    setBusinessOrganizationMember('default', organizationId, 'other', 'Owner');
    removeBusinessOrganizationMember('default', organizationId, 'person');
    expect(
      await upgradeStatus({ ok: true, userId: 'person', orgId: 'default', role: 'Owner' }),
    ).toBe(404);
  });

  it('refuses the owner authenticated against a different Server', async () => {
    expect(
      await upgradeStatus({ ok: true, userId: 'person', orgId: 'second', role: 'Owner' }),
    ).toBe(404);
  });

  it('refuses a member of the organization who does not own the session', async () => {
    setBusinessOrganizationMember('default', organizationId, 'other', 'Member');
    expect(await upgradeStatus({ ok: true, userId: 'other', orgId: 'default', role: 'User' })).toBe(
      404,
    );
  });
});
