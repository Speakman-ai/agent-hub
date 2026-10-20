// @vitest-environment jsdom
/**
 * Mobile acceptance flow for organizations, through the real Organizations panel, agents and
 * portfolio sections and the shared API clients. Requests go to an in-memory Hub that keeps
 * state across Servers, users and remounts, so the flow runs in order: Server selection →
 * explicit organizations → one project linked to two organizations → customizable agents →
 * project-agent dispatch with status → organization chat with its Computer owner → restricted
 * member → unlink → archive → remount (restart) without resurrection.
 *
 * Server-side enforcement of the same rules is covered by server/test/organization-acceptance.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Agent = {
  id: string;
  name: string;
  engine: string;
  model?: string;
  systemPrompt?: string;
  computerToolEnabled: boolean;
  isAssistant?: boolean;
  organizationTemplate?: { id: string; version: number };
  organizationScope: {
    enabled: boolean;
    archivedAt: string | null;
    projects: 'all-linked' | string[];
    tools: string[];
  };
};
type Organization = {
  id: string;
  serverId: string;
  name: string;
  archived: boolean;
  members: Record<string, 'Owner' | 'Admin' | 'Member'>;
  links: string[];
  agents: Agent[];
};

const ALL_TOOLS = [
  'projects:read',
  'dispatch',
  'artifacts',
  'credentials',
  'skills',
  'web',
  'browser',
  'computer',
  'approvals',
];

const hub = vi.hoisted(() => ({
  server: 'server-a',
  user: 'owner',
  users: { owner: 'Owner', member: 'Member' } as Record<string, string>,
  projects: {} as Record<
    string,
    { id: string; name: string; agents: { id: string; name: string }[]; only?: string[] }[]
  >,
  organizations: [] as Organization[],
  chats: [] as { id: string; organizationId: string; agentId: string; owner: string }[],
  dispatches: [] as any[],
  requests: [] as string[],
}));

function denied(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
function canAccess(projectId: string) {
  const project = hub.projects[hub.server].find((p) => p.id === projectId);
  return Boolean(project && (!project.only || project.only.includes(hub.user)));
}
function visibleOrganization(id: string) {
  const organization = hub.organizations.find(
    (o) => o.id === id && o.serverId === hub.server && !o.archived && o.members[hub.user],
  );
  return organization ?? denied(404, 'Organization not found');
}
function canManage(o: Organization) {
  return o.members[hub.user] === 'Owner' || o.members[hub.user] === 'Admin';
}
function organizationView(o: Organization) {
  return {
    id: o.id,
    serverId: o.serverId,
    name: o.name,
    role: o.members[hub.user],
    canManage: canManage(o),
  };
}
function effectiveProjects(o: Organization, agent: Agent) {
  const scope = agent.organizationScope.projects;
  return o.links.filter((id) => canAccess(id) && (scope === 'all-linked' || scope.includes(id)));
}
function projectName(id: string) {
  return hub.projects[hub.server].find((p) => p.id === id)!.name;
}
function agentView(o: Organization, agent: Agent) {
  return { ...agent, effectiveProjectIds: effectiveProjects(o, agent) };
}

/** Enough of the Hub's organization API for the panel, with its access rules. */
const request = vi.hoisted(() =>
  vi.fn(async (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : {};
    hub.requests.push(`${hub.server} ${hub.user} ${method} ${path}`);
    const [pathname] = path.split('?');
    const parts = pathname.split('/').slice(1).map(decodeURIComponent);
    if (pathname === '/chat/members')
      return {
        members: Object.entries(hub.users).map(([userId, username]) => ({ userId, username })),
      };
    if (pathname === '/organizations/project-choices')
      return {
        projects: hub.projects[hub.server]
          .filter((p) => canAccess(p.id))
          .map(({ id, name }) => ({ id, name })),
      };
    if (pathname === '/organizations') {
      if (method === 'POST') {
        const id = `${hub.server}-org-${hub.organizations.length + 1}`;
        const organization: Organization = {
          id,
          serverId: hub.server,
          name: body.name.trim(),
          archived: false,
          members: { [hub.user]: 'Owner' },
          links: [],
          // Exactly one Assistant, seeded once at creation.
          agents: [
            {
              id: `${id}-assistant`,
              name: 'Organization Assistant',
              engine: 'claude-code',
              isAssistant: true,
              computerToolEnabled: true,
              organizationScope: {
                enabled: true,
                archivedAt: null,
                projects: 'all-linked',
                tools: [...ALL_TOOLS],
              },
            },
          ],
        };
        hub.organizations.push(organization);
        return { organization: organizationView(organization) };
      }
      return {
        organizations: hub.organizations
          .filter((o) => o.serverId === hub.server && !o.archived && o.members[hub.user])
          .map(organizationView),
      };
    }
    const organization = visibleOrganization(parts[1]);
    const resource = parts[2];
    const manage = () => canManage(organization) || denied(403, 'Administrator required');
    if (!resource) {
      if (method === 'PATCH') manage() && (organization.name = body.name);
      if (method === 'DELETE') manage() && (organization.archived = true);
      return { organization: organizationView(organization) };
    }
    if (resource === 'members') {
      if (parts[3] && method === 'PUT') manage() && (organization.members[parts[3]] = body.role);
      if (parts[3] && method === 'DELETE') manage() && delete organization.members[parts[3]];
      return {
        members: Object.entries(organization.members).map(([userId, role]) => ({
          userId,
          username: hub.users[userId],
          role,
        })),
      };
    }
    if (resource === 'projects') {
      if (parts[3]) {
        manage();
        if (!canAccess(parts[3])) denied(404, 'Project not found');
        if (method === 'PUT' && !organization.links.includes(parts[3]))
          organization.links.push(parts[3]);
        if (method === 'DELETE')
          organization.links = organization.links.filter((id) => id !== parts[3]);
      }
      return {
        projects: organization.links.filter(canAccess).map((id) => ({ id, name: projectName(id) })),
      };
    }
    if (resource === 'agent-templates')
      return {
        templates: [
          {
            id: 'finance',
            version: 1,
            label: 'Finance',
            name: 'Finance',
            description: 'Budgets, costs and financial follow-up.',
            instructions: 'You help the current user reason about budgets.',
          },
        ],
      };
    if (resource === 'agents') {
      const agent = parts[3] && organization.agents.find((a) => a.id === parts[3]);
      if (parts[3] && !agent) denied(404, 'Agent not found');
      if (agent && parts[4] === 'sessions') {
        if (!agent.organizationScope.enabled || agent.organizationScope.archivedAt)
          denied(409, 'Agent unavailable');
        const chat = {
          id: `chat-${hub.chats.length + 1}`,
          organizationId: organization.id,
          agentId: agent.id,
          owner: hub.user,
        };
        hub.chats.push(chat);
        return {
          session: { id: chat.id, name: agent.name, agent_id: agent.id },
          agent: agentView(organization, agent),
        };
      }
      if (agent && method === 'PATCH') {
        manage();
        const { archived, projects, tools, ...rest } = body;
        Object.assign(agent, rest);
        if (projects !== undefined) agent.organizationScope.projects = projects;
        if (tools !== undefined) agent.organizationScope.tools = tools;
        if (archived !== undefined)
          agent.organizationScope.archivedAt = archived ? '2026-10-19T00:00:00Z' : null;
        return { agent: agentView(organization, agent) };
      }
      if (method === 'POST') {
        manage();
        const created: Agent = {
          id: `${organization.id}-agent-${organization.agents.length + 1}`,
          name: body.name || (body.templateId === 'finance' ? 'Finance' : 'Agent'),
          engine: 'claude-code',
          model: body.model,
          systemPrompt: body.systemPrompt,
          computerToolEnabled: Boolean(body.computerToolEnabled),
          ...(body.templateId ? { organizationTemplate: { id: body.templateId, version: 1 } } : {}),
          organizationScope: {
            enabled: body.enabled ?? true,
            archivedAt: null,
            projects: body.projects ?? 'all-linked',
            tools: body.tools ?? ['projects:read'],
          },
        };
        organization.agents.push(created);
        return { agent: agentView(organization, created) };
      }
      return { agents: organization.agents.map((a) => agentView(organization, a)) };
    }
    if (resource === 'sessions' && !parts[3])
      return {
        sessions: hub.chats
          .filter((c) => c.organizationId === organization.id && c.owner === hub.user)
          .map((c) => {
            const agent = organization.agents.find((a) => a.id === c.agentId)!;
            return {
              id: c.id,
              name: agent.name,
              agentId: agent.id,
              agentName: agent.name,
              agentAvailable: !agent.organizationScope.archivedAt,
              createdAt: '2026-10-19T00:00:00Z',
              updatedAt: '2026-10-19T00:00:00Z',
            };
          }),
      };
    if (resource === 'sessions' && parts[4] === 'dispatches') {
      const chat = hub.chats.find(
        (c) => c.id === parts[3] && c.owner === hub.user && c.organizationId === organization.id,
      );
      if (!chat) denied(404, 'Organization chat not found');
      const source = organization.agents.find((a) => a.id === chat!.agentId)!;
      if (
        !source.organizationScope.tools.includes('dispatch') ||
        !effectiveProjects(organization, source).includes(body.projectId)
      )
        denied(404, 'Project not found');
      const existing = hub.dispatches.find((d) => d.idempotencyKey === body.idempotencyKey);
      if (existing) return existing;
      const dispatch = {
        requestId: `request-${hub.dispatches.length + 1}`,
        status: 'accepted',
        code: null,
        message: null,
        serverId: hub.server,
        organizationId: organization.id,
        organizationAgentId: source.id,
        initiatingSessionId: chat!.id,
        actingUserId: hub.user,
        idempotencyKey: body.idempotencyKey,
        projectId: body.projectId,
        agentId: body.agentId,
        name: body.prompt,
        sessionId: `target-${hub.dispatches.length + 1}`,
        ref: null,
        sessionState: 'waiting_for_user_input',
        createdAt: '2026-10-19T00:00:00Z',
        updatedAt: '2026-10-19T00:00:00Z',
        acceptedAt: '2026-10-19T00:00:00Z',
      };
      hub.dispatches.push(dispatch);
      return dispatch;
    }
    if (resource === 'dispatches')
      return {
        dispatches: hub.dispatches.filter(
          (d) =>
            d.organizationId === organization.id &&
            d.actingUserId === hub.user &&
            canAccess(d.projectId),
        ),
        nextOffset: null,
      };
    if (resource === 'context')
      return {
        serverId: hub.server,
        organizationId: organization.id,
        retrievedAt: '2026-10-19T00:00:00Z',
        offset: 0,
        nextOffset: null,
        projects: organization.links.filter(canAccess).map((id) => {
          const project = hub.projects[hub.server].find((p) => p.id === id)!;
          return {
            id,
            name: project.name,
            source: {
              serverId: hub.server,
              organizationId: organization.id,
              projectId: id,
              projectName: project.name,
              record: `project:${id}`,
            },
            timestamp: '2026-10-19T00:00:00Z',
            agents: project.agents.map((a) => ({ ...a, role: null })),
            agentCount: project.agents.length,
            agentsTruncated: false,
            board: { columns: [], openCards: 0, totalCards: 0, epics: 0, phases: 0 },
            wiki: { pages: 0, updatedAt: null },
            sessions: { own: 0, updatedAt: null },
          };
        }),
      };
    throw new Error(`Unexpected ${method} ${path}`);
  }),
);

