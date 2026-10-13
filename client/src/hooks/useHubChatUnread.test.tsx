import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useHubChatUnread } from './useHubChatUnread';
import type { HubChatChannel } from '../utils/hubChat';

vi.mock('../utils/api', () => ({ api: { hubChat: { channels: vi.fn() } } }));

function channel(id: string, over: Partial<HubChatChannel> = {}): HubChatChannel {
  return {
    id,
    orgId: 'o',
    kind: 'dm',
    name: '',
    topic: null,
    isPrivate: true,
    projectId: null,
    agentId: null,
    dmPeerUserId: 'bob',
    createdByUserId: null,
    archivedAt: null,
    createdAt: '2026-01-01',
    lastSeq: 2,
    membership: { role: 'member', lastReadSeq: 1, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 1,
    mentionCount: 0,
    ...over,
  };
}

function emit(type: string, detail: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  });
}

const liveMessage = (channelId: string, seq: number) => ({
  channelId,
  authorName: 'bob',
  message: {
    id: `m${seq}`,
    channelId,
    seq,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: `msg ${seq}`,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T12:00:00Z',
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type ChannelsResponse = { channels: HubChatChannel[]; viewerUserId: string };

/** Initial load settled, then a reconnect refresh held open by the test. */
async function withPendingRefresh(initial: HubChatChannel[]) {
  const pending = deferred<ChannelsResponse>();
  const channels = vi
    .fn()
    .mockResolvedValueOnce({ channels: initial, viewerUserId: 'alice' })
    .mockReturnValueOnce(pending.promise);
  const chatApi = { hubChat: { channels } };
  const hook = renderHook(() =>
    useHubChatUnread({
      enabled: true,
      userId: 'alice',
      isViewingChannel: () => false,
      chatApi,
    }),
  );
  await waitFor(() => expect(hook.result.current.channels).toHaveLength(initial.length));
  emit('agenthub:ws_reconnected', {});
  expect(channels).toHaveBeenCalledTimes(2);
  return { ...hook, channels, pending };
}

describe('useHubChatUnread', () => {
  it('keeps a live message that arrives while an older fetch is in flight', async () => {
    const { result, channels, pending } = await withPendingRefresh([channel('d1')]);
    // The follow-up fetch sees the new message.
    channels.mockResolvedValue({
      channels: [channel('d1', { lastSeq: 3, unreadCount: 2 })],
      viewerUserId: 'alice',
    });
    emit('hub_chat_message', liveMessage('d1', 3));
    expect(result.current.badge).toBe(2);

    // The snapshot was taken before the message: lastSeq 2, one unread.
    await act(async () => {
      pending.resolve({ channels: [channel('d1')], viewerUserId: 'alice' });
    });
    expect(result.current.badge).toBe(2);
    await waitFor(() => expect(channels).toHaveBeenCalledTimes(3));
    expect(result.current.badge).toBe(2);
  });

  it('keeps a read that arrives while an older fetch is in flight', async () => {
    const { result, pending } = await withPendingRefresh([channel('d1')]);
    emit('hub_chat_read', { channelId: 'd1', lastReadSeq: 2 });
    expect(result.current.badge).toBe(0);

    // The snapshot predates the read and still counts one unread.
    await act(async () => {
      pending.resolve({ channels: [channel('d1')], viewerUserId: 'alice' });
    });
    expect(result.current.badge).toBe(0);
  });

  it('counts live messages, notifies DMs, and clears on read', async () => {
    const chatApi = {
      hubChat: {
        channels: vi.fn().mockResolvedValue({ channels: [channel('d1')], viewerUserId: 'alice' }),
      },
    };
    const onNotify = vi.fn();
    const { result } = renderHook(() =>
      useHubChatUnread({
        enabled: true,
        userId: 'alice',
        isViewingChannel: () => false,
        onNotify,
        chatApi,
      }),
    );
    await waitFor(() => expect(result.current.badge).toBe(1));

    emit('hub_chat_message', liveMessage('d1', 3));
    expect(result.current.badge).toBe(2);
    expect(onNotify).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'd1', title: 'bob', body: 'msg 3' }),
    );

    emit('hub_chat_read', { channelId: 'd1', lastReadSeq: 3 });
    expect(result.current.badge).toBe(0);
  });

  it('does not count or notify a message on the channel being viewed', async () => {
    const chatApi = {
      hubChat: {
        channels: vi.fn().mockResolvedValue({
          channels: [channel('d1', { unreadCount: 0, lastSeq: 1 })],
          viewerUserId: 'alice',
        }),
      },
    };
    const onNotify = vi.fn();
    const { result } = renderHook(() =>
      useHubChatUnread({
        enabled: true,
        userId: 'alice',
        isViewingChannel: (id) => id === 'd1',
        onNotify,
        chatApi,
      }),
    );
    await waitFor(() => expect(chatApi.hubChat.channels).toHaveBeenCalled());
    await waitFor(() => expect(result.current.channels).toHaveLength(1));
    emit('hub_chat_message', liveMessage('d1', 2));
    expect(result.current.badge).toBe(0);
    expect(onNotify).not.toHaveBeenCalled();
  });

  it('refetches for a message in a channel it has not seen', async () => {
    const chatApi = {
      hubChat: {
        channels: vi
          .fn()
          .mockResolvedValueOnce({ channels: [], viewerUserId: 'alice' })
          .mockResolvedValueOnce({ channels: [channel('d2')], viewerUserId: 'alice' }),
      },
    };
    const onNotify = vi.fn();
    const { result } = renderHook(() =>
      useHubChatUnread({
        enabled: true,
        userId: 'alice',
        isViewingChannel: () => false,
        onNotify,
        chatApi,
      }),
    );
    await waitFor(() => expect(chatApi.hubChat.channels).toHaveBeenCalledTimes(1));
    emit('hub_chat_message', liveMessage('d2', 2));
    await waitFor(() => expect(result.current.badge).toBe(1));
    expect(onNotify).toHaveBeenCalledTimes(1);
  });

  it('stays empty and fetches nothing while disabled', () => {
    const chatApi = { hubChat: { channels: vi.fn() } };
    const { result } = renderHook(() =>
      useHubChatUnread({
        enabled: false,
        userId: 'alice',
        isViewingChannel: () => false,
        chatApi,
      }),
    );
    expect(result.current.badge).toBe(0);
    expect(chatApi.hubChat.channels).not.toHaveBeenCalled();
  });
});
