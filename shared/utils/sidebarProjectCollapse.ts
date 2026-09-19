/**
 * Sidebar collapsed-project state. Server is per-user; local cache is first-paint
 * only. Cache is account-keyed. Pre-hydration toggles win; PUTs are serialized
 * per project so overlapping clicks cannot invert account state.
 */

/** Storage key prefix used by the web and mobile local caches. */
export const SIDEBAR_COLLAPSED_PROJECTS_KEY = 'sidebarCollapsedProjects';

/** Minimal shape of the cached auth record's `user` both clients persist. */
export interface CollapsedProjectsAccount {
  id?: string | null;
  username?: string | null;
  email?: string | null;
}

/**
 * Account-scoped cache key. Falls back id → username → email → `anonymous`
 * (local/Electron, no token).
 */
export function collapsedProjectsCacheKey(
  account: CollapsedProjectsAccount | null | undefined,
): string {
  const candidates = [account?.id, account?.username, account?.email];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return `${SIDEBAR_COLLAPSED_PROJECTS_KEY}:${candidate.trim()}`;
    }
  }
  return `${SIDEBAR_COLLAPSED_PROJECTS_KEY}:anonymous`;
}

/** True for any key this feature owns — used to prune other accounts' caches. */
export function isCollapsedProjectsCacheKey(key: string): boolean {
  return (
    key === SIDEBAR_COLLAPSED_PROJECTS_KEY || key.startsWith(`${SIDEBAR_COLLAPSED_PROJECTS_KEY}:`)
  );
}

/** Malformed cache → empty list, never a throw. */
export function parseCollapsedProjects(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeCollapsedProjects(parsed);
  } catch {
    return [];
  }
}

/** Trim, drop blanks/non-strings, de-duplicate (first occurrence wins). */
export function normalizeCollapsedProjects(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Id list → `{ [projectId]: true }` lookup for render-time checks. */
export function toCollapsedMap(ids: readonly string[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const id of ids) map[id] = true;
  return map;
}

/** `{ [projectId]: boolean }` → the id list the server persists. */
export function fromCollapsedMap(map: Record<string, boolean> | null | undefined): string[] {
  if (!map) return [];
  return Object.keys(map).filter((id) => map[id]);
}

/** Collapse (`collapsed`) or expand one project. Order-preserving, idempotent. */
export function applyCollapsedToggle(
  ids: readonly string[],
  projectId: string,
  collapsed: boolean,
): string[] {
  const id = projectId.trim();
  if (!id) return [...ids];
  if (collapsed) return ids.includes(id) ? [...ids] : [...ids, id];
  return ids.filter((existing) => existing !== id);
}

/** Local pending toggles win over the server list. */
export function mergeHydratedCollapsedProjects(
  serverIds: readonly string[],
  pendingEdits: Record<string, boolean> | null | undefined,
): string[] {
  let next = normalizeCollapsedProjects([...serverIds]);
  if (!pendingEdits) return next;
  for (const [projectId, collapsed] of Object.entries(pendingEdits)) {
    next = applyCollapsedToggle(next, projectId, collapsed);
  }
  return next;
}

/** What {@link createCollapsedProjectSaver} needs from the API layer. */
export type CollapsedProjectPut = (projectId: string, collapsed: boolean) => Promise<unknown>;

export interface CollapsedProjectSaver {
  save(projectId: string, collapsed: boolean): Promise<void>;
  isSaving(projectId: string): boolean;
  /**
   * Drop the queue and refuse further saves. In-flight PUTs still settle
   * (they carry the account that queued them). Call on account switch.
   */
  cancel(): void;
}

/**
 * Per-project serialize + coalesce. One in-flight PUT; later toggles overwrite
 * the desired value. Last write wins. Failures swallowed (optimistic UI stands).
 * One saver per signed-in account; retire on switch.
 */
export function createCollapsedProjectSaver(put: CollapsedProjectPut): CollapsedProjectSaver {
  const desired = new Map<string, boolean>();
  const inFlight = new Map<string, Promise<void>>();
  let retired = false;

  const drain = async (projectId: string): Promise<void> => {
    // No await between the loop guard and delete, so a toggle cannot be stranded.
    // Re-check retired each iteration so cancel() stops the next dispatch.
    while (!retired && desired.has(projectId)) {
      const collapsed = desired.get(projectId) as boolean;
      desired.delete(projectId);
      try {
        await put(projectId, collapsed);
      } catch {
        // Optimistic local state stands.
      }
    }
    inFlight.delete(projectId);
  };

  return {
    save(projectId: string, collapsed: boolean): Promise<void> {
      if (retired) return Promise.resolve();
      desired.set(projectId, collapsed);
      const existing = inFlight.get(projectId);
      if (existing) return existing;
      const chain = drain(projectId);
      inFlight.set(projectId, chain);
      return chain;
    },
    isSaving(projectId: string): boolean {
      return inFlight.has(projectId);
    },
    cancel(): void {
      retired = true;
      desired.clear();
    },
  };
}
