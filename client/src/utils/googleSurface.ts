/**
 * Shared predicates for gating global Google Workspace surfaces (Calendar,
 * and later Gmail / Sheets / Drive) in the web client.
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

// One incremental-consent request for the Sheets surface asks for the full
// spreadsheets scope (read + write) plus drive.file so the Drive-backed picker can
// list spreadsheets after a single round-trip.
export const SHEETS_SURFACE_SCOPES = [SHEETS_SCOPE, DRIVE_FILE_SCOPE];

// The global Drive surface is a file picker over app-accessible files, so its
// single incremental-consent request asks only for the NON-restricted drive.file
// scope. v1 never requests drive.readonly or full drive (restricted, triggers
// annual CASA).
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

/** True when the Drive-backed spreadsheet picker can list app files (drive.file). */
export function hasDriveFileScope(status: GoogleStatusLike): boolean {
  return hasGoogleScope(status, DRIVE_FILE_SCOPE);
}

/**
 * Whether to render the global Sheets entry in navigation. Gated purely on
 * connection (NOT scope), mirroring Calendar/Gmail: a connected-but-unconsented
 * user still sees the nav item, and the Sheets pane shows the inline "Enable
 * Sheets" affordance for incremental consent.
 */
export function shouldShowSheetsNav(status: GoogleStatusLike): boolean {
  return isGoogleConnected(status);
}

/**
 * Whether to render the global Drive entry in navigation. Gated purely on
 * connection (NOT scope), mirroring Calendar/Gmail/Sheets: a connected-but-
 * unconsented user still sees the nav item, and the Drive pane shows the inline
 * "Enable Drive" affordance for incremental consent.
 */
export function shouldShowDriveNav(status: GoogleStatusLike): boolean {
  return isGoogleConnected(status);
}
