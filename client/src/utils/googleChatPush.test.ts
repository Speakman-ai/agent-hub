import { describe, it, expect, vi } from 'vitest';
import {
  applyUnreadSnapshot,
  applyVersionedUnread,
  boundaryAdvances,
  createChatPushStore,
  formatUnreadCount,
  isPushActive,
  spaceIdFromName,
  totalUnread,
  unreadUpdateFromEvent,
  EMPTY_CHAT_PUSH_STATE,
  EMPTY_UNREAD_MODEL,
  type SpaceUnread,
} from './googleChatPush';
import { CHAT_SURFACE_SCOPES } from './googleSurface';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const ACTIVE = {
  state: 'ACTIVE',
  expireTime: '2099-01-01T00:00:00Z',
  suspensionReason: null,
  lastError: null,
};
const SUSPENDED = { ...ACTIVE, state: 'SUSPENDED', suspensionReason: 'USER_SCOPE_REVOKED' };

function fakeApi(over: Record<string, unknown> = {}) {
  return {
    getGoogleStatus: vi.fn().mockResolvedValue({
      connected: true,
      grantedScopes: [...CHAT_SURFACE_SCOPES],
    }),
    ensureGoogleChatSubscription: vi
      .fn()
      .mockResolvedValue({ configured: true, subscription: ACTIVE, version: 1 }),
    listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [], total: 0, version: 0 }),
    markGoogleChatSpaceRead: vi.fn(),
    ...over,
  } as any;
}

const A: SpaceUnread = {
  spaceName: 'spaces/A',
  count: 2,
  lastMessageTime: '2026-10-08T12:00:00Z',
  version: 5,
};

const messageEvent = (space: string, count: number, version: number, t = '2026-10-08T12:00:30Z') =>
  new CustomEvent('google_chat_message', {
    detail: {
      type: 'google_chat_message',
      kind: 'created',
      spaceName: space,
      unread: { count, lastMessageTime: t, version },
    },
  });

const unreadEvent = (space: string, count: number, version: number) =>
  new CustomEvent('google_chat_unread', {
    detail: { type: 'google_chat_unread', spaceName: space, count, lastMessageTime: null, version },
  });

async function startedStore(api = fakeApi(), target = new EventTarget()) {
  const store = createChatPushStore({ api, target });
  store.setConnected(true);
  await store.start();
  return { store, api, target };
}

describe('versioned unread model', () => {
  it('applies only newer versions per space', () => {
    let m = applyVersionedUnread(EMPTY_UNREAD_MODEL, A);
    expect(totalUnread(m.unread)).toBe(2);
    expect(applyVersionedUnread(m, { ...A, count: 9, version: 4 })).toBe(m);
    expect(applyVersionedUnread(m, { ...A, count: 9, version: 5 })).toBe(m);
    m = applyVersionedUnread(m, { ...A, count: 0, version: 6 });
    expect(m.unread).toEqual({});
  });

  it('takes a snapshot except for spaces known past it, and ignores older snapshots', () => {
    let m = applyVersionedUnread(EMPTY_UNREAD_MODEL, { ...A, version: 12 });
    m = applyVersionedUnread(m, {
      spaceName: 'spaces/B',
      count: 1,
      lastMessageTime: null,
      version: 3,
    });
    m = applyUnreadSnapshot(m, {
      version: 10,
      spaces: [
        { ...A, count: 7, version: 9 },
        { spaceName: 'spaces/C', count: 4, lastMessageTime: null, version: 8 },
      ],
    });
    // A changed after the snapshot was taken; B was cleared before it; C is new.
    expect(m.unread['spaces/A'].count).toBe(2);
    expect(m.unread['spaces/B']).toBeUndefined();
    expect(m.unread['spaces/C'].count).toBe(4);
    // Anything at or below the snapshot is now stale.
    expect(
      applyVersionedUnread(m, {
        spaceName: 'spaces/C',
        count: 1,
        lastMessageTime: null,
        version: 10,
      }),
    ).toBe(m);
    expect(applyUnreadSnapshot(m, { version: 9, spaces: [] })).toBe(m);
  });

  it('reads both event shapes and requires a version', () => {
    expect(
      unreadUpdateFromEvent({
        type: 'google_chat_message',
        spaceName: 'spaces/A',
        unread: { count: 3, lastMessageTime: 't', version: 7 },
      }),
    ).toEqual({ spaceName: 'spaces/A', count: 3, lastMessageTime: 't', version: 7 });
    expect(
      unreadUpdateFromEvent({
        type: 'google_chat_unread',
        spaceName: 'spaces/A',
        count: 0,
        lastMessageTime: null,
        version: 8,
      }),
    ).toEqual({ spaceName: 'spaces/A', count: 0, lastMessageTime: null, version: 8 });
    expect(
      unreadUpdateFromEvent({ type: 'google_chat_unread', spaceName: 'spaces/A', count: 1 }),
    ).toBeNull();
    expect(unreadUpdateFromEvent({ type: 'other', spaceName: 'spaces/A' })).toBeNull();
  });

  it('formats and parses', () => {
    expect(formatUnreadCount(5)).toBe('5');
    expect(formatUnreadCount(140)).toBe('99+');
    expect(spaceIdFromName('spaces/AbC-1')).toBe('AbC-1');
    expect(spaceIdFromName('spaces/A/messages/1')).toBeNull();
  });
});

