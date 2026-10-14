import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Modal: ({ visible, children }: any) => (visible ? children : null),
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));

const live = vi.hoisted(() => ({ listeners: new Set<(e: any) => void>() }));
vi.mock('../utils/hubChatInstance', () => ({
  hubChatStore: {
    subscribeLive: (fn: (e: any) => void) => {
      live.listeners.add(fn);
      return () => live.listeners.delete(fn);
    },
  },
}));
vi.mock('../utils/api', () => ({ api: { hubChat: { backlinks: vi.fn() } } }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { api } = await import('../utils/api');
const { default: HubChatBacklinks } = await import('./HubChatBacklinks');
process.env.NODE_ENV = originalNodeEnv;

const backlinks = (api as any).hubChat.backlinks as ReturnType<typeof vi.fn>;

function link(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'm1',
    channelId: 'c1',
    channelKind: 'channel',
    channelLabel: '# general',
    authorKind: 'user',
    authorName: 'alice',
    excerpt: 'Looking at #WEB-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function mount(props: Record<string, unknown>) {
  let r: any;
  await act(async () => {
    r = TestRenderer.create(React.createElement(HubChatBacklinks, props as any));
  });
  return r;
}

const rows = (r: any) => r.root.findAll((n: any) => n.props.testID === 'hub-chat-backlink');

beforeEach(() => {
  vi.clearAllMocks();
  live.listeners.clear();
  backlinks.mockResolvedValue({ backlinks: [] });
});

describe('HubChatBacklinks (mobile)', () => {
  it('renders nothing without backlinks', async () => {
    const r = await mount({ kind: 'card', targetId: 'card-1' });
    expect(backlinks).toHaveBeenCalledWith('card', 'card-1');
    expect(r.toJSON()).toBeNull();
  });

  it('lists backlinks and opens the channel on tap', async () => {
    backlinks.mockResolvedValue({ backlinks: [link()] });
    const onOpenChannel = vi.fn();
    const r = await mount({ kind: 'card', targetId: 'card-1', onOpenChannel });
    expect(rows(r)).toHaveLength(1);
    await act(async () => rows(r)[0].props.onPress());
    expect(onOpenChannel).toHaveBeenCalledWith('c1');
  });

  it('refetches when a live message references the target', async () => {
    const r = await mount({ kind: 'pr', targetId: 'web#7' });
    backlinks.mockResolvedValue({ backlinks: [link()] });
    await act(async () => {
      for (const fn of live.listeners) {
        fn({
          type: 'hub_chat_message',
          message: { id: 'm1', refs: [{ kind: 'pr', targetId: 'web#7' }] },
        });
      }
    });
    expect(backlinks).toHaveBeenCalledTimes(2);
    expect(rows(r)).toHaveLength(1);
  });

  it('chip variant opens the list in a sheet', async () => {
    backlinks.mockResolvedValue({ backlinks: [link(), link({ messageId: 'm2' })] });
    const r = await mount({ kind: 'session', targetId: 's1', variant: 'chip' });
    expect(rows(r)).toHaveLength(0);
    const toggle = r.root.find((n: any) => n.props.testID === 'hub-chat-backlinks-toggle');
    await act(async () => toggle.props.onPress());
    expect(rows(r)).toHaveLength(2);
  });

  it('ignores an older response that resolves after a newer one', async () => {
    let resolveFirst!: (v: unknown) => void;
    backlinks.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    const r = await mount({ kind: 'card', targetId: 'card-1' });

    backlinks.mockResolvedValueOnce({ backlinks: [link()] });
    await act(async () => {
      for (const fn of live.listeners) {
        fn({
          type: 'hub_chat_message',
          message: { id: 'm1', refs: [{ kind: 'card', targetId: 'card-1' }] },
        });
      }
    });
    expect(rows(r)).toHaveLength(1);

    await act(async () => resolveFirst({ backlinks: [] }));
    expect(rows(r)).toHaveLength(1);
  });

  it('drops the previous target rows while the next target loads', async () => {
    backlinks.mockResolvedValueOnce({ backlinks: [link({ channelId: 'ca' })] });
    const onOpenChannel = vi.fn();
    const r = await mount({ kind: 'session', targetId: 'a', onOpenChannel });
    expect(rows(r)).toHaveLength(1);

    let resolveB!: (v: unknown) => void;
    backlinks.mockReturnValueOnce(new Promise((res) => (resolveB = res)));
    await act(async () => {
      r.update(
        React.createElement(HubChatBacklinks, { kind: 'session', targetId: 'b', onOpenChannel }),
      );
    });
    expect(backlinks).toHaveBeenLastCalledWith('session', 'b');
    expect(rows(r)).toHaveLength(0);

    await act(async () => resolveB({ backlinks: [link({ messageId: 'm9', channelId: 'cb' })] }));
    expect(rows(r)).toHaveLength(1);
    await act(async () => rows(r)[0].props.onPress());
    expect(onOpenChannel).toHaveBeenCalledWith('cb');
  });
});
