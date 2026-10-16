/**
 * How a fleet desktop's stop is confirmed. The Hub frees a desktop's slot
 * (and lets it resume elsewhere, or its home be deleted) only on evidence
 * that its container is gone, never on a runner merely going quiet: a runner
 * can't promise its own deadline when a Docker call hangs or removal keeps
 * failing. The evidence is one of:
 *
 *   - the runner finished the job (it does so only after the container is
 *     removed and the home upload was accepted or discarded);
 *   - no runner ever claimed the job;
 *   - the runner's host was reclaimed: it reported an EC2 Spot interruption
 *     notice and has been silent for DESKTOP_SPOT_RECLAIM_GRACE_MS since
 *     (EC2 terminates the instance two minutes after the notice);
 *   - the runner agent was retired as `dead` (`runner_agents.state`), by an
 *     operator or automation that verified its host is gone.
 *
 * Without any of these the desktop keeps its slot and reads as `stopping`.
 *
 * The runner also stops its own desktop after DESKTOP_RUNNER_SELF_STOP_MS
 * without reaching the Hub. That is hygiene for a partitioned runner, not
 * something the Hub relies on. Pure constants: the runner agent bundle
 * imports this file.
 */
export const DESKTOP_RUNNER_SELF_STOP_MS = 10 * 60_000;
export const DESKTOP_SPOT_RECLAIM_GRACE_MS = 5 * 60_000;
