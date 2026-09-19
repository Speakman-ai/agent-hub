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
