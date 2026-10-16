import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { ChatDigest } from '@shared/utils/chatDigest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  StyleSheet: { create: (styles: any) => styles },
  Switch: nativeHost('Switch'),
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
    getSkills: vi.fn(),
    hubChat: {
      digests: vi.fn(),
      createDigest: vi.fn(),
      updateDigest: vi.fn(),
      removeDigest: vi.fn(),
      runDigest: vi.fn(),
    },
  },
}));

const { default: HubChatDigestSection } = await import('./HubChatDigestSection');
const { api } = await import('../utils/api');
const hubChat = api.hubChat as any;

async function flush() {
  await TestRenderer.act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

async function press(renderer: ReactTestRenderer, testID: string) {
  const control = renderer.root.findByProps({ testID });
  await TestRenderer.act(async () => control.props.onPress());
  await flush();
}

async function type(renderer: ReactTestRenderer, testID: string, text: string) {
  const control = renderer.root.findByProps({ testID });
  await TestRenderer.act(async () => control.props.onChangeText(text));
}

function count(renderer: ReactTestRenderer, testID: string): number {
  return renderer.root.findAll((n) => typeof n.type === 'string' && n.props.testID === testID)
    .length;
}

function textOf(renderer: ReactTestRenderer, testID: string): string {
  const children = renderer.root.findByProps({ testID }).props.children;
  return Array.isArray(children) ? children.join('') : String(children);
}

const PROMPT = 'Go through the server logs in the last 24 hours and show me any of concern.';

function digest(overrides: Partial<ChatDigest> = {}): ChatDigest {
  return {
    id: 'd1',
    channelId: 'c1',
    name: 'Log Summary',
    enabled: true,
    cron: '0 9 * * *',
    timeZone: 'UTC',
    scope: 'agent',
    projectIds: ['web'],
    prompt: PROMPT,
    agentId: 'web-dev',
    skills: ['support-logs'],
    ownerUserId: 'u1',
    windowStart: '2026-10-13T09:00:00.000Z',
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastMessageId: null,
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

const builtIn = (overrides: Partial<ChatDigest> = {}) =>
  digest({
    id: 'd2',
    name: 'Project digest',
    scope: 'project',
    projectIds: ['web', 'api'],
    prompt: null,
    agentId: null,
    skills: [],
    ...overrides,
  });

async function mount(projectId: string | null = null) {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <HubChatDigestSection channelId="c1" channelProjectId={projectId} />,
    );
  });
  await flush();
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getProjects).mockResolvedValue([
    {
      id: 'web',
      name: 'Web',
      agents: [
        { id: 'web-dev', name: 'Web Dev' },
        { id: 'web-ops', name: 'Web Ops', allowedSkills: ['support-logs'] },
        { id: 'web-reviewer', name: 'Web Reviewer', role: 'reviewer' },
      ],
    },
    { id: 'api', name: 'API', agents: [{ id: 'api-dev', name: 'API Dev' }] },
  ]);
  vi.mocked(api.getSkills).mockResolvedValue([{ id: 'support-logs' }, { id: 'agent-hub-kanban' }]);
});

