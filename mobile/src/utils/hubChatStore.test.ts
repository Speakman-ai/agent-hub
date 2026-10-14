import { describe, expect, it, vi } from 'vitest';
import type { HubChatChannel, HubChatMessage } from '@shared/utils/hubChat';
import { countsAboveRead, createHubChatStore, hubChatBadge } from './hubChatStore';

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
    lastSeq: 0,
    membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  };
}

function message(over: Partial<HubChatMessage> = {}): HubChatMessage {
  return {
    id: `m${over.seq ?? 1}`,
    channelId: 'c1',
    seq: 1,
    authorKind: 'user',
    authorUserId: 'u2',
    authorAgentId: null,
    body: 'hi',
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00Z',
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('hubChatStore', () => {
  it('counts a live message toward the badge with the web rail rule', async () => {
    const api = {
      channels: vi.fn().mockResolvedValue({ channels: [channel()], viewerUserId: 'u1' }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 1 }) });
    expect(store.getSnapshot().channels[0].unreadCount).toBe(1);
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
  });

  it('does not count own posts or the channel on screen', async () => {
    const api = {
      channels: vi.fn().mockResolvedValue({ channels: [channel()], viewerUserId: 'u1' }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: message({ seq: 1, authorUserId: 'u1' }),
    });
    store.setViewing('c1');
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 2 }) });
    expect(store.getSnapshot().channels[0]).toMatchObject({ lastSeq: 2, unreadCount: 0 });
  });

  it('badges only mentions in a mentions-level channel and nothing when muted', async () => {
    const mentions = channel({
      id: 'c1',
      membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'mentions', mutedUntil: null },
    });
    const muted = channel({
      id: 'c2',
      membership: {
        role: 'member',
        lastReadSeq: 0,
        notifyLevel: 'all',
        mutedUntil: '2999-01-01T00:00:00Z',
      },
    });
    const api = {
      channels: vi.fn().mockResolvedValue({ channels: [mentions, muted], viewerUserId: 'u1' }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 1 }) });
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: message({ seq: 2, refs: [{ kind: 'user', targetId: 'u1' }] }),
    });
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: message({ channelId: 'c2', seq: 1 }),
    });
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
  });

  it('clears counts on a read event and keeps them cleared against an older snapshot', async () => {
    const stale = channel({
      lastSeq: 3,
      unreadCount: 3,
      membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'all', mutedUntil: null },
    });
    const first = deferred<{ channels: HubChatChannel[]; viewerUserId: string }>();
    const api = {
      channels: vi
        .fn()
        .mockResolvedValueOnce({ channels: [stale], viewerUserId: 'u1' })
        .mockReturnValueOnce(first.promise),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    expect(hubChatBadge(store.getSnapshot())).toBe(3);
    const pending = store.refresh();
    store.handleWsEvent({ type: 'hub_chat_read', channelId: 'c1', lastReadSeq: 3 });
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
    // The snapshot was requested before the read landed.
    first.resolve({ channels: [stale], viewerUserId: 'u1' });
    await pending;
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
  });

  it('collapses refreshes requested during a fetch into one follow-up', async () => {
    const first = deferred<{ channels: HubChatChannel[] }>();
    const api = {
      channels: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue({ channels: [channel()] }),
    };
    const store = createHubChatStore(api);
    store.reset(true, 'u1');
    void store.refresh();
    void store.refresh();
    first.resolve({ channels: [] });
    await store.refresh();
    expect(api.channels).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().channels).toHaveLength(1);
  });

  it('drops a response that lands after a reset to another account', async () => {
    const first = deferred<{ channels: HubChatChannel[]; viewerUserId: string }>();
    const api = {
      channels: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue({ channels: [], viewerUserId: 'u9' }),
    };
    const store = createHubChatStore(api);
    store.reset(true, 'u1');
    store.reset(true, 'u9');
    first.resolve({ channels: [channel({ unreadCount: 5, lastSeq: 5 })], viewerUserId: 'u1' });
    await store.refresh();
    expect(store.getSnapshot()).toMatchObject({ channels: [], viewerUserId: 'u9' });
  });

  it('refetches the list for a message in a channel it has not seen', async () => {
    const api = {
      channels: vi
        .fn()
        .mockResolvedValueOnce({ channels: [], viewerUserId: 'u1' })
        .mockResolvedValue({
          channels: [channel({ kind: 'dm', lastSeq: 1, unreadCount: 1 })],
          viewerUserId: 'u1',
        }),
    };
    const notices: string[] = [];
    const store = createHubChatStore(api);
    store.setNotifier((n) => notices.push(n.channelId));
    await store.reset(true, 'u1');
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: message({ seq: 1 }),
      authorName: 'bob',
    });
    await vi.waitFor(() => expect(notices).toEqual(['c1']));
    expect(api.channels).toHaveBeenCalledTimes(2);
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
    expect(notices).toEqual(['c1']);
  });

  it('notifies for a DM but not for the channel on screen', async () => {
    const api = {
      channels: vi
        .fn()
        .mockResolvedValue({ channels: [channel({ kind: 'dm' })], viewerUserId: 'u1' }),
    };
    const notify = vi.fn();
    const store = createHubChatStore(api);
    store.setNotifier(notify);
    await store.reset(true, 'u1');
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: message({ seq: 1 }),
      authorName: 'bob',
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'bob', body: 'hi' }));
    store.setViewing('c1');
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 2 }) });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('passes live messages and edits to open views', async () => {
    const api = {
      channels: vi.fn().mockResolvedValue({ channels: [channel()], viewerUserId: 'u1' }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    const live = vi.fn();
    const off = store.subscribeLive(live);
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 1 }) });
    store.handleWsEvent({
      type: 'hub_chat_message_update',
      message: message({ seq: 1, body: 'edited', editedAt: '2026-10-13T10:01:00Z' }),
    });
    off();
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 2 }) });
    expect(live.mock.calls.map((c) => c[0].type)).toEqual([
      'hub_chat_message',
      'hub_chat_message_update',
    ]);
  });

  it('ignores events while signed out', () => {
    const api = { channels: vi.fn() };
    const store = createHubChatStore(api);
    store.handleWsEvent({ type: 'hub_chat_channel_update', channelId: 'c1' });
    expect(api.channels).not.toHaveBeenCalled();
  });

  it('markReadLocal clears the channel when read to the tail', async () => {
    const api = {
      channels: vi.fn().mockResolvedValue({
        channels: [channel({ lastSeq: 4, unreadCount: 2, mentionCount: 1 })],
        viewerUserId: 'u1',
      }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    store.markReadLocal('c1', 4);
    expect(store.getSnapshot().channels[0]).toMatchObject({ unreadCount: 0, mentionCount: 0 });
  });

  it('rolls back an optimistic read when the write fails', async () => {
    const unread = channel({ lastSeq: 4, unreadCount: 4 });
    const api = {
      channels: vi.fn().mockResolvedValue({ channels: [unread], viewerUserId: 'u1' }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    const settle = store.markReadLocal('c1', 4);
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
    settle(false);
    await vi.waitFor(() => expect(api.channels).toHaveBeenCalledTimes(2));
    await store.refresh();
    expect(store.getSnapshot().channels[0]).toMatchObject({
      unreadCount: 4,
      membership: expect.objectContaining({ lastReadSeq: 0 }),
    });
    expect(hubChatBadge(store.getSnapshot())).toBe(4);
  });

  it('keeps a read cleared over an older snapshot while the write is in flight and after it succeeds', async () => {
    const unread = channel({ lastSeq: 4, unreadCount: 4 });
    const api = {
      channels: vi.fn().mockResolvedValue({ channels: [unread], viewerUserId: 'u1' }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    const settle = store.markReadLocal('c1', 4);
    await store.refresh();
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
    settle(true);
    await store.refresh();
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
  });

  it('ignores the outcome of a read written for a previous account', async () => {
    const api = {
      channels: vi.fn().mockResolvedValue({ channels: [channel()], viewerUserId: 'u1' }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    const settle = store.markReadLocal('c1', 1);
    await store.reset(true, 'u2');
    const calls = api.channels.mock.calls.length;
    settle(false);
    expect(api.channels).toHaveBeenCalledTimes(calls);
  });

  it('resync refetches the list and tells open views to reload', async () => {
    const api = {
      channels: vi.fn().mockResolvedValue({ channels: [channel()], viewerUserId: 'u1' }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    const live = vi.fn();
    store.subscribeLive(live);
    store.resync();
    expect(live).toHaveBeenCalledWith({ type: 'resync' });
    await vi.waitFor(() => expect(api.channels).toHaveBeenCalledTimes(2));
  });

  describe('local changes racing an in-flight list fetch', () => {
    type ListRes = { channels: HubChatChannel[]; viewerUserId: string };
    async function setup(initial: HubChatChannel[]) {
      const pending: ReturnType<typeof deferred<ListRes>>[] = [];
      const api = {
        channels: vi
          .fn()
          .mockResolvedValueOnce({ channels: initial, viewerUserId: 'u1' })
          .mockImplementation(() => {
            const d = deferred<ListRes>();
            pending.push(d);
            return d.promise;
          }),
      };
      const store = createHubChatStore(api);
      await store.reset(true, 'u1');
      return { store, api, pending };
    }

    it('keeps a mute applied after the request went out, then fetches again', async () => {
      const { store, api, pending } = await setup([channel({ lastSeq: 2, unreadCount: 2 })]);
      const run = store.refresh();
      const muted = {
        role: 'member' as const,
        lastReadSeq: 0,
        notifyLevel: 'all' as const,
        mutedUntil: '2999-01-01T00:00:00Z',
      };
      store.applyMembership('c1', muted);
      expect(hubChatBadge(store.getSnapshot())).toBe(0);
      // The older list still says unmuted.
      pending[0].resolve({
        channels: [channel({ lastSeq: 2, unreadCount: 2 })],
        viewerUserId: 'u1',
      });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(store.getSnapshot().channels[0].membership?.mutedUntil).toBe(muted.mutedUntil);
      expect(hubChatBadge(store.getSnapshot())).toBe(0);
      // The follow-up fetch reflects the server after the change.
      pending[1].resolve({
        channels: [channel({ lastSeq: 2, unreadCount: 2, membership: muted })],
        viewerUserId: 'u1',
      });
      await run;
      expect(api.channels).toHaveBeenCalledTimes(3);
      expect(store.getSnapshot().channels[0].membership?.mutedUntil).toBe(muted.mutedUntil);
    });

    it('keeps a notify-level change over an older list', async () => {
      const { store, pending } = await setup([channel({ lastSeq: 3, unreadCount: 3 })]);
      void store.refresh();
      store.applyMembership('c1', {
        role: 'member',
        lastReadSeq: 0,
        notifyLevel: 'mentions',
        mutedUntil: null,
      });
      pending[0].resolve({
        channels: [channel({ lastSeq: 3, unreadCount: 3 })],
        viewerUserId: 'u1',
      });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(store.getSnapshot().channels[0].membership?.notifyLevel).toBe('mentions');
      expect(hubChatBadge(store.getSnapshot())).toBe(0);
    });

    it('keeps a channel joined after the request went out', async () => {
      const { store, pending } = await setup([]);
      void store.refresh();
      await store.requestChannel(async () => ({ channel: channel({ id: 'c9', name: 'new' }) }));
      pending[0].resolve({ channels: [], viewerUserId: 'u1' });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(store.getSnapshot().channels.map((c) => c.id)).toEqual(['c9']);
    });

    it('keeps a channel left after the request went out gone', async () => {
      const { store, pending } = await setup([channel()]);
      void store.refresh();
      store.removeChannel('c1');
      pending[0].resolve({ channels: [channel()], viewerUserId: 'u1' });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      expect(store.getSnapshot().channels).toEqual([]);
    });

    it('a list requested after the change wins again', async () => {
      const { store, pending } = await setup([channel()]);
      store.applyMembership('c1', {
        role: 'member',
        lastReadSeq: 0,
        notifyLevel: 'mentions',
        mutedUntil: null,
      });
      void store.refresh();
      // Changed elsewhere afterwards (another device): the server is right.
      pending[0].resolve({ channels: [channel()], viewerUserId: 'u1' });
      await vi.waitFor(() =>
        expect(store.getSnapshot().channels[0].membership?.notifyLevel).toBe('all'),
      );
    });
  });

  describe('notify-level and mute writes', () => {
    const member = (over: Record<string, unknown> = {}) => ({
      role: 'member' as const,
      lastReadSeq: 0,
      notifyLevel: 'all' as const,
      mutedUntil: null as string | null,
      ...over,
    });

    async function setup() {
      const api = {
        channels: vi.fn().mockResolvedValue({ channels: [channel()], viewerUserId: 'u1' }),
      };
      const store = createHubChatStore(api);
      await store.reset(true, 'u1');
      return { store, api };
    }

    it('sends writes one at a time and applies only the latest response', async () => {
      const { store } = await setup();
      const first = deferred<any>();
      const second = deferred<any>();
      const writeA = vi.fn(() => first.promise);
      const writeB = vi.fn(() => second.promise);
      const a = store.updateMembership('c1', { notifyLevel: 'mentions' }, writeA);
      const b = store.updateMembership('c1', { notifyLevel: 'none' }, writeB);
      expect(store.getSnapshot().channels[0].membership?.notifyLevel).toBe('none');
      await Promise.resolve();
      // The second write waits for the first, so the server applies them in order.
      expect(writeB).not.toHaveBeenCalled();
      first.resolve({ membership: member({ notifyLevel: 'mentions' }) });
      await a;
      expect(store.getSnapshot().channels[0].membership?.notifyLevel).toBe('none');
      second.resolve({ membership: member({ notifyLevel: 'none' }) });
      await b;
      expect(store.getSnapshot().channels[0].membership?.notifyLevel).toBe('none');
    });

    it('an earlier notify-level response does not undo a later mute', async () => {
      const { store } = await setup();
      const level = deferred<any>();
      const mute = deferred<any>();
      const a = store.updateMembership('c1', { notifyLevel: 'mentions' }, () => level.promise);
      const b = store.updateMembership(
        'c1',
        { mutedUntil: '2999-01-01T00:00:00Z' },
        () => mute.promise,
      );
      level.resolve({ membership: member({ notifyLevel: 'mentions' }) });
      await a;
      const shown = store.getSnapshot().channels[0].membership;
      expect(shown).toMatchObject({ notifyLevel: 'mentions', mutedUntil: '2999-01-01T00:00:00Z' });
      mute.resolve({
        membership: member({ notifyLevel: 'mentions', mutedUntil: '2999-01-01T00:00:00Z' }),
      });
      await b;
      expect(hubChatBadge(store.getSnapshot())).toBe(0);
    });

    it('a failed latest write refetches the server state and reports the error', async () => {
      const { store, api } = await setup();
      const calls = api.channels.mock.calls.length;
      await expect(
        store.updateMembership('c1', { notifyLevel: 'none' }, () =>
          Promise.reject(new Error('nope')),
        ),
      ).rejects.toThrow('nope');
      await vi.waitFor(() => expect(api.channels.mock.calls.length).toBe(calls + 1));
      expect(store.getSnapshot().channels[0].membership?.notifyLevel).toBe('all');
    });

    it('a failed earlier write does not block the next one', async () => {
      const { store } = await setup();
      const a = store.updateMembership('c1', { notifyLevel: 'none' }, () =>
        Promise.reject(new Error('nope')),
      );
      const b = store.updateMembership('c1', { notifyLevel: 'mentions' }, async () => ({
        membership: member({ notifyLevel: 'mentions' }),
      }));
      await a;
      await b;
      expect(store.getSnapshot().channels[0].membership?.notifyLevel).toBe('mentions');
    });
  });

  describe('channel requests across an account switch', () => {
    async function setup() {
      const api = {
        channels: vi.fn().mockResolvedValue({ channels: [], viewerUserId: 'u1' }),
      };
      const store = createHubChatStore(api);
      await store.reset(true, 'u1');
      return { store, api };
    }

    it('adds the channel a create, join or DM returns for the current account', async () => {
      const { store } = await setup();
      const got = await store.requestChannel(async () => ({ channel: channel({ id: 'c7' }) }));
      expect(got?.id).toBe('c7');
      expect(store.getSnapshot().channels.map((c) => c.id)).toEqual(['c7']);
    });

    it('drops a response that lands after the store was reset for another account', async () => {
      const { store, api } = await setup();
      const pending = deferred<{ channel: HubChatChannel }>();
      const request = store.requestChannel(() => pending.promise);
      api.channels.mockResolvedValue({ channels: [], viewerUserId: 'u2' });
      await store.reset(true, 'u2');
      const before = store.getSnapshot().account;
      pending.resolve({ channel: channel({ id: 'old', lastSeq: 9, unreadCount: 9 }) });
      expect(await request).toBeNull();
      expect(store.getSnapshot()).toMatchObject({
        channels: [],
        viewerUserId: 'u2',
        account: before,
      });
      expect(hubChatBadge(store.getSnapshot())).toBe(0);
    });

    it('swallows an error for an earlier account but reports one for the current account', async () => {
      const { store } = await setup();
      let fail!: (e: Error) => void;
      const stale = store.requestChannel(
        () => new Promise((_, reject) => (fail = reject)) as Promise<never>,
      );
      await store.reset(true, 'u2');
      fail(new Error('gone'));
      expect(await stale).toBeNull();
      await expect(store.requestChannel(() => Promise.reject(new Error('nope')))).rejects.toThrow(
        'nope',
      );
    });

    it('bumps the account on every reset', async () => {
      const { store } = await setup();
      const a = store.getSnapshot().account;
      await store.reset(true, 'u1');
      expect(store.getSnapshot().account).toBe(a + 1);
    });
  });

  describe('pending intents survive anything that replaces confirmed state', () => {
    const MUTE = '2999-01-01T00:00:00Z';
    const unread = () => channel({ lastSeq: 3, unreadCount: 3 });

    it('a refresh started after an optimistic mute does not unmute it before the write settles', async () => {
      const api = {
        channels: vi.fn().mockResolvedValue({ channels: [unread()], viewerUserId: 'u1' }),
      };
      const store = createHubChatStore(api);
      await store.reset(true, 'u1');
      const write = deferred<any>();
      const done = store.updateMembership('c1', { mutedUntil: MUTE }, () => write.promise);
      expect(hubChatBadge(store.getSnapshot())).toBe(0);
      // Started after the change; the server has not applied the write yet.
      await store.refresh();
      expect(store.getSnapshot().channels[0].membership?.mutedUntil).toBe(MUTE);
      expect(hubChatBadge(store.getSnapshot())).toBe(0);
      write.resolve({
        membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'all', mutedUntil: MUTE },
      });
      await done;
      // Confirmed now, from the write's own response.
      expect(store.getSnapshot().channels[0].membership?.mutedUntil).toBe(MUTE);
    });

    it('does not announce a message in a channel being muted while the write is pending', async () => {
      const api = {
        channels: vi
          .fn()
          .mockResolvedValue({ channels: [channel({ kind: 'dm' })], viewerUserId: 'u1' }),
      };
      const notify = vi.fn();
      const store = createHubChatStore(api);
      store.setNotifier(notify);
      await store.reset(true, 'u1');
      void store.updateMembership('c1', { mutedUntil: MUTE }, () => new Promise(() => {}));
      await store.refresh();
      store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 1 }) });
      expect(notify).not.toHaveBeenCalled();
    });

    it('a failed mute rolls back at once, without waiting for the refetch', async () => {
      const api = {
        channels: vi.fn().mockResolvedValue({ channels: [unread()], viewerUserId: 'u1' }),
      };
      const store = createHubChatStore(api);
      await store.reset(true, 'u1');
      api.channels.mockReturnValue(new Promise(() => {}));
      await expect(
        store.updateMembership('c1', { mutedUntil: MUTE }, () => Promise.reject(new Error('x'))),
      ).rejects.toThrow('x');
      expect(store.getSnapshot().channels[0].membership?.mutedUntil).toBeNull();
      expect(hubChatBadge(store.getSnapshot())).toBe(3);
    });

    it('a pending read survives a refresh started after it, and a live message', async () => {
      const api = {
        channels: vi.fn().mockResolvedValue({ channels: [unread()], viewerUserId: 'u1' }),
      };
      const store = createHubChatStore(api);
      await store.reset(true, 'u1');
      const settle = store.markReadLocal('c1', 3);
      await store.refresh();
      expect(hubChatBadge(store.getSnapshot())).toBe(0);
      store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
      // Only the new message is unread; the pending read still covers 1..3.
      expect(store.getSnapshot().channels[0]).toMatchObject({
        membership: expect.objectContaining({ lastReadSeq: 3 }),
        unreadCount: 1,
        mentionCount: 0,
      });
      expect(hubChatBadge(store.getSnapshot())).toBe(1);
      settle(true);
    });
  });

  describe('counts under a pending read as messages keep arriving', () => {
    async function setup(over: Partial<HubChatChannel> = {}) {
      const api = {
        channels: vi.fn().mockResolvedValue({
          channels: [channel({ lastSeq: 3, unreadCount: 3, mentionCount: 1, ...over })],
          viewerUserId: 'u1',
        }),
      };
      const store = createHubChatStore(api);
      await store.reset(true, 'u1');
      return { store, api };
    }

    it('leaving the channel with the read pending: the badge shows only the new message', async () => {
      const { store } = await setup();
      store.setViewing('c1');
      store.markReadLocal('c1', 3); // request stays pending
      store.setViewing(null);
      store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
      expect(store.getSnapshot().channels[0]).toMatchObject({ unreadCount: 1, mentionCount: 0 });
      expect(hubChatBadge(store.getSnapshot())).toBe(1);
    });

    it('counts a new mention above the pending read', async () => {
      const { store } = await setup();
      store.markReadLocal('c1', 3);
      store.handleWsEvent({
        type: 'hub_chat_message',
        message: message({ seq: 4, refs: [{ kind: 'user', targetId: 'u1' }] }),
      });
      store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 5 }) });
      expect(store.getSnapshot().channels[0]).toMatchObject({ unreadCount: 2, mentionCount: 1 });
    });

    it("does not count the viewer's own message above the pending read", async () => {
      const { store } = await setup();
      store.markReadLocal('c1', 3);
      store.handleWsEvent({
        type: 'hub_chat_message',
        message: message({ seq: 4, authorUserId: 'u1' }),
      });
      expect(store.getSnapshot().channels[0].unreadCount).toBe(0);
    });

    it('keeps the new message unread after a refresh while the read is still pending', async () => {
      const { store, api } = await setup();
      store.markReadLocal('c1', 3);
      store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
      // The server has not applied the read yet: it counts all four.
      api.channels.mockResolvedValue({
        channels: [channel({ lastSeq: 4, unreadCount: 4, mentionCount: 1 })],
        viewerUserId: 'u1',
      });
      await store.refresh();
      expect(store.getSnapshot().channels[0]).toMatchObject({ unreadCount: 1, mentionCount: 0 });
    });

    it('a failed read brings the covered messages back', async () => {
      const { store } = await setup();
      const settle = store.markReadLocal('c1', 3);
      store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
      settle(false);
      expect(store.getSnapshot().channels[0].unreadCount).toBe(4);
    });
  });
});