describe('isPushActive', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const sub = { ...ACTIVE, expireTime: '2026-10-08T13:00:00Z' } as const;
  const on = { ...EMPTY_CHAT_PUSH_STATE, connected: true, configured: true };

  it('needs a connected socket and an unexpired ACTIVE subscription', () => {
    expect(isPushActive({ ...on, subscription: { ...sub, expireTime: null } as any }, now)).toBe(
      false,
    );
    expect(isPushActive({ ...on, subscription: sub as any }, now)).toBe(true);
    expect(isPushActive({ ...on, connected: false, subscription: sub as any }, now)).toBe(false);
    expect(
      isPushActive(
        { ...on, subscription: { ...sub, expireTime: '2026-10-08T11:00:00Z' } as any },
        now,
      ),
    ).toBe(false);
    expect(isPushActive({ ...on, subscription: SUSPENDED as any }, now)).toBe(false);
    expect(isPushActive({ ...on, configured: false, subscription: sub as any }, now)).toBe(false);
  });
});

describe('createChatPushStore bootstrap', () => {
  it('loads unread and ensures the subscription for a user with Chat read access', async () => {
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
    });
    const { store } = await startedStore(api);
    expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(1);
    expect(store.getState().unread).toEqual({ 'spaces/A': A });
    expect(store.getState().pushActive).toBe(true);
    await store.start();
    expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe without Chat read access', async () => {
    const api = fakeApi({
      getGoogleStatus: vi.fn().mockResolvedValue({ connected: true, grantedScopes: [] }),
    });
    const { store } = await startedStore(api);
    expect(api.ensureGoogleChatSubscription).not.toHaveBeenCalled();
    expect(store.getState().pushActive).toBe(false);
  });

  it('falls back to polling when the subscription cannot be made', async () => {
    const api = fakeApi({
      ensureGoogleChatSubscription: vi.fn().mockRejectedValue(new Error('403')),
    });
    const { store } = await startedStore(api);
    expect(store.getState().pushActive).toBe(false);
  });

  it('retries bootstrap after a failed status read, on reconnect', async () => {
    const api = fakeApi();
    api.getGoogleStatus.mockRejectedValueOnce(new Error('offline'));
    const { store } = await startedStore(api);
    expect(api.ensureGoogleChatSubscription).not.toHaveBeenCalled();
    store.setConnected(false);
    store.setConnected(true);
    await vi.waitFor(() => expect(store.getState().pushActive).toBe(true));
  });

  it('subscribes once Chat read access is granted later in the session', async () => {
    const api = fakeApi();
    api.getGoogleStatus.mockResolvedValueOnce({ connected: true, grantedScopes: [] });
    const { store } = await startedStore(api);
    expect(api.ensureGoogleChatSubscription).not.toHaveBeenCalled();
    await store.start();
    expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(1);
    expect(store.getState().pushActive).toBe(true);
    await store.start();
    expect(api.getGoogleStatus).toHaveBeenCalledTimes(2);
  });
});

