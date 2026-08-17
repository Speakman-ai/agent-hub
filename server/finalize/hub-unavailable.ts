/**
 * hub-unavailable.ts — the cross-module contract for marking a reaped Finalize
 * job as collateral of a Hub-side blip (the Hub process restarted or was
 * briefly unreachable) rather than a per-agent crash.
 *
 * ## Why this exists
 *
 * A runner agent heartbeats to the Hub on every tick. When the Hub itself
 * restarts (a frequent event on auto-deploy hubs) or is briefly unreachable,
 * EVERY in-flight agent's heartbeat fails at once — not because the agents
 * crashed, but because the far side went away. On the next reaper tick their
 * leases have all expired together, so `reapDeadRunnerJobs` marks a whole
 * batch `lost` in a single tick. That "N jobs reaped in one tick" shape is the
 * tell: N independent agents do not crash simultaneously; the Hub side blinked.
 *
 * A Hub restart is a known-transient EXTERNAL event, exactly like an EC2 Spot
 * reclaim — it has nothing to do with the change set and recovers on its own in
 * seconds. So a job lost to it deserves the same generous retry-generation cap a
 * reclaim earns (see `resolveRetryGenerationCap`), instead of the conservative
 * `container_unavailable` cap that can park a run caught by back-to-back restart
 * windows before the Hub stabilises.
 *
 * ## The seam
 *
 * The only channel between the Hub-side reaper and step-runner's classification
 * hot path is the `Error.message` passed to `RunnerJobChannel.fail()` — there is
 * no structured failure-reason field on that path. So we embed a string marker
 * in the `detail`, exactly as `spot-interruption.ts` does for reclaims, and read
 * it back with {@link detailIsHubUnavailable} so the exact token lives in one
 * place. step-runner checks the Spot marker first (a job can only carry one),
 * then this one, else falls back to `container_unavailable`.
 */

/**
 * Marker embedded in a lost-job `detail` string to signal that the loss was
 * collateral of a Hub restart / brief Hub unreachability (a whole batch of leases
 * reaped in one tick), not a per-agent crash. `step-runner.ts` reads this off the
 * spawn-error detail to choose `hub_unavailable` over `container_unavailable` as
 * the terminal `failure_reason`.
 */
export const HUB_UNAVAILABLE_DETAIL_MARKER = '[hub_unavailable]';

/**
 * Build the human-readable `detail` for a job lost to a Hub blip, prefixed with
 * {@link HUB_UNAVAILABLE_DETAIL_MARKER} so the classification seam in step-runner
 * can recognise it. Use for the `RunnerJobChannel.fail()` message when a whole
 * batch of leases expired in one reaper tick.
 */
export function hubUnavailableDetail(humanMessage: string): string {
  return `${HUB_UNAVAILABLE_DETAIL_MARKER} ${humanMessage}`;
}

/**
 * Does a lost-job `detail` string indicate a known Hub blip? Pure; safe to call
 * from the step-runner classification hot path.
 */
export function detailIsHubUnavailable(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return detail.includes(HUB_UNAVAILABLE_DETAIL_MARKER);
}