it('a confirmed membership with a newer read position recounts instead of keeping old totals', async () => {
  const api = {
    channels: vi.fn().mockResolvedValue({
      channels: [channel({ lastSeq: 3, unreadCount: 3 })],
      viewerUserId: 'u1',
    }),
  };
  const store = createHubChatStore(api);
  await store.reset(true, 'u1');
  store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
  store.applyMembership('c1', {
    role: 'member',
    lastReadSeq: 3,
    notifyLevel: 'all',
    mutedUntil: null,
  });
  expect(store.getSnapshot().channels[0].unreadCount).toBe(1);
});

describe('a confirmed partial read is committed, not just dropped', () => {
  async function setup() {
    const api = {
      channels: vi.fn().mockResolvedValue({
        channels: [channel({ lastSeq: 3, unreadCount: 3 })],
        viewerUserId: 'u1',
      }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    return { store, api };
  }

  it('success with a held refresh, then a new message: only the two new messages count', async () => {
    const { store, api } = await setup();
    const settle = store.markReadLocal('c1', 3);
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
    api.channels.mockReturnValue(new Promise(() => {})); // any refresh hangs
    settle(true);
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 5 }) });
    expect(store.getSnapshot().channels[0]).toMatchObject({
      membership: expect.objectContaining({ lastReadSeq: 3 }),
      unreadCount: 2,
    });
    expect(hubChatBadge(store.getSnapshot())).toBe(2);
  });

  it('the committed count stands when the follow-up refresh fails', async () => {
    const { store, api } = await setup();
    const settle = store.markReadLocal('c1', 3);
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
    api.channels.mockRejectedValue(new Error('offline'));
    settle(true);
    await store.refresh();
    // Republish from current state (a no-op preference change) so the check
    // reads what is committed, not a stale snapshot.
    void store.updateMembership('c1', { notifyLevel: 'all' }, () => new Promise(() => {}));
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
  });

  it('needs no refetch when every message above the read was seen', async () => {
    const { store, api } = await setup();
    const settle = store.markReadLocal('c1', 3);
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
    const calls = api.channels.mock.calls.length;
    settle(true);
    expect(api.channels.mock.calls.length).toBe(calls);
  });

  it('a read event from another device short of the tail commits too', async () => {
    const { store, api } = await setup();
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 4 }) });
    api.channels.mockReturnValue(new Promise(() => {}));
    store.handleWsEvent({ type: 'hub_chat_read', channelId: 'c1', lastReadSeq: 3 });
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 5 }) });
    expect(hubChatBadge(store.getSnapshot())).toBe(2);
  });
});

