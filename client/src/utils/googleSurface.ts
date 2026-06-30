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
