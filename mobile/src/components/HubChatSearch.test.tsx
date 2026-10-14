import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubChatSearchResult } from '@shared/utils/hubChatSearch';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  ScrollView: 'ScrollView',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  View: 'View',
  StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
}));
const api = vi.hoisted(() => ({ hubChat: { search: vi.fn() } }));
vi.mock('../utils/api', () => ({ api }));
vi.mock('../utils/hubChatInstance', async () => {
  const { createMarkdownLocator } = await import('@shared/utils/hubChatRefTokens');
  return { locateChatMarkdownCode: createMarkdownLocator(() => ({ type: 'root', children: [] })) };
});
vi.mock('./HubIcon', () => ({ default: () => null }));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: HubChatSearch, SEARCH_DEBOUNCE_MS } = await import('./HubChatSearch');
process.env.NODE_ENV = originalNodeEnv;

function result(id: string, body: string): HubChatSearchResult {
  return {
    message: {
      id,
      channelId: 'c1',
      seq: 1,
      authorKind: 'user',
      authorUserId: 'u2',
      authorAgentId: null,
      body,
      refs: [],
      payload: null,
      editedAt: null,
      deletedAt: null,
      createdAt: '2026-10-13T10:00:00Z',
    },
    channel: {
      id: 'c1',
      kind: 'channel',
      name: 'general',
      dmPeerUserId: null,
      isPrivate: false,
      isMember: true,
    },
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let r: any = null;
const element = (account: number) =>
  React.createElement(HubChatSearch, {
    account,
    usernames: new Map(),
    viewerUserId: 'u1',
    onPick: () => {},
    children: React.createElement('Text', { testID: 'rail' }, 'rail'),
  });
const byTestId = (id: string) => r.root.findAll((n: any) => n.props.testID === id);
const input = () => byTestId('hub-chat-search-input')[0];
const shownResults = () =>
  r.root
    .findAll((n: any) => typeof n.props.testID === 'string')
    .map((n: any) => n.props.testID as string)
    .filter((id: string) => id.startsWith('hub-chat-search-result-'));
async function type(text: string) {
  await act(async () => input().props.onChangeText(text));
  await act(async () => {
    await new Promise((res) => setTimeout(res, SEARCH_DEBOUNCE_MS + 20));
  });
}

describe('HubChatSearch account switch', () => {
  beforeEach(async () => {
    api.hubChat.search.mockReset();
    await act(async () => {
      r = TestRenderer.create(element(1));
    });
  });
  afterEach(() => {
    act(() => r?.unmount());
    r = null;
  });

  it('drops finished results and the query when the account changes', async () => {
    api.hubChat.search.mockResolvedValue({ results: [result('m1', 'needle')], hasMore: false });
    await type('needle');
    expect(shownResults()).toEqual(['hub-chat-search-result-m1']);

    await act(async () => r.update(element(2)));
    expect(shownResults()).toEqual([]);
    expect(input().props.value).toBe('');
    expect(byTestId('rail')).toHaveLength(1);
  });

  it('ignores a response from the previous account that lands after the switch', async () => {
    const old = deferred<any>();
    api.hubChat.search.mockReturnValueOnce(old.promise);
    await type('needle');
    expect(api.hubChat.search).toHaveBeenCalledTimes(1);

    await act(async () => r.update(element(2)));
    await act(async () => old.resolve({ results: [result('m1', 'needle')], hasMore: false }));
    expect(shownResults()).toEqual([]);
    expect(byTestId('rail')).toHaveLength(1);

    // A search under the new account still works.
    api.hubChat.search.mockResolvedValueOnce({ results: [result('m2', 'other')], hasMore: false });
    await type('other');
    expect(shownResults()).toEqual(['hub-chat-search-result-m2']);
  });
});