describe('message edits and deletes update channel totals', () => {
  const MENTIONS = {
    role: 'member' as const,
    lastReadSeq: 0,
    notifyLevel: 'mentions' as const,
    mutedUntil: null,
  };
  const mentionMe = [{ kind: 'user', targetId: 'u1' }];

  async function setup(over: Partial<HubChatChannel> = {}) {
    const api = {
      channels: vi.fn().mockResolvedValue({
        channels: [channel({ lastSeq: 0, unreadCount: 0, ...over })],
        viewerUserId: 'u1',
      }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    return { store, api };
  }

  it('an edit that adds a mention badges a mentions-only channel at once, then refreshes', async () => {
    const { store, api } = await setup({ membership: MENTIONS });
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 1 }) });
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
    const calls = api.channels.mock.calls.length;
    api.channels.mockReturnValue(new Promise(() => {}));
    store.handleWsEvent({
      type: 'hub_chat_message_update',
      message: message({ seq: 1, refs: mentionMe, editedAt: '2026-10-13T11:00:00Z' }),
    });
    expect(store.getSnapshot().channels[0]).toMatchObject({ unreadCount: 1, mentionCount: 1 });
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
    expect(api.channels.mock.calls.length).toBe(calls + 1);
  });

  it('an edit that removes the mention clears the mentions-only badge', async () => {
    const { store, api } = await setup({ membership: MENTIONS });
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: message({ seq: 1, refs: mentionMe }),
    });
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
    api.channels.mockReturnValue(new Promise(() => {}));
    store.handleWsEvent({
      type: 'hub_chat_message_update',
      message: message({ seq: 1, editedAt: '2026-10-13T11:00:00Z' }),
    });
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
  });

  it('deleting an unread message takes it out of the count', async () => {
    const { store, api } = await setup();
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 1 }) });
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 2 }) });
    expect(hubChatBadge(store.getSnapshot())).toBe(2);
    api.channels.mockReturnValue(new Promise(() => {}));
    store.handleWsEvent({
      type: 'hub_chat_message_update',
      message: message({ seq: 2, deletedAt: '2026-10-13T11:00:00Z' }),
    });
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
  });

  it('an edit to a message only known from a snapshot takes the server totals', async () => {
    const { store, api } = await setup({ lastSeq: 1, unreadCount: 1, membership: MENTIONS });
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
    api.channels.mockResolvedValue({
      channels: [channel({ lastSeq: 1, unreadCount: 1, mentionCount: 1, membership: MENTIONS })],
      viewerUserId: 'u1',
    });
    store.handleWsEvent({
      type: 'hub_chat_message_update',
      message: message({ seq: 1, refs: mentionMe, editedAt: '2026-10-13T11:00:00Z' }),
    });
    await vi.waitFor(() => expect(hubChatBadge(store.getSnapshot())).toBe(1));
  });

  it("an edit to the viewer's own message changes nothing", async () => {
    const { store, api } = await setup();
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: message({ seq: 1, authorUserId: 'u1' }),
    });
    api.channels.mockReturnValue(new Promise(() => {}));
    store.handleWsEvent({
      type: 'hub_chat_message_update',
      message: message({ seq: 1, authorUserId: 'u1', deletedAt: '2026-10-13T11:00:00Z' }),
    });
    expect(store.getSnapshot().channels[0].unreadCount).toBe(0);
  });
});

