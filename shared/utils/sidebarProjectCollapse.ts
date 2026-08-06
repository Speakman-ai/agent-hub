/**
 * Pure helpers for the sidebar's collapsed-project state.
 *
 * The authoritative store is per **user**, on the server
 * (`GET/PUT /api/auth/me/sidebar-collapsed-projects`), so the same account sees
 * the same collapsed projects on web, mobile, and Electron. Each surface keeps
 * a local cache (localStorage / AsyncStorage) purely so the first paint after a
 * reload matches what the user last saw instead of flashing every project open
 * while the fetch is in flight.
 *
 * That split creates two races worth naming, both handled here:
 *
 *  1. The user can toggle a project *before* the hydration fetch resolves.
 *     {@link mergeHydratedCollapsedProjects} lets local pre-hydration toggles
 *     win over the server list, mirroring `mergeHydratedNavGroups`.
 *  2. Rapid collapse/expand clicks can produce overlapping PUTs that arrive
 *     out of order, leaving the account state inverted relative to the UI.
 *     {@link createCollapsedProjectSaver} serializes and coalesces saves per
 *     project so only the newest desired value is ever in flight.
 *
 * The cache is also keyed per account ({@link collapsedProjectsCacheKey}) —
 * two people sharing a browser must never see each other's collapsed projects,
 * least of all when the hydration fetch fails and the cache is all we have.
 *
 * Everything here is storage- and network-free so it can be unit tested and
 * shared by both clients.
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
 * Storage key for one account's cache.
 *
 * The cache MUST be account-scoped. It is the only state rendered before the
 * hydration fetch resolves, and it survives a failed fetch — so a global key
 * would show user A's collapsed projects to user B after an account switch on
 * a shared browser, indefinitely if B is offline.
 *
 * Falls back through `id → username → email` because `user.id` is optional on
 * the wire, and finally to `anonymous` for local-bundled deployments
 * (Electron / `AGENT_HUB_MODE=local`) where no token is ever issued and there
 * is exactly one user.
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

/**
 * Parse a raw cached payload into a validated, de-duplicated id list. Anything
 * malformed (missing, bad JSON, non-array, non-string entries) degrades to an
 * empty list — a broken cache should mean "nothing collapsed", never a crash.
 */
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

/**
 * Fold the server's list into local state, preserving toggles the user made
 * while the hydration fetch was still in flight.
 *
 * `pendingEdits` maps projectId → the collapsed value the user chose locally.
 * Those win; every other project takes the server's value. Without this, a
 * click landing a few hundred ms before the fetch resolves would visibly snap
 * back — and, worse, the surviving server value would then be what the next
 * cache write persists.
 */
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
  /** Record the desired value for `projectId` and ensure it reaches the server. */
  save(projectId: string, collapsed: boolean): Promise<void>;
  /** True while a PUT for `projectId` is in flight (or queued). Test/debug aid. */
  isSaving(projectId: string): boolean;
  /**
   * Permanently retire this saver: drop everything still queued and refuse
   * further `save()` calls. Requests already dispatched are left to settle —
   * they were sent with the credentials of the account that queued them, so
   * they land on the right account.
   *
   * **Call this whenever the signed-in account changes.** A queued value is
   * only bound to a request at dispatch time, and the API layer reads the auth
   * token at dispatch time too — so a value queued by user A but sent after
   * user B signs in would be written to B's preferences. Retiring the saver
   * and building a fresh one per account is what keeps A's pending toggles out
   * of B's account.
   */
  cancel(): void;
}

/**
 * Serialize and coalesce collapsed-project saves **per project**.
 *
 * Toggling is a click target, so a user can easily produce three PUTs in under
 * a second. Fired independently, those requests race: the browser is free to
 * deliver `collapsed=true` after `collapsed=false`, and the account is then
 * left holding the opposite of what the UI and cache show — a divergence that
 * only surfaces on the *next* reload, which makes it miserable to diagnose.
 *
 * The fix is a per-project chain with a single-slot queue. At most one request
 * per project is ever in flight; while it is, further toggles only overwrite
 * the *desired* value. When the request settles, the newest desired value (if
 * it still differs from what was just sent) goes out next. Intermediate values
 * are intentionally dropped — nobody needs the middle of a double-click — and
 * the last write always wins because it is literally sent last.
 *
 * Failures are swallowed: this is best-effort UI state, the optimistic local
 * value is already correct, and the next hydration reconciles.
 *
 * A saver belongs to exactly ONE signed-in account. The queue holds values,
 * not requests, so anything still queued when the account changes would be
 * dispatched with the *new* account's credentials. Retire it with
 * {@link CollapsedProjectSaver.cancel} and build a fresh one per account.
 */
export function createCollapsedProjectSaver(put: CollapsedProjectPut): CollapsedProjectSaver {
  /** projectId → the value the user most recently asked for but we haven't sent. */
  const desired = new Map<string, boolean>();
  /** projectId → the chain currently draining `desired` for that project. */
  const inFlight = new Map<string, Promise<void>>();
  /** Set by `cancel()`; makes the saver permanently inert. */
  let retired = false;

  const drain = async (projectId: string): Promise<void> => {
    // No `await` between the loop guard and the delete below, so a toggle that
    // lands after the guard can't be stranded: it either re-enters this loop or
    // finds `inFlight` already cleared and starts a fresh chain.
    //
    // `retired` is re-checked every iteration, so a `cancel()` that lands while
    // a request is in flight stops the NEXT dispatch — which is the one that
    // would otherwise carry the old account's value under the new account's
    // token.
    while (!retired && desired.has(projectId)) {
      const collapsed = desired.get(projectId) as boolean;
      desired.delete(projectId);
      try {
        await put(projectId, collapsed);
      } catch {
        // Best-effort — the optimistic local state stands.
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
