/**
 * `@agent` mentions in a regular channel: members see which mentioned agents
 * are still answering (server state), the poster sees refused mentions, and
 * the reply carries its session chip.
 */
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
    post: vi.fn(),
  },
}));
vi.mock('../utils/api', () => ({ api }));
vi.mock('../utils/hubChatInstance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/hubChatInstance')>();
  const { createHubChatStore } = await import('../utils/hubChatStore');
  return { ...actual, hubChatStore: createHubChatStore(api.hubChat) };
});
vi.mock('../context/AppContext', () => ({ useApp: () => ({ handleOpenHandoffSession: vi.fn() }) }));
vi.mock('./ChatScreen', () => ({ default: () => null }));
const composer = vi.hoisted(() => ({ onChange: null as null | ((t: string, m: any[]) => void) }));
vi.mock('../components/HubChatRefs', () => ({
  HubChatComposer: (props: any) => {
    composer.onChange = props.onChange;
    return null;
  },
  // The raw body, so a test can see which chip a row renders.
  HubChatMessageBody: ({ body }: { body: string }) => body,
}));
vi.mock('../components/HubIcon', () => ({ default: () => null }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: HubChatScreen } = await import('./HubChatScreen');
const { hubChatStore } = await import('../utils/hubChatInstance');
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
const flush = () => act(async () => {});

let mounted: any = null;
async function mount() {
  await act(async () => {
    mounted = TestRenderer.create(React.createElement(HubChatScreen, { initialChannelId: 'c1' }));
  });
  return mounted;
}

const textOf = (node: any): string =>
  node.children.map((c: any) => (typeof c === 'string' ? c : textOf(c))).join('');
const byTestId = (r: any, id: string) => r.root.findAll((n: any) => n.props?.testID === id);

async function sendMention() {
  await act(async () => {
    composer.onChange!('@Web Dev @Docs look', [
      { display: '@Web Dev', token: '@[Web Dev](agent:web-dev)', at: 0 },
      { display: '@Docs', token: '@[Docs](agent:docs)', at: 9 },
    ]);
  });
  await act(async () => {
    byTestId(mounted, 'hub-chat-send')[0].props.onPress();
  });
  await flush();
}

const pendingUpdate = (mentionPending: unknown[]) =>
  act(async () => {
    hubChatStore.handleWsEvent({
      type: 'hub_chat_channel_update',
      channelId: 'c1',
      reason: 'mention_state',
      mentionPending,
    });
  });

describe('HubChatScreen agent mentions (mounted)', () => {
  beforeEach(async () => {
    appState.currentState = 'active';
    nav.focused = true;
    for (const fn of Object.values(api.hubChat)) fn.mockReset();
    api.hubChat.members.mockResolvedValue({ members: [] });
    api.hubChat.channel.mockResolvedValue({ channel: channel() });
    api.hubChat.markRead.mockResolvedValue({});
    api.hubChat.pins.mockResolvedValue({ pins: [] });
    api.hubChat.channels.mockResolvedValue({ channels: [channel()], viewerUserId: 'u1' });
    api.hubChat.messages.mockResolvedValue({ messages: range(1, 50), hasMore: false });
    api.hubChat.post.mockResolvedValue({
      message: { ...msg(51), authorUserId: 'u1', body: '@[Web Dev](agent:web-dev) @Docs look' },
      agentSessionId: null,
      mentionSessions: [{ agentId: 'web-dev', sessionId: 'sess-1' }],
      mentionNotices: [
        {
          agentId: 'docs',
          code: 'mention_not_eligible',
          message: '@Docs cannot answer chat mentions.',
        },
      ],
    });
    await hubChatStore.reset(true, 'u1');
  });
  afterEach(() => {
    act(() => mounted?.unmount());
    mounted = null;
    hubChatStore.setViewing(null);
  });

  it('shows the refused mention from the post response once', async () => {
    await mount();
    await sendMention();
    expect(api.hubChat.post).toHaveBeenCalledWith(
      'c1',
      '@[Web Dev](agent:web-dev) @[Docs](agent:docs) look',
    );
    const notices = byTestId(mounted, 'hub-chat-mention-notice');
    expect(notices.map(textOf)).toEqual(['@Docs cannot answer chat mentions.']);

    // The same notice over the socket is not shown twice.
    await act(async () => {
      hubChatStore.handleWsEvent({
        type: 'hub_chat_notice',
        channelId: 'c1',
        messageId: 'm51',
        agentId: 'docs',
        code: 'mention_not_eligible',
        message: '@Docs cannot answer chat mentions.',
      });
    });
    expect(byTestId(mounted, 'hub-chat-mention-notice')).toHaveLength(1);
  });

  it("shows which agents are answering from the channel's live state", async () => {
    await mount();
    expect(byTestId(mounted, 'hub-chat-mention-pending')).toHaveLength(0);
    await pendingUpdate([
      { agentId: 'web-dev', agentName: 'Web Dev', sessionId: 'sess-1' },
      { agentId: 'api-dev', agentName: 'API Dev', sessionId: null },
    ]);
    const pending = byTestId(mounted, 'hub-chat-mention-pending');
    expect(pending.map(textOf)).toEqual(['Web Dev and API Dev are working…']);
    // A live state update is complete: no channel list refetch.
    expect(api.hubChat.channels).toHaveBeenCalledTimes(1);

    await pendingUpdate([]);
    expect(byTestId(mounted, 'hub-chat-mention-pending')).toHaveLength(0);
  });

  it('shows agents already answering when the channel opens', async () => {
    api.hubChat.channels.mockResolvedValue({
      channels: [
        channel({
          mentionPending: [{ agentId: 'web-dev', agentName: 'Web Dev', sessionId: null }],
        }),
      ],
      viewerUserId: 'u1',
    });
    await hubChatStore.reset(true, 'u1');
    await mount();
    expect(byTestId(mounted, 'hub-chat-mention-pending').map(textOf)).toEqual([
      'Web Dev is working…',
    ]);
  });

  it("renders the agent's reply with its session chip", async () => {
    const reply: HubChatMessage = {
      ...msg(52),
      authorKind: 'agent',
      authorUserId: null,
      authorAgentId: 'web-dev',
      authorAgentName: 'Web Dev',
      body: 'Done.\n\n@[@Web Dev in #general](session:sess-1)',
      refs: [{ kind: 'session', targetId: 'sess-1', projectId: 'p1' }],
    };
    const { MessageRow } = await import('./HubChatScreen');
    let row: any;
    act(() => {
      row = TestRenderer.create(
        React.createElement(MessageRow, {
          row: {
            message: reply,
            showHeader: true,
            own: false,
            dayLabel: null,
            unreadDivider: false,
          },
          usernames: new Map(),
        } as any),
      );
    });
    const text = textOf(row.root);
    act(() => row.unmount());
    expect(text).toContain('Web Dev');
    expect(text).toContain('(session:sess-1)');
  });

  it('shows a live notice for this channel only, and dismisses it', async () => {
    await mount();
    await act(async () => {
      for (const channelId of ['other', 'c1']) {
        hubChatStore.handleWsEvent({
          type: 'hub_chat_notice',
          channelId,
          messageId: 'm9',
          agentId: 'secret',
          code: 'mention_forbidden',
          message: '@Secret was not asked: you need access to its project to use it.',
        });
      }
    });
    const notices = byTestId(mounted, 'hub-chat-mention-notice');
    expect(notices).toHaveLength(1);
    await act(async () => {
      notices[0].findByProps({ accessibilityLabel: 'Dismiss notice' }).props.onPress();
    });
    expect(byTestId(mounted, 'hub-chat-mention-status')).toHaveLength(0);
  });
});
