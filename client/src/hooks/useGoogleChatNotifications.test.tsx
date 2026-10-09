import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/auth', () => ({ getAuthRecord: () => null }));

import { useGoogleChatNotifications } from './useGoogleChatNotifications';

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
