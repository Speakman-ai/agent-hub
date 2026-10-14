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
});
