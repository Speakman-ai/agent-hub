/**
 * In-memory timers that advance the reviewer Check Run from `context` →
 * `analyze` mid-session. Kept in a dedicated module so `pr-actions.ts` can
 * cancel them without importing the full `webhooks.ts` graph (which pulls DB
 * and native deps not needed for POST /api/pr/review).
 */

const ANALYZE_PHASE_DELAY_MS = 15_000;
const analyzePhaseTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function analyzePhaseTimerKey(repoFullName: string, prNumber: number): string {
  return `${repoFullName}#${prNumber}`;
}

/**
 * Cancel a pending `analyze` phase advance for a PR. Called from
 * `pr-actions.ts` when the formal review lands so we don't stomp on the
 * completed Check Run with a late-firing PATCH.
 */
export function cancelAnalyzePhaseTimer(repoFullName: string, prNumber: number): void {
  const key = analyzePhaseTimerKey(repoFullName, prNumber);
  const t = analyzePhaseTimers.get(key);
  if (t) {
    clearTimeout(t);
    analyzePhaseTimers.delete(key);
  }
}

/**
 * Schedule the `context → analyze` transition so the GitHub Checks panel
 * animates mid-run. Cancelled by {@link cancelAnalyzePhaseTimer}.
 */
export function scheduleReviewerAnalyzePhaseTransition(args: {
  repoFullName: string;
  prNumber: number;
  onFire: () => void;
}): void {
  const analyzeKey = analyzePhaseTimerKey(args.repoFullName, args.prNumber);
  const existingAnalyze = analyzePhaseTimers.get(analyzeKey);
  if (existingAnalyze) clearTimeout(existingAnalyze);
  const analyzeTimer = setTimeout(() => {
    analyzePhaseTimers.delete(analyzeKey);
    args.onFire();
  }, ANALYZE_PHASE_DELAY_MS);
  if (typeof analyzeTimer.unref === 'function') analyzeTimer.unref();
  analyzePhaseTimers.set(analyzeKey, analyzeTimer);
}

/** Test-only: clear every pending analyze timer. */
export function clearAllAnalyzePhaseTimers(): void {
  for (const t of analyzePhaseTimers.values()) clearTimeout(t);
  analyzePhaseTimers.clear();
}
