import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';

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
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));

vi.mock('../utils/api', () => ({
  api: {
    getProjects: vi.fn(),
    hubChat: { digest: vi.fn(), saveDigest: vi.fn(), removeDigest: vi.fn() },
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

function statusText(renderer: ReactTestRenderer): string {
  return String(renderer.root.findByProps({ testID: 'hub-chat-digest-status' }).props.children);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getProjects).mockResolvedValue([{ id: 'web', name: 'Web' }]);
});

describe('mobile HubChatDigestSection', () => {
  it('schedules a project digest from the presets', async () => {
    hubChat.digest.mockResolvedValue({ digest: null });
    hubChat.saveDigest.mockResolvedValue({
      digest: {
        channelId: 'c1',
        enabled: true,
        cron: '0 9 * * *',
        timeZone: 'UTC',
        scope: 'project',
        projectId: 'web',
        ownerUserId: 'u1',
        windowStart: '2026-10-13T09:00:00.000Z',
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        lastMessageId: null,
        createdAt: 'x',
        updatedAt: 'x',
      },
    });
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <HubChatDigestSection channelId="c1" channelProjectId={null} />,
      );
    });
    await flush();
    expect(statusText(renderer)).toBe('No digest scheduled.');

    await press(renderer, 'hub-chat-digest-scope-project');
    await press(renderer, 'hub-chat-digest-project-web');
    await press(renderer, 'hub-chat-digest-preset-1');
    await press(renderer, 'hub-chat-digest-save');

    expect(hubChat.saveDigest).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ cron: '0 9 * * *', scope: 'project', projectId: 'web' }),
    );
    expect(statusText(renderer)).toBe('Not run yet.');
  });
});