describe('createChatPushStore ordering (by server version, never arrival)', () => {
  it('keeps an event newer than a snapshot that was in flight', async () => {
    const snapshot = deferred<any>();
    const api = fakeApi({ listGoogleChatUnread: vi.fn().mockReturnValue(snapshot.promise) });
    const target = new EventTarget();
    const store = createChatPushStore({ api, target });
    store.setConnected(true);
    const started = store.start();
    target.dispatchEvent(messageEvent('spaces/B', 1, 6));
    // Read at version 5, before B's message.
    snapshot.resolve({ spaces: [A], total: 2, version: 5 });
    await started;
    expect(store.getState().unread['spaces/A']).toEqual(A);
    expect(store.getState().unread['spaces/B'].count).toBe(1);
  });

  it('clears optimistically on read and applies the server result', async () => {
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
      markGoogleChatSpaceRead: vi
        .fn()
        .mockResolvedValue({ spaceName: 'spaces/A', count: 0, lastMessageTime: null, version: 6 }),
    });
    const { store } = await startedStore(api);
    const pending = store.markRead('A', '2026-10-08T12:00:00Z');
    expect(store.getState().unread).toEqual({});
    await pending;
    expect(api.markGoogleChatSpaceRead).toHaveBeenCalledWith('A', '2026-10-08T12:00:00Z');
    expect(store.getState().unread).toEqual({});
  });

  it('keeps the count when the user has only seen older messages', async () => {
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
      markGoogleChatSpaceRead: vi.fn().mockResolvedValue({ ...A, count: 1, version: 6 }),
    });
    const { store } = await startedStore(api);
    const pending = store.markRead('A', '2026-10-08T11:59:00Z');
    expect(store.getState().unread['spaces/A'].count).toBe(2);
    await pending;
    expect(store.getState().unread['spaces/A'].count).toBe(1);
  });

  it('does not let a late mark-read response erase a message that arrived meanwhile', async () => {
    const response = deferred<any>();
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
      markGoogleChatSpaceRead: vi.fn().mockReturnValue(response.promise),
    });
    const { store, target } = await startedStore(api);
    const pending = store.markRead('A', '2026-10-08T12:00:00Z');
    target.dispatchEvent(messageEvent('spaces/A', 1, 7));
    // Computed at version 6, before the new message.
    response.resolve({ spaceName: 'spaces/A', count: 0, lastMessageTime: null, version: 6 });
    await pending;
    expect(store.getState().unread['spaces/A']).toMatchObject({ count: 1, version: 7 });
  });

  it("does not let a late partial read restore a badge another tab's read cleared", async () => {
    const response = deferred<any>();
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
      markGoogleChatSpaceRead: vi.fn().mockReturnValue(response.promise),
    });
    const { store, target } = await startedStore(api);
    // This tab has seen only the older message.
    const pending = store.markRead('A', '2026-10-08T11:59:00Z');
    // Another tab reads everything (version 7) before this tab's answer lands.
    target.dispatchEvent(unreadEvent('spaces/A', 0, 7));
    response.resolve({ ...A, count: 1, version: 6 });
    await pending;
    expect(store.getState().unread).toEqual({});
  });

  it('ignores a status event older than the subscription read it raced', async () => {
    const ensure = deferred<any>();
    const api = fakeApi({ ensureGoogleChatSubscription: vi.fn().mockReturnValue(ensure.promise) });
    const target = new EventTarget();
    const store = createChatPushStore({ api, target });
    store.setConnected(true);
    const started = store.start();
    await vi.waitFor(() => expect(api.ensureGoogleChatSubscription).toHaveBeenCalled());
    // Suspended at 4, reactivated at 5; the HTTP answer (5) lands first.
    ensure.resolve({ configured: true, subscription: ACTIVE, version: 5 });
    await started;
    target.dispatchEvent(
      new CustomEvent('google_chat_events_status', {
        detail: { type: 'google_chat_events_status', subscription: SUSPENDED, version: 4 },
      }),
    );
    expect(store.getState().pushActive).toBe(true);
  });

  it('keeps a newer status event over the subscription read it raced', async () => {
    const ensure = deferred<any>();
    const api = fakeApi({ ensureGoogleChatSubscription: vi.fn().mockReturnValue(ensure.promise) });
    const target = new EventTarget();
    const store = createChatPushStore({ api, target });
    store.setConnected(true);
    const started = store.start();
    await vi.waitFor(() => expect(api.ensureGoogleChatSubscription).toHaveBeenCalled());
    target.dispatchEvent(
      new CustomEvent('google_chat_events_status', {
        detail: { type: 'google_chat_events_status', subscription: SUSPENDED, version: 6 },
      }),
    );
    ensure.resolve({ configured: true, subscription: ACTIVE, version: 5 });
    await started;
    expect(store.getState().subscription?.state).toBe('SUSPENDED');
    expect(store.getState().pushActive).toBe(false);
  });
});

