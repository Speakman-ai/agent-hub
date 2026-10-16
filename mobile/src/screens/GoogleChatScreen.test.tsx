import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';

const getGoogleStatus = vi.fn();
const listGoogleChatSpaces = vi.fn();
const listGoogleChatMessages = vi.fn();
const sendGoogleChatMessage = vi.fn();
const appStateListeners: Array<(state: string) => void> = [];
let snapshot = { account: 1 };
const snapshotListeners = new Set<() => void>();
function switchAccount(account: number) {
  snapshot = { account };
  snapshotListeners.forEach((l) => l());
}

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  AppState: {
    currentState: 'active',
    addEventListener: (_: string, fn: (state: string) => void) => {
      appStateListeners.push(fn);
      return {
        remove: () => appStateListeners.splice(appStateListeners.indexOf(fn), 1),
      };
    },
  },
  FlatList: 'FlatList',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios' },
  StyleSheet: { create: (s: any) => s },
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));
vi.mock('../hooks/useHubChat', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useHubChatSnapshot: () =>
      useSyncExternalStore(
        (l: () => void) => {
          snapshotListeners.add(l);
          return () => snapshotListeners.delete(l);
        },
        () => snapshot,
      ),
  };
});
vi.mock('../utils/api', () => ({
  api: { getGoogleStatus, listGoogleChatSpaces, listGoogleChatMessages, sendGoogleChatMessage },
}));

const React = await import('react');
const { default: TestRenderer, act } = await import('react-test-renderer');
const { default: GoogleChatPane, MESSAGES_POLL_MS } = await import('./GoogleChatScreen');

const READ = [
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.messages.create',
];

const mounted: ReactTestRenderer[] = [];

async function mount() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(GoogleChatPane));
  });
  mounted.push(renderer);
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((n: any) => typeof n.type === 'string')
    .flatMap((n: any) => [n.props.value, ...[n.props.children].flat()])
    .filter((c: unknown) => typeof c === 'string')
    .join('\n');
}

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

function byTestId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    (n: any) => n.props?.testID === testID && typeof n.type === 'string',
  )[0];
}

function spaceList(renderer: ReactTestRenderer) {
  return (renderer.root as any).findByProps({ testID: 'google-chat-pane' }).findByType('FlatList');
}

function messageList(renderer: ReactTestRenderer) {
  return (renderer.root as any)
    .findByProps({ testID: 'google-chat-thread' })
    .findByType('FlatList');
}

async function openSpaceAt(renderer: ReactTestRenderer, index: number) {
  const list = spaceList(renderer);
  await act(async () => {
    list.props.renderItem({ item: list.props.data[index], index }).props.onPress();
    await Promise.resolve();
  });
}

const msg = (id: string, text: string, createTime: string) => ({
  name: `spaces/X/messages/${id}`,
  text,
  createTime,
  sender: { name: 'users/2', displayName: 'Ada', type: 'HUMAN' },
});

afterEach(() => {
  act(() => {
    mounted.splice(0).forEach((r) => r.unmount());
  });
});

beforeEach(() => {
  snapshot = { account: 1 };
  appStateListeners.length = 0;
  getGoogleStatus.mockReset();
  listGoogleChatSpaces.mockReset();
  listGoogleChatMessages.mockReset();
  sendGoogleChatMessage.mockReset();
});