vi.mock('../utils/api', async () => {
  const { createOrganizationApi } = await import('@shared/utils/organizations');
  const { createOrganizationAgentApi } = await import('@shared/utils/organization-agents');
  const { createOrganizationPortfolioApi } = await import('@shared/utils/organization-portfolio');
  return {
    api: {
      organizations: createOrganizationApi(request),
      organizationAgents: createOrganizationAgentApi(request),
      organizationPortfolio: createOrganizationPortfolioApi(request),
      getModelConfig: async () => ({
        engineValidModels: { 'claude-code': ['claude-sonnet'] },
        engineDefaultModels: { 'claude-code': 'claude-sonnet' },
      }),
    },
  };
});
// The selected Server and signed-in user scope every organization read.
vi.mock('../utils/orgs', () => ({ getActiveOrg: () => ({ id: hub.server }) }));
vi.mock('../utils/auth', () => ({ getAuthRecord: () => ({ user: { id: hub.user } }) }));
vi.mock('../utils/config', () => ({ getApiBaseUrl: () => `https://${hub.server}.example.test` }));

function host(tag: string) {
  return ({ children, onPress, disabled, accessibilityLabel, accessibilityRole }: any) =>
    React.createElement(
      tag,
      { onClick: onPress, disabled, 'aria-label': accessibilityLabel, role: accessibilityRole },
      children,
    );
}
vi.mock('react-native', () => ({
  View: host('div'),
  Text: host('span'),
  TouchableOpacity: host('button'),
  TextInput: ({ accessibilityLabel, value, onChangeText }: any) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      readOnly
    />
  ),
  Switch: ({ accessibilityLabel, value, onValueChange, disabled }: any) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      onChange={() => onValueChange(!value)}
      disabled={disabled}
    />
  ),
  StyleSheet: { create: (styles: any) => styles },
}));
vi.mock('./HubChatRefs', () => ({ HubChatPlainTextWithRefs: () => null }));
vi.mock('../context/AppContext', () => ({ useApp: () => ({ lastOrganizationEvent: 0 }) }));

