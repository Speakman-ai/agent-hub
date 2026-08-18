/**
 * runner-lost.ts — the cross-module contract for marking a reaped Finalize
 * job as a single dead runner (crash, OOM, Spot kill that missed IMDS, dropped
 * transport) rather than a deterministic environment fault.
 *
 * ## Why this exists
 *
 * `spot_reclaimed` requires the agent to have posted an IMDS interruption
 * notice before its lease expired. `hub_unavailable` requires a whole batch of
 * leases to expire in one tick. A *single* Spot reclaim often hits neither:
 * AWS terminates the instance, the agent never heartbeats the notice, and the
 * reaper sees one expired lease. That used to fall through to
 * `container_unavailable` and the conservative retry cap, which parks the run
 * after one or two generations even though a fresh agent would recover.
 *
 * A missing heartbeat is never the change set. Crash, OOM, deploy/scale-in,
 * and an IMDS-missed Spot kill all recover on a new agent. So a single
 * lease-expiry earns the same generous retry-generation cap as a known Spot
 * reclaim / Hub blip (see `resolveRetryGenerationCap`).
 *
 * ## The seam
 *
 * Same as `spot-interruption.ts` / `hub-unavailable.ts`: embed a marker in the
 * `Error.message` passed to `RunnerJobChannel.fail()`, and read it back with
 * {@link detailIsRunnerLost}. step-runner checks Spot first, then Hub blip,
 * then this, else `container_unavailable`.
 */

export const RUNNER_LOST_DETAIL_MARKER = '[runner_lost]';

export function runnerLostDetail(humanMessage: string): string {
  return `${RUNNER_LOST_DETAIL_MARKER} ${humanMessage}`;
}

export function detailIsRunnerLost(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return detail.includes(RUNNER_LOST_DETAIL_MARKER);
}
