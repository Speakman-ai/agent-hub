/**
 * Shared predicates for gating global Google Workspace surfaces (Calendar,
 * and later Gmail / Sheets / Drive) on mobile. Mirrors
 * `client/src/utils/googleSurface.ts` for web/mobile parity.
 *
 * The connection is per-USER and lives in Settings -> Account. Surface
 * navigation is connection-gated: it appears only when
 * `/api/auth/google/status` reports `connected === true`. Incremental consent
 * for a specific scope is a separate, inline "Enable …" affordance.
 */

export const CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_FULL_SCOPE = 'https://www.googleapis.com/auth/calendar';

// Gmail scopes. This screen only LISTS/READS threads and SENDS mail, so it
// requests the narrowest scopes: `gmail.readonly` (read) + `gmail.send` (send),
// NOT `gmail.modify` (which also grants mailbox mutation the UI never uses).
// Every Gmail read scope is restricted per Google's scope table, so readonly is
// the least-privilege read scope, not a way to dodge restricted verification.
// modify / full still satisfy the predicates for previously-granted accounts.
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_FULL_SCOPE = 'https://mail.google.com/';
export const GMAIL_SURFACE_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE];

// Sheets + Drive scopes. The viewer reads + edits spreadsheet values (full
// `spreadsheets`, sensitive) and lists spreadsheets via the NON-restricted
// `drive.file` picker — never `drive.readonly` or full `drive` (restricted,
// triggers annual CASA). Mirrors the server scope gates and the web client.
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SHEETS_SURFACE_SCOPES = [SHEETS_SCOPE, DRIVE_FILE_SCOPE];

// The global Drive surface is a file picker over app-accessible files, so its
// single incremental-consent request asks only for the NON-restricted drive.file
// scope — never drive.readonly or full drive (restricted, triggers annual CASA).
export const DRIVE_SURFACE_SCOPES = [DRIVE_FILE_SCOPE];

/** True only when the calling user has linked a Google account. */
export function isGoogleConnected(status: any): boolean {
  return !!status?.connected;
}

/** True when the linked Google account has granted a specific scope. */
export function hasGoogleScope(status: any, scope: string): boolean {
  const scopes = status?.grantedScopes || [];
  return scopes.includes(scope);
}

/** True when the user can read/write the primary Google Calendar. */
export function hasCalendarScope(status: any): boolean {
  return hasGoogleScope(status, CALENDAR_EVENTS_SCOPE) || hasGoogleScope(status, CALENDAR_FULL_SCOPE);
}

/**
 * Whether to render the global Calendar entry in the drawer. Gated purely on
 * connection (NOT scope): a connected-but-unconsented user still sees the nav
 * item, and the Calendar screen shows the inline "Enable Calendar" affordance.
 */
export function shouldShowCalendarNav(status: any): boolean {
  return isGoogleConnected(status);
}

/** True when the linked Google account can read/list Gmail (readonly/modify/full). */
export function hasGmailReadScope(status: any): boolean {
  return (
    hasGoogleScope(status, GMAIL_READONLY_SCOPE) ||
    hasGoogleScope(status, GMAIL_MODIFY_SCOPE) ||
    hasGoogleScope(status, GMAIL_FULL_SCOPE)
  );
}

/** True when the linked Google account can send mail (send, modify, or full). */
export function hasGmailSendScope(status: any): boolean {
  return (
    hasGoogleScope(status, GMAIL_SEND_SCOPE) ||
    hasGoogleScope(status, GMAIL_MODIFY_SCOPE) ||
    hasGoogleScope(status, GMAIL_FULL_SCOPE)
  );
}

/**
 * Whether to render the global Gmail entry in the drawer. Gated purely on
 * connection (NOT scope), mirroring Calendar: a connected-but-unconsented user
 * still sees the nav item, and the Gmail screen shows the inline "Enable Gmail"
 * affordance for incremental consent.
 */
export function shouldShowGmailNav(status: any): boolean {
  return isGoogleConnected(status);
}

/** True when the linked Google account can read spreadsheet values (readonly/full). */
export function hasSheetsScope(status: any): boolean {
  return hasGoogleScope(status, SHEETS_SCOPE) || hasGoogleScope(status, SHEETS_READONLY_SCOPE);
}

/** True when the linked Google account can WRITE spreadsheet values (full scope only). */
export function hasSheetsWriteScope(status: any): boolean {
  return hasGoogleScope(status, SHEETS_SCOPE);
}

/** True when the Drive-backed spreadsheet picker can list app files (drive.file). */
export function hasDriveFileScope(status: any): boolean {
  return hasGoogleScope(status, DRIVE_FILE_SCOPE);
}

/**
 * Whether to render the global Sheets entry in the drawer. Gated purely on
 * connection (NOT scope), mirroring Calendar/Gmail: a connected-but-unconsented
 * user still sees the nav item, and the Sheets screen shows the inline "Enable
 * Sheets" affordance for incremental consent.
 */
export function shouldShowSheetsNav(status: any): boolean {
  return isGoogleConnected(status);
}

/**
 * Whether to render the global Drive entry in the drawer. Gated purely on
 * connection (NOT scope), mirroring Calendar/Gmail/Sheets: a connected-but-
 * unconsented user still sees the nav item, and the Drive screen shows the
 * inline "Enable Drive" affordance for incremental consent.
 */
export function shouldShowDriveNav(status: any): boolean {
  return isGoogleConnected(status);
}
