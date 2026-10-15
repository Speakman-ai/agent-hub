/**
 * Per-user Summaries channel: one private channel per user, and a summary
 * posted there (a my_work digest) pushes to its owner.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as chat from './hub-chat-store.js';
import { getOrCreateSummaryChannel } from './hub-chat-summaries.js';
import { broadcastHubChatMessage } from './hub-chat-broadcast.js';
import { HUB_CHAT_MESSAGE_EVENT } from './hub-chat-events.js';
import { chatPushUserIdsFromStore, mapBroadcastToPush } from './push.js';
import type { BroadcastFn } from './types.js';

let org = '';
let alice = '';
let bob = '';
beforeEach(() => {
  org = `org-${randomUUID()}`;
  alice = `alice-${randomUUID()}`;
  bob = `bob-${randomUUID()}`;
});

/** Posts the way the digest runner does: a system message, then the broadcast. */
function post(userId: string, body: string, broadcast: BroadcastFn) {
  const { channel } = getOrCreateSummaryChannel(org, userId);
  const message = chat.appendMessage({ channelId: channel.id, authorKind: 'system', body });
  broadcastHubChatMessage(broadcast, HUB_CHAT_MESSAGE_EVENT, channel, message);
  return { channel, message };
}

describe('getOrCreateSummaryChannel', () => {
  it('creates one private summary channel per user, owned by that user only', () => {
    const first = getOrCreateSummaryChannel(org, alice);
    const again = getOrCreateSummaryChannel(org, alice);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.channel.id).toBe(first.channel.id);
    expect(first.channel.kind).toBe('summary');
    expect(first.channel.is_private).toBe(1);
    expect(chat.listMembers(first.channel.id).map((m) => m.user_id)).toEqual([alice]);
    expect(getOrCreateSummaryChannel(org, bob).channel.id).not.toBe(first.channel.id);
  });
});

describe('posting to the Summaries channel', () => {
  it('broadcasts to the owner only and pushes the summary to them', () => {
    const broadcast = vi.fn();
    const { channel } = post(alice, 'Busy day.', broadcast);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const data = broadcast.mock.calls[0][0];
    expect(data).toMatchObject({
      type: 'hub_chat_message',
      recipientUserIds: [alice],
      channelId: channel.id,
      channelKind: 'summary',
    });
    // Members default to notify_level=mentions; the Summaries channel still pushes.
    expect(chat.getMember(channel.id, alice)?.notify_level).toBe('mentions');
    expect(chatPushUserIdsFromStore(data)).toEqual([alice]);
    const push = mapBroadcastToPush(data);
    expect(push?.event).toBe('chat_message');
    expect(push?.payload.title).toBe('Summaries');
    expect(push?.payload.body).toContain('Busy day.');
  });

  it('does not push when the owner muted the channel', () => {
    const { channel } = getOrCreateSummaryChannel(org, alice);
    chat.updateMemberPrefs(channel.id, alice, { notifyLevel: 'none' });
    const broadcast = vi.fn();
    post(alice, 'Quiet day.', broadcast);
    expect(chatPushUserIdsFromStore(broadcast.mock.calls[0][0])).toEqual([]);
  });
});
