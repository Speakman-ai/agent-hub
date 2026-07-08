/**
 * Pane-gating logic for the personal Dashboard home (spec NAV-PLACEMENT).
 *
 * The four-pane home always renders Todos and My Work — they have no external
 * dependency. The Calendar and Gmail panes are Google-gated: this resolves,
 * from the `/api/me/dashboard` `google` block, which affordance a Google pane
 * should show — the live surface, a connect-Google prompt, a reconnect prompt,
 * an incremental-consent prompt, or a "not configured" notice when the server
 * has no Google OAuth app at all.
 *
 * Kept as a pure function so the gating is unit-testable without rendering the
 * dashboard (acceptance: "Test for pane gating logic").
 */

export type GooglePaneState =
  | 'not-configured'
  | 'connect'
  | 'reconnect'
  | 'scope-required'
  | 'ready';

export interface GooglePaneConnection {
  configured?: boolean;
  connected?: boolean;
  reconnectRequired?: boolean;
}

export interface DashboardGoogleLike extends GooglePaneConnection {
  calendar?: { scopeGranted?: boolean } | null;
  mail?: { scopeGranted?: boolean } | null;
}

/**
 * Resolve a Google pane's render state from the connection block and whether
 * the surface's own scope was granted. Order matters — a disconnected user is
 * asked to connect before we ever consider scope; a stale token (reconnect)
 * takes priority over a missing scope.
 */
export function googlePaneState(
  google: GooglePaneConnection | null | undefined,
  scopeGranted: boolean,
): GooglePaneState {
  if (!google || !google.configured) return 'not-configured';
  if (!google.connected) return 'connect';
  if (google.reconnectRequired) return 'reconnect';
  if (!scopeGranted) return 'scope-required';
  return 'ready';
}

/** Calendar pane state: gated on the calendar scope from the dashboard payload. */
export function calendarPaneState(google: DashboardGoogleLike | null | undefined): GooglePaneState {
  return googlePaneState(google, !!google?.calendar?.scopeGranted);
}

/** Gmail pane state: gated on the mail scope from the dashboard payload. */
export function mailPaneState(google: DashboardGoogleLike | null | undefined): GooglePaneState {
  return googlePaneState(google, !!google?.mail?.scopeGranted);
}

/** True only when the pane should render its live Google data. */
export function isGooglePaneReady(state: GooglePaneState): boolean {
  return state === 'ready';
}
