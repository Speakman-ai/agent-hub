import { describe, it, expect } from 'vitest';
import {
  applyMessageToChannels,
  applyReadToChannels,
  authorLabel,
  channelLabel,
  layoutHubChatMessages,
  mergeIntoWindow,
  reconcileChannels,
  changedGroups,
  reconcileChannel,
  reconcileMembership,
  railUnread,
  sectionChannels,
  type HubChatChannel,
  type HubChatMessage,
} from './hubChat';

function channel(over: Partial<HubChatChannel> = {}): HubChatChannel {
  return {
    id: 'c1',
    orgId: 'acme',
    kind: 'channel',
    name: 'general',
    topic: null,
    isPrivate: false,
    projectId: null,
    agentId: null,
    dmPeerUserId: null,
    createdByUserId: 'alice',
    archivedAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    lastSeq: 0,
    membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'all', mutedUntil: null },
    unreadCount: 0,
    mentionCount: 0,
    ...over,
  };
}

function msg(seq: number, over: Partial<HubChatMessage> = {}): HubChatMessage {
  return {
    id: `m${seq}`,
    channelId: 'c1',
    seq,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: `hello ${seq}`,
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    ...over,
  };
}

const names = new Map([
  ['alice', 'alice'],
  ['bob', 'bob'],
]);

describe('sectionChannels', () => {
  it('puts DMs and groups under Direct messages and sorts by label', () => {
    const s = sectionChannels(
      [
        channel({ id: 'z', name: 'zeta' }),
        channel({ id: 'a', name: 'alpha' }),
        channel({ id: 'dm', kind: 'dm', name: '', dmPeerUserId: 'bob' }),
        channel({ id: 'g', kind: 'group', name: 'crew' }),
        channel({ id: 't', kind: 'trigger', name: 'activity' }),
        channel({ id: 's', kind: 'summary', name: 'Summaries' }),
        channel({ id: 'old', name: 'old', archivedAt: '2026-01-01T00:00:00Z' }),
      ],
      names,
    );
    expect(s.channels.map((c) => c.id)).toEqual(['a', 'z']);
    expect(s.dms.map((c) => c.id)).toEqual(['dm', 'g']);
    expect(s.triggers.map((c) => c.id)).toEqual(['t']);
    expect(s.summaries.map((c) => c.id)).toEqual(['s']);
  });

  it('labels a DM by its peer', () => {
    expect(channelLabel(channel({ kind: 'dm', name: '', dmPeerUserId: 'bob' }), names)).toBe('bob');
    expect(channelLabel(channel(), names)).toBe('# general');
  });
});

describe('railUnread', () => {
  it('badges every unread message at notify level all', () => {
    expect(railUnread(channel({ unreadCount: 3 }))).toEqual({ count: 3, bold: true });
  });

  it('badges only mentions at notify level mentions, but stays bold', () => {
    const c = channel({
      unreadCount: 5,
      mentionCount: 1,
      membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'mentions', mutedUntil: null },
    });
    expect(railUnread(c)).toEqual({ count: 1, bold: true });
  });

  it('badges a DM at notify level mentions', () => {
    const c = channel({
      kind: 'dm',
      unreadCount: 2,
      membership: { role: 'member', lastReadSeq: 0, notifyLevel: 'mentions', mutedUntil: null },
    });
    expect(railUnread(c).count).toBe(2);
  });

  it('never badges a muted channel', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const c = channel({
      unreadCount: 4,
      membership: {
        role: 'member',
        lastReadSeq: 0,
        notifyLevel: 'all',
        mutedUntil: '2026-10-13T13:00:00Z',
      },
    });
    expect(railUnread(c, now)).toEqual({ count: 0, bold: false });
    expect(railUnread(c, Date.parse('2026-10-13T14:00:00Z')).count).toBe(4);
  });
});

