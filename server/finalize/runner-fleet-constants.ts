/**
 * runner-fleet-constants.ts — fleet-sizing defaults shared by the autoscaler and
 * the Hub-side job dispatcher.
 *
 * Deliberately dependency-free (no AWS SDK, no queue/DB) so `job-runner.ts` can
 * import the canonical fleet defaults without pulling the heavy modules that
 * `runner-fleet-scaler.ts` depends on. This is the single source of truth — the
 * scaler and the dispatcher both import from here so the remote backend can't
 * silently dispatch fewer jobs than the fleet is allowed to scale to.
 */

/** Default ASG/agent ceiling (override with FINALIZE_FLEET_MAX_AGENTS). */
export const DEFAULT_FLEET_MAX_AGENTS = 8;

/** Default warm-pool floor (override with FINALIZE_FLEET_MIN_AGENTS). */
export const DEFAULT_FLEET_MIN_AGENTS = 0;
