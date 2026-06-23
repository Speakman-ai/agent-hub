/**
 * Helpers for the per-session "Changes" toolbar badge count.
 *
 * The count is derived from `GET /api/sessions/:id/changes` (the same
 * summary the diff pane renders) and stored in App.jsx as a
 * `{ [sessionId]: number }` map. These pure helpers keep the
 * derive-and-merge logic in one place so the diff pane's `onSummary`
 * callback and the live WS-driven refresh stay in lockstep, and so the
 * tricky React bail-out (return the same object reference when nothing
 * changed) is unit-testable without rendering the app.
 */

/**
 * Number of changed files reported by a changes summary body.
 * Tolerates null/partial bodies (network errors, non-worktree sessions).
 *
 * @param {{ files?: unknown }} [summary]
 * @returns {number}
 */
export function fileCountFromChangesSummary(summary: any) {
  return Array.isArray(summary?.files) ? summary.files.length : 0;
}

/**
 * Immutably set the changed-file count for one session.
 *
 * Returns the SAME `prev` reference when the value is unchanged (or the
 * sessionId is missing) so React's state-equality check bails out of a
 * rerender instead of churning on every refetch.
 *
 * @param {Record<string, number>} prev
 * @param {string} sessionId
 * @param {number} count
 * @returns {Record<string, number>}
 */
export function setSessionFileCount(prev: any, sessionId: any, count: any) {
  if (!sessionId) return prev;
  if (prev[sessionId] === count) return prev;
  return { ...prev, [sessionId]: count };
}

/**
 * True for sessions that can have a git-worktree diff. Used to gate the
 * turn-`done` recount and the activation seed so non-worktree sessions
 * never trigger a pointless `/changes` fetch.
 *
 * @param {{ use_worktree?: number|boolean, worktree_branch?: string|null } | null} [session]
 * @returns {boolean}
 */
export function isWorktreeSession(session: any) {
  return !!(session && (session.use_worktree || session.worktree_branch));
}

/**
 * Build a per-session, order-safe refresher for the Changes badge count.
 *
 * Session activation, the `code_changed` WS event, and the turn-`done` WS
 * event can each issue an overlapping `/changes` fetch for the same session.
 * Responses may resolve out of order, so a slow earlier request could
 * otherwise clobber the badge with a stale (often lower) count *after* a
 * later request already stored the final tally.
 *
 * Each call gets a per-session monotonic issue sequence. A response is applied
 * only when its sequence is newer than the last one that was *successfully
 * applied* — so the badge reflects the newest count it has actually received
 * and never regresses. Crucially, the guard tracks the last *applied* result,
 * not merely the last *issued* request: a newer request that fails or returns
 * null/undefined does not advance the guard, so an older-but-valid result is
 * still applied instead of stranding the badge stale on a transient failure.
 *
 * I/O is injected (no React, no fetch) so the ordering guard is unit-testable.
 *
 * @param {object} io
 * @param {(sessionId: string) => Promise<number|null|undefined>} io.fetchCount
 *        resolves to the changed-file count, or null/undefined to skip applying.
 * @param {(sessionId: string, count: number) => void} io.applyCount
 * @returns {(sessionId: string) => Promise<void>}
 */
export function createDiffFileCountRefresher({ fetchCount, applyCount }: any) {
  /** @type {Map<string, number>} next issue sequence per session */
  const issuedSeqBySession = new Map();
  /** @type {Map<string, number>} sequence of the last successfully applied count per session */
  const appliedSeqBySession = new Map();
  return async function refreshDiffFileCount(sessionId: any) {
    if (!sessionId) return;
    const seq = (issuedSeqBySession.get(sessionId) || 0) + 1;
    issuedSeqBySession.set(sessionId, seq);
    let count: any;
    try {
      count = await fetchCount(sessionId);
    } catch {
      return; // network blip — does not advance the applied guard
    }
    if (count == null) return; // nothing to apply — does not advance the applied guard
    // Apply only when this result is newer than the last successfully applied
    // one. Older results that lose the race (or arrive after a newer success)
    // are discarded so the badge never regresses; failed/null newer requests
    // never advance the guard, so a valid older result is not stranded.
    if (seq <= (appliedSeqBySession.get(sessionId) || 0)) return;
    appliedSeqBySession.set(sessionId, seq);
    applyCount(sessionId, count);
  };
}

/**
 * Apply the Changes-badge side effects for a WebSocket event. This is the
 * core "live badge" contract, extracted from App.jsx's WS handler so it can
 * be unit-tested without rendering the app:
 *
 *  - `code_changed` (first dirty transition; the session must exist): refresh
 *    the closed-pane badge count and bump the open-pane reload token.
 *  - `done` (turn end): same, but only for worktree sessions — re-tally so the
 *    badge reflects every file touched during the turn (`code_changed` only
 *    fires once, on the first transition).
 *  - any other event / unknown or missing session: no-op.
 *
 * The two effects are injected so this stays a pure dispatcher and the App
 * handler is a thin caller.
 *
 * @param {{ type?: string, sessionId?: string } | null} event
 * @param {object} opts
 * @param {Array<{ id: string }>} opts.sessions current sessions list
 * @param {(sessionId: string) => void} opts.refresh refetch + update badge count
 * @param {(sessionId: string) => void} opts.bumpReloadToken refresh an open diff pane
 * @returns {boolean} whether any effect fired
 */
export function applyDiffCountWsEffect(event: any, { sessions, refresh, bumpReloadToken }: any) {
  if (!event || !event.sessionId) return false;
  const { type, sessionId } = event;
  const session = Array.isArray(sessions) ? sessions.find((s: any) => s.id === sessionId) : null;
  if (!session) return false;
  if (type === 'code_changed') {
    bumpReloadToken(sessionId);
    refresh(sessionId);
    return true;
  }
  if (type === 'done') {
    if (!isWorktreeSession(session)) return false;
    bumpReloadToken(sessionId);
    refresh(sessionId);
    return true;
  }
  return false;
}
