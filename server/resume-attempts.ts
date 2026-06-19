/**
 * Crash-loop guard for automatic post-restart session resume.
 *
 * When the server restarts mid-turn, `reconcileOrphanedTasks` (index.ts)
 * re-spawns each orphaned session on boot. Without a cap, a server stuck in a
 * crash/restart loop (e.g. a bad deploy that dies before any turn completes)
 * would re-spawn the same sessions on every boot forever.
 *
 * Each session carries a persistent `resume_attempts` counter (sessions table):
 *  - incremented per boot, just before an orphaned turn is re-spawned;
 *  - reset to 0 when a fresh, externally-initiated turn is actually committed
 *    and about to spawn (NOT on message receipt) — past validation and the
 *    session-busy / duplicate-send enqueue guard — provided the turn is not
 *    itself an automatic crash-resume (human message, queue drain, cron,
 *    autonomous dispatch — see the `_autoResume` gate in chat.ts `handleChat`,
 *    placed just before `insertActiveTask`).
 *
 * So the counter only grows across *consecutive* automatic crash-resumes that
 * are themselves interrupted before completing. Once it reaches
 * MAX_RESUME_ATTEMPTS we stop auto-resuming and surface an error message for a
 * human to pick up.
 *
 * Resetting at the start of a fresh turn (rather than only on a clean process
 * exit) is what guarantees the contract that a human-initiated turn always
 * supersedes a prior give-up: even if the server restarts before that turn
 * reaches a clean exit, reconcile sees `resume_attempts = 0` and auto-resumes
 * it with a full budget. The counter governs AUTOMATIC boot resume only —
 * externally-initiated turns never increment it and are never capped.
 */
export const MAX_RESUME_ATTEMPTS = 3;

/**
 * Decide whether to give up auto-resuming a session given how many consecutive
 * automatic resume attempts have already been made without a clean completion.
 *
 * @param priorAttempts the session's current `resume_attempts` value (treats
 *   nullish / negative as 0).
 * @param max override the cap (defaults to MAX_RESUME_ATTEMPTS).
 */
export function shouldGiveUpAutoResume(
  priorAttempts: number | null | undefined,
  max: number = MAX_RESUME_ATTEMPTS,
): boolean {
  const attempts = typeof priorAttempts === 'number' && priorAttempts > 0 ? priorAttempts : 0;
  return attempts >= max;
}

/**
 * Decide whether a starting turn should clear the session's `resume_attempts`
 * cap. True for any fresh, externally-initiated turn; false for an automatic
 * crash-resume (whose increment must stand) and for in-turn ReAct
 * continuations (which would otherwise reset the cap mid-resume, since only the
 * first handle of an auto-resume carries `_autoResume`).
 */
export function shouldResetResumeAttemptsOnTurnStart(opts: {
  isAutoResume?: boolean;
  isAutoContinuation?: boolean;
}): boolean {
  return !opts.isAutoResume && !opts.isAutoContinuation;
}
