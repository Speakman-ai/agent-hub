/**
 * Shared predicates for Google Workspace surfaces in the web client.
 *
 * The connection is per-USER and lives in Settings -> Account. Surface
 * navigation and panes are connection-gated: they appear only when
 * `/api/auth/google/status` reports `connected === true`. Once connected, a
 * surface may still need incremental consent for its specific scope, which is
 * what `hasGoogleScope` checks (the surface then shows an inline "Enable …"
 * affordance rather than being hidden from navigation).
 */

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_FULL_SCOPE = 'https://www.googleapis.com/auth/calendar';

// Gmail scopes. This surface only LISTS/READS threads and SENDS mail, so it
// requests the narrowest scopes for that behavior: `gmail.readonly` (read) +
// `gmail.send` (send). It deliberately does NOT request `gmail.modify`, which
// would also grant mailbox-mutation (compose/label/move) power the UI never
// uses. Per Google's scope table every Gmail *read* scope is restricted, so
// `gmail.readonly` is simply the least-privilege read scope — not a way to
// avoid restricted-scope verification (no such non-restricted read scope
// exists). `gmail.modify` / the legacy full scope still satisfy the read/send
// predicates below for accounts that granted them previously.
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_FULL_SCOPE = 'https://mail.google.com/';

// The single incremental-consent request for the Gmail surface asks for the
// narrowest read + send scopes so the inbox and compose work after one
// round-trip without over-granting mailbox-mutation power.
export const GMAIL_SURFACE_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE];

// Sheets scopes. The viewer reads and writes spreadsheet values, so it requests
// the full `spreadsheets` scope (sensitive, not restricted). `spreadsheets.readonly`
// still satisfies the read predicate for accounts that granted it previously, but
// editing requires the full scope.
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// Drive scope. The picker lists spreadsheets the user has created or opened with
// the Hub via the NON-restricted `drive.file` scope only — never `drive.readonly`
// or full `drive` (restricted, triggers annual CASA). Mirrors the server gate.
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Agent/API Sheets writes need the full spreadsheets scope. Drive/Docs saves
// need only the NON-restricted drive.file scope. v1 never requests
// drive.readonly or full drive (restricted, triggers annual CASA).
export const SHEETS_SURFACE_SCOPES = [SHEETS_SCOPE];
export const DRIVE_SURFACE_SCOPES = [DRIVE_FILE_SCOPE];

export type GoogleStatusLike = {
  connected?: boolean;
  email?: string | null;
  grantedScopes?: string[];
  serverConfigured?: boolean;
} | null;

/** True only when the calling user has linked a Google account. */
export function isGoogleConnected(status: GoogleStatusLike): boolean {
  return !!status?.connected;
}

/** True when the linked Google account has granted a specific scope. */
export function hasGoogleScope(status: GoogleStatusLike, scope: string): boolean {
  const scopes = status?.grantedScopes || [];
  return scopes.includes(scope);
}

/** True when the user can read/write the primary Google Calendar. */
export function hasCalendarScope(status: GoogleStatusLike): boolean {
  return (
    hasGoogleScope(status, CALENDAR_EVENTS_SCOPE) || hasGoogleScope(status, CALENDAR_FULL_SCOPE)
  );
}

/**
 * Whether to render the global Calendar entry in navigation. Gated purely on
 * connection (NOT scope): a connected-but-unconsented user still sees the nav
 * item, and the Calendar pane shows the inline "Enable Calendar" affordance.
 */
export function shouldShowCalendarNav(status: GoogleStatusLike): boolean {
  return isGoogleConnected(status);
}

/** True when the linked Google account can read/list Gmail (readonly/modify/full). */
export function hasGmailReadScope(status: GoogleStatusLike): boolean {
  return (
    hasGoogleScope(status, GMAIL_READONLY_SCOPE) ||
    hasGoogleScope(status, GMAIL_MODIFY_SCOPE) ||
    hasGoogleScope(status, GMAIL_FULL_SCOPE)
  );
}

