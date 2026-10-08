/**
 * Map a Gmail message or Calendar event into a personal-todo create payload.
 * `sourceMeta.deepLink` is a public web URL, never a token.
 */

import type { CalendarEventLike } from './calendarEvents.js';

/** Origin subset of todo source types. */
export type CaptureSourceType = 'email' | 'calendar' | 'chat';

/** Create-todo body: title plus provenance triple. */
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

/** `#all/<id>` opens a Gmail thread regardless of label. Null if blank. */
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

/** Title: subject, then snippet, then fallback. `sourceId` prefers message id. */
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

/** Title from summary; location becomes the note. Deep link is `htmlLink`. */
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

/** A Google Chat message as loaded by the Chat pane, narrowed to what capture needs. */
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

const MAX_CHAT_BODY = 8_000;

/** Fields a Chat capture shares between the todo and card drafts. */
export interface ChatCaptureParts {
  title: string;
  /** "From <sender> in <space>", or empty. */
  header: string;
  /** Message text, clamped to MAX_CHAT_BODY. */
  body: string;
  deepLink: string | null;
  sourceId: string | null;
  sourceMeta: Record<string, unknown>;
}

/** Title is the message's first line, else "Chat request in <space>". */
export function chatCaptureParts(input: ChatCaptureInput): ChatCaptureParts {
  const text = clean(input.text);
  const spaceLabel = clean(input.spaceLabel);
  const sender = clean(input.sender);
  const messageName = clean(input.messageName) || null;
  const deepLink = safeCaptureDeepLink(input.deepLink);

  const fallback = spaceLabel ? `Chat request in ${spaceLabel}` : 'Chat request';
  const header = [sender && `From ${sender}`, spaceLabel && `in ${spaceLabel}`]
    .filter(Boolean)
    .join(' ');
  const body = text.length > MAX_CHAT_BODY ? `${text.slice(0, MAX_CHAT_BODY - 1)}…` : text;

  const sourceMeta: Record<string, unknown> = { kind: 'google-chat' };
  if (messageName) sourceMeta.messageName = messageName;
  if (clean(input.spaceName)) sourceMeta.spaceName = clean(input.spaceName);
  if (clean(input.threadName)) sourceMeta.threadName = clean(input.threadName);
  if (sender) sourceMeta.from = sender;
  if (deepLink) sourceMeta.deepLink = deepLink;

  return {
    title: clampTitle(text.split('\n')[0], fallback),
    header,
    body,
    deepLink,
    sourceId: messageName,
    sourceMeta,
  };
}

/** Chat message → todo draft. Notes carry the sender line and the message text. */
export function buildChatTodoDraft(input: ChatCaptureInput): CaptureTodoDraft {
  const parts = chatCaptureParts(input);
  const notes = [parts.header, parts.body].filter(Boolean).join('\n\n');
  return {
    title: parts.title,
    ...(notes ? { notes } : {}),
    sourceType: 'chat',
    sourceId: parts.sourceId,
    sourceMeta: parts.sourceMeta,
  };
}

/**
 * Only `https://*.google.com` / `google.com`. `source_meta` is attacker-influenced
 * and is handed to `<a href>` / `Linking.openURL`.
 */
const SAFE_CAPTURE_DEEP_LINK = /^https:\/\/([a-z0-9-]+\.)*google\.com([/?#]|$)/i;

/** Trimmed URL if it is a safe Google https link, else null. */
export function safeCaptureDeepLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && SAFE_CAPTURE_DEEP_LINK.test(trimmed) ? trimmed : null;
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
    case 'chat':
      return 'From Google Chat';
    default:
      return null;
  }
}

/** Reopen URL, or null if missing/unsafe. */
export function todoOriginDeepLink(todo: TodoOriginLike): string | null {
  return safeCaptureDeepLink(todo.sourceMeta?.deepLink);
}
