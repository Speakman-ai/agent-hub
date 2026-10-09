/**
 * Map a Gmail message or Calendar event into a kanban-card create payload.
 * Description includes a `Source: <deepLink>` line (public URL, never a token).
 */

import type { CalendarEventLike } from './calendarEvents.js';
import {
  buildCalendarTodoDraft,
  chatCaptureParts,
  type ChatCaptureInput,
  buildEmailTodoDraft,
  safeCaptureDeepLink,
  type CaptureSourceType,
  type CaptureTodoDraft,
  type GmailCaptureInput,
} from './captureTodo.js';

export type { CaptureSourceType, ChatCaptureInput, GmailCaptureInput };

/** Capture triple stamped on a card by board create. */
export interface CaptureCardSource {
  sourceType: CaptureSourceType;
  sourceId: string | null;
  sourceMeta: Record<string, unknown>;
}

/** Create-card body once the picker chooses a `columnId`. */
export interface CaptureCardDraft {
  title: string;
  description?: string;
  source: CaptureCardSource;
}

/** Note plus `Source: <deepLink>`. Undefined if both empty. */
function draftDescription(todo: CaptureTodoDraft): string | undefined {
  const parts: string[] = [];
  if (todo.notes) parts.push(todo.notes);
  const link = todo.sourceMeta.deepLink;
  if (typeof link === 'string' && link.trim()) parts.push(`Source: ${link.trim()}`);
  return parts.length ? parts.join('\n\n') : undefined;
}

/** Same provenance as the todo draft. */
function toCardDraft(todo: CaptureTodoDraft): CaptureCardDraft {
  const description = draftDescription(todo);
  return {
    title: todo.title,
    ...(description ? { description } : {}),
    source: {
      sourceType: todo.sourceType,
      sourceId: todo.sourceId,
      sourceMeta: todo.sourceMeta,
    },
  };
}

/** Email → card draft. Description includes sender note and thread reopen link. */
export function buildEmailCardDraft(input: GmailCaptureInput): CaptureCardDraft {
  return toCardDraft(buildEmailTodoDraft(input));
}

/** Calendar → card draft. Description includes location note and htmlLink. */
export function buildCalendarCardDraft(event: CalendarEventLike): CaptureCardDraft {
  return toCardDraft(buildCalendarTodoDraft(event));
}

/** Snake_case provenance on a card row. Optional for hand-built cards. */
export interface CardOriginLike {
  source_type?: string | null;
  source_meta?: Record<string, unknown> | null;
}

/** Origin label, or null for a manual card. */
export function cardOriginLabel(card: CardOriginLike): string | null {
  switch (card.source_type) {
    case 'todo':
      return 'From todo';
    case 'email':
      return 'From email';
    case 'calendar':
      return 'From calendar';
    case 'chat':
      return 'From Google Chat';
    default:
      return null;
  }
}

/** Direct captures only. Todo-promoted cards stamp `{ todoId, userId }` and have no reopen URL. */
const DIRECT_CAPTURE_SOURCE_TYPES = new Set(['email', 'calendar', 'chat']);

/**
 * Reopen URL for a directly-captured card. Gate on `source_type` first so a
 * todo/manual card never opens an injected `source_meta.deepLink`.
 */
export function cardOriginDeepLink(card: CardOriginLike): string | null {
  if (!card.source_type || !DIRECT_CAPTURE_SOURCE_TYPES.has(card.source_type)) return null;
  return safeCaptureDeepLink(card.source_meta?.deepLink);
}

/**
 * Chat message → card draft. The message name is the `sourceId`; the space
 * link goes in `sourceMeta` and the description.
 */
export function buildChatCardDraft(input: ChatCaptureInput): CaptureCardDraft {
  const parts = chatCaptureParts(input);
  const description = [parts.header, parts.body, parts.deepLink && `Source: ${parts.deepLink}`]
    .filter(Boolean)
    .join('\n\n');
  return {
    title: parts.title,
    ...(description ? { description } : {}),
    source: { sourceType: 'chat', sourceId: parts.sourceId, sourceMeta: parts.sourceMeta },
  };
}

/** Several Chat messages from one space, picked together in the pane. */
export interface ChatMultiCaptureInput {
  spaceName?: string | null;
  /** Set only when every picked message is in the same thread. */
  threadName?: string | null;
  spaceLabel?: string | null;
  deepLink?: string | null;
  /** Oldest first. */
  messages: Array<{
    messageName?: string | null;
    sender?: string | null;
    createTime?: string | null;
    text?: string | null;
  }>;
}

const MAX_MULTI_CHAT_BODY = 8_000;

/**
 * Several Chat messages → one card draft. The title comes from the first
 * message; every message goes in the description, and `sourceMeta.messageNames`
 * keeps all of them while `sourceId` stays the first for provenance lookups.
 */
export function buildChatMultiCardDraft(input: ChatMultiCaptureInput): CaptureCardDraft {
  const first = input.messages[0];
  const parts = chatCaptureParts({
    messageName: first?.messageName,
    spaceName: input.spaceName,
    threadName: input.threadName,
    spaceLabel: input.spaceLabel,
    text: first?.text,
    deepLink: input.deepLink,
  });
  const spaceLabel = (input.spaceLabel || '').trim();
  const count = input.messages.length;
  const header = `${count} message${count === 1 ? '' : 's'}${spaceLabel ? ` in ${spaceLabel}` : ''}`;
  const joined = input.messages
    .map((m) => {
      const sender = (m.sender || '').trim() || 'Someone';
      const time = (m.createTime || '').trim();
      return `${time ? `${sender} (${time})` : sender}:\n${(m.text || '').trim() || '(no text)'}`;
    })
    .join('\n\n');
  const body =
    joined.length > MAX_MULTI_CHAT_BODY ? `${joined.slice(0, MAX_MULTI_CHAT_BODY - 1)}…` : joined;
  const description = [header, body, parts.deepLink && `Source: ${parts.deepLink}`]
    .filter(Boolean)
    .join('\n\n');
  const messageNames = input.messages.map((m) => (m.messageName || '').trim()).filter(Boolean);
  const sourceMeta: Record<string, unknown> = { ...parts.sourceMeta };
  if (messageNames.length) sourceMeta.messageNames = messageNames;
  return {
    title: parts.title,
    description,
    source: { sourceType: 'chat', sourceId: parts.sourceId, sourceMeta },
  };
}
