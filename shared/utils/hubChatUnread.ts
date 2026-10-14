import {
  isChannelMuted,
  mentionsUser,
  railUnread,
  type HubChatChannel,
  type HubChatMessage,
} from './hubChat';

/**
 * The Agent Hub side's badge: what each rail row badges, summed. DMs and
 * `all` channels count every unread message, `mentions` channels only
 * mentions; muted and `none` channels count nothing.
 */
export function hubChatBadgeCount(channels: HubChatChannel[], now: number = Date.now()): number {
  let total = 0;
  for (const c of channels) {
    if (c.archivedAt) continue;
    total += railUnread(c, now).count;
  }
  return total;
}

/** The Chat button badge: Agent Hub unread plus Google Chat unread. */
export function combinedChatBadge(hubUnread: number, googleUnread: number): number {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return safe(hubUnread) + safe(googleUnread);
}

/** Shape of the `hub_chat_message` WS event the server broadcasts. */
export interface HubChatMessageEvent {
  channelId?: string;
  channelKind?: string;
  channelName?: string | null;
  authorName?: string | null;
  message?: HubChatMessage;
}

export interface HubChatNotice {
  channelId: string;
  messageId: string;
  title: string;
  body: string;
}

const MAX_BODY = 120;

/** `@[label](kind:id)` tokens read as `@label` outside the app. */
export function plainChatText(body: string): string {
  const text = body
    .replace(/@\[([^\]]*)\]\([a-z]+:[^)]*\)/g, '@$1')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}

/**
 * The desktop notice for a live Agent Hub message, or null when it should
 * stay quiet. Only DMs and mentions of the viewer notify. Own posts, deleted
 * messages, the channel on screen, muted channels and notify level `none`
 * never do; mute wins over a mention.
 */
export function hubChatNoticeFor(
  event: HubChatMessageEvent,
  channel: HubChatChannel | undefined,
  opts: { viewerUserId: string | null; viewingChannelId: string | null; now?: number },
): HubChatNotice | null {
  const message = event.message;
  if (!message || !channel || !channel.membership) return null;
  if (message.deletedAt) return null;
  if (opts.viewingChannelId === channel.id) return null;
  if (
    message.authorKind === 'user' &&
    !!opts.viewerUserId &&
    message.authorUserId === opts.viewerUserId
  ) {
    return null;
  }
  if (isChannelMuted(channel, opts.now)) return null;
  if (channel.membership.notifyLevel === 'none') return null;
  // The user's own Summaries channel notifies like a DM.
  const direct = channel.kind === 'dm' || channel.kind === 'group' || channel.kind === 'summary';
  if (!direct && !mentionsUser(message, opts.viewerUserId)) return null;
  const author = event.authorName || 'Someone';
  const name = event.channelName ?? channel.name;
  let title = author;
  if (channel.kind === 'group') title = `${author} · ${name || 'Group'}`;
  else if (channel.kind === 'summary') title = name || 'Summaries';
  else if (!direct) title = `${author} · #${name || 'channel'}`;
  return {
    channelId: channel.id,
    messageId: message.id,
    title,
    body: plainChatText(message.body),
  };
}
