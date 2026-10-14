import { describe, expect, it, vi } from 'vitest';
import type { HubChatChannel } from '@shared/utils/hubChat';
import { createHubChatStore } from './hubChatStore';
import { createHubChatAccountGate } from './hubChatAccountGate';

const ch = (id: string, over: Partial<HubChatChannel> = {}) =>
  ({
    id,
    orgId: 'o',
    kind: 'channel',
    name: id,
    topic: null,
    isPrivate: false,
    projectId: null,
    agentId: null,
    dmPeerUserId: null,
    createdByUserId: 'u1',
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    lastSeq: 2,
    membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 2,
    mentionCount: 0,
    ...over,
  }) as HubChatChannel;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup() {
  const api = { channels: vi.fn() };
  const store = createHubChatStore(api);
  const resetCaches = vi.fn();
  const gate = createHubChatAccountGate({
    reset: (enabled, user) => store.reset(enabled, user),
    resync: () => store.resync(),
    resetCaches,
  });
  return { api, store, gate, resetCaches };
}

const ORG_A = 'https://hub|u1|orgA';
const ORG_B = 'https://hub|u1|orgB';

describe('hubChatAccountGate', () => {
  it('org switch while disconnected: the old org is gone at once and stays gone until reconnect', async () => {
    const { api, store, gate, resetCaches } = setup();
    api.channels.mockResolvedValue({ channels: [ch('a1')], viewerUserId: 'u1' });
    gate.update({ account: ORG_A, userId: 'u1', connected: true });
    await vi.waitFor(() => expect(store.getSnapshot().channels).toHaveLength(1));
    // An org-A request is still in flight when the switch starts.
    const late = deferred<{ channel: HubChatChannel }>();
    const joining = store.requestChannel(() => late.promise);

    // The socket is already down, and reconnecting has not finished.
    gate.update({ account: ORG_A, userId: 'u1', connected: false });
    gate.invalidate(); // switch starts
    gate.update({ account: ORG_B, userId: 'u1', connected: false });

    expect(store.getSnapshot()).toMatchObject({ channels: [], loaded: false });
    expect(resetCaches).toHaveBeenCalled();
    late.resolve({ channel: ch('a2') });
    expect(await joining).toBeNull();
    // Old-org live events are ignored while invalidated.
    store.handleWsEvent({
      type: 'hub_chat_message',
      message: { channelId: 'a1', seq: 3 },
    });
    expect(store.getSnapshot().channels).toEqual([]);
    expect(api.channels).toHaveBeenCalledTimes(1);

    // Connected to org B: now it loads, for org B.
    api.channels.mockResolvedValue({ channels: [ch('b1')], viewerUserId: 'u1' });
    gate.update({ account: ORG_B, userId: 'u1', connected: true });
    await vi.waitFor(() => expect(store.getSnapshot().channels.map((c) => c.id)).toEqual(['b1']));
  });

  it('bumps the account so views holding old-org channel ids drop them immediately', () => {
    const { store, gate, api } = setup();
    api.channels.mockReturnValue(new Promise(() => {}));
    gate.update({ account: ORG_A, userId: 'u1', connected: true });
    const before = store.getSnapshot().account;
    gate.invalidate();
    expect(store.getSnapshot().account).toBeGreaterThan(before);
  });

  it('sign-out drops chat at once', async () => {
    const { store, gate, api } = setup();
    api.channels.mockResolvedValue({ channels: [ch('a1')], viewerUserId: 'u1' });
    gate.update({ account: ORG_A, userId: 'u1', connected: true });
    await vi.waitFor(() => expect(store.getSnapshot().channels).toHaveLength(1));
    gate.update({ account: null, userId: null, connected: true });
    expect(store.getSnapshot().channels).toEqual([]);
  });

  it('same account reconnecting resyncs instead of resetting', async () => {
    const { store, gate, api } = setup();
    api.channels.mockResolvedValue({ channels: [ch('a1')], viewerUserId: 'u1' });
    gate.update({ account: ORG_A, userId: 'u1', connected: true });
    await vi.waitFor(() => expect(store.getSnapshot().loaded).toBe(true));
    const account = store.getSnapshot().account;
    gate.update({ account: ORG_A, userId: 'u1', connected: false });
    gate.update({ account: ORG_A, userId: 'u1', connected: true });
    expect(store.getSnapshot().account).toBe(account);
    await vi.waitFor(() => expect(api.channels).toHaveBeenCalledTimes(2));
  });

  it('switching account while connected loads the new one straight away', async () => {
    const { store, gate, api } = setup();
    api.channels.mockResolvedValue({ channels: [ch('a1')], viewerUserId: 'u1' });
    gate.update({ account: ORG_A, userId: 'u1', connected: true });
    await vi.waitFor(() => expect(store.getSnapshot().loaded).toBe(true));
    api.channels.mockResolvedValue({ channels: [ch('b1')], viewerUserId: 'u1' });
    gate.update({ account: ORG_B, userId: 'u1', connected: true });
    await vi.waitFor(() => expect(store.getSnapshot().channels.map((c) => c.id)).toEqual(['b1']));
  });
});
