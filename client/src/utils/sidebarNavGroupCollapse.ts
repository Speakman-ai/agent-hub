// Persistence for the labeled sidebar nav-group collapse state
// (Git / Planning / Support / AI / Settings).
//
// Nav groups default to COLLAPSED — an entry is only stored once the user has
// explicitly toggled a group, so their expand/collapse choices survive reloads.
// The map is keyed by `${projectId}:${groupKey}`; a value of `true` means
// collapsed and `false` means the user expanded it. A missing key falls back to
// the collapsed default at the read site.

export const SIDEBAR_NAV_GROUPS_KEY = 'sidebarNavGroupsCollapsed';

/**
 * Read the persisted nav-group collapse map. Returns an empty object (all groups
 * fall back to the collapsed default) when storage is unavailable or malformed.
 */
export function readNavGroupCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SIDEBAR_NAV_GROUPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && key.length > 0 && typeof value === 'boolean') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    // Storage disabled / quota / SSR — treat as no persisted state.
    return {};
  }
}

/**
 * Persist the nav-group collapse map. Removes the key entirely when the map is
 * empty so the default (all collapsed) stays clean. Best-effort — swallows
 * storage failures (private mode, quota).
 */
export function writeNavGroupCollapsed(state: Record<string, boolean>): void {
  try {
    if (!state || Object.keys(state).length === 0) {
      localStorage.removeItem(SIDEBAR_NAV_GROUPS_KEY);
      return;
    }
    localStorage.setItem(SIDEBAR_NAV_GROUPS_KEY, JSON.stringify(state));
  } catch {
    // Best-effort — ignore storage failures.
  }
}
