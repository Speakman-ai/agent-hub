/**
 * Mobile push for Agent Hub chat: who gets a `chat_message` push (DMs,
 * mentions, notify_level=all; never the author, muted, or `none`) and that
 * the dispatcher only targets those users' devices.
 */
import { describe, it, expect, vi } from 'vitest';
import { chatPushRecipients, mentionedUserIds } from './hub-chat-events.js';
import {
  handleBroadcastForPush,
  mapBroadcastToPush,
  type DeviceTokenRowWithPrefs,
} from './push.js';
import type { HubChatMemberRow } from './types.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');

function member(
  user_id: string,
  notify_level: HubChatMemberRow['notify_level'] = 'all',
  muted_until: string | null = null,
) {
  return { user_id, notify_level, muted_until };
}

describe('chatPushRecipients', () => {
  it('pushes a DM to the other party, not the author', () => {
    const r = chatPushRecipients({
      channelKind: 'dm',
      members: [member('a'), member('b', 'mentions')],
      authorUserId: 'a',
      mentioned: new Set(),
      now: NOW,
    });
    expect(r).toEqual(['b']);
  });

  it('pushes a channel message only at notify_level=all, a mention at mentions too', () => {
    const members = [member('a'), member('b', 'all'), member('c', 'mentions'), member('d', 'none')];
    const plain = chatPushRecipients({
      channelKind: 'channel',
      members,
      authorUserId: 'a',
      mentioned: new Set(),
      now: NOW,
    });
    expect(plain).toEqual(['b']);
    const mention = chatPushRecipients({
      channelKind: 'channel',
      members,
      authorUserId: 'a',
      mentioned: new Set(['c', 'd']),
      now: NOW,
    });
    expect(mention).toEqual(['b', 'c']);
  });

  it('never pushes a muted member, even for a DM or a mention', () => {
    const muted = '2026-10-14T00:00:00Z';
    expect(
      chatPushRecipients({
        channelKind: 'dm',
        members: [member('a'), member('b', 'all', muted)],
        authorUserId: 'a',
        mentioned: new Set(['b']),
        now: NOW,
      }),
    ).toEqual([]);
    // An expired mute no longer applies.
    expect(
      chatPushRecipients({
        channelKind: 'channel',
        members: [member('a'), member('b', 'all', '2026-10-12T00:00:00Z')],
        authorUserId: 'a',
        mentioned: new Set(),
        now: NOW,
      }),
    ).toEqual(['b']);
  });

  it('reads user mentions from message refs', () => {
    expect([
      ...mentionedUserIds([
        { kind: 'user', targetId: 'u1' },
        { kind: 'card', targetId: 'c1' },
        null,
      ]),
    ]).toEqual(['u1']);
  });
});

function token(t: string, user_id: string | null, enabled?: string[]): DeviceTokenRowWithPrefs {
  return {
    token: t,
    user_id,
    enabled_events: enabled ? JSON.stringify(enabled) : null,
  } as unknown as DeviceTokenRowWithPrefs;
}

function chatEvent(over: Record<string, unknown> = {}) {
  return {
    type: 'hub_chat_message',
    recipientUserIds: ['a', 'b', 'c'],
    channelId: 'ch1',
    channelKind: 'channel',
    channelName: 'general',
    authorName: 'alice',
    message: { id: 'm1', authorUserId: 'a', body: 'hey @[bob](user:b)', refs: [] },
    ...over,
  };
}

describe('hub_chat_message push dispatch', () => {
  it('formats the push and sends only to the resolved users', async () => {
    const fetchFn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const sent = JSON.parse(String(init?.body)) as unknown[];
      return new Response(JSON.stringify({ data: sent.map(() => ({ status: 'ok' })) }));
    });
    const n = await handleBroadcastForPush(chatEvent(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      getAllTokens: () => [
        token('tok-a', 'a'),
        token('tok-b', 'b'),
        token('tok-c', 'c'),
        token('tok-legacy', null),
        token('tok-b2', 'b', ['awaiting_feedback']),
      ],
      getChatPushUserIds: () => ['b'],
      log: () => {},
    });
    expect(n).toBe(1);
    const sent = JSON.parse(String(fetchFn.mock.calls[0][1]?.body)) as Array<{
      to: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
    }>;
    expect(sent.map((m) => m.to)).toEqual(['tok-b']);
    expect(sent[0].title).toBe('#general');
    expect(sent[0].body).toBe('alice: hey @bob');
    expect(sent[0].data).toMatchObject({ type: 'chat_message', channelId: 'ch1', messageId: 'm1' });
  });

  it('sends nothing when no member qualifies (muted channel)', async () => {
    const fetchFn = vi.fn();
    const n = await handleBroadcastForPush(chatEvent(), {
      fetchFn: fetchFn as unknown as typeof fetch,
      getAllTokens: () => [token('tok-b', 'b')],
      getChatPushUserIds: () => [],
    });
    expect(n).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('titles a DM push with the author and skips edits', () => {
    const dm = mapBroadcastToPush(chatEvent({ channelKind: 'dm' }));
    expect(dm?.event).toBe('chat_message');
    expect(dm?.payload.title).toBe('alice');
    expect(mapBroadcastToPush({ ...chatEvent(), type: 'hub_chat_message_update' })).toBeNull();
  });
});
