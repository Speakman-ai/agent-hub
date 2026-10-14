import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubChatChannel, HubChatMessage } from '@shared/utils/hubChat';

const appStateListeners = vi.hoisted(() => new Set<(s: string) => void>());
const appState = vi.hoisted(() => ({ currentState: 'active' }));
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_: string, fn: (s: string) => void) => {
      appStateListeners.add(fn);
      return { remove: () => appStateListeners.delete(fn) };
    },
  },
  FlatList: 'FlatList',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
  StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
}));

const nav = vi.hoisted(() => ({ focused: true }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => nav.focused }));

const api = vi.hoisted(() => ({
  hubChat: {
    members: vi.fn(),
    channels: vi.fn(),
    channel: vi.fn(),
    messages: vi.fn(),
    markRead: vi.fn(),
    pins: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
  },
}));
vi.mock('../utils/api', () => ({ api }));
vi.mock('../utils/hubChatInstance', async () => {
  const { createHubChatStore } = await import('../utils/hubChatStore');
  return { hubChatStore: createHubChatStore(api.hubChat) };
});
vi.mock('../context/AppContext', () => ({ useApp: () => ({ handleOpenHandoffSession: vi.fn() }) }));
vi.mock('../components/HubChatRefs', () => ({
  HubChatComposer: () => null,
  HubChatMessageBody: () => null,
}));
vi.mock('../components/HubIcon', () => ({ default: () => null }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: HubChatScreen } = await import('./HubChatScreen');
const { hubChatStore } = await import('../utils/hubChatInstance');
const { hubChatBadge } = await import('../utils/hubChatStore');
process.env.NODE_ENV = originalNodeEnv;

function channel(over: Partial<HubChatChannel> = {}): HubChatChannel {
  return {
    id: 'c1',
    orgId: 'o1',
    kind: 'channel',
    name: 'general',
    topic: null,
    isPrivate: false,
    projectId: null,
    agentId: null,
    dmPeerUserId: null,
    createdByUserId: 'u1',
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    lastSeq: 50,
    membership: { role: 'member', lastReadSeq: 50, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  };
}
function msg(seq: number): HubChatMessage {
  return {
    id: `m${seq}`,
    channelId: 'c1',
    seq,
    authorKind: 'user',
    authorUserId: 'u2',
    authorAgentId: null,
    body: `b${seq}`,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00Z',
  };
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => msg(a + i));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => act(async () => {});
const shownSeqs = (r: any): number[] =>
  (r.root.findByType('FlatList').props.data as { message: HubChatMessage }[]).map(
    (row) => row.message.seq,
  );

let mounted: any = null;
async function mount() {
  await act(async () => {
    mounted = TestRenderer.create(React.createElement(HubChatScreen, { initialChannelId: 'c1' }));
  });
  return mounted;
}

describe('HubChatScreen channel view (mounted)', () => {
  beforeEach(async () => {
    appState.currentState = 'active';
    nav.focused = true;
    for (const fn of Object.values(api.hubChat)) fn.mockReset();
    api.hubChat.members.mockResolvedValue({ members: [] });
    api.hubChat.channel.mockResolvedValue({ channel: channel() });
    api.hubChat.markRead.mockResolvedValue({});
    api.hubChat.pins.mockResolvedValue({ pins: [] });
    api.hubChat.channels.mockResolvedValue({ channels: [channel()], viewerUserId: 'u1' });
    await hubChatStore.reset(true, 'u1');
  });
  afterEach(() => {
    // Unmount even when an assertion failed, so no view leaks into the next test.
    act(() => mounted?.unmount());
    mounted = null;
    hubChatStore.setViewing(null);
  });

  it('repairs a gap from a live message that arrives before the first page', async () => {
    const all = range(1, 53);
    const firstPage = deferred<any>();
    api.hubChat.messages.mockImplementation(async (_c: string, o: any) => {
      if (o.after === undefined && o.before === undefined) return firstPage.promise;
      const rows = all.filter((m) => m.seq > o.after);
      return { messages: rows, hasMore: false };
    });
    const r = await mount();
    // 51 and 52 were missed; 53 comes over the socket while history loads.
    await act(async () => {
      hubChatStore.handleWsEvent({ type: 'hub_chat_message', message: msg(53) });
    });
    await act(async () => {
      firstPage.resolve({ messages: range(1, 50), hasMore: false });
    });
    await flush();
    expect(shownSeqs(r)).toEqual(all.map((m) => m.seq));
  });

  it('stops viewing in the background so new messages count as unread and stay unread', async () => {
    api.hubChat.messages.mockResolvedValue({ messages: range(1, 50), hasMore: false });
    await mount();
    expect(hubChatStore.getViewing()).toBe('c1');
    await act(async () => {
      appState.currentState = 'background';
      for (const fn of appStateListeners) fn('background');
    });
    expect(hubChatStore.getViewing()).toBeNull();
    await act(async () => {
      hubChatStore.handleWsEvent({ type: 'hub_chat_message', message: msg(51) });
    });
    expect(hubChatStore.getSnapshot().channels[0].unreadCount).toBe(1);
    expect(api.hubChat.markRead).not.toHaveBeenCalled();

    // Back in front: viewing again, the window reloads and the read is written.
    api.hubChat.messages.mockResolvedValue({ messages: [msg(51)], hasMore: false });
    await act(async () => {
      appState.currentState = 'active';
      for (const fn of appStateListeners) fn('active');
    });
    await flush();
    expect(hubChatStore.getViewing()).toBe('c1');
    expect(api.hubChat.markRead).toHaveBeenCalledWith('c1', 51);
  });

  it('does not mark read while the screen is covered by another one', async () => {
    api.hubChat.messages.mockResolvedValue({ messages: range(1, 50), hasMore: false });
    const r = await mount();
    nav.focused = false;
    await act(async () => {
      r.update(React.createElement(HubChatScreen, { initialChannelId: 'c1' }));
    });
    expect(hubChatStore.getViewing()).toBeNull();
    await act(async () => {
      hubChatStore.handleWsEvent({ type: 'hub_chat_message', message: msg(51) });
    });
    await flush();
    expect(shownSeqs(r)).toContain(51);
    expect(api.hubChat.markRead).not.toHaveBeenCalled();
    expect(hubChatStore.getSnapshot().channels[0].unreadCount).toBe(1);
  });

  it('closes the open channel when the account changes', async () => {
    api.hubChat.messages.mockResolvedValue({ messages: range(1, 50), hasMore: false });
    const r = await mount();
    expect(r.root.findAllByType('FlatList')).toHaveLength(1);
    api.hubChat.channels.mockResolvedValue({ channels: [], viewerUserId: 'u2' });
    await act(async () => {
      await hubChatStore.reset(true, 'u2');
    });
    expect(r.root.findAllByType('FlatList')).toHaveLength(0);
    expect(hubChatStore.getViewing()).toBeNull();
  });

  it('writes the read for a live message seen while focused, and it stays read after leaving', async () => {
    api.hubChat.messages.mockResolvedValue({ messages: range(1, 50), hasMore: false });
    const r = await mount();
    expect(api.hubChat.markRead).not.toHaveBeenCalled();
    await act(async () => {
      hubChatStore.handleWsEvent({ type: 'hub_chat_message', message: msg(51) });
    });
    await flush();
    // The on-screen overlay must not stand in for telling the server.
    expect(api.hubChat.markRead).toHaveBeenCalledWith('c1', 51);
    nav.focused = false;
    await act(async () => {
      r.update(React.createElement(HubChatScreen, { initialChannelId: 'c1' }));
    });
    await flush();
    expect(hubChatStore.getViewing()).toBeNull();
    expect(hubChatStore.getSnapshot().channels[0]).toMatchObject({
      unreadCount: 0,
      membership: expect.objectContaining({ lastReadSeq: 51 }),
    });
    expect(hubChatBadge(hubChatStore.getSnapshot())).toBe(0);
  });

  it('shows live reactions and pin changes without touching unread state', async () => {
    api.hubChat.messages.mockResolvedValue({ messages: range(1, 50), hasMore: false });
    const r = await mount();
    const pinsLabel = () =>
      r.root.findByProps({ testID: 'hub-chat-pins-button' }).props.accessibilityLabel;
    expect(pinsLabel()).toBe('Pinned messages');
    api.hubChat.pins.mockResolvedValue({
      pins: [{ message: msg(7), pinnedByUserId: 'u2', pinnedAt: '2026-10-13T10:00:00Z' }],
    });
    const reactions = [{ emoji: '👍', count: 1, userIds: ['u2'] }];
    await act(async () => {
      hubChatStore.handleWsEvent({
        type: 'hub_chat_message_meta',
        channelId: 'c1',
        messageId: 'm7',
        metaRev: 2,
        reactions,
        pinned: { byUserId: 'u2', at: '2026-10-13T10:00:00Z' },
        pinChanged: true,
      });
    });
    await flush();
    const rows = r.root.findByType('FlatList').props.data as { message: HubChatMessage }[];
    expect(rows.find((row) => row.message.id === 'm7')!.message.reactions).toEqual(reactions);
    expect(pinsLabel()).toBe('Pinned messages (1)');
    expect(api.hubChat.channels).toHaveBeenCalledTimes(1);
  });

  it('opens an older pinned message that is not loaded yet', async () => {
    const all = range(1, 300);
    api.hubChat.messages.mockImplementation(
      async (_c: string, o: { before?: number; limit?: number }) => {
        const rows = all.filter((m) => o.before === undefined || m.seq < o.before);
        const limit = o.limit ?? 50;
        return { messages: rows.slice(-limit), hasMore: rows.length > limit };
      },
    );
    api.hubChat.pins.mockResolvedValue({
      pins: [{ message: msg(7), pinnedByUserId: 'u2', pinnedAt: '2026-10-13T10:00:00Z' }],
    });
    const scrollToIndex = vi.fn();
    await act(async () => {
      mounted = TestRenderer.create(
        React.createElement(HubChatScreen, { initialChannelId: 'c1' }),
        {
          createNodeMock: (el: { type: unknown }) =>
            el.type === 'FlatList'
              ? { scrollToIndex, scrollToEnd: vi.fn(), scrollToOffset: vi.fn() }
              : null,
        },
      );
    });
    const r = mounted;
    await flush();
    expect(shownSeqs(r)[0]).toBe(251);
    const pinRow = r.root.findByProps({ testID: 'hub-chat-pin' });
    await act(async () => {
      pinRow.findAllByType('TouchableOpacity' as any)[0]!.props.onPress();
    });
    await flush();
    const shown = shownSeqs(r);
    expect(shown[0]).toBeLessThanOrEqual(7);
    expect(shown[shown.length - 1]).toBe(300);
    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: shown.indexOf(7) }),
    );
  });

  it('updates the header from pin and unpin responses when no socket echo arrives', async () => {
    api.hubChat.messages.mockResolvedValue({ messages: range(1, 50), hasMore: false });
    const pinned = { byUserId: 'u1', at: '2026-10-13T10:00:00Z' };
    const meta = (metaRev: number, p: typeof pinned | null) => ({
      messageId: 'm50',
      channelId: 'c1',
      metaRev,
      reactions: [],
      pinned: p,
    });
    api.hubChat.pin.mockResolvedValue({ meta: meta(1, pinned) });
    api.hubChat.unpin.mockResolvedValue({ meta: meta(2, null) });
    const r = await mount();
    await flush();
    const pinsLabel = () =>
      r.root.findByProps({ testID: 'hub-chat-pins-button' }).props.accessibilityLabel;
    expect(pinsLabel()).toBe('Pinned messages');
    api.hubChat.pins.mockResolvedValue({
      pins: [
        { message: { ...msg(50), metaRev: 1, pinned }, pinnedByUserId: 'u1', pinnedAt: pinned.at },
      ],
    });
    // The list renders rows through renderItem; open the row's long-press sheet.
    const list = r.root.findByType('FlatList');
    const item = (list.props.data as { message: HubChatMessage }[]).find(
      (row) => row.message.id === 'm50',
    )!;
    const rowEl = list.props.renderItem({ item });
    await act(async () => rowEl.props.onLongPress(item.message));
    const sheet = r.root.findByProps({ testID: 'hub-chat-message-actions' });
    const pinAction = sheet
      .findAllByType('TouchableOpacity' as any)
      .find((n: any) =>
        n.findAllByType('Text' as any).some((t: any) => t.props.children === 'Pin to channel'),
      );
    await act(async () => pinAction.props.onPress());
    await flush();
    expect(api.hubChat.pin).toHaveBeenCalledWith('m50');
    expect(pinsLabel()).toBe('Pinned messages (1)');

    // Unpin from the pinned list: the item goes without waiting for an event.
    const unpin = r.root.findByProps({ accessibilityLabel: 'Unpin' });
    await act(async () => unpin.props.onPress());
    await flush();
    expect(api.hubChat.unpin).toHaveBeenCalledWith('m50');
    expect(pinsLabel()).toBe('Pinned messages');
    expect(r.root.findAllByProps({ testID: 'hub-chat-pin' })).toHaveLength(0);
  });
});
