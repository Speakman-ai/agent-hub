/**
 * Pane-gating logic for the personal Dashboard home (spec NAV-PLACEMENT).
 *
 * Mirrors `client/src/utils/dashboardPanes.ts` 1:1 so web and mobile gate the
 * Google panes with identical rules. The four-pane home always renders Todos
 * and My Work — they have no external dependency. The Calendar and Gmail panes
 * are Google-gated: this resolves, from the `/api/me/dashboard` `google` block,
 * which affordance a Google pane should show — the live surface, a
 * connect-Google prompt, a reconnect prompt, an incremental-consent prompt, or
 * a "not configured" notice when the server has no Google OAuth app at all.
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

export interface DashboardGoogleAccountLike {
  accountId: string;
  email: string;
  reconnectRequired?: boolean;
  calendarScopeGranted?: boolean;
  mailScopeGranted?: boolean;
  calendarError?: string | null;
  mailError?: string | null;
}

export interface DashboardGoogleLike extends GooglePaneConnection {
  calendar?: { scopeGranted?: boolean } | null;
  mail?: { scopeGranted?: boolean } | null;
  accounts?: DashboardGoogleAccountLike[] | null;
}

export type GoogleDashboardSurface = 'calendar' | 'mail';

function accountHasScope(account: DashboardGoogleAccountLike, surface: GoogleDashboardSurface) {
  return surface === 'calendar' ? !!account.calendarScopeGranted : !!account.mailScopeGranted;
}

/**
 * Whether any linked account can feed a surface. Reads the per-account scopes
 * when the payload carries them, so one usable account is enough; otherwise
 * the block-level flag.
 */
export function surfaceScopeGranted(
  google: DashboardGoogleLike | null | undefined,
  surface: GoogleDashboardSurface,
): boolean {
  const accounts = google?.accounts;
  if (accounts?.length) {
    return accounts.some((a) => !a.reconnectRequired && accountHasScope(a, surface));
  }
  return surface === 'calendar' ? !!google?.calendar?.scopeGranted : !!google?.mail?.scopeGranted;
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
  return googlePaneState(google, surfaceScopeGranted(google, 'calendar'));
}

/** Gmail pane state: gated on the mail scope from the dashboard payload. */
export function mailPaneState(google: DashboardGoogleLike | null | undefined): GooglePaneState {
  return googlePaneState(google, surfaceScopeGranted(google, 'mail'));
}

export interface PaneAccountNotice {
  accountId: string;
  email: string;
  reason: 'reconnect' | 'scope-required' | 'error';
  detail: string | null;
}

/**
 * Linked accounts a live pane is NOT showing, and why. The pane renders the
 * accounts that work and lists these underneath, so a second account with a
 * stale token or a missing scope doesn't silently drop out.
 */
export function paneAccountNotices(
  google: DashboardGoogleLike | null | undefined,
  surface: GoogleDashboardSurface,
): PaneAccountNotice[] {
  const notices: PaneAccountNotice[] = [];
  for (const a of google?.accounts ?? []) {
    const error = surface === 'calendar' ? a.calendarError : a.mailError;
    if (a.reconnectRequired) {
      notices.push({ accountId: a.accountId, email: a.email, reason: 'reconnect', detail: null });
    } else if (!accountHasScope(a, surface)) {
      notices.push({
        accountId: a.accountId,
        email: a.email,
        reason: 'scope-required',
        detail: null,
      });
    } else if (error) {
      notices.push({ accountId: a.accountId, email: a.email, reason: 'error', detail: error });
    }
  }
  return notices;
}

/** One-line copy for a pane account notice. */
export function paneAccountNoticeText(
  notice: PaneAccountNotice,
  surface: GoogleDashboardSurface,
): string {
  const name = surface === 'calendar' ? 'Calendar' : 'Gmail';
  if (notice.reason === 'reconnect') return `${notice.email}: reconnect to include it`;
  if (notice.reason === 'scope-required') return `${notice.email}: ${name} access not granted`;
  return `${notice.email}: ${notice.detail ?? `${name} unavailable`}`;
}

/** True only when the pane should render its live Google data. */
export function isGooglePaneReady(state: GooglePaneState): boolean {
  return state === 'ready';
}
