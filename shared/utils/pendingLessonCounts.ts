/**
 * Pending skill-lesson counts. Seeded only on success. Failures keep last count.
 * Departed projects are pruned. Completions apply only if the fetch token is newest.
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
   * Projects in the last reconciled list. A WS refresh must not fetch a
   * project that already left (that would re-seed it).
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
 * Reconcile against the current list and return fetches to dispatch.
 * Prunes departed projects (including tokens). `seed`: unseeded, not in flight.
 * `refresh`: every present project not already in flight.
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

  // Prune so a revisit refetches and a slow in-flight response cannot match.
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
  // Membership so a later WS refresh can reject a departed project.
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
 * One-off fetch. Returns null for an invalid id or a project not in the last
 * reconciled list (would re-seed a departed project).
 */
export function beginPendingLessonFetch(
  state: PendingLessonCountsState,
  projectId: string,
): PendingLessonFetch | null {
  if (typeof projectId !== 'string' || !projectId) return null;
  if (!state.present.has(projectId)) return null;
  return { projectId, token: issueToken(state, projectId) };
}

/** Success. No-op if the token is stale. */
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

/** Failure/cancel. Drops in-flight so the next reconcile retries; keeps last count. */
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
