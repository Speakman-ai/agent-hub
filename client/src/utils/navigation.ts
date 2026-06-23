/**
 * Top-level navigation helpers for the web client.
 *
 * The client is a state-driven SPA (no URL router): the active top-level
 * pane is held in App's `currentView` state. This module is the single
 * source of truth for what the app lands on when it first mounts.
 */

/**
 * The view the app shows on first load (the "home page"). The org-wide
 * Dashboard is the landing surface; chat is opened explicitly by picking an
 * agent/session from the sidebar.
 */
export const DEFAULT_VIEW = 'dashboard';

/**
 * Resolve the initial top-level view at mount time.
 *
 * @param {string} [requested] — an explicit view to honor (e.g. a future
 *   deep-link). Any non-empty string wins; otherwise we fall back to the
 *   default home view.
 * @returns {string}
 */
export function getInitialView(requested?: any) {
  if (typeof requested === 'string' && requested.trim() !== '') {
    return requested;
  }
  return DEFAULT_VIEW;
}
