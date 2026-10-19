import { describe, expect, it, vi } from 'vitest';
import {
  createBodyFromDraft,
  createOrganizationAgentApi,
  draftFromAgent,
  newAgentDraft,
  OrganizationAgentsController,
  patchFromDraft,
  organizationAgentComputerLabel,
  rosterAgents,
  type OrganizationAgent,
} from './organization-agents';

const template = {
  id: 'finance',
  version: 1,
  label: 'Finance',
  name: 'Finance',
  description: 'Budgets',
  instructions: 'Track budgets.',
};
const agent = (id: string, patch: Partial<OrganizationAgent> = {}): OrganizationAgent => ({
  id,
  name: id,
  engine: 'claude-code',
  model: 'm1',
  systemPrompt: '',
  organizationScope: { enabled: true, archivedAt: null, projects: 'all-linked', tools: [] },
  ...patch,
});

describe('organization agent drafts', () => {
  it('copies only the name and instructions from a template', () => {
    const draft = newAgentDraft(template, 'm1');
    expect(draft).toMatchObject({
      templateId: 'finance',
      name: 'Finance',
      systemPrompt: 'Track budgets.',
      tools: ['projects:read'],
      allLinked: true,
    });
    draft.name = 'Money';
    expect(template.name).toBe('Finance');
  });

  it('patches only fields the user changed', () => {
    const existing = agent('a', {
      computerToolEnabled: true,
      organizationScope: {
        enabled: true,
        archivedAt: null,
        projects: ['p1'],
        tools: ['computer', 'projects:read'],
      },
    });
    const draft = draftFromAgent(existing);
    expect(patchFromDraft(existing, draft)).toEqual({});
    draft.name = 'Renamed';
    draft.tools = ['projects:read'];
    expect(patchFromDraft(existing, draft)).toEqual({
      name: 'Renamed',
      tools: ['projects:read'],
      computerToolEnabled: false,
    });
  });

  it('keeps Computer off on create unless explicitly enabled with the computer tool', () => {
    const draft = newAgentDraft(template, 'm1');
    expect(draft.computerByDefault).toBe(false);
    expect(createBodyFromDraft(draft)).not.toHaveProperty('computerToolEnabled');
    draft.computerByDefault = true;
    // The preference alone does nothing without the tool.
    expect(createBodyFromDraft(draft)).not.toHaveProperty('computerToolEnabled');
    draft.tools = ['computer', 'projects:read'];
    expect(createBodyFromDraft(draft)).toMatchObject({
      computerToolEnabled: true,
      tools: ['computer', 'projects:read'],
    });
  });

  it('round-trips the Computer default and patches it on its own', () => {
    const assistant = agent('assistant', {
      isAssistant: true,
      computerToolEnabled: true,
      organizationScope: {
        enabled: true,
        archivedAt: null,
        projects: 'all-linked',
        tools: ['computer'],
      },
    });
    const draft = draftFromAgent(assistant);
    expect(draft.computerByDefault).toBe(true);
    draft.computerByDefault = false;
    expect(patchFromDraft(assistant, draft)).toEqual({ computerToolEnabled: false });

    const custom = agent('custom', {
      organizationScope: { enabled: true, archivedAt: null, projects: [], tools: ['computer'] },
    });
    const enable = draftFromAgent(custom);
    expect(enable.computerByDefault).toBe(false);
    enable.computerByDefault = true;
    expect(patchFromDraft(custom, enable)).toEqual({ computerToolEnabled: true });
  });

  it('labels each agent Computer preference for the roster', () => {
    expect(organizationAgentComputerLabel(agent('none'))).toBe('No Computer');
    const scope = { enabled: true, archivedAt: null, projects: [], tools: ['computer'] };
    expect(organizationAgentComputerLabel(agent('off', { organizationScope: scope }))).toBe(
      'Computer off by default',
    );
    expect(
      organizationAgentComputerLabel(
        agent('on', { organizationScope: scope, computerToolEnabled: true }),
      ),
    ).toBe('Computer on by default');
  });

  it('keeps the Assistant first and drops archived agents from the roster', () => {
    const list = rosterAgents([
      agent('custom'),
      agent('gone', {
        organizationScope: { enabled: true, archivedAt: 'now', projects: [], tools: [] },
      }),
      agent('assistant', { isAssistant: true }),
    ]);
    expect(list.map((a) => a.id)).toEqual(['assistant', 'custom']);
  });
});

