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

export function isTerminalStatus(status) {
  return !!status && TERMINAL_STATUSES.has(status);
}

export function isFinalizeBlocked(status) {
  return !!status && FINALIZE_BLOCKED_STATUSES.has(status);
}

/**
 * Short human label for a phase + status pair. Used by the in-flight
 * label on the mobile button so the wording matches the web badge.
 * The `running` branch special-cases `phase === 'tasks'` so the user
 * sees "running checks" rather than the generic "running" once the
 * orchestrator entered the step-runner phase.
 */
export function describeRunPhase(status, phase) {
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

// Exported for tests so the membership predicates can be asserted
// against the canonical sets rather than re-derived in the spec.
export const __test = { TERMINAL_STATUSES, FINALIZE_BLOCKED_STATUSES };
