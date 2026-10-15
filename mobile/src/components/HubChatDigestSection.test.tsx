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

function digest(overrides: Partial<ChatDigest> = {}): ChatDigest {
  return {
    id: 'd1',
    channelId: 'c1',
    name: 'Project digest',
    enabled: true,
    cron: '0 9 * * *',
    timeZone: 'UTC',
    scope: 'project',
    projectIds: ['web'],
    prompt: null,
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

async function mount() {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(<HubChatDigestSection channelId="c1" channelProjectId={null} />);
  });
  await flush();
  return renderer;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getProjects).mockResolvedValue([
    { id: 'web', name: 'Web' },
    { id: 'api', name: 'API' },
  ]);
});

describe('mobile HubChatDigestSection', () => {
  it('lists every digest on the channel as a card', async () => {
    hubChat.digests.mockResolvedValue({
      digests: [
        digest(),
        digest({ id: 'd2', name: 'Channel recap', scope: 'channel', projectIds: [] }),
      ],
    });
    const renderer = await mount();

    expect(count(renderer, 'hub-chat-digest-card-d1')).toBe(1);
    expect(count(renderer, 'hub-chat-digest-card-d2')).toBe(1);
    expect(textOf(renderer, 'hub-chat-digest-card-status-d2')).toBe('Not run yet.');
    expect(count(renderer, 'hub-chat-digest-editor')).toBe(0);
  });

  it('adds a multi-project digest with custom instructions', async () => {
    hubChat.digests.mockResolvedValue({ digests: [] });
    hubChat.createDigest.mockResolvedValue({
      digest: digest({ id: 'd9', name: 'Morning', projectIds: ['web', 'api'], prompt: 'Short.' }),
    });
    const renderer = await mount();
    expect(textOf(renderer, 'hub-chat-digest-empty')).toBe('No digests scheduled.');

    await press(renderer, 'hub-chat-digest-add');
    await type(renderer, 'hub-chat-digest-name', 'Morning');
    await press(renderer, 'hub-chat-digest-scope-project');
    // The first visible project is preselected when the list loads.
    expect(renderer.root.findByProps({ testID: 'hub-chat-digest-project-web' }).props.active).toBe(
      true,
    );
    await press(renderer, 'hub-chat-digest-project-api');
    await press(renderer, 'hub-chat-digest-preset-1');
    const prompt = renderer.root.findByProps({ testID: 'hub-chat-digest-prompt' });
    expect(prompt.props.placeholder).toContain('Lead with the most important outcomes');
    await type(renderer, 'hub-chat-digest-prompt', '  Short.  ');
    await press(renderer, 'hub-chat-digest-save');

    expect(hubChat.createDigest).toHaveBeenCalledWith('c1', {
      name: 'Morning',
      enabled: true,
      cron: '0 9 * * *',
      timeZone: expect.any(String),
      scope: 'project',
      projectIds: ['web', 'api'],
      prompt: 'Short.',
    });
    expect(count(renderer, 'hub-chat-digest-card-d9')).toBe(1);
    expect(count(renderer, 'hub-chat-digest-editor')).toBe(0);
  });

  it('deselects a project and blocks saving a project digest with none', async () => {
    hubChat.digests.mockResolvedValue({ digests: [digest()] });
    const renderer = await mount();
    await press(renderer, 'hub-chat-digest-card-d1');
    await press(renderer, 'hub-chat-digest-project-web');

    const save = renderer.root.findByProps({ testID: 'hub-chat-digest-save' });
    expect(save.props.disabled).toBe(true);
  });

  it('edits a saved digest and clears its prompt back to the default', async () => {
    hubChat.digests.mockResolvedValue({ digests: [digest({ prompt: 'Old instructions' })] });
    hubChat.updateDigest.mockResolvedValue({
      digest: digest({ enabled: false, prompt: null }),
    });
    const renderer = await mount();
    await press(renderer, 'hub-chat-digest-card-d1');
    expect(renderer.root.findByProps({ testID: 'hub-chat-digest-prompt' }).props.value).toBe(
      'Old instructions',
    );
    const toggle = renderer.root.findByProps({ testID: 'hub-chat-digest-enabled' });
    await TestRenderer.act(async () => toggle.props.onValueChange(false));
    await type(renderer, 'hub-chat-digest-prompt', '');
    await press(renderer, 'hub-chat-digest-save');

    expect(hubChat.updateDigest).toHaveBeenCalledWith(
      'c1',
      'd1',
      expect.objectContaining({ enabled: false, prompt: null, projectIds: ['web'] }),
    );
    expect(textOf(renderer, 'hub-chat-digest-card-status-d1')).toBe('Paused. Not run yet.');
  });

  it('runs a digest now and reports the outcome', async () => {
    hubChat.digests.mockResolvedValue({ digests: [digest()] });
    hubChat.runDigest.mockResolvedValue({
      result: { status: 'skipped', reason: 'empty_window' },
      digest: digest({ lastRunAt: '2026-10-15T09:00:00.000Z', lastStatus: 'skipped' }),
    });
    const renderer = await mount();
    await press(renderer, 'hub-chat-digest-card-d1');
    await press(renderer, 'hub-chat-digest-run');

    expect(hubChat.runDigest).toHaveBeenCalledWith('c1', 'd1');
    expect(textOf(renderer, 'hub-chat-digest-notice')).toBe(
      'Nothing new since the last digest, nothing posted.',
    );
    expect(textOf(renderer, 'hub-chat-digest-status')).toContain('nothing new, skipped posting');
  });

  it('removes a digest from the list', async () => {
    hubChat.digests.mockResolvedValue({
      digests: [digest(), digest({ id: 'd2', name: 'Other', scope: 'channel', projectIds: [] })],
    });
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

  describe('my_work scope', () => {
    async function mountSummaries() {
      let renderer!: ReactTestRenderer;
      await TestRenderer.act(async () => {
        renderer = TestRenderer.create(
          <HubChatDigestSection channelId="c1" channelProjectId={null} allowMyWork />,
        );
      });
      await flush();
      return renderer;
    }
    const myWork = digest({
      id: 'd3',
      name: 'Daily summary',
      cron: '0,15 8,9 * * * | 30 9,10 * * *',
      scope: 'my_work',
      projectIds: [],
    });

    it('is not offered outside the Summaries channel', async () => {
      hubChat.digests.mockResolvedValue({ digests: [] });
      const renderer = await mount();
      await press(renderer, 'hub-chat-digest-add');
      expect(count(renderer, 'hub-chat-digest-scope-my_work')).toBe(0);
    });

    it('defaults new digests to my_work on the Summaries channel', async () => {
      hubChat.digests.mockResolvedValue({ digests: [] });
      hubChat.createDigest.mockResolvedValue({ digest: myWork });
      const renderer = await mountSummaries();
      await press(renderer, 'hub-chat-digest-add');
      expect(
        renderer.root.findByProps({ testID: 'hub-chat-digest-scope-my_work' }).props.active,
      ).toBe(true);
      await press(renderer, 'hub-chat-digest-save');

      expect(hubChat.createDigest).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ scope: 'my_work', projectIds: [] }),
      );
      expect(api.getProjects).not.toHaveBeenCalled();
    });

    it('edits a migrated my_work digest without changing its scope', async () => {
      hubChat.digests.mockResolvedValue({ digests: [myWork] });
      hubChat.updateDigest.mockResolvedValue({ digest: { ...myWork, enabled: false } });
      const renderer = await mountSummaries();
      await press(renderer, 'hub-chat-digest-card-d3');
      expect(
        renderer.root.findByProps({ testID: 'hub-chat-digest-scope-my_work' }).props.active,
      ).toBe(true);
      const toggle = renderer.root.findByProps({ testID: 'hub-chat-digest-enabled' });
      await TestRenderer.act(async () => toggle.props.onValueChange(false));
      expect(renderer.root.findByProps({ testID: 'hub-chat-digest-save' }).props.disabled).toBe(
        false,
      );
      await press(renderer, 'hub-chat-digest-save');

      expect(hubChat.updateDigest).toHaveBeenCalledWith(
        'c1',
        'd3',
        expect.objectContaining({
          scope: 'my_work',
          projectIds: [],
          enabled: false,
          cron: '0,15 8,9 * * * | 30 9,10 * * *',
        }),
      );
    });
  });
});