describe('the live ledger after events may have been missed', () => {
  const MENTIONS = {
    role: 'member' as const,
    lastReadSeq: 0,
    notifyLevel: 'mentions' as const,
    mutedUntil: null,
  };
  const mentionMe = [{ kind: 'user', targetId: 'u1' }];

  it('a missed edit, a reconnect, then a partial read: the remaining mention still badges', async () => {
    const api = {
      channels: vi.fn().mockResolvedValue({
        channels: [channel({ lastSeq: 0, unreadCount: 0, membership: MENTIONS })],
        viewerUserId: 'u1',
      }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: message({ seq: 1, refs: mentionMe }),
    });
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 2 }) });
    expect(hubChatBadge(store.getSnapshot())).toBe(1);

    // Disconnected while message 2 was edited to mention the viewer; the
    // reconnect refetches the totals.
    api.channels.mockResolvedValue({
      channels: [channel({ lastSeq: 2, unreadCount: 2, mentionCount: 2, membership: MENTIONS })],
      viewerUserId: 'u1',
    });
    store.resync();
    await vi.waitFor(() => expect(hubChatBadge(store.getSnapshot())).toBe(2));

    // Read through 1 on another device. The ledger from before the reconnect
    // would call message 2 a plain unread and drop the badge to 0.
    const calls = api.channels.mock.calls.length;
    api.channels.mockResolvedValue({
      channels: [
        channel({
          lastSeq: 2,
          unreadCount: 1,
          mentionCount: 1,
          membership: { ...MENTIONS, lastReadSeq: 1 },
        }),
      ],
      viewerUserId: 'u1',
    });
    store.handleWsEvent({ type: 'hub_chat_read', channelId: 'c1', lastReadSeq: 1 });
    // Never hidden while the server is asked: an upper bound until it answers.
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
    await vi.waitFor(() => expect(api.channels.mock.calls.length).toBeGreaterThan(calls));
    await store.refresh();
    expect(store.getSnapshot().channels[0]).toMatchObject({ unreadCount: 1, mentionCount: 1 });
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
  });

  it('messages seen live after the reconnect are exact again', async () => {
    const api = {
      channels: vi.fn().mockResolvedValue({
        channels: [channel({ lastSeq: 0, unreadCount: 0 })],
        viewerUserId: 'u1',
      }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    store.resync();
    await store.refresh();
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 1 }) });
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 2 }) });
    const calls = api.channels.mock.calls.length;
    api.channels.mockReturnValue(new Promise(() => {}));
    store.handleWsEvent({ type: 'hub_chat_read', channelId: 'c1', lastReadSeq: 1 });
    expect(store.getSnapshot().channels[0].unreadCount).toBe(1);
    // Exact from the ledger: no refetch needed.
    expect(api.channels.mock.calls.length).toBe(calls);
  });
});

