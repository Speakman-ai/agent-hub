/**
 * Pure view-helpers for the mobile Finalize UI on the Changes screen.
 *
 * Kept free of React / React Native imports so the logic that drives the
 * Finalize button, the CI card, and the review card can be unit-tested in the
 * node vitest suite. Mirrors the derivations in the web finalize components
 * (`FinalizeButton.jsx`, `FinalizeChecksRoundBlock.jsx`, `ReviewerThreadsPanel.jsx`).
 */
import { isFinalizeBlocked } from './finalizeRun';
/**
 * Summarize a finalize run's CI steps into a single pass/fail headline.
 *
 * @param {Array<{name?: string, state?: string}>|null|undefined} steps
 * @returns {{ total: number, passed: number, failed: number, running: number,
 *   failedName: string|null, allPassed: boolean, headline: string }}
 */
export function summarizeChecks(steps: any) {
  const list = Array.isArray(steps) ? steps : [];
  const total = list.length;
  let passed = 0;
  let failed = 0;
  let running = 0;
  let failedName = null;
  for (const s of list) {
    if (s?.state === 'passed') passed += 1;
    else if (s?.state === 'failed') {
      failed += 1;
      if (!failedName) failedName = s?.name || 'A step';
    } else if (s?.state === 'running' || s?.state === 'queued') running += 1;
  }
  const allPassed = total > 0 && passed === total;
  let headline;
  if (total === 0) headline = 'No checks yet';
  else if (failed > 0) headline = `${failedName} failed`;
  else if (running > 0) headline = `${passed}/${total} passed · running`;
  else headline = `${passed}/${total} passed`;
  return { total, passed, failed, running, failedName, allPassed, headline };
}
/**
 * Group reviewer threads by file path, preserving first-seen order, so the
 * review card can render one collapsible section per file.
 *
 * @param {Array<{file_path?: string}>|null|undefined} threads
 * @returns {Array<{ file: string, items: Array<object> }>}
 */
export function groupThreadsByFile(threads: any) {
  const list = Array.isArray(threads) ? threads : [];
  const order = [];
  const byFile = new Map();
  for (const t of list) {
    const file = t?.file_path || '(general)';
    if (!byFile.has(file)) {
      byFile.set(file, []);
      order.push(file);
    }
    byFile.get(file).push(t);
  }
  return order.map((file: any) => ({ file, items: byFile.get(file) }));
}
/**
 * Derive the Finalize button's label/disabled/tone from run status.
 *
 * `fullyValidated` is true when both checks and review passed on the current
 * HEAD (the caller computes it from `phases`); `hasChanges` gates the button
 * when there is nothing committable to finalize.
 *
 * @returns {{ label: string, disabled: boolean, inFlight: boolean, tone: 'busy'|'done'|'default' }}
 */
export function deriveFinalizeButton({
  status,
  fullyValidated = false,
  hasChanges = true,
}: any = {}) {
  const inFlight = isFinalizeBlocked(status);
  if (inFlight) {
    return { label: 'Stop', disabled: false, inFlight: true, tone: 'busy' };
  }
  if (fullyValidated) {
    return { label: 'Finalized', disabled: !hasChanges, inFlight: false, tone: 'done' };
  }
  return { label: 'Finalize', disabled: !hasChanges, inFlight: false, tone: 'default' };
}
/**
 * Whether the Push to Agent Hub button should be enabled. Push is allowed once
 * a run is parked at `ready_to_push`, or when there are committable changes on
 * a terminal/idle run (a force-push path the caller confirms first).
 *
 * @returns {boolean}
 */
export function canPush({ status, hasChanges = false }: any = {}) {
  if (status === 'ready_to_push') return true;
  // Never offer push mid-run; otherwise allow it when there's something to ship.
  if (isFinalizeBlocked(status)) return false;
  return !!hasChanges;
}
/**
 * Both checks and review validated on the *same* HEAD commit → the branch is
 * finalized. Mirrors the web `fullyValidated` gate.
 *
 * @param {{ checks?: {status?: string, validated_head_sha?: string},
 *           review?: {status?: string, validated_head_sha?: string} }|null} phases
 * @returns {boolean}
 */
export function isFullyValidated(phases: any) {
  const checks = phases?.checks;
  const review = phases?.review;
  if (!checks || !review) return false;
  const passed = (p: any) => p?.status === 'ready_to_push' || p?.status === 'pushed';
  return (
    passed(checks) &&
    passed(review) &&
    !!checks.validated_head_sha &&
    checks.validated_head_sha === review.validated_head_sha
  );
}
/**
 * Guard against out-of-order async responses in the finalize/review pollers.
 *
 * Each effect run takes a monotonic generation token (bumped whenever the
 * keyed input changes — `sessionId` for the run poll, `projectId`/`runId` for
 * the review card). An in-flight request captures the live token at call time
 * and re-checks it after awaiting, before touching state. A response that
 * resolves after the key changed carries a stale token and must be dropped —
 * otherwise session A's run/findings could install under session B, which is
 * exactly the wrong-run Stop/Push (and stale-verdict) case.
 *
 * A shared boolean "cancelled" ref cannot do this: the next effect resets it to
 * `false`, so A's late response passes the check and installs under B. The
 * generation token is monotonic and never reset, so a stale request can never
 * masquerade as current.
 *
 * @param {number} capturedGen generation captured when the request started
 * @param {number} currentGen the live generation at resolve time
 * @returns {boolean} true iff the captured token still matches the live one
 */
export function isFreshGeneration(capturedGen: any, currentGen: any) {
  return capturedGen === currentGen;
}
/**
 * The cleared poll state for {@link useFinalizeRunPoll}.
 *
 * This is the value the hook must reset to the moment its `sessionId` changes:
 * a new session must never render the previous session's run id/status (which
 * would let Stop/Push act on the wrong finalize run) before the first poll for
 * the new session resolves. Centralised here so the reset path and the
 * "no data" path produce an identical shape that tests can pin.
 *
 * @returns {{ run: null, steps: Array<never>, phases: null }}
 */
export function emptyFinalizeRunState() {
  return { run: null, steps: [], phases: null };
}
/**
 * Normalize a `GET /sessions/:id/finalize-runs/latest` payload into the poll
 * state shape. Missing/garbage fields collapse to the cleared values so a
 * partial response can't smuggle a stale `run` through.
 *
 * @param {{ run?: unknown, steps?: unknown, phases?: unknown }|null|undefined} data
 * @returns {{ run: unknown, steps: Array<unknown>, phases: unknown }}
 */
export function normalizeFinalizeRunResult(data: any) {
  return {
    run: data?.run ?? null,
    steps: Array.isArray(data?.steps) ? data.steps : [],
    phases: data?.phases ?? null,
  };
}
/**
 * The cleared state for {@link ReviewerThreadsCard}.
 *
 * Reset to this whenever `projectId`/`runId` changes so findings from a
 * previous finalize run never render under a new run, and a transient fetch
 * failure on the new run can't leave the old review visible indefinitely.
 *
 * @returns {{ threads: Array<never>, verdict: null }}
 */
export function emptyReviewerThreads() {
  return { threads: [], verdict: null };
}
/**
 * Normalize a `GET /reviewer-threads` payload into the review-card shape.
 *
 * @param {{ threads?: unknown, reviewer_verdict?: unknown }|null|undefined} resp
 * @returns {{ threads: Array<unknown>, verdict: unknown }}
 */
export function normalizeReviewerThreads(resp: any) {
  return {
    threads: Array.isArray(resp?.threads) ? resp.threads : [],
    verdict: resp?.reviewer_verdict ?? null,
  };
}