describe('GoogleChatPane', () => {
  it('asks to connect Google instead of sending the user to the web app', async () => {
    getGoogleStatus.mockResolvedValue({ connected: false, grantedScopes: [] });
    const renderer = await mount();
    expect(textOf(renderer)).toContain('Connect Google to use Chat.');
    expect(textOf(renderer)).not.toContain('available in the web app');
    expect(listGoogleChatSpaces).not.toHaveBeenCalled();
  });

  it('lists conversations and opens their messages', async () => {
    getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ, email: 'a@b.c' });
    listGoogleChatSpaces.mockResolvedValue({
      spaces: [{ id: 'AAA', displayName: 'Ops', spaceType: 'SPACE' }],
    });
    listGoogleChatMessages.mockResolvedValue({
      selfUserName: 'users/me',
      messages: [
        {
          name: 'spaces/AAA/messages/1',
          text: 'hello from chat',
          createTime: '2026-01-01T00:00:00Z',
          sender: { name: 'users/2', displayName: 'Ada', type: 'HUMAN' },
        },
      ],
    });
    const renderer = await mount();
    const list = (renderer.root as any).findByType('FlatList');
    expect(list.props.data.map((s: any) => s.displayName)).toEqual(['Ops']);
    await act(async () => {
      list.props.renderItem({ item: list.props.data[0], index: 0 }).props.onPress();
      await Promise.resolve();
    });
    expect(listGoogleChatMessages).toHaveBeenCalledWith('AAA', { pageSize: 50, order: 'desc' });
    const thread = renderer.root.findByProps({ testID: 'google-chat-thread' });
    const messages = (thread as any).findByType('FlatList');
    expect(messages.props.data[0].text).toBe('hello from chat');
  });

  it('ignores a late response for a conversation the user already left', async () => {
    getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
    listGoogleChatSpaces.mockResolvedValue({
      spaces: [
        { id: 'A', displayName: 'Alpha', spaceType: 'SPACE' },
        { id: 'B', displayName: 'Beta', spaceType: 'SPACE' },
      ],
    });
    const lateA = deferred();
    listGoogleChatMessages.mockImplementation((id: string) =>
      id === 'A'
        ? lateA.promise
        : Promise.resolve({ messages: [msg('b1', 'from beta', '2026-01-01T00:00:00Z')] }),
    );
    const renderer = await mount();
    await openSpaceAt(renderer, 0);
    await act(async () => {
      byTestId(renderer, 'google-chat-back').props.onPress();
    });
    await flush();
    await openSpaceAt(renderer, 1);
    await flush();
    await act(async () => {
      lateA.resolve({ messages: [msg('a1', 'from alpha', '2026-01-01T00:00:00Z')] });
      await lateA.promise;
    });
    await flush();
    expect(messageList(renderer).props.data.map((m: any) => m.text)).toEqual(['from beta']);
    expect(textOf(renderer)).toContain('Beta');
  });

  it('drops the open conversation, draft and pending results when the account changes', async () => {
    getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
    listGoogleChatSpaces.mockResolvedValueOnce({
      spaces: [{ id: 'A', displayName: 'Server A space', spaceType: 'SPACE' }],
    });
    const pendingA = deferred();
    listGoogleChatMessages.mockReturnValueOnce(pendingA.promise);
    const renderer = await mount();
    await openSpaceAt(renderer, 0);
    await act(async () => {
      byTestId(renderer, 'google-chat-input').props.onChangeText('draft for A');
    });

    listGoogleChatSpaces.mockResolvedValueOnce({
      spaces: [{ id: 'B', displayName: 'Server B space', spaceType: 'SPACE' }],
    });
    await act(async () => {
      switchAccount(2);
    });
    await flush();
    await act(async () => {
      pendingA.resolve({ messages: [msg('a1', 'from server A', '2026-01-01T00:00:00Z')] });
      await pendingA.promise;
    });
    await flush();

    expect(
      renderer.root.findAll((n: any) => n.props?.testID === 'google-chat-thread'),
    ).toHaveLength(0);
    expect(spaceList(renderer).props.data.map((s: any) => s.id)).toEqual(['B']);
    expect(textOf(renderer)).not.toContain('draft for A');
    expect(textOf(renderer)).not.toContain('from server A');
    expect(sendGoogleChatMessage).not.toHaveBeenCalled();
  });

  it('pages through conversations and older messages', async () => {
    getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
    listGoogleChatSpaces
      .mockResolvedValueOnce({
        spaces: [{ id: 'A', displayName: 'First', spaceType: 'SPACE' }],
        nextPageToken: 'spaces-2',
      })
      .mockResolvedValueOnce({ spaces: [{ id: 'B', displayName: 'Second', spaceType: 'SPACE' }] });
    listGoogleChatMessages
      .mockResolvedValueOnce({
        messages: [msg('2', 'newer', '2026-01-02T00:00:00Z')],
        nextPageToken: 'msgs-2',
      })
      .mockResolvedValueOnce({ messages: [msg('1', 'older', '2026-01-01T00:00:00Z')] });
    const renderer = await mount();

    await act(async () => {
      spaceList(renderer).props.ListFooterComponent.props.onPress();
    });
    await flush();
    expect(listGoogleChatSpaces).toHaveBeenLastCalledWith({ pageSize: 50, pageToken: 'spaces-2' });
    expect(spaceList(renderer).props.data.map((s: any) => s.id)).toEqual(['A', 'B']);
    expect(spaceList(renderer).props.ListFooterComponent).toBeNull();

    await openSpaceAt(renderer, 0);
    await flush();
    await act(async () => {
      messageList(renderer).props.ListHeaderComponent.props.onPress();
    });
    await flush();
    expect(listGoogleChatMessages).toHaveBeenLastCalledWith('A', {
      pageSize: 50,
      order: 'desc',
      pageToken: 'msgs-2',
    });
    expect(messageList(renderer).props.data.map((m: any) => m.text)).toEqual(['older', 'newer']);
    expect(messageList(renderer).props.ListHeaderComponent).toBeNull();
  });

  it('shows the composer after sending is enabled from inside a conversation', async () => {
    const readOnly = READ.filter((s) => !s.endsWith('chat.messages.create'));
    getGoogleStatus.mockResolvedValueOnce({ connected: true, grantedScopes: readOnly });
    listGoogleChatSpaces.mockResolvedValue({
      spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
    });
    listGoogleChatMessages.mockResolvedValue({ messages: [] });
    const renderer = await mount();
    await openSpaceAt(renderer, 0);
    await flush();
    expect(byTestId(renderer, 'google-chat-input')).toBeUndefined();

    getGoogleStatus.mockResolvedValueOnce({ connected: true, grantedScopes: READ });
    await act(async () => {
      appStateListeners.forEach((l) => l('active'));
    });
    await flush();
    expect(byTestId(renderer, 'google-chat-input')).toBeDefined();
    expect(
      renderer.root.findAll((n: any) => n.props?.testID === 'google-chat-thread'),
    ).not.toHaveLength(0);
  });

  it('keeps text typed while a send is in flight, and restores a failed send', async () => {
    getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
    listGoogleChatSpaces.mockResolvedValue({
      spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
    });
    listGoogleChatMessages.mockResolvedValue({ messages: [] });
    const renderer = await mount();
    await openSpaceAt(renderer, 0);
    await flush();
    const input = () => byTestId(renderer, 'google-chat-input');

    const first = deferred();
    sendGoogleChatMessage.mockReturnValueOnce(first.promise);
    await act(async () => input().props.onChangeText('first'));
    await act(async () => {
      void byTestId(renderer, 'google-chat-send').props.onPress();
    });
    expect(input().props.value).toBe('');
    await act(async () => input().props.onChangeText('second'));
    await act(async () => {
      first.resolve({});
      await first.promise;
    });
    await flush();
    expect(sendGoogleChatMessage).toHaveBeenCalledWith('A', { text: 'first' });
    expect(input().props.value).toBe('second');

    sendGoogleChatMessage.mockRejectedValueOnce(new Error('nope'));
    await act(async () => input().props.onChangeText('third'));
    await act(async () => {
      void byTestId(renderer, 'google-chat-send').props.onPress();
    });
    await flush();
    expect(input().props.value).toBe('third');
    expect(textOf(renderer)).toContain('nope');
  });

  describe('incoming replies in an open conversation', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    async function openWithHistory() {
      getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
      listGoogleChatSpaces.mockResolvedValue({
        spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
      });
      listGoogleChatMessages
        .mockResolvedValueOnce({
          messages: [msg('2', 'newer', '2026-01-02T00:00:00Z')],
          nextPageToken: 'older',
        })
        .mockResolvedValueOnce({ messages: [msg('1', 'older', '2026-01-01T00:00:00Z')] });
      const renderer = await mount();
      await openSpaceAt(renderer, 0);
      await flush();
      await act(async () => {
        messageList(renderer).props.ListHeaderComponent.props.onPress();
      });
      await flush();
      expect(messageList(renderer).props.data.map((m: any) => m.text)).toEqual(['older', 'newer']);
      return renderer;
    }

    const withReply = {
      messages: [
        msg('3', 'a reply', '2026-01-03T00:00:00Z'),
        msg('2', 'newer', '2026-01-02T00:00:00Z'),
      ],
      nextPageToken: 'older',
    };

    it('shows a reply on return to the foreground and keeps older pages', async () => {
      const renderer = await openWithHistory();
      listGoogleChatMessages.mockResolvedValueOnce(withReply);
      await act(async () => {
        appStateListeners.forEach((l) => l('active'));
      });
      await flush();
      expect(messageList(renderer).props.data.map((m: any) => m.text)).toEqual([
        'older',
        'newer',
        'a reply',
      ]);
      // The refresh's page token is for history already loaded; it must not
      // bring back "Load older messages".
      expect(messageList(renderer).props.ListHeaderComponent).toBeNull();
    });

    it('polls the open conversation for replies', async () => {
      vi.useFakeTimers();
      const renderer = await openWithHistory();
      listGoogleChatMessages.mockResolvedValueOnce(withReply);
      await act(async () => {
        vi.advanceTimersByTime(MESSAGES_POLL_MS);
      });
      await flush();
      expect(messageList(renderer).props.data.map((m: any) => m.text)).toContain('a reply');
    });

    it('refreshes on pull', async () => {
      const renderer = await openWithHistory();
      listGoogleChatMessages.mockResolvedValueOnce(withReply);
      await act(async () => {
        messageList(renderer).props.onRefresh();
      });
      await flush();
      expect(messageList(renderer).props.data.map((m: any) => m.text)).toContain('a reply');
      expect(messageList(renderer).props.refreshing).toBe(false);
    });
  });

  describe('overlapping message requests', () => {
    async function openOps() {
      getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
      listGoogleChatSpaces.mockResolvedValue({
        spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
      });
      listGoogleChatMessages.mockResolvedValueOnce({
        messages: [msg('1', 'original', '2026-01-01T00:00:00Z')],
      });
      const renderer = await mount();
      await openSpaceAt(renderer, 0);
      await flush();
      return renderer;
    }

    it('never lets an older refresh overwrite a newer edit', async () => {
      const renderer = await openOps();
      const older = deferred();
      const newer = deferred();
      listGoogleChatMessages.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      await act(async () => {
        appStateListeners.forEach((l) => l('active'));
      });
      await act(async () => {
        messageList(renderer).props.onRefresh();
      });
      await act(async () => {
        newer.resolve({ messages: [msg('1', 'edited', '2026-01-01T00:00:00Z')] });
        await newer.promise;
      });
      await flush();
      await act(async () => {
        older.resolve({ messages: [msg('1', 'original', '2026-01-01T00:00:00Z')] });
        await older.promise;
      });
      await flush();
      expect(messageList(renderer).props.data.map((m: any) => m.text)).toEqual(['edited']);
    });

    it('drops a response from an earlier visit to the same conversation', async () => {
      const renderer = await openOps();
      const fromFirstVisit = deferred();
      listGoogleChatMessages.mockReturnValueOnce(fromFirstVisit.promise);
      await act(async () => {
        messageList(renderer).props.onRefresh();
      });
      await act(async () => {
        byTestId(renderer, 'google-chat-back').props.onPress();
      });
      await flush();
      listGoogleChatMessages.mockResolvedValueOnce({
        messages: [msg('2', 'second visit', '2026-01-02T00:00:00Z')],
      });
      await openSpaceAt(renderer, 0);
      await flush();
      await act(async () => {
        fromFirstVisit.resolve({ messages: [msg('9', 'stale', '2026-01-03T00:00:00Z')] });
        await fromFirstVisit.promise;
      });
      await flush();
      expect(messageList(renderer).props.data.map((m: any) => m.text)).toEqual(['second visit']);
    });

    it('keeps the first load usable when a refresh overtakes it', async () => {
      getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
      listGoogleChatSpaces.mockResolvedValue({
        spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
      });
      const first = deferred();
      listGoogleChatMessages.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
        messages: [msg('2', 'newest', '2026-01-02T00:00:00Z')],
        nextPageToken: 'older',
      });
      const renderer = await mount();
      await openSpaceAt(renderer, 0);
      await act(async () => {
        appStateListeners.forEach((l) => l('active'));
      });
      await flush();
      await act(async () => {
        first.resolve({ messages: [msg('1', 'stale first load', '2026-01-01T00:00:00Z')] });
        await first.promise;
      });
      await flush();
      const list = messageList(renderer);
      expect(list.props.data.map((m: any) => m.text)).toEqual(['newest']);
      expect(list.props.ListHeaderComponent).not.toBeNull();
    });
  });

  it('applies Google status replies in the order they were requested', async () => {
    const readOnly = READ.filter((scope) => !scope.endsWith('chat.messages.create'));
    getGoogleStatus.mockResolvedValueOnce({ connected: true, grantedScopes: readOnly });
    listGoogleChatSpaces.mockResolvedValue({
      spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
    });
    listGoogleChatMessages.mockResolvedValue({ messages: [] });
    const renderer = await mount();
    await openSpaceAt(renderer, 0);
    await flush();
    const stale = deferred();
    getGoogleStatus
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ connected: true, grantedScopes: READ });
    await act(async () => {
      appStateListeners.forEach((l) => l('active'));
    });
    await act(async () => {
      appStateListeners.forEach((l) => l('active'));
    });
    await flush();
    expect(byTestId(renderer, 'google-chat-input')).toBeDefined();
    await act(async () => {
      stale.resolve({ connected: true, grantedScopes: readOnly });
      await stale.promise;
    });
    await flush();
    expect(byTestId(renderer, 'google-chat-input')).toBeDefined();
  });

  it('fills in every message that arrived while away, even after history ran out', async () => {
    const page = (from: number, to: number, next: string | null) => ({
      messages: Array.from({ length: to - from + 1 }, (_, i) => {
        const n = to - i;
        return msg(String(n), `m${n}`, new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString());
      }),
      nextPageToken: next,
    });
    getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
    listGoogleChatSpaces.mockResolvedValue({
      spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
    });
    // The whole conversation fits one page: history is exhausted.
    listGoogleChatMessages.mockResolvedValueOnce(page(1, 30, null));
    const renderer = await mount();
    await openSpaceAt(renderer, 0);
    await flush();
    expect(messageList(renderer).props.ListHeaderComponent).toBeNull();

    // 120 messages arrive while the app is in the background.
    listGoogleChatMessages
      .mockResolvedValueOnce(page(101, 150, 't1'))
      .mockResolvedValueOnce(page(51, 100, 't2'))
      .mockResolvedValueOnce(page(1, 50, null));
    await act(async () => {
      appStateListeners.forEach((l) => l('active'));
    });
    await flush();
    await flush();
    const texts = messageList(renderer).props.data.map((m: any) => m.text);
    expect(texts).toHaveLength(150);
    expect(texts[0]).toBe('m1');
    expect(texts[149]).toBe('m150');
    expect(listGoogleChatMessages).toHaveBeenLastCalledWith('A', {
      pageSize: 50,
      order: 'desc',
      pageToken: 't2',
    });
  });

  it('keeps a failed message when a newer draft is already in the composer', async () => {
    getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
    listGoogleChatSpaces.mockResolvedValue({
      spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
    });
    listGoogleChatMessages.mockResolvedValue({ messages: [] });
    const renderer = await mount();
    await openSpaceAt(renderer, 0);
    await flush();
    const input = () => byTestId(renderer, 'google-chat-input');

    const first = deferred();
    sendGoogleChatMessage.mockReturnValueOnce(first.promise);
    await act(async () => input().props.onChangeText('message A'));
    await act(async () => {
      void byTestId(renderer, 'google-chat-send').props.onPress();
    });
    await act(async () => input().props.onChangeText('message B'));
    await act(async () => {
      first.promise.catch(() => {});
      (first as any).resolve(Promise.reject(new Error('offline')));
    });
    await flush();

    // Both texts survive: B stays in the composer, A is listed as unsent.
    expect(input().props.value).toBe('message B');
    const unsent = renderer.root.findAll(
      (n: any) => typeof n.type === 'string' && /^google-chat-unsent-\d+$/.test(n.props?.testID),
    );
    expect(unsent).toHaveLength(1);
    expect(textOf(renderer)).toContain('message A');

    // Retry sends A again and clears it; B is untouched.
    const id = unsent[0].props.testID.split('-').pop();
    sendGoogleChatMessage.mockResolvedValueOnce({});
    await act(async () => {
      byTestId(renderer, `google-chat-unsent-retry-${id}`).props.onPress();
    });
    await flush();
    expect(sendGoogleChatMessage).toHaveBeenLastCalledWith('A', { text: 'message A' });
    expect(byTestId(renderer, `google-chat-unsent-${id}`)).toBeUndefined();
    expect(input().props.value).toBe('message B');
  });

  it('moves an unsent message into the composer below the current draft on Edit', async () => {
    getGoogleStatus.mockResolvedValue({ connected: true, grantedScopes: READ });
    listGoogleChatSpaces.mockResolvedValue({
      spaces: [{ id: 'A', displayName: 'Ops', spaceType: 'SPACE' }],
    });
    listGoogleChatMessages.mockResolvedValue({ messages: [] });
    const renderer = await mount();
    await openSpaceAt(renderer, 0);
    await flush();
    const input = () => byTestId(renderer, 'google-chat-input');
    const first = deferred();
    sendGoogleChatMessage.mockReturnValueOnce(first.promise);
    await act(async () => input().props.onChangeText('A'));
    await act(async () => {
      void byTestId(renderer, 'google-chat-send').props.onPress();
    });
    await act(async () => input().props.onChangeText('B'));
    await act(async () => {
      first.promise.catch(() => {});
      (first as any).resolve(Promise.reject(new Error('offline')));
    });
    await flush();
    const unsent = renderer.root.findAll(
      (n: any) => typeof n.type === 'string' && /^google-chat-unsent-\d+$/.test(n.props?.testID),
    );
    const id = unsent[0].props.testID.split('-').pop();
    await act(async () => {
      byTestId(renderer, `google-chat-unsent-edit-${id}`).props.onPress();
    });
    expect(input().props.value).toBe('B\nA');
  });
});
