import { describe, it, expect } from 'vitest';
import {
  avatarColor,
  avatarInitials,
  chatDayLabel,
  keepNewerReactions,
  layoutChatMessages,
  newestTopLevelTime,
} from './googleChatLayout';
import type { ChatMessage } from './googleChat';

function m(over: Partial<ChatMessage>): ChatMessage {
  return {
    name: 'spaces/A/messages/X',
    id: 'X',
    spaceName: 'spaces/A',
    threadName: null,
    threadReply: false,
    text: 'hi',
    createTime: '2026-10-08T10:00:00Z',
    lastUpdateTime: null,
    deleted: false,
    attachmentCount: 0,
    sender: { name: 'users/1', displayName: 'A B', type: 'HUMAN' },
    ...over,
  };
}

describe('googleChatLayout', () => {
  it('derives initials and a stable per-sender color', () => {
    expect(avatarInitials('Kevin Woeste')).toBe('KW');
    expect(avatarInitials('greg')).toBe('G');
    expect(avatarInitials('  ')).toBe('?');
    const kevin = { name: 'users/5', displayName: 'Kevin', type: 'HUMAN' };
    expect(avatarColor(kevin)).toBe(avatarColor({ ...kevin }));
  });

  it('labels days like Chat does', () => {
    const now = new Date(2026, 9, 9, 12);
    expect(chatDayLabel(new Date(2026, 9, 9, 1), now)).toBe('Today');
    expect(chatDayLabel(new Date(2026, 9, 8, 23), now)).toBe('Yesterday');
    expect(chatDayLabel(new Date(2025, 0, 2), now)).toContain('2025');
  });

  it('starts a new header on a sender change, a 5 minute gap, or the unread line', () => {
    const other = { name: 'users/2', displayName: 'C D', type: 'HUMAN' };
    const rows = layoutChatMessages(
      [
        m({ name: '1', createTime: '2026-10-08T10:00:00Z' }),
        m({ name: '2', createTime: '2026-10-08T10:02:00Z' }),
        m({ name: '3', createTime: '2026-10-08T10:09:00Z' }),
        m({ name: '4', createTime: '2026-10-08T10:09:30Z', sender: other }),
        m({ name: '5', createTime: '2026-10-08T10:09:40Z', sender: other }),
      ],
      { selfUserName: 'users/1', lastReadTime: '2026-10-08T10:09:35Z' },
    );
    expect(rows.map((r) => r.showHeader)).toEqual([true, false, true, true, true]);
    expect(rows.map((r) => r.own)).toEqual([true, true, true, false, false]);
    expect(rows.map((r) => r.unreadDivider)).toEqual([false, false, false, false, true]);
    expect(rows.filter((r) => r.dayLabel).length).toBe(1);
  });

  it('never puts the unread line on your own message', () => {
    const rows = layoutChatMessages([m({ createTime: '2026-10-08T11:00:00Z' })], {
      selfUserName: 'users/1',
      lastReadTime: '2026-10-08T10:00:00Z',
    });
    expect(rows[0].unreadDivider).toBe(false);
  });

  it('keeps reactions set by a toggle newer than the read', () => {
    const thumbs3 = [{ emoji: '👍', customEmojiUrl: null, count: 3 }];
    const thumbs2 = [{ emoji: '👍', customEmojiUrl: null, count: 2 }];
    const current = [m({ name: 'a', reactions: thumbs3 }), m({ name: 'b', reactions: [] })];
    const fresh = [m({ name: 'a', reactions: thumbs2 }), m({ name: 'b', reactions: thumbs2 })];
    const touched = new Map([['a', 5]]);
    // Read issued at epoch 4, before the toggle stamped 'a' at 5: 'a' keeps 3.
    const kept = keepNewerReactions(fresh, current, touched, 4);
    expect(kept.map((x) => x.reactions)).toEqual([thumbs3, thumbs2]);
    // A read issued after the toggle is authoritative.
    expect(keepNewerReactions(fresh, current, touched, 5)).toEqual(fresh);
    expect(keepNewerReactions(fresh, current, new Map(), 0)).toBe(fresh);
  });

  it('never judges a thread reply by the space read position', () => {
    // Google's space read state covers top-level messages only; this reply
    // may already be read in its thread even though it is newer.
    const other = { name: 'users/2', displayName: 'C D', type: 'HUMAN' };
    const rows = layoutChatMessages(
      [
        m({ name: 'top', createTime: '2026-10-08T10:00:00Z', sender: other }),
        m({ name: 'reply', createTime: '2026-10-08T10:05:00Z', sender: other, threadReply: true }),
      ],
      { selfUserName: 'users/1', lastReadTime: '2026-10-08T10:01:00Z' },
    );
    expect(rows.map((r) => r.unreadDivider)).toEqual([false, false]);
  });

  it('takes the newest top-level message for the space read position', () => {
    expect(
      newestTopLevelTime([
        m({ createTime: '2026-10-08T10:00:00.5Z' }),
        m({ createTime: '2026-10-08T10:09:00Z', threadReply: true }),
        m({ createTime: '2026-10-08T10:08:00Z', deleted: true }),
        m({ createTime: '2026-10-08T10:00:00.25Z' }),
      ]),
    ).toBe('2026-10-08T10:00:00.5Z');
    expect(newestTopLevelTime([m({ threadReply: true })])).toBeNull();
  });
});
