/**
 * Per-project pending skill-lesson count tracking, shared by the web sidebar
 * badge (a per-project map) and the mobile drawer badge (a summed total).
 *
 * The hard part is the fetch *lifecycle*, not the arithmetic. Rules, each
 * learned from a concrete bug:
 *
 * 1. **Only a successful fetch marks a project seeded.** Marking a project
 *    seeded when the request is merely *dispatched* means a request that is
 *    later cancelled or that fails is never retried — the badge stays blank
 *    forever. Only {@link applyPendingLessonSuccess} adds to `seeded`.
 *
 * 2. **A failure/cancellation preserves the last known count.** Treating a
 *    failed request as zero erases counts we already know, so one transient
 *    error blanks the badge after an unrelated refresh.
 *    {@link applyPendingLessonFailure} never touches `counts`.
 *
 * 3. **Projects that leave the list are pruned.** A project revisited after an
 *    org switch must refetch fresh, so {@link reconcilePendingLessonProjects}
 *    drops departed projects from every map/set.
 *
 * 4. **Stale completions are ignored.** Overlapping fetches for one project
 *    (a background seed plus a WebSocket-triggered refresh) can resolve out of
 *    order, and a response can arrive after its project has departed. Every
 *    fetch is issued a monotonic token via {@link beginPendingLessonFetch} /
 *    {@link reconcilePendingLessonProjects}; a completion applies only if its
 *    token is still the newest one for that project. Tokens come from a global
 *    counter and are never reused, so a slow old response can never alias a
 *    newer fetch, and a pruned project has no token so its late response is
 *    dropped instead of re-seeding it.
 */
export interface PendingLessonCountsState {
  /** Last successfully fetched pending count per project. Survives failures. */
  counts: Record<string, number>;
  /** Projects whose count was successfully fetched at least once. */
  seeded: Set<string>;
  /** Projects with a fetch currently in flight (dedupes concurrent seeds). */
  inFlight: Set<string>;
  /** Newest issued fetch token per project; a completion with a different token is stale. */
  token: Record<string, number>;
  /**
   * Projects present in the most recently reconciled list. A WebSocket-driven
   * refresh must not start a fetch for a project that already departed — its
   * response would re-seed the project and hide the fresh-seed a later revisit
   * needs. Updated on every {@link reconcilePendingLessonProjects}.
   */
  present: Set<string>;
  /** Monotonic global token source — never reused, so stale responses can't alias newer fetches. */
  nextToken: number;
}

/** A dispatched fetch: the project to query and the token its completion must carry. */
export interface PendingLessonFetch {
  projectId: string;
  token: number;
}

export function createPendingLessonCountsState(): PendingLessonCountsState {
  return {
    counts: {},
    seeded: new Set(),
    inFlight: new Set(),
    token: {},
    present: new Set(),
    nextToken: 1,
  };
}

export type PendingLessonFetchMode =
  /** Fetch each project at most once (skip already-seeded). Used on project-list change. */
  | 'seed'
  /** Refetch every present project (only skip in-flight). Used on a change broadcast. */
  | 'refresh';

function normalizeCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** Issue a token for a project fetch, marking it in flight and superseding any prior in-flight request. */
function issueToken(state: PendingLessonCountsState, projectId: string): number {
  const token = state.nextToken++;
  state.token[projectId] = token;
  state.inFlight.add(projectId);
  return token;
}

/**
 * Reconcile tracked state against the current project list and return the
 * fetches to dispatch (each with its token). Prunes departed projects from
 * every map/set — including their token, so an in-flight response for a
 * departed project is dropped rather than re-seeding it. In `seed` mode,
 * returns present projects that are neither seeded nor in flight; in `refresh`
 * mode, returns every present project not already in flight.
 */
export function reconcilePendingLessonProjects(
  state: PendingLessonCountsState,
  projectIds: Iterable<string | null | undefined>,
  mode: PendingLessonFetchMode,
): PendingLessonFetch[] {
  const current = new Set<string>();
  for (const id of projectIds) {
    if (typeof id === 'string' && id) current.add(id);
  }

  // Prune departed projects so a later revisit refetches, and so a slow
  // in-flight response can no longer match (its token entry is gone).
  for (const id of Object.keys(state.counts)) {
    if (!current.has(id)) delete state.counts[id];
  }
  for (const id of [...state.seeded]) {
    if (!current.has(id)) state.seeded.delete(id);
  }
  for (const id of [...state.inFlight]) {
    if (!current.has(id)) state.inFlight.delete(id);
  }
  for (const id of Object.keys(state.token)) {
    if (!current.has(id)) delete state.token[id];
  }
  // Record membership so a later WS refresh can reject a departed project.
  state.present = current;

  const toFetch: PendingLessonFetch[] = [];
  for (const id of current) {
    if (state.inFlight.has(id)) continue;
    if (mode === 'seed' && state.seeded.has(id)) continue;
    toFetch.push({ projectId: id, token: issueToken(state, id) });
  }
  return toFetch;
}

/**
 * Begin a one-off fetch for a single project (e.g. a WebSocket-triggered
 * refresh), returning its token. Supersedes any in-flight fetch for the same
 * project so out-of-order completions are ignored. Returns null for an invalid
 * id OR for a project that is not in the most recently reconciled list — a
 * refresh event that arrives after the project departed (e.g. an org switch)
 * must not mint a token that would re-seed the departed project.
 */
export function beginPendingLessonFetch(
  state: PendingLessonCountsState,
  projectId: string,
): PendingLessonFetch | null {
  if (typeof projectId !== 'string' || !projectId) return null;
  if (!state.present.has(projectId)) return null;
  return { projectId, token: issueToken(state, projectId) };
}

/**
 * Record a successful fetch. No-ops (returning false) if the token is stale —
 * a newer fetch superseded this one, or the project departed and was pruned.
 * On acceptance: clears in-flight, marks seeded, stores the count.
 */
export function applyPendingLessonSuccess(
  state: PendingLessonCountsState,
  projectId: string,
  token: number,
  count: number,
): boolean {
  if (state.token[projectId] !== token) return false;
  state.inFlight.delete(projectId);
  state.seeded.add(projectId);
  state.counts[projectId] = normalizeCount(count);
  return true;
}

/**
 * Record a failed or cancelled fetch. No-ops if the token is stale (a newer
 * fetch owns the in-flight slot, or the project departed). On acceptance:
 * drops the in-flight marker so the next reconcile retries, WITHOUT touching
 * the last known count or the seeded flag.
 */
export function applyPendingLessonFailure(
  state: PendingLessonCountsState,
  projectId: string,
  token: number,
): boolean {
  if (state.token[projectId] !== token) return false;
  state.inFlight.delete(projectId);
  return true;
}

/** Sum of the last known per-project counts (drives the mobile drawer badge). */
export function totalPendingLessons(state: PendingLessonCountsState): number {
  let total = 0;
  for (const id of Object.keys(state.counts)) total += state.counts[id];
  return total;
}

/** Shallow copy of the per-project counts (drives the web sidebar badge). */
export function pendingLessonCountsSnapshot(
  state: PendingLessonCountsState,
): Record<string, number> {
  return { ...state.counts };
}
