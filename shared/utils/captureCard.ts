/**
 * captureCard.ts — the pure capture mapping from a Gmail message/thread or a
 * Google Calendar event straight into a kanban-card create payload (spec
 * CAPTURE-PROVENANCE, direct path: source → ticket, no todo middle step).
 *
 * This is the ticket-side sibling of `captureTodo.ts`. It reuses the same
 * title / notes / provenance derivation, then reshapes the result into the body
 * that `POST /api/projects/:projectId/board/cards` accepts: a `title`, an
 * optional `description`, and the `source` capture triple
 * (`{ sourceType, sourceId, sourceMeta }`) the board endpoint stamps on the new
 * card so it can be traced back to (and reopened from) the Gmail message /
 * Calendar event it came from.
 *
 * The card `description` carries the human note (From <sender> / At <location>)
 * plus a `Source: <deepLink>` line so the origin is visible on the board even
 * before a card viewer renders the provenance triple directly. The deep link is
 * always a plain public web URL (mail.google.com / the event's htmlLink), never
 * a token.
 *
 * Kept free of React / network so the mapping is unit-testable in isolation and
 * shared 1:1 between the web and mobile clients.
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

/** The capture-provenance triple stamped on a card by the board create endpoint. */
export interface CaptureCardSource {
  sourceType: CaptureSourceType;
  sourceId: string | null;
  sourceMeta: Record<string, unknown>;
}

/**
 * The create-card payload a capture produces. Assignable to the
 * `POST /api/projects/:projectId/board/cards` request body (once a `columnId`
 * is chosen by the picker).
 */
export interface CaptureCardDraft {
  title: string;
  description?: string;
  source: CaptureCardSource;
}

/**
 * Build the card description from the todo draft's note and the origin deep
 * link. Returns undefined when neither is present so we never stamp an empty
 * description on the card.
 */
function draftDescription(todo: CaptureTodoDraft): string | undefined {
  const parts: string[] = [];
  if (todo.notes) parts.push(todo.notes);
  const link = todo.sourceMeta.deepLink;
  if (typeof link === 'string' && link.trim()) parts.push(`Source: ${link.trim()}`);
  return parts.length ? parts.join('\n\n') : undefined;
}

/** Reshape a shared todo draft into the card create draft (same provenance). */
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

/**
 * Map a Gmail message/thread into a card draft. Title, sourceId, and sourceMeta
 * match `buildEmailTodoDraft` exactly; the description folds in the sender note
 * and a reopen link to the thread.
 */
export function buildEmailCardDraft(input: GmailCaptureInput): CaptureCardDraft {
  return toCardDraft(buildEmailTodoDraft(input));
}

/**
 * Map a Google Calendar event into a card draft. Title, sourceId, and
 * sourceMeta match `buildCalendarTodoDraft` exactly; the description folds in
 * the location note and the event's htmlLink.
 */
export function buildCalendarCardDraft(event: CalendarEventLike): CaptureCardDraft {
  return toCardDraft(buildCalendarTodoDraft(event));
}

/**
 * A persisted card narrowed to the provenance fields a card viewer reads. The
 * board serializes provenance in snake_case (`source_type` / `source_meta`),
 * which is what a card row carries; both are optional so a hand-built card
 * without provenance is accepted.
 */
export interface CardOriginLike {
  source_type?: string | null;
  source_meta?: Record<string, unknown> | null;
}

/**
 * Short human origin label for a captured or promoted card, or null for a
 * manual card with no capture origin. `todo` means the card was promoted from a
 * personal todo (spec TODO-TO-TICKET); `email` / `calendar` are the direct
 * capture paths (spec CAPTURE-PROVENANCE).
 */
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

/** The direct capture source types that legitimately carry a reopen deep link. */
const DIRECT_CAPTURE_SOURCE_TYPES = new Set(['email', 'calendar']);

/**
 * The reopen URL stored on a directly-captured card (Gmail / Calendar), or null.
 *
 * A deep link is only ever meaningful for the direct capture paths (`email` /
 * `calendar`). Todo-promoted (and manual) cards have no reopen target — they
 * stamp `{ todoId, userId }` — so we gate on `source_type` FIRST: a
 * todo/manual card returns null even if an injected `source_meta.deepLink`
 * would otherwise pass validation. The remaining value is then run through
 * `safeCaptureDeepLink`, so an unsafe/injected payload never reaches an
 * `<a href>` / `Linking.openURL`.
 */
export function cardOriginDeepLink(card: CardOriginLike): string | null {
  if (!card.source_type || !DIRECT_CAPTURE_SOURCE_TYPES.has(card.source_type)) return null;
  return safeCaptureDeepLink(card.source_meta?.deepLink);
}