describe('live unread updates', () => {
  it('counts a message from someone else in a channel the viewer is not looking at', () => {
    const next = applyMessageToChannels([channel()], msg(1), {
      viewerUserId: 'alice',
      viewingChannelId: null,
    });
    expect(next[0]).toMatchObject({ lastSeq: 1, unreadCount: 1, mentionCount: 0 });
  });

  it('counts a mention of the viewer', () => {
    const next = applyMessageToChannels(
      [channel()],
      msg(1, { refs: [{ kind: 'user', targetId: 'alice' }] }),
      { viewerUserId: 'alice', viewingChannelId: null },
    );
    expect(next[0].mentionCount).toBe(1);
  });

  it('skips own messages, the open channel, and replays', () => {
    const opts = { viewerUserId: 'alice', viewingChannelId: null };
    expect(
      applyMessageToChannels([channel()], msg(1, { authorUserId: 'alice' }), opts)[0].unreadCount,
    ).toBe(0);
    expect(
      applyMessageToChannels([channel()], msg(1), { ...opts, viewingChannelId: 'c1' })[0]
        .unreadCount,
    ).toBe(0);
    expect(
      applyMessageToChannels([channel({ lastSeq: 1, unreadCount: 1 })], msg(1), opts)[0]
        .unreadCount,
    ).toBe(1);
  });

  it('clears unread when the read reaches the tail and asks for a refetch otherwise', () => {
    const c = channel({ lastSeq: 4, unreadCount: 3, mentionCount: 1 });
    expect(applyReadToChannels([c], 'c1', 4)?.[0]).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
      membership: { lastReadSeq: 4 },
    });
    expect(applyReadToChannels([c], 'c1', 2)).toBeNull();
  });
});

describe('a delayed message already covered by the read position', () => {
  it('moves the tail without counting it unread', () => {
    const c = channel({
      lastSeq: 50,
      membership: { role: 'member', lastReadSeq: 51, notifyLevel: 'all', mutedUntil: null },
    });
    const [next] = applyMessageToChannels([c], msg(51), {
      viewerUserId: 'alice',
      viewingChannelId: null,
    });
    expect(next).toMatchObject({ lastSeq: 51, unreadCount: 0, mentionCount: 0 });
  });
});

describe('layoutHubChatMessages', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 13, 10, min)).toISOString();
  const now = new Date(Date.UTC(2026, 9, 13, 12, 0));

  it('groups a run from one sender within five minutes under one header', () => {
    const rows = layoutHubChatMessages(
      [
        msg(1, { createdAt: at(0) }),
        msg(2, { createdAt: at(2) }),
        msg(3, { createdAt: at(10) }),
        msg(4, { createdAt: at(11), authorUserId: 'alice' }),
      ],
      { viewerUserId: 'alice', lastReadSeq: null, now },
    );
    expect(rows.map((r) => r.showHeader)).toEqual([true, false, true, true]);
    expect(rows[3].own).toBe(true);
  });

  it('labels the first message of each day', () => {
    const rows = layoutHubChatMessages(
      [
        msg(1, { createdAt: new Date(2026, 9, 12, 12).toISOString() }),
        msg(2, { createdAt: new Date(2026, 9, 13, 9).toISOString() }),
        msg(3, { createdAt: new Date(2026, 9, 13, 9, 1).toISOString() }),
      ],
      { viewerUserId: 'alice', lastReadSeq: null, now: new Date(2026, 9, 13, 12) },
    );
    expect(rows.map((r) => r.dayLabel)).toEqual(['Yesterday', 'Today', null]);
  });

  it('puts the Unread line before the first unread message from someone else and breaks the run', () => {
    const rows = layoutHubChatMessages(
      [
        msg(1, { createdAt: at(0) }),
        msg(2, { createdAt: at(1), authorUserId: 'alice' }),
        msg(3, { createdAt: at(2) }),
        msg(4, { createdAt: at(3) }),
      ],
      { viewerUserId: 'alice', lastReadSeq: 1, now },
    );
    expect(rows.map((r) => r.unreadDivider)).toEqual([false, false, true, false]);
    expect(rows[2].showHeader).toBe(true);
  });
});

const never = () => false;

