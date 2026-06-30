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
