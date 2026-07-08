// Persisted preference for the epics list layout: 'list' (default card grid)
// or 'board' (read-only kanban grouped by lifecycle state). Kept in localStorage
// so the choice survives reloads. Reads are defensive — a missing/broken store
// falls back to 'list'.

export type EpicListViewMode = 'list' | 'board';

const STORAGE_KEY = 'epicListViewMode';

export function isEpicListViewMode(value: unknown): value is EpicListViewMode {
  return value === 'list' || value === 'board';
}

export function readEpicListViewMode(): EpicListViewMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isEpicListViewMode(raw) ? raw : 'list';
  } catch {
    return 'list';
  }
}

export function writeEpicListViewMode(mode: EpicListViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignore — a blocked/unavailable store just means the preference isn't persisted.
  }
}