describe('messages that arrive while the channel is on screen', () => {
  async function setup() {
    const api = {
      channels: vi.fn().mockResolvedValue({
        channels: [channel({ lastSeq: 2, unreadCount: 2 })],
        viewerUserId: 'u1',
      }),
    };
    const store = createHubChatStore(api);
    await store.reset(true, 'u1');
    return { store, api };
  }

  it('a failed read while viewing, then a partial read elsewhere: the viewed message still counts', async () => {
    const { store, api } = await setup();
    store.setViewing('c1');
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 3 }) });
    expect(store.getSnapshot().channels[0].unreadCount).toBe(0);
    const settle = store.markReadLocal('c1', 3);
    // The read fails; the server still counts all three.
    api.channels.mockResolvedValue({
      channels: [channel({ lastSeq: 3, unreadCount: 3 })],
      viewerUserId: 'u1',
    });
    settle(false);
    store.setViewing(null);
    await store.refresh();
    expect(hubChatBadge(store.getSnapshot())).toBe(3);
    // Another device reads through 2: message 3 is still unread.
    const calls = api.channels.mock.calls.length;
    store.handleWsEvent({ type: 'hub_chat_read', channelId: 'c1', lastReadSeq: 2 });
    expect(store.getSnapshot().channels[0].unreadCount).toBe(1);
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
    // Exact from the ledger, so no refetch was needed.
    expect(api.channels.mock.calls.length).toBe(calls);
  });

  it('shows a viewed message as read at once, before the view writes the read', async () => {
    const { store } = await setup();
    store.markReadLocal('c1', 2);
    store.setViewing('c1');
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 3 }) });
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
  });

  it('leaving before the read is written counts the viewed message again', async () => {
    const { store } = await setup();
    store.markReadLocal('c1', 2);
    store.setViewing('c1');
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 3 }) });
    store.setViewing(null);
    expect(hubChatBadge(store.getSnapshot())).toBe(1);
  });

  it('a successful read of the viewed message keeps it read after leaving', async () => {
    const { store, api } = await setup();
    store.setViewing('c1');
    store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 3 }) });
    const settle = store.markReadLocal('c1', 3);
    api.channels.mockReturnValue(new Promise(() => {}));
    settle(true);
    store.setViewing(null);
    expect(hubChatBadge(store.getSnapshot())).toBe(0);
  });
});

