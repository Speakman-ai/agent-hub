/**
 * Google OAuth scope constants + per-surface grant predicates.
 *
 * Single source of truth shared by the `/api/google/*` proxy routes and the
 * host-mediated `google` ReAct read action (`google-react.ts`). Keeping the
 * scope strings and the "does this grant cover surface X" logic in one place
 * means the proxy's incremental-consent gating and the ReAct path can never
 * drift — a connected-but-missing-scope user is treated identically (a
 * recoverable "enable <surface>" observation), not a host error, in both paths.
 *
 * v1 requests only non-sensitive + sensitive scopes (no restricted scopes →
 * no annual CASA). The legacy full scopes are accepted where present (an
 * upgraded connection) but never requested.
 */

// Calendar (sensitive)
export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_FULL_SCOPE = 'https://www.googleapis.com/auth/calendar';

// Gmail (sensitive Tier 2: readonly is narrowest read; modify/full also read)
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_FULL_SCOPE = 'https://mail.google.com/';

// Sheets (sensitive)
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// Read gates (the only ones the ReAct read action needs)

export function hasCalendarReadScope(scopes: string[]): boolean {
  return scopes.includes(CALENDAR_EVENTS_SCOPE) || scopes.includes(CALENDAR_FULL_SCOPE);
}

export function hasGmailReadScope(scopes: string[]): boolean {
  // readonly is the narrowest read scope; modify/full also grant reading.
  return (
    scopes.includes(GMAIL_READONLY_SCOPE) ||
    scopes.includes(GMAIL_MODIFY_SCOPE) ||
    scopes.includes(GMAIL_FULL_SCOPE)
  );
}

export function hasSheetsReadScope(scopes: string[]): boolean {
  // The full `spreadsheets` scope and the narrower readonly scope both read.
  return scopes.includes(SHEETS_SCOPE) || scopes.includes(SHEETS_READONLY_SCOPE);
}

// Write gates (used by the proxy mutation routes)

export function hasGmailModifyScope(scopes: string[]): boolean {
  // Mutating labels needs modify (or the legacy full scope); readonly can't.
  return scopes.includes(GMAIL_MODIFY_SCOPE) || scopes.includes(GMAIL_FULL_SCOPE);
}

export function hasGmailSendScope(scopes: string[]): boolean {
  return (
    scopes.includes(GMAIL_SEND_SCOPE) ||
    scopes.includes(GMAIL_MODIFY_SCOPE) ||
    scopes.includes(GMAIL_FULL_SCOPE)
  );
}

export function hasSheetsWriteScope(scopes: string[]): boolean {
  // Only the full `spreadsheets` scope can mutate; readonly cannot.
  return scopes.includes(SHEETS_SCOPE);
}

// Google Chat. Listing spaces needs `chat.spaces.readonly` (sensitive); reading
// messages needs `chat.messages.readonly` (restricted, same tier as every Gmail
// read scope); posting needs `chat.messages.create` (sensitive). The broader
// `chat.spaces` / `chat.messages` scopes also satisfy these gates for accounts
// that granted them, but the surface never requests them.
export const CHAT_SPACES_READONLY_SCOPE = 'https://www.googleapis.com/auth/chat.spaces.readonly';
export const CHAT_SPACES_SCOPE = 'https://www.googleapis.com/auth/chat.spaces';
export const CHAT_MESSAGES_READONLY_SCOPE =
  'https://www.googleapis.com/auth/chat.messages.readonly';
export const CHAT_MESSAGES_CREATE_SCOPE = 'https://www.googleapis.com/auth/chat.messages.create';
export const CHAT_MESSAGES_SCOPE = 'https://www.googleapis.com/auth/chat.messages';
// Optional: participant names for DMs and group chats, which have no display name.
export const CHAT_MEMBERSHIPS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/chat.memberships.readonly';
export const CHAT_MEMBERSHIPS_SCOPE = 'https://www.googleapis.com/auth/chat.memberships';

export function hasChatMembershipsReadScope(scopes: string[]): boolean {
  return (
    scopes.includes(CHAT_MEMBERSHIPS_READONLY_SCOPE) || scopes.includes(CHAT_MEMBERSHIPS_SCOPE)
  );
}

export function hasChatSpacesReadScope(scopes: string[]): boolean {
  return scopes.includes(CHAT_SPACES_READONLY_SCOPE) || scopes.includes(CHAT_SPACES_SCOPE);
}

export function hasChatMessagesReadScope(scopes: string[]): boolean {
  return scopes.includes(CHAT_MESSAGES_READONLY_SCOPE) || scopes.includes(CHAT_MESSAGES_SCOPE);
}

export function hasChatMessagesCreateScope(scopes: string[]): boolean {
  return scopes.includes(CHAT_MESSAGES_CREATE_SCOPE) || scopes.includes(CHAT_MESSAGES_SCOPE);
}

// Optional: add and remove the caller's own emoji reactions. The broader
// `chat.messages` scope also covers reactions.
export const CHAT_REACTIONS_SCOPE = 'https://www.googleapis.com/auth/chat.messages.reactions';

export function hasChatReactionsScope(scopes: string[]): boolean {
  return scopes.includes(CHAT_REACTIONS_SCOPE) || scopes.includes(CHAT_MESSAGES_SCOPE);
}

// Optional: the caller's own read position in a space. Google exposes no read
// receipts for other members, only "where I last read up to".
export const CHAT_READSTATE_SCOPE = 'https://www.googleapis.com/auth/chat.users.readstate';
export const CHAT_READSTATE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/chat.users.readstate.readonly';

export function hasChatReadStateReadScope(scopes: string[]): boolean {
  return scopes.includes(CHAT_READSTATE_SCOPE) || scopes.includes(CHAT_READSTATE_READONLY_SCOPE);
}

export function hasChatReadStateWriteScope(scopes: string[]): boolean {
  return scopes.includes(CHAT_READSTATE_SCOPE);
}