/** True when the linked Google account can send mail (send, modify, or full). */
export function hasGmailSendScope(status: GoogleStatusLike): boolean {
  return (
    hasGoogleScope(status, GMAIL_SEND_SCOPE) ||
    hasGoogleScope(status, GMAIL_MODIFY_SCOPE) ||
    hasGoogleScope(status, GMAIL_FULL_SCOPE)
  );
}

/**
 * Whether to render the global Gmail entry in navigation. Gated purely on
 * connection (NOT scope), mirroring Calendar: a connected-but-unconsented user
 * still sees the nav item, and the Gmail pane shows the inline "Enable Gmail"
 * affordance for incremental consent.
 */
export function shouldShowGmailNav(status: GoogleStatusLike): boolean {
  return isGoogleConnected(status);
}

/** True when the linked Google account can read spreadsheet values (readonly or full). */
export function hasSheetsScope(status: GoogleStatusLike): boolean {
  return hasGoogleScope(status, SHEETS_SCOPE) || hasGoogleScope(status, SHEETS_READONLY_SCOPE);
}

/** True when the linked Google account can WRITE spreadsheet values (full scope only). */
export function hasSheetsWriteScope(status: GoogleStatusLike): boolean {
  return hasGoogleScope(status, SHEETS_SCOPE);
}

/** True when the linked account can create/list app-accessible Drive or Docs files. */
export function hasDriveFileScope(status: GoogleStatusLike): boolean {
  return hasGoogleScope(status, DRIVE_FILE_SCOPE);
}

// Google Chat scopes. The pane lists spaces (`chat.spaces.readonly`, sensitive),
// reads messages (`chat.messages.readonly`, restricted like every Gmail read
// scope), and posts replies (`chat.messages.create`, sensitive). The broader
// `chat.spaces` / `chat.messages` scopes satisfy the predicates for accounts
// that granted them elsewhere. Mirrors the server gates in google-scopes.ts.
export const CHAT_SPACES_READONLY_SCOPE = 'https://www.googleapis.com/auth/chat.spaces.readonly';
export const CHAT_SPACES_SCOPE = 'https://www.googleapis.com/auth/chat.spaces';
export const CHAT_MESSAGES_READONLY_SCOPE =
  'https://www.googleapis.com/auth/chat.messages.readonly';
export const CHAT_MESSAGES_CREATE_SCOPE = 'https://www.googleapis.com/auth/chat.messages.create';
export const CHAT_MESSAGES_SCOPE = 'https://www.googleapis.com/auth/chat.messages';

// Optional: who is in a DM or group chat, which have no display name.
export const CHAT_MEMBERSHIPS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/chat.memberships.readonly';
export const CHAT_MEMBERSHIPS_SCOPE = 'https://www.googleapis.com/auth/chat.memberships';

// Optional: add and remove your own emoji reactions.
export const CHAT_REACTIONS_SCOPE = 'https://www.googleapis.com/auth/chat.messages.reactions';
// Optional: your read position, so the pane shows unread messages and marks
// conversations read in Google Chat too.
export const CHAT_READSTATE_SCOPE = 'https://www.googleapis.com/auth/chat.users.readstate';
export const CHAT_READSTATE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/chat.users.readstate.readonly';

export const CHAT_SURFACE_SCOPES = [
  CHAT_SPACES_READONLY_SCOPE,
  CHAT_MESSAGES_READONLY_SCOPE,
  CHAT_MESSAGES_CREATE_SCOPE,
  CHAT_MEMBERSHIPS_READONLY_SCOPE,
  CHAT_REACTIONS_SCOPE,
  CHAT_READSTATE_SCOPE,
];

/** True when the account can list spaces AND read their messages. */
export function hasChatReadScope(status: GoogleStatusLike): boolean {
  const spaces =
    hasGoogleScope(status, CHAT_SPACES_READONLY_SCOPE) || hasGoogleScope(status, CHAT_SPACES_SCOPE);
  const messages =
    hasGoogleScope(status, CHAT_MESSAGES_READONLY_SCOPE) ||
    hasGoogleScope(status, CHAT_MESSAGES_SCOPE);
  return spaces && messages;
}

