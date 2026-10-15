/**
 * Keeps the bell inbox in step with Hub Chat read state. DM and mention rows
 * use the source key `hub_chat:<messageId>` (see notification-fanout.ts), so
 * moving a member's read pointer marks every such row for a message in that
 * channel at or before the pointer read.
 */
import { messageIdsReadThrough } from './hub-chat-store.js';
import {
  countUnreadNotifications,
  listUnreadBySourcePrefix,
  markNotificationsReadByIds,
} from './notifications-store.js';
import type { BroadcastFn } from './types.js';

export const HUB_CHAT_SOURCE_PREFIX = 'hub_chat:';

/** Returns the inbox ids that flipped to read, and broadcasts them to the user. */
export function syncChatReadToInbox(
  userId: string,
  channelId: string,
  lastReadSeq: number,
  broadcast?: BroadcastFn,
  now: Date = new Date(),
): string[] {
  const unread = listUnreadBySourcePrefix(userId, HUB_CHAT_SOURCE_PREFIX);
  if (!unread.length) return [];
  const byMessage = new Map(
    unread.map((r) => [r.sourceKey.slice(HUB_CHAT_SOURCE_PREFIX.length), r.id]),
  );
  const read = messageIdsReadThrough(channelId, lastReadSeq, [...byMessage.keys()]);
  const ids = markNotificationsReadByIds(
    userId,
    [...read].map((m) => byMessage.get(m)!),
    now,
  );
  if (ids.length && broadcast) {
    broadcast({
      type: 'notification_read',
      ownerUserId: userId,
      ids,
      readAt: now.toISOString(),
      unreadCount: countUnreadNotifications(userId),
    });
  }
  return ids;
}
