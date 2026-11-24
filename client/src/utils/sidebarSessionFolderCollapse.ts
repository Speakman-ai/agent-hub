// Collapsed session folders in the sidebar, keyed by folder id. Folders default
// to expanded; only collapsed ids are stored.

export const SIDEBAR_SESSION_FOLDERS_KEY = 'sidebarSessionFoldersCollapsed';

export function readCollapsedSessionFolders(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SIDEBAR_SESSION_FOLDERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const id of parsed) if (typeof id === 'string' && id) out[id] = true;
    return out;
  } catch {
    return {};
  }
}

export function writeCollapsedSessionFolders(state: Record<string, boolean>): void {
  try {
    const ids = Object.keys(state).filter((id) => state[id]);
    if (ids.length === 0) localStorage.removeItem(SIDEBAR_SESSION_FOLDERS_KEY);
    else localStorage.setItem(SIDEBAR_SESSION_FOLDERS_KEY, JSON.stringify(ids));
  } catch {
    // Storage disabled or full: collapse state just won't persist.
  }
}