describe('OrganizationAgentsController', () => {
  function setup() {
    let scope = 'server-a';
    const pending: Array<() => void> = [];
    let hold = false;
    const request = vi.fn(async (path: string): Promise<any> => {
      if (hold) await new Promise<void>((resolve) => pending.push(resolve));
      if (path.endsWith('/agent-templates')) return { templates: [template] };
      if (path.endsWith('/sessions')) return { sessions: [] };
      return { agents: [agent(`${scope}-assistant`, { isAssistant: true })] };
    });
    const api = createOrganizationAgentApi(request);
    const controller = new OrganizationAgentsController(api, () => scope, 'org');
    return {
      controller,
      request,
      setScope: (next: string) => (scope = next),
      holdRequests: () => (hold = true),
      release: () => pending.splice(0).forEach((resolve) => resolve()),
    };
  }

  it('loads the roster, templates and chats for one organization', async () => {
    const { controller, request } = setup();
    await controller.load();
    expect(controller.snapshot().agents.map((a) => a.id)).toEqual(['server-a-assistant']);
    expect(controller.snapshot().templates).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('/organizations/org/sessions');
  });

  it('drops a roster that arrives after the Server changed', async () => {
    const { controller, setScope, holdRequests, release } = setup();
    holdRequests();
    const loading = controller.load();
    setScope('server-b');
    release();
    await loading;
    expect(controller.snapshot().agents).toEqual([]);
    expect(controller.state.ready).toBe(false);
  });

  it('does not hand back a chat started before a Server switch', async () => {
    const { controller, setScope, request } = setup();
    request.mockImplementationOnce(async () => {
      setScope('server-b');
      return { session: { id: 's1' }, agent: agent('a') };
    });
    expect(await controller.startChat('a')).toBeNull();
  });

  it('drops a chat started before the user switched organizations', async () => {
    const { controller, request } = setup();
    let resolve!: (value: any) => void;
    request.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const pending = controller.startChat('a');
    // The panel for organization A unmounts when B is selected.
    controller.cancel();
    resolve({ session: { id: 's1' }, agent: agent('a') });
    expect(await pending).toBeNull();
  });

  it('keeps a chat started while the roster reloads', async () => {
    const { controller, request } = setup();
    let resolve!: (value: any) => void;
    request.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const pending = controller.startChat('a');
    await controller.load();
    resolve({ session: { id: 's1' }, agent: agent('a') });
    expect(await pending).toMatchObject({ session: { id: 's1' } });
  });

  it('adds a started chat to the owned history', async () => {
    const { controller, request } = setup();
    await controller.load();
    request.mockImplementationOnce(async () => ({
      session: { id: 's9', name: 'Plan' },
      agent: agent('a', { name: 'Marketing' }),
    }));
    await controller.startChat('a');
    expect(controller.snapshot().chats).toEqual([
      expect.objectContaining({ id: 's9', name: 'Plan', agentId: 'a', agentName: 'Marketing' }),
    ]);
  });

  it('finishes a save even when a refresh reloads the roster meanwhile', async () => {
    const { controller, request } = setup();
    await controller.load();
    let resolve!: (value: any) => void;
    request.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const saving = controller.update(agent('a'), { name: 'B' });
    void controller.load();
    resolve({ agent: agent('a', { name: 'B' }) });
    expect(await saving).toBe('a');
  });

  it('drops a save that finishes after the view left the organization', async () => {
    const { controller, request } = setup();
    await controller.load();
    let resolve!: (value: any) => void;
    request.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const saving = controller.update(agent('a'), { name: 'B' });
    controller.cancel();
    resolve({ agent: agent('a', { name: 'B' }) });
    expect(await saving).toBeNull();
  });
});
