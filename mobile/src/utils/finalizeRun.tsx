/**
 * Mobile mirror of the status helpers from
 * `client/src/hooks/useFinalizeRun.js`.
 *
 * Why a separate file (and not an import from the web hook)?
 *   - The web hook calls `window.addEventListener` at module top level,
 *     which doesn't exist in React Native.
 *   - The mobile `<FinalizeButton>` runs without a WS bridge today and
 *     polls instead — the helpers it needs are a small subset of the
 *     web hook's surface.
 *
 * Drift policy: this file MUST stay in lock-step with
 * `useFinalizeRun.js`. If the web hook adds a status or a phase, mirror
 * it here in the same commit. The status set in particular is the
 * source of truth for the disabled-button gate — letting it drift would
 * silently re-enable the button mid-run.
 */
/** Terminal status codes — see `FinalizeRunStatus` in server/types.ts. */
const TERMINAL_STATUSES = new Set([
  'pushed',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
]);
/**
 * Set of statuses during which a "Finalize" affordance must be disabled.
 * Mirrors `isFinalizeBlocked` on the web side.
 */
const FINALIZE_BLOCKED_STATUSES = new Set([
  'queued',
  'rebasing',
  'reviewing',
  'running',
  'dispatching',
  'pushing',
]);
export function isTerminalStatus(status: any) {
  return !!status && TERMINAL_STATUSES.has(status);
}
export function isFinalizeBlocked(status: any) {
  return !!status && FINALIZE_BLOCKED_STATUSES.has(status);
}
/**
 * Short human label for a phase + status pair. Used by the in-flight
 * label on the mobile button so the wording matches the web badge.
 * The `running` branch special-cases `phase === 'tasks'` so the user
 * sees "running checks" rather than the generic "running" once the
 * orchestrator entered the step-runner phase.
 */
export function describeRunPhase(status: any, phase: any) {
  if (!status) return 'idle';
  switch (status) {
    case 'queued':
      return 'queued';
    case 'rebasing':
      return 'rebasing';
    case 'reviewing':
      return 'reviewing';
    case 'running':
      return phase === 'tasks' ? 'running checks' : 'running';
    case 'dispatching':
      return 'awaiting fix';
    case 'pushing':
      return 'pushing';
    case 'pushed':
      return 'pushed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed out';
    case 'infra_error':
      return 'infra error';
    case 'cancelled':
      return 'cancelled';
    case 'stalled_no_response':
      return 'stalled';
    default:
      return String(status).replace(/_/g, ' ');
  }
}
/**
 * Freshness window (ms) for the live finalize WS stream. If no
 * `finalize_run_*` event for the active session has arrived within this
 * window, the polling fallback resumes even while the socket reports
 * connected — covering the "connected but silent / reconnected after missing
 * a frame" case. Kept well above the 2s poll cadence so a normally-flowing
 * stream doesn't thrash polling on and off between phase events.
 */
export const FINALIZE_LIVE_FRESH_MS = 15000;
/**
 * Decide whether the FinalizeButton polling fallback should issue a network
 * fetch on a given tick.
 *
 * Polling is the safety net for when the live WebSocket stream isn't
 * delivering finalize events. We SKIP the fetch only while the stream is
 * demonstrably healthy: the socket is connected AND a finalize event for THIS
 * session arrived within `freshMs`. Any of these resumes polling so the button
 * can never get stuck in a non-terminal state:
 *   - socket disconnected (`connected === false`);
 *   - the last event belongs to a different session (or none seen yet);
 *   - the last event is stale — older than `freshMs` (covers a reconnect that
 *     missed the terminal frame, or a server that went silent).
 *
 * Pure / synchronous; `now` and `freshMs` are injected so it's unit-testable.
 *
 * @param {{
 *   connected: boolean,
 *   lastEvent: { sessionId?: string, bump?: number } | null | undefined,
 *   sessionId: string | null | undefined,
 *   now: number,
 *   freshMs?: number,
 * }} args
 * @returns {boolean} true → poll (fetch); false → skip this tick.
 */
export function shouldPollFinalizeFallback({
  connected,
  lastEvent,
  sessionId,
  now,
  freshMs = FINALIZE_LIVE_FRESH_MS,
}: any) {
  if (!sessionId) return false;
  if (!connected) return true;
  if (!lastEvent || lastEvent.sessionId !== sessionId) return true;
  if (typeof lastEvent.bump !== 'number') return true;
  return now - lastEvent.bump >= freshMs;
}
// Exported for tests so the membership predicates can be asserted
// against the canonical sets rather than re-derived in the spec.
export const __test = { TERMINAL_STATUSES, FINALIZE_BLOCKED_STATUSES };
