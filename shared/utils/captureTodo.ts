/**
 * captureTodo.ts — the pure capture mapping from a Gmail message/thread or a
 * Google Calendar event into a personal-todo create payload (spec
 * CAPTURE-PROVENANCE).
 *
 * The Gmail / Calendar panes read their data through the owner-scoped
 * `/api/google/*` proxy; this module never touches Google itself. It only shapes
 * already-loaded pane data into the `{ title, notes?, sourceType, sourceId,
 * sourceMeta }` body that `POST /api/me/todos` accepts, stamping the
 * capture-provenance triple so a captured todo can be traced back to (and reopen)
 * the Gmail message / Calendar event it came from.
 *
 * `sourceMeta.deepLink` is the reopen target the Todos pane surfaces as the
 * origin link — a plain public web URL (mail.google.com / the event's htmlLink),
 * never a token.
 *
 * Kept free of React / network so the mapping is unit-testable in isolation and
 * shared 1:1 between the web and mobile clients.
 */

import type { CalendarEventLike } from './calendarEvents.js';

/** Provenance a capture can stamp (the origin subset of the todo source types). */
export type CaptureSourceType = 'email' | 'calendar';

/**
 * The create-todo payload a capture produces. Assignable to the
 * `POST /api/me/todos` request body (title + provenance triple).
 */
export interface CaptureTodoDraft {
  title: string;
  notes?: string;
  sourceType: CaptureSourceType;
  sourceId: string | null;
  sourceMeta: Record<string, unknown>;
}

/** Max characters for a captured title before we ellipsize (snippets run long). */
const MAX_TITLE = 140;

/** Collapse whitespace, trim, ellipsize to MAX_TITLE, or fall back if empty. */
function clampTitle(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return fallback;
  return trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1)}…` : trimmed;
}

function clean(value: string | null | undefined): string {
  return (value || '').trim();
}

/**
 * Gmail web-UI permalink that opens a thread. Gmail's `#all/<id>` anchor resolves
 * a thread id regardless of which label it lives under. Returns null for a blank
 * id so callers can omit the origin link.
 */
export function gmailThreadDeepLink(threadId: string | null | undefined): string | null {
  const id = clean(threadId);
  return id ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}` : null;
}

/** A Gmail message / thread as loaded by the pane, narrowed to what capture needs. */
export interface GmailCaptureInput {
  threadId?: string | null;
  messageId?: string | null;
  subject?: string | null;
  from?: string | null;
  snippet?: string | null;
}

/**
 * Map a Gmail message/thread into a todo draft. Title prefers the subject, then
 * the snippet, then a generic fallback. `sourceId` is the message id when known
 * (more specific), else the thread id. `sourceMeta.deepLink` reopens the thread.
 */
export function buildEmailTodoDraft(input: GmailCaptureInput): CaptureTodoDraft {
  const subject = clean(input.subject);
  const snippet = clean(input.snippet);
  const from = clean(input.from);
  const threadId = clean(input.threadId) || null;
  const messageId = clean(input.messageId) || null;
  const deepLink = gmailThreadDeepLink(threadId);

  const sourceMeta: Record<string, unknown> = { kind: 'gmail' };
  if (threadId) sourceMeta.threadId = threadId;
  if (messageId) sourceMeta.messageId = messageId;
  if (subject) sourceMeta.subject = subject;
  if (from) sourceMeta.from = from;
  if (snippet) sourceMeta.snippet = snippet;
  if (deepLink) sourceMeta.deepLink = deepLink;

  return {
    title: clampTitle(subject || snippet, 'Email'),
    ...(from ? { notes: `From ${from}` } : {}),
    sourceType: 'email',
    sourceId: messageId || threadId,
    sourceMeta,
  };
}

/** The start/end of a calendar event, whichever of date / dateTime is present. */
function eventBoundary(time: CalendarEventLike['start']): string | null {
  return clean(time?.dateTime) || clean(time?.date) || null;
}

/**
 * Map a Google Calendar event into a todo draft. Title is the event summary (or
 * a generic fallback); location becomes the note. `sourceMeta.deepLink` is the
 * event's own `htmlLink`, which opens it in Google Calendar.
 */
export function buildCalendarTodoDraft(event: CalendarEventLike): CaptureTodoDraft {
  const summary = clean(event.summary);
  const location = clean(event.location);
  const eventId = clean(event.id) || null;
  const deepLink = clean(event.htmlLink) || null;
  const start = eventBoundary(event.start);
  const end = eventBoundary(event.end);

  const sourceMeta: Record<string, unknown> = { kind: 'calendar' };
  if (eventId) sourceMeta.eventId = eventId;
  if (summary) sourceMeta.summary = summary;
  if (location) sourceMeta.location = location;
  if (start) sourceMeta.start = start;
  if (end) sourceMeta.end = end;
  if (deepLink) sourceMeta.deepLink = deepLink;

  return {
    title: clampTitle(summary, 'Calendar event'),
    ...(location ? { notes: `At ${location}` } : {}),
    sourceType: 'calendar',
    sourceId: eventId,
    sourceMeta,
  };
}

/** A persisted todo, narrowed to the provenance fields the origin display reads. */
export interface TodoOriginLike {
  sourceType?: string | null;
  sourceMeta?: Record<string, unknown> | null;
}

/** Short human origin label for a captured todo, or null for manual/unknown. */
export function todoOriginLabel(todo: TodoOriginLike): string | null {
  switch (todo.sourceType) {
    case 'email':
      return 'From email';
    case 'calendar':
      return 'From calendar';
    default:
      return null;
  }
}

/** The reopen URL stored on a captured todo, or null when there isn't one. */
export function todoOriginDeepLink(todo: TodoOriginLike): string | null {
  const link = todo.sourceMeta?.deepLink;
  return typeof link === 'string' && link.trim() ? link : null;
}
