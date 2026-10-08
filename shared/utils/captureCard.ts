/**
 * Map a Gmail message or Calendar event into a kanban-card create payload.
 * Description includes a `Source: <deepLink>` line (public URL, never a token).
 */

import type { CalendarEventLike } from './calendarEvents.js';
import {
  buildCalendarTodoDraft,
  buildEmailTodoDraft,
  safeCaptureDeepLink,
  type CaptureSourceType,
  type CaptureTodoDraft,
  type GmailCaptureInput,
} from './captureTodo.js';

export type { CaptureSourceType, GmailCaptureInput };

/** Capture triple stamped on a card by board create. */
export interface CaptureCardSource {
  // `manual` carries sources with no dedicated provenance type yet (Google Chat).
  sourceType: CaptureSourceType | 'manual';
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
    default:
      return null;
  }
}

/** Email/calendar only. Todo-promoted cards stamp `{ todoId, userId }` and have no reopen URL. */
const DIRECT_CAPTURE_SOURCE_TYPES = new Set(['email', 'calendar']);

/**
 * Reopen URL for a directly-captured card. Gate on `source_type` first so a
 * todo/manual card never opens an injected `source_meta.deepLink`.
 */
export function cardOriginDeepLink(card: CardOriginLike): string | null {
  if (!card.source_type || !DIRECT_CAPTURE_SOURCE_TYPES.has(card.source_type)) return null;
  return safeCaptureDeepLink(card.source_meta?.deepLink);
}

/** A Google Chat message as loaded by the Chat pane, narrowed to what a card needs. */
export interface ChatCaptureInput {
  /** Message resource name, e.g. `spaces/AAA/messages/BBB`. */
  messageName?: string | null;
  spaceName?: string | null;
  threadName?: string | null;
  spaceLabel?: string | null;
  sender?: string | null;
  text?: string | null;
  /** Reopen URL for the space; must be a google.com URL or it is dropped. */
  deepLink?: string | null;
}

const MAX_CHAT_CARD_TITLE = 140;
const MAX_CHAT_CARD_BODY = 8_000;

/**
 * Chat message → card draft. Chat has no card source type of its own yet, so
 * the card is stamped `manual` with the message name as `sourceId` and the
 * space link in `sourceMeta` and the description.
 */
export function buildChatCardDraft(input: ChatCaptureInput): CaptureCardDraft {
  const text = (input.text || '').trim();
  const firstLine = text.split('\n')[0].trim().replace(/\s+/g, ' ');
  const spaceLabel = (input.spaceLabel || '').trim();
  const sender = (input.sender || '').trim();
  const messageName = (input.messageName || '').trim() || null;
  const deepLink = safeCaptureDeepLink(input.deepLink);

  const fallback = spaceLabel ? `Chat request in ${spaceLabel}` : 'Chat request';
  const title =
    firstLine.length > MAX_CHAT_CARD_TITLE
      ? `${firstLine.slice(0, MAX_CHAT_CARD_TITLE - 1)}…`
      : firstLine || fallback;

  const header = [sender && `From ${sender}`, spaceLabel && `in ${spaceLabel}`]
    .filter(Boolean)
    .join(' ');
  const body =
    text.length > MAX_CHAT_CARD_BODY ? `${text.slice(0, MAX_CHAT_CARD_BODY - 1)}…` : text;
  const parts = [header, body, deepLink && `Source: ${deepLink}`].filter(Boolean) as string[];

  const sourceMeta: Record<string, unknown> = { kind: 'google-chat' };
  if (messageName) sourceMeta.messageName = messageName;
  if (input.spaceName) sourceMeta.spaceName = input.spaceName;
  if (input.threadName) sourceMeta.threadName = input.threadName;
  if (sender) sourceMeta.from = sender;
  if (deepLink) sourceMeta.deepLink = deepLink;

  return {
    title,
    ...(parts.length ? { description: parts.join('\n\n') } : {}),
    source: { sourceType: 'manual', sourceId: messageName, sourceMeta },
  };
}