describe('createChatPushStore server state vs local guesses', () => {
  it('recovers when the server reports the same ACTIVE version after a failed request', async () => {
    const api = fakeApi({
      ensureGoogleChatSubscription: vi
        .fn()
        .mockResolvedValue({ configured: true, subscription: ACTIVE, version: 5 }),
    });
    const { store } = await startedStore(api);
    expect(store.getState().pushActive).toBe(true);

    api.ensureGoogleChatSubscription.mockRejectedValueOnce(new Error('502'));
    store.setConnected(false);
    store.setConnected(true);
    await vi.waitFor(() => expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.getState().pushActive).toBe(false));

    // Nothing changed server-side, so the answer is still version 5.
    store.setConnected(false);
    store.setConnected(true);
    await vi.waitFor(() => expect(store.getState().pushActive).toBe(true));
  });

  it('does not let an older status answer lift a local block', async () => {
    const api = fakeApi({
      ensureGoogleChatSubscription: vi
        .fn()
        .mockResolvedValue({ configured: true, subscription: ACTIVE, version: 5 }),
    });
    const { store, target } = await startedStore(api);
    api.ensureGoogleChatSubscription.mockRejectedValueOnce(new Error('502'));
    store.setConnected(false);
    store.setConnected(true);
    await vi.waitFor(() => expect(store.getState().pushActive).toBe(false));
    target.dispatchEvent(
      new CustomEvent('google_chat_events_status', {
        detail: { type: 'google_chat_events_status', subscription: ACTIVE, version: 3 },
      }),
    );
    expect(store.getState().pushActive).toBe(false);
  });

  it('shows the badge again when a read fails and the re-read fails too', async () => {
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
      markGoogleChatSpaceRead: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const { store } = await startedStore(api);
    api.listGoogleChatUnread.mockRejectedValue(new Error('offline'));
    const pending = store.markRead('A', null);
    expect(store.getState().unread).toEqual({});
    await pending;
    // The read never reached the server, so the server's state stands.
    expect(store.getState().unread['spaces/A']).toEqual(A);
  });

  it('keeps showing a message newer than an in-flight read covers', async () => {
    const response = deferred<any>();
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
      markGoogleChatSpaceRead: vi.fn().mockReturnValue(response.promise),
    });
    const { store, target } = await startedStore(api);
    const pending = store.markRead('A', '2026-10-08T12:00:00Z');
    expect(store.getState().unread).toEqual({});
    target.dispatchEvent(messageEvent('spaces/A', 3, 6, '2026-10-08T12:00:30Z'));
    expect(store.getState().unread['spaces/A'].count).toBe(3);
    response.resolve({ ...A, count: 1, lastMessageTime: '2026-10-08T12:00:30Z', version: 7 });
    await pending;
    expect(store.getState().unread['spaces/A'].count).toBe(1);
  });

  it('drops badges the server cleared (access lost) without a reload', async () => {
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
    });
    const { store, target } = await startedStore(api);
    expect(totalUnread(store.getState().unread)).toBe(2);
    target.dispatchEvent(unreadEvent('spaces/A', 0, 9));
    target.dispatchEvent(
      new CustomEvent('google_chat_events_status', {
        detail: { type: 'google_chat_events_status', subscription: null, version: 10 },
      }),
    );
    expect(store.getState().unread).toEqual({});
    expect(store.getState().pushActive).toBe(false);
  });
});

describe('createChatPushStore mark-read retries', () => {
  it('retries a failing read a bounded number of times, however often it is asked', async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi({
        listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
        markGoogleChatSpaceRead: vi.fn().mockRejectedValue(new Error('500')),
      });
      const { store } = await startedStore(api);
      for (let i = 0; i < 20; i++) {
        void store.markRead('A', '2026-10-08T12:00:00Z');
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(api.markGoogleChatSpaceRead).toHaveBeenCalledTimes(3);
      // The server's state stands after giving up.
      expect(store.getState().unread['spaces/A']).toEqual(A);

      // A newer boundary gets a fresh budget.
      void store.markRead('A', '2026-10-08T12:00:05Z');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.markGoogleChatSpaceRead).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(api.markGoogleChatSpaceRead).toHaveBeenCalledTimes(6);

      // A reconnect re-sends the exhausted read by itself, with a fresh budget.
      api.markGoogleChatSpaceRead.mockResolvedValue({
        spaceName: 'spaces/A',
        count: 0,
        lastMessageTime: null,
        version: 9,
      });
      store.setConnected(false);
      store.setConnected(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.markGoogleChatSpaceRead).toHaveBeenCalledTimes(7);
      expect(api.markGoogleChatSpaceRead).toHaveBeenLastCalledWith('A', '2026-10-08T12:00:05Z');
      expect(store.getState().unread).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a successful boundary once', async () => {
    const api = fakeApi({
      listGoogleChatUnread: vi.fn().mockResolvedValue({ spaces: [A], total: 2, version: 5 }),
      markGoogleChatSpaceRead: vi
        .fn()
        .mockResolvedValue({ ...A, count: 1, lastMessageTime: '2026-10-08T12:00:00Z', version: 6 }),
    });
    const { store } = await startedStore(api);
    await store.markRead('A', '2026-10-08T11:59:00Z');
    await store.markRead('A', '2026-10-08T11:59:00Z');
    expect(api.markGoogleChatSpaceRead).toHaveBeenCalledTimes(1);
  });
});

