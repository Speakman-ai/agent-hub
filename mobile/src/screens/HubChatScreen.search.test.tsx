import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubChatChannel, HubChatMessage } from '@shared/utils/hubChat';

// The list's scroll methods, so tests can see where a jump scrolls to.
const listApi = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
  scrollToEnd: vi.fn(),
}));
vi.mock('react-native', async () => {
  const R = await import('react');
  // A ref-capable FlatList: exposes the scroll methods and renders a
  // `FlatList` host element carrying its props.
  const FlatList = R.forwardRef((props: any, ref: any) => {
    R.useImperativeHandle(ref, () => listApi, []);
    return R.createElement('FlatList', props);
  });
  return {
    ActivityIndicator: 'ActivityIndicator',
    Alert: { alert: vi.fn() },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    FlatList,
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
  };
});
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

const api = vi.hoisted(() => ({
  hubChat: {
    members: vi.fn(),
    channels: vi.fn(),
    channel: vi.fn(),
    messages: vi.fn(),
    markRead: vi.fn(),
    message: vi.fn(),
    search: vi.fn(),
    pins: vi.fn(),
  },
}));
vi.mock('../utils/api', () => ({ api }));
vi.mock('../utils/hubChatInstance', async () => {
  const { createHubChatStore } = await import('../utils/hubChatStore');
  const actual = await vi.importActual<typeof import('../utils/hubChatInstance')>(
    '../utils/hubChatInstance',
  );
  return {
    hubChatStore: createHubChatStore(api.hubChat),
    locateChatMarkdownCode: actual.locateChatMarkdownCode,
  };
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
const { SEARCH_DEBOUNCE_MS } = await import('../components/HubChatSearch');
process.env.NODE_ENV = originalNodeEnv;

function channel(id: string, lastSeq: number): HubChatChannel {
  return {
    id,
    orgId: 'o1',
    kind: 'channel',
    name: id === 'c2' ? 'release' : 'general',
    topic: null,
    isPrivate: false,
    projectId: null,
    agentId: null,
    dmPeerUserId: null,
    createdByUserId: 'u1',
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    lastSeq,
    membership: { role: 'member', lastReadSeq: lastSeq, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 0,
    mentionCount: 0,
  };
}
function msg(channelId: string, seq: number): HubChatMessage {
  return {
    id: `${channelId}-m${seq}`,
    channelId,
    seq,
    authorKind: 'user',
    authorUserId: 'u2',
    authorAgentId: null,
    body: seq === 5 || seq === 120 ? 'the deploy needle is here' : `b${seq}`,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00Z',
  };
}

/** Channel c2 holds `total` messages and answers the REST paging contract. */
async function serveC2(total: number) {
  const all = Array.from({ length: total }, (_, i) => msg('c2', i + 1));
  api.hubChat.channels.mockResolvedValue({
    channels: [channel('c1', 1), channel('c2', total)],
    viewerUserId: 'u1',
  });
  api.hubChat.messages.mockImplementation(async (_c: string, o: any) => {
    const limit = o.limit ?? 50;
    if (o.after !== undefined) {
      const rows = all.filter((m) => m.seq > o.after);
      return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
    }
    const rows = all.filter((m) => o.before === undefined || m.seq < o.before);
    return { messages: rows.slice(-limit), hasMore: rows.length > limit };
  });
  api.hubChat.message.mockImplementation(async (id: string) => ({
    message: all.find((m) => m.id === id),
  }));
  await hubChatStore.reset(true, 'u1');
  return all;
}

const flush = () => act(async () => {});
let mounted: any = null;
async function mount() {
  await act(async () => {
    mounted = TestRenderer.create(React.createElement(HubChatScreen, {}));
  });
  return mounted;
}
const byTestId = (r: any, id: string) => r.root.findAll((n: any) => n.props.testID === id);

async function searchAndPick(r: any, query: string, messageId: string) {
  const input = byTestId(r, 'hub-chat-search-input')[0];
  await act(async () => input.props.onChangeText(query));
  await act(async () => {
    await new Promise((res) => setTimeout(res, SEARCH_DEBOUNCE_MS + 20));
  });
  await flush();
  const hit = byTestId(r, `hub-chat-search-result-${messageId}`)[0];
  expect(hit).toBeDefined();
  await act(async () => hit.props.onPress());
  await flush();
  await flush();
}

/** The highlighted message, as handed to the list (rows render through it). */
const highlighted = (r: any): string | null => {
  const lists = r.root.findAllByType('FlatList');
  return lists.length ? (lists[0].props.extraData ?? null) : null;
};

/** Presses the touchable inside `container` whose text is `label`. */
function pressLabel(container: any, label: string) {
  const target = container.findAll(
    (n: any) =>
      typeof n.props.onPress === 'function' &&
      n.findAll((t: any) => t.type === 'Text' && t.props.children === label).length > 0,
  )[0];
  expect(target).toBeDefined();
  target.props.onPress();
}

describe('HubChatScreen message search', () => {
  beforeEach(async () => {
    for (const fn of Object.values(api.hubChat)) fn.mockReset();
    api.hubChat.pins.mockResolvedValue({ pins: [] });
    for (const fn of Object.values(listApi)) fn.mockReset();
    api.hubChat.members.mockResolvedValue({ members: [{ userId: 'u2', username: 'bo' }] });
    api.hubChat.markRead.mockResolvedValue({});
  });
  afterEach(() => {
    act(() => mounted?.unmount());
    mounted = null;
    hubChatStore.setViewing(null);
  });

  it('searches from the rail and jumps to a message older than the first page', async () => {
    const all = await serveC2(300);
    api.hubChat.search.mockResolvedValue({
      results: [
        {
          message: all[119],
          channel: {
            id: 'c2',
            kind: 'channel',
            name: 'release',
            dmPeerUserId: null,
            isPrivate: false,
            isMember: true,
          },
        },
      ],
      hasMore: false,
    });
    const r = await mount();
    await flush();
    await searchAndPick(r, 'needle', 'c2-m120');

    expect(api.hubChat.search).toHaveBeenCalledWith('needle', { limit: 30 });
    const list = r.root.findByType('FlatList');
    const shown = (list.props.data as { message: HubChatMessage }[]).map((x) => x.message.seq);
    expect(shown[0]).toBeLessThanOrEqual(120);
    expect(shown[shown.length - 1]).toBe(300);
    expect(highlighted(r)).toBe('c2-m120');
    // Scrolled to the target's row once history reached it.
    expect(listApi.scrollToIndex).toHaveBeenLastCalledWith({
      index: shown.indexOf(120),
      viewPosition: 0.5,
      animated: false,
    });
    // The search box is gone with the rail; the channel is open.
    expect(byTestId(r, 'hub-chat-search-input')).toHaveLength(0);
  });

  it('asks before loading further back, then finds the message on Keep loading', async () => {
    const all = await serveC2(1300);
    api.hubChat.search.mockResolvedValue({
      results: [{ message: all[4], channel: { ...channel('c2', 1300), isMember: true } }],
      hasMore: false,
    });
    const r = await mount();
    await flush();
    await searchAndPick(r, 'needle', 'c2-m5');

    expect(byTestId(r, 'hub-chat-seek-pending')).toHaveLength(1);
    expect(highlighted(r)).toBeNull();
    const pending = byTestId(r, 'hub-chat-seek-pending')[0];
    const keep = pending.findAll(
      (n: any) =>
        n.props.onPress && n.findAll((t: any) => t.children?.includes('Keep loading')).length,
    )[0];
    await act(async () => keep.props.onPress());
    await flush();
    await flush();
    expect(byTestId(r, 'hub-chat-seek-pending')).toHaveLength(0);
    expect(highlighted(r)).toBe('c2-m5');
  });

  it('says so when the message was deleted since it was found', async () => {
    const all = await serveC2(300);
    api.hubChat.message.mockRejectedValue(Object.assign(new Error('404: gone'), { status: 404 }));
    api.hubChat.search.mockResolvedValue({
      results: [{ message: all[119], channel: { ...channel('c2', 300), isMember: true } }],
      hasMore: false,
    });
    const r = await mount();
    await flush();
    await searchAndPick(r, 'needle', 'c2-m120');
    const banner = byTestId(r, 'hub-chat-seek-error');
    expect(banner).toHaveLength(1);
    expect(
      JSON.stringify(banner[0].findAllByType('Text').map((t: any) => t.props.children)),
    ).toContain('no longer in this conversation');
    expect(highlighted(r)).toBeNull();
  });

  it('shows no results for an empty match and keeps the rail hidden while searching', async () => {
    await serveC2(10);
    api.hubChat.search.mockResolvedValue({ results: [], hasMore: false });
    const r = await mount();
    await flush();
    expect(byTestId(r, 'hub-chat-channel-c2')).toHaveLength(1);
    const input = byTestId(r, 'hub-chat-search-input')[0];
    await act(async () => input.props.onChangeText('zzz'));
    await act(async () => {
      await new Promise((res) => setTimeout(res, SEARCH_DEBOUNCE_MS + 20));
    });
    expect(byTestId(r, 'hub-chat-channel-c2')).toHaveLength(0);
    expect(JSON.stringify(r.toJSON())).toContain('No messages found.');
    await act(async () => byTestId(r, 'hub-chat-search-clear')[0].props.onPress());
    expect(byTestId(r, 'hub-chat-channel-c2')).toHaveLength(1);
  });

  it('Stop ends the history loading: no page is requested after it', async () => {
    const all = await serveC2(1300);
    const serve = api.hubChat.messages.getMockImplementation()!;
    const older: { resolve: () => void }[] = [];
    api.hubChat.messages.mockImplementation((c: string, o: any) => {
      if (o.before === undefined) return serve(c, o);
      return new Promise((resolve) => older.push({ resolve: () => resolve(serve(c, o)) }));
    });
    api.hubChat.search.mockResolvedValue({
      results: [{ message: all[4], channel: { ...channel('c2', 1300), isMember: true } }],
      hasMore: false,
    });
    const r = await mount();
    await flush();
    await searchAndPick(r, 'needle', 'c2-m5');
    expect(older).toHaveLength(1);
    const before = api.hubChat.messages.mock.calls.length;

    const bar = byTestId(r, 'hub-chat-seeking')[0];
    await act(async () => pressLabel(bar, 'Stop'));
    await act(async () => older[0].resolve());
    await flush();
    await flush();

    expect(api.hubChat.messages.mock.calls.length).toBe(before);
    expect(older).toHaveLength(1);
    expect(byTestId(r, 'hub-chat-seeking')).toHaveLength(0);
    expect(byTestId(r, 'hub-chat-seek-pending')).toHaveLength(0);
    expect(highlighted(r)).toBeNull();
  });

  it('keeps the jump when the first load fails and finishes it after a reload', async () => {
    const all = await serveC2(300);
    const serve = api.hubChat.messages.getMockImplementation()!;
    let failFirst = true;
    api.hubChat.messages.mockImplementation(async (c: string, o: any) => {
      if (failFirst && o.before === undefined && o.after === undefined) {
        failFirst = false;
        throw new Error('503: unavailable');
      }
      return serve(c, o);
    });
    api.hubChat.search.mockResolvedValue({
      results: [{ message: all[119], channel: { ...channel('c2', 300), isMember: true } }],
      hasMore: false,
    });
    const r = await mount();
    await flush();
    await searchAndPick(r, 'needle', 'c2-m120');
    expect(JSON.stringify(r.toJSON())).toContain('503: unavailable');
    expect(api.hubChat.message).not.toHaveBeenCalled();

    // A reconnect reloads the channel.
    await act(async () => hubChatStore.resync());
    await flush();
    await flush();
    expect(api.hubChat.message).toHaveBeenCalledWith('c2-m120');
    expect(highlighted(r)).toBe('c2-m120');
  });

  it('falls back to an offset and retries when the row is not laid out yet', async () => {
    const all = await serveC2(300);
    api.hubChat.search.mockResolvedValue({
      results: [{ message: all[119], channel: { ...channel('c2', 300), isMember: true } }],
      hasMore: false,
    });
    const r = await mount();
    await flush();
    await searchAndPick(r, 'needle', 'c2-m120');
    const flatList = r.root.findByType('FlatList');
    const index = (flatList.props.data as { message: HubChatMessage }[]).findIndex(
      (x) => x.message.id === 'c2-m120',
    );
    expect(listApi.scrollToIndex).toHaveBeenCalledTimes(1);

    await act(async () =>
      flatList.props.onScrollToIndexFailed({
        index,
        averageItemLength: 40,
        highestMeasuredFrameIndex: 10,
      }),
    );
    expect(listApi.scrollToOffset).toHaveBeenCalledWith({ offset: 40 * index, animated: false });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 150));
    });
    expect(listApi.scrollToIndex).toHaveBeenCalledTimes(2);
    expect(listApi.scrollToIndex).toHaveBeenLastCalledWith({
      index,
      viewPosition: 0.5,
      animated: true,
    });
  });
});
