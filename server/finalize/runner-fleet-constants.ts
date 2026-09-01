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

/**
 * Platforms the remote fleet can run NATIVE (non-container) jobs on — i.e. which
 * `runs-on` families it can dispatch to a native agent. The macOS runner-agent
 * runs iOS jobs natively (no container), so the fleet advertises `darwin`.
 *
 * This is what the remote backend reports as `nativeHostPlatforms`, so a Linux
 * Hub with the remote backend accepts `runs-on: macos-*` and enqueues it to the
 * macOS runner class instead of rejecting it as "no macOS host" (the coordinator
 * platform is irrelevant — the fleet, not the Hub, provides the Mac).
 *
 * Override with FINALIZE_FLEET_NATIVE_PLATFORMS (comma-separated), e.g.
 * `darwin,linux`, or empty to disable native fleet dispatch entirely (a
 * deployment with no macOS agents can turn it off so macOS jobs fail fast rather
 * than queueing forever).
 */
export const DEFAULT_FLEET_NATIVE_PLATFORMS: readonly NodeJS.Platform[] = ['darwin'];

export function resolveFleetNativePlatforms(
  env: NodeJS.ProcessEnv = process.env,
): readonly NodeJS.Platform[] {
  const raw = env.FINALIZE_FLEET_NATIVE_PLATFORMS;
  if (raw === undefined) return DEFAULT_FLEET_NATIVE_PLATFORMS;
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as NodeJS.Platform[];
  return parsed;
}
