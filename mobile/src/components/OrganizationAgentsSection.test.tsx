// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const templates = [
    {
      id: 'finance',
      version: 1,
      label: 'Finance',
      name: 'Finance',
      description: 'Budgets and costs.',
      instructions: 'Track budgets.',
    },
    {
      id: 'marketing',
      version: 1,
      label: 'Marketing',
      name: 'Marketing',
      description: 'Positioning.',
      instructions: 'Plan launches.',
    },
  ];
  return {
    scope: 'server-a',
    templates,
    agents: [] as any[],
    chats: [] as any[],
    creates: [] as any[],
    patches: [] as any[],
    next: 1,
  };
});
const request = vi.hoisted(() =>
  vi.fn(async (path: string, options: any = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    const [, , , resource, agentId, sub] = path.split('/');
    if (resource === 'agent-templates') return { templates: fake.templates };
    if (resource === 'sessions')
      return {
        sessions: fake.chats.map((chat) => {
          const scope = fake.agents.find((a) => a.id === chat.agentId)?.organizationScope;
          return { ...chat, agentAvailable: Boolean(scope?.enabled && !scope.archivedAt) };
        }),
      };
    if (resource === 'agents' && sub === 'sessions') {
      const agent = fake.agents.find((a) => a.id === agentId);
      const session = { id: `s${fake.next++}`, agent_id: agentId, name: agent.name };
      fake.chats.unshift({
        id: session.id,
        name: session.name,
        agentId,
        agentName: agent.name,
        agentAvailable: true,
        createdAt: 'now',
        updatedAt: 'now',
      });
      return { session, agent };
    }
    if (resource === 'agents' && agentId && options.method === 'PATCH') {
      fake.patches.push({ agentId, body });
      const agent = fake.agents.find((a) => a.id === agentId);
      const { archived, enabled, tools, projects, ...rest } = body;
      Object.assign(agent, rest);
      if (archived !== undefined) agent.organizationScope.archivedAt = archived ? 'now' : null;
      if (enabled !== undefined) agent.organizationScope.enabled = enabled;
      if (tools) agent.organizationScope.tools = tools;
      if (projects) agent.organizationScope.projects = projects;
      return { agent };
    }
    if (resource === 'agents' && options.method === 'POST') {
      fake.creates.push(body);
      const template = fake.templates.find((t) => t.id === body.templateId);
      const agent = {
        id: `__organization_x__agent_${fake.next++}`,
        name: body.name,
        engine: 'claude-code',
        model: body.model,
        systemPrompt: body.systemPrompt,
        organizationScope: {
          enabled: body.enabled,
          archivedAt: null,
          projects: body.projects,
          tools: body.tools,
        },
        ...(template ? { organizationTemplate: { id: template.id, version: 1 } } : {}),
      };
      fake.agents.push(agent);
      return { agent };
    }
    if (resource === 'agents') return { agents: fake.agents.map((a) => structuredClone(a)) };
    throw new Error(`Unexpected ${path}`);
  }),
);
vi.mock('../utils/api', async () => {
  const { createOrganizationAgentApi } = await import('@shared/utils/organization-agents');
  return {
    api: {
      organizationAgents: createOrganizationAgentApi(request),
      getModelConfig: async () => ({
        engineValidModels: { 'claude-code': ['model-a', 'model-b'] },
        engineDefaultModels: { 'claude-code': 'model-a' },
      }),
    },
  };
});
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
  Switch: ({ accessibilityLabel, value, onValueChange }: any) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      onChange={() => onValueChange(!value)}
    />
  ),
  StyleSheet: { create: (styles: any) => styles },
}));

import Section from './OrganizationAgentsSection';