describe('createChatPushStore bootstrap is derived, not latched', () => {
  it('subscribes again after the server cleared the subscription, without a reconnect', async () => {
    const { store, api, target } = await startedStore();
    expect(store.getState().pushActive).toBe(true);
    await store.start();
    expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(1);

    // Access revoked: maintenance clears the subscription and says so.
    target.dispatchEvent(
      new CustomEvent('google_chat_events_status', {
        detail: { type: 'google_chat_events_status', subscription: null, version: 7 },
      }),
    );
    expect(store.getState().pushActive).toBe(false);

    // Access granted again; the pane calls start() when it sees it.
    api.ensureGoogleChatSubscription.mockResolvedValue({
      configured: true,
      subscription: ACTIVE,
      version: 8,
    });
    await store.start();
    expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(2);
    expect(store.getState().pushActive).toBe(true);
  });
});

describe('read boundaries', () => {
  it('only moves forward', () => {
    expect(boundaryAdvances('2026-10-08T12:00:01Z', '2026-10-08T12:00:00Z')).toBe(true);
    expect(boundaryAdvances('2026-10-08T12:00:00Z', '2026-10-08T12:00:00Z')).toBe(false);
    expect(boundaryAdvances('2026-10-08T11:00:00Z', '2026-10-08T12:00:00Z')).toBe(false);
    expect(boundaryAdvances(null, '2026-10-08T12:00:00Z')).toBe(true);
    expect(boundaryAdvances('2026-10-08T13:00:00Z', null)).toBe(false);
  });

  it('records a viewed boundary with no badge, and never sends an older one', async () => {
    const api = fakeApi({
      markGoogleChatSpaceRead: vi
        .fn()
        .mockResolvedValue({ spaceName: 'spaces/A', count: 0, lastMessageTime: null, version: 3 }),
    });
    const { store } = await startedStore(api);
    expect(store.getState().unread).toEqual({});
    await store.markRead('A', '2026-10-08T12:00:00Z');
    await store.markRead('A', '2026-10-08T11:00:00Z');
    await store.markRead('A', '2026-10-08T12:00:00Z');
    expect(api.markGoogleChatSpaceRead).toHaveBeenCalledTimes(1);
    await store.markRead('A', '2026-10-08T12:00:05Z');
    expect(api.markGoogleChatSpaceRead).toHaveBeenCalledTimes(2);
  });
});

describe('createChatPushStore connectivity and expiry', () => {
  it('picks up a suspension that happened while the socket was down', async () => {
    const { store, api } = await startedStore();
    expect(store.getState().pushActive).toBe(true);
    api.ensureGoogleChatSubscription.mockResolvedValue({
      configured: true,
      subscription: SUSPENDED,
      version: 9,
    });
    store.setConnected(false);
    store.setConnected(true);
    await vi.waitFor(() => expect(store.getState().subscription?.state).toBe('SUSPENDED'));
    expect(store.getState().pushActive).toBe(false);
  });

  it('turns push off while the socket is down, and re-syncs when it returns', async () => {
    const { store, api } = await startedStore();
    store.setConnected(false);
    expect(store.getState().pushActive).toBe(false);
    api.ensureGoogleChatSubscription.mockResolvedValue({
      configured: true,
      subscription: ACTIVE,
      version: 2,
    });
    store.setConnected(true);
    await vi.waitFor(() => expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(2));
    expect(store.getState().pushActive).toBe(true);
  });

  it('turns push off at expireTime with no event, then asks the server again', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
      const stale = { ...ACTIVE, expireTime: '2026-10-08T12:30:00Z', lastError: 'renew failed' };
      const api = fakeApi({
        ensureGoogleChatSubscription: vi
          .fn()
          .mockResolvedValue({ configured: true, subscription: stale, version: 3 }),
      });
      const { store } = await startedStore(api);
      expect(store.getState().pushActive).toBe(true);
      const notified = vi.fn();
      store.subscribe(notified);

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
      expect(store.getState().pushActive).toBe(false);
      expect(notified).toHaveBeenCalled();
      expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(2);
      // No timer for a past expiry, so a server stuck on stale state can't spin it.
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(api.ensureGoogleChatSubscription).toHaveBeenCalledTimes(2);

      store.applyEvent({
        type: 'google_chat_events_status',
        subscription: { ...ACTIVE, expireTime: '2026-10-08T17:00:00Z' },
        version: 4,
      });
      expect(store.getState().pushActive).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
