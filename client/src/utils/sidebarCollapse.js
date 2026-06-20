// Persistence helpers for the desktop sidebar collapse state.
//
// On wide (md+) screens the agent/session sidebar can be collapsed to reclaim
// horizontal space, mirroring how the mobile drawer hides. The collapsed flag
// is persisted to localStorage so it survives reloads. Mobile (< md) ignores
// this flag entirely — it keeps using the slide-out drawer (`sidebarOpen`).

export const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';

/**
 * Read the persisted collapsed flag. Returns `false` (expanded) when storage
 * is unavailable, empty, or holds anything other than the truthy sentinel.
 * @returns {boolean}
 */
export function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    // Storage disabled / quota / SSR — treat as expanded.
    return false;
  }
}

/**
 * Persist the collapsed flag. Stores the '1' sentinel when collapsed and
 * removes the key when expanded so the default stays clean. Swallows storage
 * errors (private mode, quota) since persistence is best-effort.
 * @param {boolean} collapsed
 */
export function writeSidebarCollapsed(collapsed) {
  try {
    if (collapsed) {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    } else {
      localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    }
  } catch {
    // Best-effort — ignore storage failures.
  }
}