const assistant = () => ({
  id: '__organization_x__assistant',
  name: 'Organization Assistant',
  engine: 'claude-code',
  model: 'model-a',
  systemPrompt: 'Assist.',
  isAssistant: true,
  organizationScope: {
    enabled: true,
    archivedAt: null,
    projects: 'all-linked',
    tools: ['projects:read'],
  },
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpenChat = vi.fn();
async function flush() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => undefined);
  }
}
// Stable like the real module-level scope, so re-renders keep the same controller.
const scope = () => fake.scope;
async function render(canManage = true, refreshKey = 0) {
  flushSync(() =>
    root.render(
      <Section
        refreshKey={refreshKey}
        organization={{ id: 'org', name: 'Org', serverId: 'server-a', role: null, canManage }}
        linkedProjects={[
          { id: 'alpha', name: 'Alpha' },
          { id: 'beta', name: 'Beta' },
        ]}
        scope={scope}
        onOpenChat={onOpenChat}
      />,
    ),
  );
  await flush();
}
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label);
async function click(label: string) {
  expect(button(label), label).toBeTruthy();
  button(label)!.click();
  await flush();
}
async function type(label: string, value: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
async function toggle(label: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  expect(input, label).toBeTruthy();
  input.click();
  await flush();
}

beforeEach(() => {
  fake.scope = 'server-a';
  fake.agents = [assistant()];
  fake.chats = [];
  fake.creates = [];
  fake.patches = [];
  fake.next = 1;
  onOpenChat.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('organization agent management (mobile)', () => {
  it('renames the Assistant and creates a Marketing agent with a selected project', async () => {
    await render();
    await click('Edit Organization Assistant');
    await type('Agent name', 'Chief of Staff');
    await click('Save agent');
    expect(fake.patches).toEqual([
      { agentId: '__organization_x__assistant', body: { name: 'Chief of Staff' } },
    ]);
    await click('Add agent');
    await click('Start from scratch');
    await type('Agent name', 'Marketing');
    await toggle('All linked projects');
    await toggle('Alpha');
    await click('Create agent');
    expect(fake.creates).toEqual([
      expect.objectContaining({ name: 'Marketing', projects: ['alpha'], tools: ['projects:read'] }),
    ]);
    expect(button('Chat with Marketing')).toBeTruthy();
  });

  it('creates from the Finance template and edits only that agent', async () => {
    await render();
    await click('Add agent');
    await click('Preview Finance instructions');
    expect(container.textContent).toContain('Track budgets.');
    await click('Use Finance template');
    await click('Create agent');
    expect(fake.creates[0]).toMatchObject({ templateId: 'finance', name: 'Finance' });
    await click('Edit Finance');
    await type('Instructions', 'Quarterly budgets.');
    await click('Save agent');
    expect(fake.templates[0].instructions).toBe('Track budgets.');
    expect(fake.patches).toEqual([
      { agentId: fake.agents[1].id, body: { systemPrompt: 'Quarterly budgets.' } },
    ]);
    expect(fake.agents[0].name).toBe('Organization Assistant');
  });

  it('lets Members chat but not manage', async () => {
    await render(false);
    await click('Chat with Organization Assistant');
    expect(onOpenChat).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org', sessionId: 's1' }),
    );
    expect(button('Add agent')).toBeUndefined();
    expect(button('Edit Organization Assistant')).toBeUndefined();
  });

  it('shows the empty state after archiving the Assistant and keeps its history', async () => {
    await render();
    await click('Chat with Organization Assistant');
    await click('Edit Organization Assistant');
    await click('Archive agent');
    await click('Confirm archive of Organization Assistant');
    expect(container.textContent).toContain('No active agents');
    expect(button('Add agent')).toBeTruthy();
    expect(fake.creates).toEqual([]);
    expect(container.textContent).toContain('(history only)');
    await click('Open Organization Assistant');
    expect(onOpenChat).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's1' }));
  });

  it('lists a new chat in history right away and after returning to the screen', async () => {
    await render();
    expect(container.textContent).not.toContain('Your conversations');
    await click('Chat with Organization Assistant');
    expect(onOpenChat).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's1' }));
    // Chat opened on top of this screen; it stayed mounted and shows the conversation.
    expect(button('Open Organization Assistant')).toBeTruthy();
    // Returning to the screen reloads history from the server.
    const calls = request.mock.calls.length;
    await render(true, 1);
    expect(request.mock.calls.slice(calls).some(([path]) => path.endsWith('/sessions'))).toBe(true);
    onOpenChat.mockClear();
    await click('Open Organization Assistant');
    expect(onOpenChat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', agentId: '__organization_x__assistant' }),
    );
  });
});
