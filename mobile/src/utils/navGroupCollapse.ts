// Persistence for the drawer's labeled nav-group collapse state
// (Git / Planning / Support / AI / Settings), mirroring the web sidebar.
//
// Nav groups default to COLLAPSED — an entry is only stored once the user has
// explicitly toggled a group, so their expand/collapse choices survive app
// restarts. The map is keyed by `${projectId}:${groupKey}`; `true` means
// collapsed and `false` means the user expanded it. A missing key falls back to
// the collapsed default at the read site.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const NAV_GROUPS_STORAGE_KEY = 'agent-hub-nav-groups-collapsed';

/** Pure parse of a raw storage payload into a validated collapse map. */
export function parseNavGroupCollapsed(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
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
    return {};
  }
}

/**
 * Merge an asynchronously-loaded persisted map with any local toggles the user
 * made before hydration resolved. Local (pre-hydration) choices win over stored
 * ones, so a tap made while the load is in flight is neither discarded when the
 * load lands nor lost from persistence (the caller saves the merged result once
 * hydration completes). With no local changes this is just the stored map.
 */
export function mergeHydratedNavGroups(
  stored: Record<string, boolean>,
  local: Record<string, boolean>,
): Record<string, boolean> {
  return { ...stored, ...local };
}

/** Load the persisted nav-group collapse map. Best-effort — empty on failure. */
export async function loadNavGroupCollapsed(): Promise<Record<string, boolean>> {
  try {
    const raw = await AsyncStorage.getItem(NAV_GROUPS_STORAGE_KEY);
    return parseNavGroupCollapsed(raw);
  } catch {
    return {};
  }
}

/**
 * Persist the nav-group collapse map. Removes the key when the map is empty so
 * the collapsed default stays clean. Best-effort — swallows storage failures.
 */
export async function saveNavGroupCollapsed(state: Record<string, boolean>): Promise<void> {
  try {
    if (!state || Object.keys(state).length === 0) {
      await AsyncStorage.removeItem(NAV_GROUPS_STORAGE_KEY);
      return;
    }
    await AsyncStorage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort — ignore storage failures.
  }
}