it('readWritten reports what the server was told, not what is on screen', async () => {
  const api = {
    channels: vi.fn().mockResolvedValue({
      channels: [
        channel({
          lastSeq: 2,
          unreadCount: 0,
          membership: { role: 'member', lastReadSeq: 2, notifyLevel: 'all', mutedUntil: null },
        }),
      ],
      viewerUserId: 'u1',
    }),
  };
  const store = createHubChatStore(api);
  await store.reset(true, 'u1');
  store.setViewing('c1');
  store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 3 }) });
  // Shown as read, but nothing was written yet.
  expect(store.getSnapshot().channels[0].membership?.lastReadSeq).toBe(3);
  expect(store.readWritten('c1')).toBe(2);
  store.markReadLocal('c1', 3);
  expect(store.readWritten('c1')).toBe(3);
});

it('a message whose read was written before its event arrived is not counted', async () => {
  const api = {
    channels: vi.fn().mockResolvedValue({
      channels: [
        channel({
          lastSeq: 50,
          unreadCount: 0,
          membership: { role: 'member', lastReadSeq: 50, notifyLevel: 'all', mutedUntil: null },
        }),
      ],
      viewerUserId: 'u1',
    }),
  };
  const store = createHubChatStore(api);
  await store.reset(true, 'u1');
  // History loaded 51 and its read settled before the socket delivered 51.
  store.setViewing('c1');
  const settle = store.markReadLocal('c1', 51);
  settle(true);
  store.setViewing(null);
  store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 51 }) });
  expect(store.getSnapshot().channels[0]).toMatchObject({
    lastSeq: 51,
    unreadCount: 0,
    membership: expect.objectContaining({ lastReadSeq: 51 }),
  });
  expect(hubChatBadge(store.getSnapshot())).toBe(0);
  expect(store.readWritten('c1')).toBe(51);
  // The next message is unread as usual.
  store.handleWsEvent({ type: 'hub_chat_message', message: message({ seq: 52 }) });
  expect(hubChatBadge(store.getSnapshot())).toBe(1);
});

