import { describe, it, expect } from 'vitest';
import type { HubChatChannel, HubChatMessage } from './hubChat';
import {
  combinedChatBadge,
  hubChatBadgeCount,
  hubChatNoticeFor,
  plainChatText,
} from './hubChatUnread';

const NOW = Date.parse('2026-10-13T12:00:00Z');

function channel(over: Partial<HubChatChannel> = {}, membership = {}): HubChatChannel {
  return {
    id: 'c1',
    orgId: 'o',
    kind: 'channel',
    name: 'general',
    topic: null,
    isPrivate: false,
    projectId: null,
    agentId: null,
    dmPeerUserId: null,
    createdByUserId: null,
    archivedAt: null,
    createdAt: '2026-01-01',
    lastSeq: 10,
    membership: {
      role: 'member',
      lastReadSeq: 5,
      notifyLevel: 'all',
      mutedUntil: null,
      ...membership,
    },
    unreadCount: 5,
    mentionCount: 1,
    ...over,
  };
}

function message(over: Partial<HubChatMessage> = {}): HubChatMessage {
  return {
    id: 'm1',
    channelId: 'c1',
    seq: 11,
    authorKind: 'user',
    authorUserId: 'bob',
    authorAgentId: null,
    body: 'hi',
    refs: [],
    payload: null,
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-10-13T12:00:00Z',
    ...over,
  };
}

describe('combinedChatBadge', () => {
  it('sums Agent Hub and Google Chat unread', () => {
    expect(combinedChatBadge(3, 4)).toBe(7);
    expect(combinedChatBadge(0, 0)).toBe(0);
    expect(combinedChatBadge(120, 0)).toBe(120);
  });

  it('ignores negative or non-finite inputs', () => {
    expect(combinedChatBadge(-2, 5)).toBe(5);
    expect(combinedChatBadge(Number.NaN, 1)).toBe(1);
  });
});

describe('hubChatBadgeCount', () => {
  it('sums what each rail row badges', () => {
    const channels = [
      channel({ id: 'all', unreadCount: 3 }),
      channel({ id: 'men', unreadCount: 4, mentionCount: 1 }, { notifyLevel: 'mentions' }),
      channel({ id: 'dm', kind: 'dm', unreadCount: 2 }, { notifyLevel: 'mentions' }),
      channel({ id: 'none', unreadCount: 9 }, { notifyLevel: 'none' }),
      channel({ id: 'muted', unreadCount: 9 }, { mutedUntil: '2026-10-14T00:00:00Z' }),
      channel({ id: 'arch', unreadCount: 9, archivedAt: '2026-10-01' }),
      channel({ id: 'browse', unreadCount: 9, membership: null }),
    ];
    expect(hubChatBadgeCount(channels, NOW)).toBe(3 + 1 + 2);
  });

  it('counts a channel again once its mute expires', () => {
    const c = channel({ unreadCount: 2 }, { mutedUntil: '2026-10-13T11:00:00Z' });
    expect(hubChatBadgeCount([c], NOW)).toBe(2);
  });
});

describe('hubChatNoticeFor', () => {
  const opts = { viewerUserId: 'alice', viewingChannelId: null, now: NOW };

  it('announces a DM with the author as the title', () => {
    const notice = hubChatNoticeFor(
      { authorName: 'bob', message: message({ body: 'ping' }) },
      channel({ kind: 'dm', name: '' }),
      opts,
    );
    expect(notice).toEqual({ channelId: 'c1', messageId: 'm1', title: 'bob', body: 'ping' });
  });

  it('announces a mention in a channel, with mention tokens as plain text', () => {
    const notice = hubChatNoticeFor(
      {
        authorName: 'bob',
        channelName: 'general',
        message: message({
          body: 'hey @[alice](user:alice)',
          refs: [{ kind: 'user', targetId: 'alice' }],
        }),
      },
      channel(),
      opts,
    );
    expect(notice?.title).toBe('bob · #general');
    expect(notice?.body).toBe('hey @alice');
  });

  it('stays quiet for a plain channel message, even at notify level all', () => {
    expect(hubChatNoticeFor({ message: message() }, channel(), opts)).toBeNull();
  });

  it('stays quiet for own, deleted, on-screen, muted and none messages', () => {
    const dm = channel({ kind: 'dm' });
    expect(hubChatNoticeFor({ message: message({ authorUserId: 'alice' }) }, dm, opts)).toBeNull();
    expect(hubChatNoticeFor({ message: message({ deletedAt: 'x' }) }, dm, opts)).toBeNull();
    expect(
      hubChatNoticeFor({ message: message() }, dm, { ...opts, viewingChannelId: 'c1' }),
    ).toBeNull();
    expect(
      hubChatNoticeFor(
        { message: message() },
        channel({ kind: 'dm' }, { mutedUntil: '2026-10-14T00:00:00Z' }),
        opts,
      ),
    ).toBeNull();
    expect(
      hubChatNoticeFor(
        { message: message() },
        channel({ kind: 'dm' }, { notifyLevel: 'none' }),
        opts,
      ),
    ).toBeNull();
    expect(hubChatNoticeFor({ message: message() }, undefined, opts)).toBeNull();
  });
});

describe('plainChatText', () => {
  it('trims long bodies', () => {
    const out = plainChatText('x'.repeat(200));
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });
});
