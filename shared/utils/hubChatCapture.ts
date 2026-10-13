/**
 * Agent Hub chat message → kanban card draft / agent session seed, plus the
 * in-app link that reopens a message. The Google Chat pane has the same
 * actions (see captureCard.ts and sessionSeed.ts); these mirror them for the
 * Hub's own chat, where the origin is identified by channel and message id.
 */

import type { CaptureCardDraft } from './captureCard.js';

/** One chat message as the pane has it, narrowed to what a capture needs. */
export interface HubChatCaptureMessage {
  id: string;
  sender?: string | null;
  createdAt?: string | null;
  /** Body with ref tokens; the seed keeps them so the agent sees the ids. */
  body?: string | null;
  /** Body with ref tokens flattened to their labels, for card text. */
  plainText?: string | null;
}

export interface HubChatCaptureInput {
  channelId: string;
  /** Human label, e.g. `# general` or a DM peer's name. */
  channelLabel?: string | null;
  /** Oldest first. */
  messages: HubChatCaptureMessage[];
  /** Absolute app URL that reopens the first message (see hubChatMessageHash). */
  link?: string | null;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TITLE = 140;
const MAX_BODY = 8_000;

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * The hash route that opens the Hub Chat pane on a channel and scrolls to a
 * message. Null when either id is not a plain id, so a stored `source_meta`
 * can never inject anything else into the URL.
 */
export function hubChatMessageHash(channelId: unknown, messageId?: unknown): string | null {
  if (typeof channelId !== 'string' || !SAFE_ID.test(channelId)) return null;
  const params = new URLSearchParams({ channel: channelId });
  if (messageId != null) {
    if (typeof messageId !== 'string' || !SAFE_ID.test(messageId)) return null;
    params.set('message', messageId);
  }
  return `#/hub/chat?${params.toString()}`;
}

function messageText(m: HubChatCaptureMessage): string {
  return clean(m.plainText) || clean(m.body);
}

function senderLine(m: HubChatCaptureMessage): string {
  const sender = clean(m.sender) || 'Someone';
  const time = clean(m.createdAt);
  return time ? `${sender} (${time})` : sender;
}

/** Message(s) → card draft whose provenance points back at the first message. */
export function buildHubChatCardDraft(input: HubChatCaptureInput): CaptureCardDraft {
  const messages = input.messages;
  const first = messages[0];
  const channelLabel = clean(input.channelLabel);
  const link = clean(input.link);
  const fallback = channelLabel ? `Chat request in ${channelLabel}` : 'Chat request';
  const firstLine = first ? messageText(first).split('\n')[0].replace(/\s+/g, ' ').trim() : '';
  const title = firstLine ? clamp(firstLine, MAX_TITLE) : fallback;

  let header: string;
  let body: string;
  if (messages.length === 1 && first) {
    header = [
      clean(first.sender) && `From ${clean(first.sender)}`,
      channelLabel && `in ${channelLabel}`,
    ]
      .filter(Boolean)
      .join(' ');
    body = clamp(messageText(first), MAX_BODY);
  } else {
    header = `${messages.length} messages${channelLabel ? ` in ${channelLabel}` : ''}`;
    body = clamp(
      messages.map((m) => `${senderLine(m)}:\n${messageText(m) || '(no text)'}`).join('\n\n'),
      MAX_BODY,
    );
  }
  const description = [header, body, link && `Source: ${link}`].filter(Boolean).join('\n\n');

  const sourceMeta: Record<string, unknown> = { kind: 'hub-chat', channelId: input.channelId };
  if (first) sourceMeta.messageId = first.id;
  if (messages.length > 1) sourceMeta.messageIds = messages.map((m) => m.id);
  if (channelLabel) sourceMeta.channelLabel = channelLabel;
  const sender = first && clean(first.sender);
  if (sender) sourceMeta.from = sender;

  return {
    title,
    ...(description ? { description } : {}),
    source: { sourceType: 'hub_chat', sourceId: first?.id ?? null, sourceMeta },
  };
}

/**
 * Message(s) → the opening user message of a new agent session. Carries the
 * channel and message ids so the agent (and anyone reading the transcript)
 * can tell exactly where the request came from.
 */
export function buildHubChatSessionSeed(input: HubChatCaptureInput): string {
  const messages = input.messages;
  const channelLabel = clean(input.channelLabel);
  const link = clean(input.link);
  const one = messages.length === 1;
  const lines: string[] = [
    one
      ? "Here's an Agent Hub chat message I'd like you to work on."
      : `Here are ${messages.length} Agent Hub chat messages I'd like you to work on.`,
    '',
  ];
  if (channelLabel) lines.push(`**Channel:** ${channelLabel}`);
  if (one && messages[0]) {
    const sender = clean(messages[0].sender);
    const time = clean(messages[0].createdAt);
    if (sender) lines.push(`**From:** ${sender}`);
    if (time) lines.push(`**Sent:** ${time}`);
  }
  if (link) lines.push(`**Link:** ${link}`);
  const ids = messages.map((m) => m.id).join(', ');
  lines.push(
    `**Chat reference:** Agent Hub chat channel ${input.channelId} (message${one ? '' : 's'} ${ids})`,
  );

  const text = one
    ? clean(messages[0]?.body) || '(no text)'
    : messages.map((m) => `**${senderLine(m)}**:\n${clean(m.body) || '(no text)'}`).join('\n\n');
  lines.push('', clamp(text, MAX_BODY));
  return lines.join('\n');
}