describe('reconcileChannels', () => {
  it('takes server fields for a channel touched only by a live message', () => {
    // Renamed remotely; a live message landed while the refresh was in flight.
    const current = [channel({ id: 'a', name: 'old', lastSeq: 6, unreadCount: 1 })];
    const fresh = [channel({ id: 'a', name: 'renamed', lastSeq: 5, unreadCount: 0 })];
    const r = reconcileChannels(fresh, current, never);
    expect(r.channels[0]).toMatchObject({ name: 'renamed', lastSeq: 6, unreadCount: 1 });
    expect(r.exact).toBe(false);
  });

  it('keeps a read that landed after the request', () => {
    const read = {
      role: 'member' as const,
      lastReadSeq: 5,
      notifyLevel: 'all' as const,
      mutedUntil: null,
    };
    const current = [channel({ id: 'a', lastSeq: 5, unreadCount: 0, membership: read })];
    const fresh = [channel({ id: 'a', lastSeq: 5, unreadCount: 3 })];
    const r = reconcileChannels(fresh, current, never);
    expect(r.channels[0]).toMatchObject({ unreadCount: 0, membership: { lastReadSeq: 5 } });
    expect(r.exact).toBe(true);
  });

  it('estimates from the server count when a live message also arrived, and asks again', () => {
    // Reconnect: the server recovered 5 missed messages; one more came live.
    const current = [channel({ id: 'a', lastSeq: 11, unreadCount: 1 })];
    const fresh = [channel({ id: 'a', lastSeq: 10, unreadCount: 5 })];
    const r = reconcileChannels(fresh, current, never);
    expect(r.channels[0]).toMatchObject({ lastSeq: 11, unreadCount: 5 });
    expect(r.exact).toBe(false);
  });

  it('keeps only the field groups the client changed since the request', () => {
    const mine = {
      role: 'member' as const,
      lastReadSeq: 0,
      notifyLevel: 'none' as const,
      mutedUntil: null,
    };
    const current = [
      channel({ id: 'a', name: 'mine', membership: mine }),
      channel({ id: 'joined' }),
    ];
    const fresh = [
      channel({ id: 'a', name: 'server', topic: 'server topic' }),
      channel({ id: 'b' }),
      channel({ id: 'left' }),
    ];
    const changed = new Set(['a:membership', 'joined:presence', 'left:presence']);
    const r = reconcileChannels(fresh, current, (id, g) => changed.has(`${id}:${g}`));
    expect(r.channels.map((c) => c.id).sort()).toEqual(['a', 'b', 'joined']);
    expect(r.channels[0]).toMatchObject({
      name: 'server',
      topic: 'server topic',
      membership: { notifyLevel: 'none' },
    });
  });
});

describe('reconcileChannels read progress', () => {
  it('drops an optimistic read the server never confirmed', () => {
    const shown = {
      role: 'member' as const,
      lastReadSeq: 4,
      notifyLevel: 'all' as const,
      mutedUntil: null,
    };
    const current = [channel({ id: 'a', lastSeq: 4, unreadCount: 0, membership: shown })];
    const fresh = [channel({ id: 'a', lastSeq: 4, unreadCount: 4 })];
    // Confirmed read is 0 (the write failed): the server pointer and count win.
    const r = reconcileChannels(fresh, current, never, () => 0);
    expect(r.channels[0]).toMatchObject({ unreadCount: 4, membership: { lastReadSeq: 0 } });
    expect(r.exact).toBe(true);
    // A confirmed or in-flight read still wins over the older snapshot.
    expect(reconcileChannels(fresh, current, never, () => 4).channels[0].unreadCount).toBe(0);
  });
});

describe('reconcileChannel and reconcileMembership', () => {
  const member = (lastReadSeq: number, notifyLevel: 'all' | 'none' = 'all') => ({
    role: 'member' as const,
    lastReadSeq,
    notifyLevel,
    mutedUntil: null,
  });

  it('takes a rename from a response without rolling back a newer live message', () => {
    const current = channel({
      id: 'a',
      name: 'old',
      lastSeq: 3,
      unreadCount: 1,
      membership: member(2),
    });
    const fresh = channel({
      id: 'a',
      name: 'renamed',
      lastSeq: 2,
      unreadCount: 0,
      membership: member(2),
    });
    const r = reconcileChannel(fresh, current, () => false, 2);
    expect(r.channel).toMatchObject({ name: 'renamed', lastSeq: 3, unreadCount: 1 });
    expect(r.exact).toBe(false);
  });

  it('applies membership prefs without touching counts, and never moves read back', () => {
    const current = channel({ id: 'a', lastSeq: 5, unreadCount: 2, membership: member(3) });
    const next = reconcileMembership(current, member(1, 'none'), false, 3);
    expect(next).toMatchObject({
      unreadCount: 2,
      membership: { notifyLevel: 'none', lastReadSeq: 3 },
    });
    // A prefs change made after the request keeps the client's prefs.
    expect(reconcileMembership(current, member(1, 'none'), true, 3).membership?.notifyLevel).toBe(
      'all',
    );
  });
});

