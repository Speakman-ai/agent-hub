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
        computerToolEnabled: body.computerToolEnabled ?? false,
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

import Panel from './OrganizationAgentsPanel';

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
const linked = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpenChat = vi.fn();
async function flush() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => undefined);
  }
}
const scope = () => fake.scope;
async function render(canManage = true, organizationId = 'org') {
  flushSync(() =>
    root.render(
      <Panel
        key={organizationId}
        organization={{
          id: organizationId,
          name: 'Org',
          serverId: 'server-a',
          role: null,
          canManage,
        }}
        linkedProjects={linked}
        scope={scope}
        onOpenChat={onOpenChat}
      />,
    ),
  );
  await flush();
}
const buttons = () => [...container.querySelectorAll('button')];
const button = (label: string) => buttons().find((b) => b.textContent === label);
async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeTruthy();
  target!.click();
  await flush();
}
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(element);
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
const field = (label: string) =>
  [...container.querySelectorAll('label')]
    .find((l) => l.firstChild?.textContent === label)!
    .querySelector('input, textarea, select') as HTMLInputElement;
async function toggle(label: string) {
  const input = [...container.querySelectorAll<HTMLInputElement>('input')].find(
    (i) => i.closest('label')?.textContent === label,
  );
  expect(input, label).toBeTruthy();
  input!.click();
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

describe('organization agent management (web/Electron)', () => {
  it('shows the initial Assistant with an Add agent action and renames it', async () => {
    await render();
    expect(button('Chat with Organization Assistant')).toBeTruthy();
    expect(button('Add agent')).toBeTruthy();
    await click('Edit Organization Assistant');
    setValue(field('Agent name'), 'Chief of Staff');
    setValue(field('Instructions'), 'Keep us on track.');
    await flush();
    await click('Save agent');
    expect(fake.patches).toEqual([
      {
        agentId: '__organization_x__assistant',
        body: { name: 'Chief of Staff', systemPrompt: 'Keep us on track.' },
      },
    ]);
    expect(button('Chat with Chief of Staff')).toBeTruthy();
  });

  it('creates a Marketing agent from scratch with a selected project scope', async () => {
    await render();
    await click('Add agent');
    await click('Start from scratch');
    setValue(field('Agent name'), 'Marketing');
    await flush();
    await toggle('Selected projects');
    await toggle('Beta');
    await toggle('Web search');
    await click('Create agent');
    expect(fake.creates).toEqual([
      {
        name: 'Marketing',
        systemPrompt: '',
        model: 'model-a',
        tools: ['projects:read', 'web'],
        projects: ['beta'],
        enabled: true,
      },
    ]);
    expect(button('Chat with Marketing')).toBeTruthy();
  });

  it('creates from the Finance template and edits it without touching the template or others', async () => {
    await render();
    await click('Add agent');
    expect(container.textContent).toContain('Track budgets.');
    await click('Use Finance template');
    expect(field('Agent name').value).toBe('Finance');
    await click('Create agent');
    expect(fake.creates[0]).toMatchObject({
      templateId: 'finance',
      name: 'Finance',
      systemPrompt: 'Track budgets.',
      tools: ['projects:read'],
      projects: 'all-linked',
    });
    await click('Edit Finance');
    setValue(field('Instructions'), 'Track Q3 budgets only.');
    await flush();
    await click('Save agent');
    expect(fake.templates[0].instructions).toBe('Track budgets.');
    expect(fake.agents[0]).toMatchObject({
      name: 'Organization Assistant',
      systemPrompt: 'Assist.',
    });
    expect(fake.patches).toEqual([
      { agentId: fake.agents[1].id, body: { systemPrompt: 'Track Q3 budgets only.' } },
    ]);
    expect(container.textContent).toContain('from Finance template');
  });

  it('hides management controls from organization Members', async () => {
    await render(false);
    expect(button('Chat with Organization Assistant')).toBeTruthy();
    expect(button('Add agent')).toBeUndefined();
    expect(button('Edit Organization Assistant')).toBeUndefined();
  });

  it('archives the Assistant into a zero-agent state, keeps history and never recreates it', async () => {
    await render();
    await click('Chat with Organization Assistant');
    expect(onOpenChat).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org', sessionId: 's1' }),
    );
    await click('Edit Organization Assistant');
    await click('Archive agent');
    await click('Confirm archive of Organization Assistant');
    expect(container.textContent).toContain('No active agents');
    expect(button('Add agent')).toBeTruthy();
    expect(fake.creates).toEqual([]);
    expect(button('Restore Organization Assistant')).toBeTruthy();
    expect(container.textContent).toContain('(history only)');
    await click('Open Organization Assistant');
    expect(onOpenChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 's1', agentId: '__organization_x__assistant' }),
    );
  });

  it('only offers linked projects the caller can access in the scope picker', async () => {
    await render();
    await click('Add agent');
    await click('Start from scratch');
    await toggle('Selected projects');
    const labels = [...container.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toContain('Alpha');
    expect(labels).toContain('Beta');
    expect(labels.join()).not.toContain('Secret');
  });

  it('never shows a roster fetched before a Server switch', async () => {
    let release!: () => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ agents: [{ ...assistant(), name: 'Stale Assistant' }] });
        }),
    );
    await render();
    fake.scope = 'server-b';
    fake.agents = [];
    await render();
    release();
    await flush();
    expect(container.textContent).not.toContain('Stale Assistant');
  });

  it('does not open a chat whose request finished after switching organizations', async () => {
    await render();
    let finish!: () => void;
    request.mockImplementationOnce(
      (path: string) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              session: { id: 'late', agent_id: path.split('/')[4], name: 'Late' },
              agent: assistant(),
            });
        }),
    );
    button('Chat with Organization Assistant')!.click();
    await render(true, 'other-org');
    finish();
    await flush();
    expect(onOpenChat).not.toHaveBeenCalled();
  });

  describe('Computer preference', () => {
    const computerAssistant = () => ({
      ...assistant(),
      computerToolEnabled: true,
      organizationScope: { ...assistant().organizationScope, tools: ['computer', 'projects:read'] },
    });
    const computerLabel = (id: string) =>
      container.querySelector(`[data-testid="organization-agent-computer-${id}"]`)?.textContent;

    it('shows the Assistant Computer on by default and lets an admin turn the default off', async () => {
      fake.agents = [computerAssistant()];
      await render();
      expect(computerLabel('__organization_x__assistant')).toBe('Computer on by default');
      await click('Edit Organization Assistant');
      const box = [...container.querySelectorAll<HTMLInputElement>('input')].find(
        (i) => i.closest('label')?.textContent === 'Computer on by default in new chats',
      )!;
      expect(box.checked).toBe(true);
      await toggle('Computer on by default in new chats');
      await click('Save agent');
      expect(fake.patches).toEqual([
        { agentId: '__organization_x__assistant', body: { computerToolEnabled: false } },
      ]);
      expect(computerLabel('__organization_x__assistant')).toBe('Computer off by default');
    });

    it('creates custom agents with Computer off unless it is explicitly enabled', async () => {
      await render();
      await click('Add agent');
      await click('Start from scratch');
      setValue(field('Agent name'), 'Ops');
      await flush();
      await toggle('Computer');
      // The tool alone grants access; the default stays off.
      await click('Create agent');
      expect(fake.creates[0]).not.toHaveProperty('computerToolEnabled');
      expect(computerLabel(fake.agents[1].id)).toBe('Computer off by default');

      await click('Add agent');
      await click('Start from scratch');
      setValue(field('Agent name'), 'Research');
      await flush();
      await toggle('Computer');
      await toggle('Computer on by default in new chats');
      await click('Create agent');
      expect(fake.creates[1]).toMatchObject({
        name: 'Research',
        tools: ['computer', 'projects:read'],
        computerToolEnabled: true,
      });
      expect(computerLabel(fake.agents[2].id)).toBe('Computer on by default');
    });

    it('never enables Computer from a template', async () => {
      await render();
      await click('Add agent');
      await click('Use Finance template');
      expect(container.textContent).not.toContain('Computer on by default in new chats');
      await click('Create agent');
      expect(fake.creates[0]).not.toHaveProperty('computerToolEnabled');
      expect(fake.creates[0].tools).not.toContain('computer');
    });

    it('passes the organization name with an opened chat so its Computer names the owner', async () => {
      fake.agents = [computerAssistant()];
      await render();
      await click('Chat with Organization Assistant');
      expect(onOpenChat).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org', organizationName: 'Org' }),
      );
    });

    it('archives a Computer-enabled agent out of the roster', async () => {
      fake.agents = [computerAssistant()];
      await render();
      await click('Edit Organization Assistant');
      await click('Archive agent');
      await click('Confirm archive of Organization Assistant');
      expect(computerLabel('__organization_x__assistant')).toBeUndefined();
      expect(button('Chat with Organization Assistant')).toBeUndefined();
    });
  });
});