export type ChatConsent = {
  canRead: boolean;
  canSend: boolean;
  /** Scopes to request to unlock reading (empty when reading already works). */
  missingRead: string[];
  /** Scopes to request to unlock sending (empty when sending already works). */
  missingSend: string[];
  /** Scopes to request to name DMs and group chats by participant. */
  missingNames: string[];
  canReact: boolean;
  /** Can read the caller's read position (for the Unread line). */
  canReadState: boolean;
  /** Can mark conversations read in Google Chat. */
  canWriteReadState: boolean;
  /** Scopes to request for reactions and read status. */
  missingExtras: string[];
  /** Can edit your own messages (Google only accepts the full `chat.messages` scope). */
  canEdit: boolean;
  /** Scopes to request to unlock editing. */
  missingEdit: string[];
};

/**
 * Single source of truth for which Chat capabilities the account has and which
 * scopes would unlock the rest. Every enable affordance in the Chat pane is
 * driven from this, so a partial grant can never leave a capability with no
 * way to request it.
 */
export function chatConsent(status: GoogleStatusLike): ChatConsent {
  const hasSpaces =
    hasGoogleScope(status, CHAT_SPACES_READONLY_SCOPE) || hasGoogleScope(status, CHAT_SPACES_SCOPE);
  const hasMessagesRead =
    hasGoogleScope(status, CHAT_MESSAGES_READONLY_SCOPE) ||
    hasGoogleScope(status, CHAT_MESSAGES_SCOPE);
  const canSend = hasChatSendScope(status);
  const canReact =
    hasGoogleScope(status, CHAT_REACTIONS_SCOPE) || hasGoogleScope(status, CHAT_MESSAGES_SCOPE);
  const canWriteReadState = hasGoogleScope(status, CHAT_READSTATE_SCOPE);
  const canEdit = hasGoogleScope(status, CHAT_MESSAGES_SCOPE);
  const canReadState = canWriteReadState || hasGoogleScope(status, CHAT_READSTATE_READONLY_SCOPE);
  const missingRead = [
    ...(hasSpaces ? [] : [CHAT_SPACES_READONLY_SCOPE]),
    ...(hasMessagesRead ? [] : [CHAT_MESSAGES_READONLY_SCOPE]),
  ];
  return {
    canRead: missingRead.length === 0,
    canSend,
    missingRead,
    missingSend: canSend ? [] : [CHAT_MESSAGES_CREATE_SCOPE],
    missingNames:
      hasGoogleScope(status, CHAT_MEMBERSHIPS_READONLY_SCOPE) ||
      hasGoogleScope(status, CHAT_MEMBERSHIPS_SCOPE)
        ? []
        : [CHAT_MEMBERSHIPS_READONLY_SCOPE],
    canReact,
    canReadState,
    canWriteReadState,
    missingExtras: [
      ...(canReact ? [] : [CHAT_REACTIONS_SCOPE]),
      ...(canWriteReadState ? [] : [CHAT_READSTATE_SCOPE]),
    ],
    canEdit,
    missingEdit: canEdit ? [] : [CHAT_MESSAGES_SCOPE],
  };
}

/** Proxy error codes meaning a Chat scope is missing or was revoked. */
export const CHAT_READ_SCOPE_ERROR = 'google_chat_scope_required';
export const CHAT_SEND_SCOPE_ERROR = 'google_chat_send_scope_required';
export const CHAT_EDIT_SCOPE_ERROR = 'google_chat_edit_scope_required';

/** True when the account can post Chat messages. */
export function hasChatSendScope(status: GoogleStatusLike): boolean {
  return (
    hasGoogleScope(status, CHAT_MESSAGES_CREATE_SCOPE) ||
    hasGoogleScope(status, CHAT_MESSAGES_SCOPE)
  );
}