describe('reconcileChannel presence', () => {
  it('drops a response for a channel removed locally after the request', () => {
    const fresh = channel({ id: 'a', name: 'renamed' });
    const changed = (g: string) => g === 'presence';
    expect(reconcileChannel(fresh, undefined, changed, 0).channel).toBeNull();
    // Without a later local removal, an absent channel is added.
    expect(reconcileChannel(fresh, undefined, () => false, 0).channel?.name).toBe('renamed');
  });
});

describe('changedGroups', () => {
  it('names the field groups that differ, ignoring the read pointer', () => {
    const a = channel({ id: 'a' });
    expect(changedGroups(a, { ...a, lastSeq: 9, unreadCount: 3 })).toEqual([]);
    expect(changedGroups(a, { ...a, name: 'renamed' })).toEqual(['meta']);
    expect(
      changedGroups(a, {
        ...a,
        membership: { ...a.membership!, lastReadSeq: 5 },
      }),
    ).toEqual([]);
    expect(
      changedGroups(a, { ...a, membership: { ...a.membership!, notifyLevel: 'none' } }),
    ).toEqual(['membership']);
    expect(changedGroups(undefined, a)).toEqual(['presence']);
    expect(changedGroups(a, undefined)).toEqual(['presence']);
  });
});

describe('mergeIntoWindow', () => {
  const empty = { messages: [], revisions: {} };
  const edited = (at: string, body: string) => msg(1, { body, editedAt: at });

  it('dedupes by id and keeps seq order', () => {
    const w = mergeIntoWindow(mergeIntoWindow(empty, [msg(1), msg(3)], true), [msg(2)], true);
    expect(w.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('keeps a deletion and the later edit over stale copies', () => {
    const deleted = msg(1, { body: '', deletedAt: '2026-10-13T10:05:00Z' });
    let w = mergeIntoWindow(empty, [deleted], true);
    w = mergeIntoWindow(w, [msg(1), edited('2026-10-13T10:09:00Z', 'x')], true);
    expect(w.messages[0].deletedAt).toBeTruthy();
    let e = mergeIntoWindow(empty, [edited('2026-10-13T10:05:00Z', 'newer')], true);
    e = mergeIntoWindow(e, [msg(1, { body: 'original' })], true);
    expect(e.messages[0].body).toBe('newer');
  });

  it('remembers an update for an unloaded message and applies it when the page lands', () => {
    let w = mergeIntoWindow(
      empty,
      [msg(1, { body: '', deletedAt: '2026-10-13T10:05:00Z' })],
      false,
    );
    expect(w.messages).toHaveLength(0);
    w = mergeIntoWindow(w, [msg(1, { body: 'secret' }), msg(2)], true);
    expect(w.messages.map((m) => m.deletedAt !== null)).toEqual([true, false]);
  });
});

describe('agent-authored messages', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 13, 10, min)).toISOString();
  const now = new Date(Date.UTC(2026, 9, 13, 12, 0));
  const agentMsg = (seq: number, agentId: string, min: number) =>
    msg(seq, {
      authorKind: 'agent',
      authorUserId: 'alice',
      authorAgentId: agentId,
      authorAgentName: agentId === 'web-dev' ? 'Web Dev' : null,
      createdAt: at(min),
    });

  it('labels by agent name, falling back to the id', () => {
    expect(authorLabel(agentMsg(1, 'web-dev', 0), names)).toBe('Web Dev');
    expect(authorLabel(agentMsg(2, 'docs', 0), names)).toBe('docs');
  });

  it("is not the owner's own message and groups by agent, not by owner", () => {
    const rows = layoutHubChatMessages(
      [agentMsg(1, 'web-dev', 0), agentMsg(2, 'web-dev', 1), agentMsg(3, 'docs', 2)],
      { viewerUserId: 'alice', lastReadSeq: null, now },
    );
    expect(rows.map((r) => r.own)).toEqual([false, false, false]);
    expect(rows.map((r) => r.showHeader)).toEqual([true, false, true]);
  });
});