describe('mobile HubChatDigestSection', () => {
  it('lists every digest on the channel as a card', async () => {
    hubChat.digests.mockResolvedValue({ digests: [digest(), builtIn()] });
    const renderer = await mount();

    expect(count(renderer, 'hub-chat-digest-card-d1')).toBe(1);
    expect(count(renderer, 'hub-chat-digest-card-d2')).toBe(1);
    expect(textOf(renderer, 'hub-chat-digest-card-status-d2')).toBe('Not run yet.');
    expect(count(renderer, 'hub-chat-digest-editor')).toBe(0);
  });

  it('adds an agent digest: project, agent, skills and prompt, no summarize choice', async () => {
    hubChat.digests.mockResolvedValue({ digests: [] });
    hubChat.createDigest.mockResolvedValue({ digest: digest({ id: 'd9' }) });
    const renderer = await mount('web');
    expect(textOf(renderer, 'hub-chat-digest-empty')).toBe('No digests scheduled.');

    await press(renderer, 'hub-chat-digest-add');
    expect(count(renderer, 'hub-chat-digest-scope-project')).toBe(0);
    expect(renderer.root.findByProps({ testID: 'hub-chat-digest-project-web' }).props.active).toBe(
      true,
    );
    // Reviewers cannot run a digest session.
    expect(count(renderer, 'hub-chat-digest-agent-web-reviewer')).toBe(0);
    await press(renderer, 'hub-chat-digest-agent-web-dev');
    await press(renderer, 'hub-chat-digest-skill-support-logs');
    await type(renderer, 'hub-chat-digest-name', 'Log Summary');
    await press(renderer, 'hub-chat-digest-preset-1');
    expect(renderer.root.findByProps({ testID: 'hub-chat-digest-save' }).props.disabled).toBe(true);
    await type(renderer, 'hub-chat-digest-prompt', PROMPT);
    await press(renderer, 'hub-chat-digest-save');

    expect(hubChat.createDigest).toHaveBeenCalledWith('c1', {
      name: 'Log Summary',
      enabled: true,
      cron: '0 9 * * *',
      timeZone: expect.any(String),
      scope: 'agent',
      projectIds: ['web'],
      agentId: 'web-dev',
      skills: ['support-logs'],
      prompt: PROMPT,
    });
    expect(count(renderer, 'hub-chat-digest-card-d9')).toBe(1);
    expect(count(renderer, 'hub-chat-digest-editor')).toBe(0);
  });

  it("offers only the skills the agent's allowlist permits", async () => {
    hubChat.digests.mockResolvedValue({ digests: [] });
    const renderer = await mount('web');
    await press(renderer, 'hub-chat-digest-add');
    await press(renderer, 'hub-chat-digest-agent-web-ops');
    expect(api.getSkills).toHaveBeenCalledWith('web-ops');
    expect(count(renderer, 'hub-chat-digest-skill-support-logs')).toBe(1);
    expect(count(renderer, 'hub-chat-digest-skill-agent-hub-kanban')).toBe(0);
  });

  it('switching project clears the agent and blocks saving', async () => {
    hubChat.digests.mockResolvedValue({ digests: [digest()] });
    const renderer = await mount();
    await press(renderer, 'hub-chat-digest-card-d1');
    await press(renderer, 'hub-chat-digest-project-api');
    expect(
      renderer.root.findByProps({ testID: 'hub-chat-digest-agent-api-dev' }).props.active,
    ).toBe(false);
    expect(renderer.root.findByProps({ testID: 'hub-chat-digest-save' }).props.disabled).toBe(true);
  });

  it('keeps a built-in digest under its own scope when edited', async () => {
    hubChat.digests.mockResolvedValue({ digests: [builtIn()] });
    hubChat.updateDigest.mockResolvedValue({ digest: builtIn({ enabled: false }) });
    const renderer = await mount();
    await press(renderer, 'hub-chat-digest-card-d2');
    expect(count(renderer, 'hub-chat-digest-builtin')).toBe(1);
    const toggle = renderer.root.findByProps({ testID: 'hub-chat-digest-enabled' });
    await TestRenderer.act(async () => toggle.props.onValueChange(false));
    await press(renderer, 'hub-chat-digest-save');

    expect(hubChat.updateDigest).toHaveBeenCalledWith(
      'c1',
      'd2',
      expect.objectContaining({ scope: 'project', projectIds: ['web', 'api'], enabled: false }),
    );
    expect(textOf(renderer, 'hub-chat-digest-card-status-d2')).toBe('Paused. Not run yet.');
  });

  it('runs an agent digest now and says the reply will follow', async () => {
    hubChat.digests.mockResolvedValue({ digests: [digest()] });
    hubChat.runDigest.mockResolvedValue({
      result: { status: 'started', sessionId: 's1', skippedSkills: [] },
      digest: digest({ lastRunAt: '2026-10-15T09:00:00.000Z', lastStatus: 'started' }),
    });
    const renderer = await mount();
    await press(renderer, 'hub-chat-digest-card-d1');
    await press(renderer, 'hub-chat-digest-run');

    expect(hubChat.runDigest).toHaveBeenCalledWith('c1', 'd1');
    expect(textOf(renderer, 'hub-chat-digest-notice')).toContain('Started the agent');
    expect(textOf(renderer, 'hub-chat-digest-status')).toContain('started the agent');
  });

  it('removes a digest from the list', async () => {
    hubChat.digests.mockResolvedValue({ digests: [digest(), builtIn()] });
    hubChat.removeDigest.mockResolvedValue({ ok: true });
    const renderer = await mount();
    await press(renderer, 'hub-chat-digest-card-d1');
    await press(renderer, 'hub-chat-digest-remove');

    expect(hubChat.removeDigest).toHaveBeenCalledWith('c1', 'd1');
    expect(count(renderer, 'hub-chat-digest-card-d1')).toBe(0);
    expect(count(renderer, 'hub-chat-digest-card-d2')).toBe(1);
  });

  it('disables Add digest at the per-channel limit', async () => {
    hubChat.digests.mockResolvedValue({
      digests: Array.from({ length: 10 }, (_, i) => digest({ id: `d${i}` })),
    });
    const renderer = await mount();
    expect(renderer.root.findByProps({ testID: 'hub-chat-digest-add' }).props.disabled).toBe(true);
  });
});
