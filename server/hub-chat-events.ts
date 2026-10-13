/**
 * Live fan-out for Agent Hub chat: WebSocket event shapes and the mobile push
 * recipient rule.
 *
 * Every chat event carries `recipientUserIds`, stamped from channel membership
 * at broadcast time. `broadcast-filter.ts` delivers a chat event only to those
 * users, so membership is decided once, here, and never re-derived from a
 * project. Public-channel readers who have not joined get no live events; they
 * read over REST.
 */

import type { HubChatMemberRow, HubChatChannelKind } from './types.js';

export const HUB_CHAT_MESSAGE_EVENT = 'hub_chat_message';
export const HUB_CHAT_MESSAGE_UPDATE_EVENT = 'hub_chat_message_update';
export const HUB_CHAT_READ_EVENT = 'hub_chat_read';
export const HUB_CHAT_CHANNEL_UPDATE_EVENT = 'hub_chat_channel_update';

export const HUB_CHAT_EVENT_TYPES: ReadonlySet<string> = new Set([
  HUB_CHAT_MESSAGE_EVENT,
  HUB_CHAT_MESSAGE_UPDATE_EVENT,
  HUB_CHAT_READ_EVENT,
  HUB_CHAT_CHANNEL_UPDATE_EVENT,
]);

export type HubChatChannelUpdateReason =
  | 'created'
  | 'updated'
  | 'member_added'
  | 'member_removed'
  | 'membership';

/** Users that receive a chat event: a sorted, de-duplicated list of ids. */
export function recipientsOf(members: Pick<HubChatMemberRow, 'user_id'>[], extra: string[] = []) {
  return [...new Set([...members.map((m) => m.user_id), ...extra])].sort();
}

export function isMuted(mutedUntil: string | null, now: number): boolean {
  if (!mutedUntil) return false;
  const until = Date.parse(mutedUntil);
  return Number.isFinite(until) && until > now;
}

/** User ids mentioned in a message's refs (`kind: 'user'`). */
export function mentionedUserIds(refs: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(refs)) return out;
  for (const r of refs) {
    if (r && typeof r === 'object') {
      const ref = r as { kind?: unknown; targetId?: unknown };
      if (ref.kind === 'user' && typeof ref.targetId === 'string' && ref.targetId) {
        out.add(ref.targetId);
      }
    }
  }
  return out;
}

/**
 * Who gets a phone push for a new message. Never the author, never a muted
 * member, never `notify_level=none`. A DM or a mention notifies at `all` and
 * `mentions`; any other message notifies only at `all`.
 */
export function chatPushRecipients(args: {
  channelKind: HubChatChannelKind;
  members: Pick<HubChatMemberRow, 'user_id' | 'notify_level' | 'muted_until'>[];
  authorUserId: string | null;
  mentioned: Set<string>;
  now?: number;
}): string[] {
  const now = args.now ?? Date.now();
  const out: string[] = [];
  for (const m of args.members) {
    if (m.user_id === args.authorUserId) continue;
    if (m.notify_level === 'none' || isMuted(m.muted_until, now)) continue;
    const direct = args.channelKind === 'dm' || args.mentioned.has(m.user_id);
    if (m.notify_level === 'all' || direct) out.push(m.user_id);
  }
  return out;
}