it('a read event at the tail repairs totals that still count messages', async () => {
  const api = {
    channels: vi.fn().mockResolvedValue({
      channels: [
        channel({
          lastSeq: 51,
          unreadCount: 1,
          membership: { role: 'member', lastReadSeq: 51, notifyLevel: 'all', mutedUntil: null },
        }),
      ],
      viewerUserId: 'u1',
    }),
  };
  const store = createHubChatStore(api);
  await store.reset(true, 'u1');
  store.handleWsEvent({ type: 'hub_chat_read', channelId: 'c1', lastReadSeq: 51 });
  expect(store.getSnapshot().channels[0].unreadCount).toBe(0);
});

describe('countsAboveRead', () => {
  const c = { lastSeq: 6, unreadCount: 5, mentionCount: 2 };
  it('is exact when every message above the read was seen', () => {
    const seen = new Map([
      [5, 'mention' as const],
      [6, 'none' as const],
    ]);
    expect(countsAboveRead(c, 4, seen)).toEqual({ unreadCount: 1, mentionCount: 1 });
  });
  it('treats messages it never saw as unread, capped by the confirmed totals', () => {
    expect(countsAboveRead(c, 4, undefined)).toEqual({ unreadCount: 2, mentionCount: 2 });
    expect(countsAboveRead(c, 0, undefined)).toEqual({ unreadCount: 5, mentionCount: 2 });
  });
  it('is zero once the read reaches the tail', () => {
    expect(countsAboveRead(c, 6, undefined)).toEqual({ unreadCount: 0, mentionCount: 0 });
  });
});
