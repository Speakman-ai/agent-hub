import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/auth', () => ({ getAuthRecord: () => null }));

import { useGoogleChatNotifications } from './useGoogleChatNotifications';
import {
  chatNotifyGate,
  createChatMuteStore,
  useChatMutes,
  useChatMutesSync,
  type ChatMuteStore,
} from '../utils/googleChatMutes';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('useGoogleChatNotifications', () => {
  it("does not show user A's message when A's request resolves after switching to user B", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:30:00Z'));
    let lastActive = '2026-10-09T10:00:00Z';
    let release: (v: any) => void = () => {};
    const chatApi = {
      listGoogleChatSpaces: vi.fn(async () => ({
        spaces: [{ id: 'A', name: 'spaces/A', displayName: 'Room A', lastActiveTime: lastActive }],
      })),
      listGoogleChatMessages: vi.fn(() => new Promise((resolve) => (release = resolve))),
    };
    const onNotify = vi.fn();
    const { rerender } = renderHook(
      ({ userId }) =>
        useGoogleChatNotifications({
          enabled: true,
          pushActive: false,
          userId,
          onNotify,
          chatApi,
        }),
      { initialProps: { userId: 'user-a' } },
    );
    await act(flush); // user A's first poll primes

    // User A's next poll finds activity and starts reading messages.
    lastActive = '2026-10-09T10:05:00Z';
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await flush();
    });
    expect(chatApi.listGoogleChatMessages).toHaveBeenCalledTimes(1);

    // Account switch before the read answers.
    rerender({ userId: 'user-b' });
    await act(async () => {
      release({
        messages: [
          {
            name: 'spaces/A/messages/m1',
            createTime: '2026-10-09T10:05:00Z',
            text: "A's secret",
            deleted: false,
            attachmentCount: 0,
            sender: { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' },
          },
        ],
        selfUserName: 'users/a',
      });
      await flush();
    });
    expect(onNotify).not.toHaveBeenCalled();
  });
});

describe('useGoogleChatNotifications with mutes', () => {
  // The same wiring App uses.
  function useAppWiring(store: ChatMuteStore, chatApi: any, onNotify: (n: any) => void) {
    useChatMutesSync(true, 'u1', store);
    const mutes = useChatMutes(store);
    useGoogleChatNotifications({
      ...chatNotifyGate(true, mutes),
      pushActive: true,
      userId: 'u1',
      onNotify,
      chatApi,
    });
  }

  const message = (space: string, id: string, createTime: string) => ({
    name: `spaces/${space}/messages/${id}`,
    createTime,
    text: `hello from ${space}`,
    deleted: false,
    attachmentCount: 0,
    sender: { name: 'users/alice', displayName: 'Alice', type: 'HUMAN' },
  });
  const pushEvent = (space: string, id: string, createTime: string) =>
    window.dispatchEvent(
      new CustomEvent('google_chat_message', {
        detail: {
          type: 'google_chat_message',
          kind: 'created',
          ownerUserId: 'u1',
          spaceName: `spaces/${space}`,
          messageName: `spaces/${space}/messages/${id}`,
          createTime,
        },
      }),
    );

  it('never notifies for a muted space while the mute list is still loading, then retries the load', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:30:00Z'));
    const muteApi = {
      getGoogleChatMutes: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ spaceIds: ['A'], revision: 1 }),
      setGoogleChatSpaceMuted: vi.fn(),
    };
    const store = createChatMuteStore(muteApi);
    let messages: Record<string, any[]> = {};
    const chatApi = {
      listGoogleChatSpaces: vi.fn(async () => ({
        spaces: [
          {
            id: 'A',
            name: 'spaces/A',
            displayName: 'Room A',
            lastActiveTime: '2026-10-09T10:00:00Z',
          },
          {
            id: 'B',
            name: 'spaces/B',
            displayName: 'Room B',
            lastActiveTime: '2026-10-09T10:00:00Z',
          },
        ],
      })),
      listGoogleChatMessages: vi.fn(async (space: string) => ({
        messages: messages[space] ?? [],
        selfUserName: 'users/me',
      })),
    };
    const onNotify = vi.fn();
    renderHook(() => useAppWiring(store, chatApi, onNotify));
    await act(flush);

    // The first load failed; a message in the muted space arrives meanwhile.
    expect(store.getState().loaded).toBe(false);
    messages = { A: [message('A', 'm1', '2026-10-09T10:31:00Z')] };
    await act(async () => {
      pushEvent('A', 'm1', '2026-10-09T10:31:00Z');
      await flush();
    });
    expect(onNotify).not.toHaveBeenCalled();
    expect(chatApi.listGoogleChatMessages).not.toHaveBeenCalled();

    // The retry loads the list and notifications start, still skipping A.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await flush();
    });
    expect(muteApi.getGoogleChatMutes).toHaveBeenCalledTimes(2);
    expect(store.getState().loaded).toBe(true);
    messages = {
      A: [message('A', 'm2', '2026-10-09T10:32:00Z')],
      B: [message('B', 'm3', '2026-10-09T10:32:00Z')],
    };
    await act(async () => {
      pushEvent('A', 'm2', '2026-10-09T10:32:00Z');
      pushEvent('B', 'm3', '2026-10-09T10:32:00Z');
      await flush();
    });
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify.mock.calls[0][0].spaceId).toBe('B');
  });
});