import Panel from './OrganizationsPanel';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpenChat = vi.fn();

async function flush() {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => undefined);
  }
}
/** Mount fresh, as after an app launch, Server switch or Hub restart. */
async function mount() {
  flushSync(() => root?.unmount());
  root = createRoot(container);
  flushSync(() => root.render(<Panel onOpenChat={onOpenChat} />));
  await flush();
}
function buttons(label: string) {
  return [...container.querySelectorAll('button')].filter(
    (b) => b.getAttribute('aria-label') === label,
  );
}
async function press(label: string, index = 0) {
  const button = buttons(label)[index];
  expect(button, label).toBeTruthy();
  expect(button.disabled, `${label} disabled`).toBe(false);
  button.click();
  await flush();
}
async function type(label: string, value: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  expect(input, label).toBeTruthy();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
async function toggle(label: string, index = 0) {
  const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(
    (input) => input.getAttribute('aria-label') === label,
  );
  expect(inputs[index], label).toBeTruthy();
  inputs[index].click();
  await flush();
}
const text = () => container.textContent ?? '';
function organization(name: string) {
  return hub.organizations.find((o) => o.name === name && o.serverId === hub.server)!;
}

beforeEach(() => {
  hub.server = 'server-a';
  hub.user = 'owner';
  hub.projects = {
    'server-a': [
      {
        id: 'storefront',
        name: 'Shared Storefront',
        agents: [{ id: 'storefront-dev', name: 'Storefront Dev' }],
      },
      {
        id: 'ledger',
        name: 'Restricted Ledger',
        agents: [{ id: 'ledger-dev', name: 'Ledger Dev' }],
        only: ['owner'],
      },
      { id: 'tools', name: 'Independent Tools', agents: [{ id: 'tools-dev', name: 'Tools Dev' }] },
    ],
    'server-b': [
      { id: 'storefront', name: 'Server B Storefront', agents: [{ id: 'b-dev', name: 'B Dev' }] },
    ],
  };
  hub.organizations = [];
  hub.chats = [];
  hub.dispatches = [];
  hub.requests = [];
  onOpenChat.mockClear();
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('mobile organization acceptance flow', () => {
  it('runs from Server selection to archive and remount without leaking data', async () => {
    // Server A is selected; nothing exists until the user creates it.
    await mount();
    expect(text()).toContain('No organizations yet');

    for (const [name, projects] of [
      ['Northwind', ['Shared Storefront', 'Restricted Ledger']],
      ['Contoso', ['Shared Storefront']],
    ] as const) {
      await type('New organization name', name);
      await press('Create organization');
      await press(name);
      for (const project of projects) await toggle(project);
      await press('Save project links');
    }
    expect(organization('Northwind').links).toEqual(['storefront', 'ledger']);
    expect(organization('Contoso').links).toEqual(['storefront']);
    // Independent Tools is never linked, and linking is the only project change.
    expect(hub.organizations.every((o) => !o.links.includes('tools'))).toBe(true);
    expect(hub.requests.some((r) => r.includes('/projects/tools'))).toBe(false);

    // One Assistant with Computer on; rename it in place.
    await press('Northwind');
    expect(buttons('Chat with Organization Assistant')).toHaveLength(1);
    expect(text()).toContain('Computer on by default');
    await press('Edit Organization Assistant');
    await type('Agent name', 'Chief of Staff');
    await press('Save agent');
    expect(organization('Northwind').agents.map((a) => [a.id, a.name])).toEqual([
      [`${organization('Northwind').id}-assistant`, 'Chief of Staff'],
    ]);

    // A custom agent from scratch, limited to the storefront, with dispatch.
    await press('Add agent');
    await press('Start from scratch');
    await type('Agent name', 'Release Tracker');
    await toggle('Dispatch project agents');
    await toggle('All linked projects');
    await toggle('Shared Storefront', 1);
    await press('Create agent');
    const tracker = organization('Northwind').agents.find((a) => a.name === 'Release Tracker')!;
    expect(tracker).toMatchObject({
      computerToolEnabled: false,
      organizationScope: { projects: ['storefront'] },
    });
    expect(tracker.organizationScope.tools.sort()).toEqual(['dispatch', 'projects:read']);

    // An optional template fills in a name and instructions only.
    await press('Add agent');
    await press('Use Finance template');
    expect(
      (container.querySelector('input[aria-label="Agent name"]') as HTMLInputElement).value,
    ).toBe('Finance');
    await press('Create agent');
    const finance = organization('Northwind').agents.find((a) => a.name === 'Finance')!;
    expect(finance).toMatchObject({
      organizationTemplate: { id: 'finance', version: 1 },
      computerToolEnabled: false,
      organizationScope: { tools: ['projects:read'] },
    });
    expect(text()).toContain('from Finance template');
    await mount();
    await press('Northwind');

    // Portfolio and dispatch: the scoped agent offers only its subset.
    expect(text()).toContain('Restricted Ledger');
    await press('From Release Tracker');
    expect(buttons('Project Shared Storefront')).toHaveLength(1);
    expect(buttons('Project Restricted Ledger')).toHaveLength(0);
    await press('From Chief of Staff');
    expect(buttons('Project Restricted Ledger')).toHaveLength(1);
    await press('Project Shared Storefront');
    await press('Agent Storefront Dev');
    await type('Task for the project agent', 'Summarize open storefront cards');
    await press('Dispatch');
    expect(hub.dispatches).toHaveLength(1);
    expect(hub.dispatches[0]).toMatchObject({
      projectId: 'storefront',
      agentId: 'storefront-dev',
      actingUserId: 'owner',
      organizationAgentId: `${organization('Northwind').id}-assistant`,
    });
    await press('Refresh portfolio');
    const card = container.querySelector('[aria-label="Dispatch Summarize open storefront cards"]');
    expect(card?.textContent).toContain('Completed');

    // The dispatch's organization chat opens with its organization named.
    await press('Open organization chat');
    expect(onOpenChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationId: organization('Northwind').id,
        organizationName: 'Northwind',
        sessionId: hub.dispatches[0].initiatingSessionId,
      }),
    );
    await press('Chat with Chief of Staff');
    expect(onOpenChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        organizationName: 'Northwind',
        agent: expect.objectContaining({ name: 'Chief of Staff', computerToolEnabled: true }),
      }),
    );

    // Selecting another Server shows only that Server's organizations.
    hub.server = 'server-b';
    await mount();
    expect(text()).toContain('No organizations yet');
    expect(text()).not.toContain('Northwind');
    hub.server = 'server-a';
    await mount();
    expect(buttons('Northwind')).toHaveLength(1);

    // A Member without ledger access: read only, storefront only, no other organization.
    organization('Northwind').members.member = 'Member';
    hub.user = 'member';
    await mount();
    expect(buttons('Contoso')).toHaveLength(0);
    await press('Northwind');
    expect(text()).toContain('Read only.');
    expect(text()).toContain('Shared Storefront');
    expect(text()).not.toContain('Restricted Ledger');
    expect(text()).not.toContain('Summarize open storefront cards');
    expect(buttons('Add agent')).toHaveLength(0);
    expect(buttons('Edit Chief of Staff')).toHaveLength(0);
    await press('From Chief of Staff');
    expect(buttons('Project Restricted Ledger')).toHaveLength(0);

    // Unlink from Northwind only.
    hub.user = 'owner';
    await mount();
    await press('Northwind');
    await toggle('Shared Storefront');
    await press('Save project links');
    expect(organization('Northwind').links).toEqual(['ledger']);
    expect(organization('Contoso').links).toEqual(['storefront']);

    // Archive the custom agent and the Contoso Assistant, then remount.
    await press('Edit Release Tracker');
    await press('Archive agent');
    await press('Confirm archive of Release Tracker');
    expect(buttons('Restore Release Tracker')).toHaveLength(1);
    await press('Contoso');
    await press('Edit Organization Assistant');
    await press('Archive agent');
    await press('Confirm archive of Organization Assistant');
    expect(text()).toContain('No active agents.');
    await mount();
    await press('Contoso');
    expect(text()).toContain('No active agents.');
    expect(buttons('Add agent')).toHaveLength(1);
    expect(organization('Contoso').agents).toHaveLength(1);
    await press('Northwind');
    expect(buttons('Restore Release Tracker')).toHaveLength(1);
    expect(buttons('Chat with Release Tracker')).toHaveLength(0);

    // Archive Contoso: Northwind and every project remain.
    await press('Contoso');
    await press('Archive organization');
    await press('Confirm archive');
    expect(buttons('Contoso')).toHaveLength(0);
    expect(buttons('Northwind')).toHaveLength(1);
    expect(hub.projects['server-a'].map((p) => p.id)).toEqual(['storefront', 'ledger', 'tools']);

    // Every read was scoped to the selected Server and signed-in user.
    expect(
      hub.requests.filter((r) => r.startsWith('server-b') && !r.includes('GET /organizations')),
    ).toEqual([]);
  });
});
