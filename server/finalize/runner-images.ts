/**
 * Map ci.yaml `runs-on` labels to Docker images for Finalize job containers.
 *
 * Override the default tag with FINALIZE_RUNNER_IMAGE_UBUNTU_24_04 env var
 * when testing a locally built image.
 */

export const FINALIZE_RUNNER_WORKSPACE = '/github/workspace';

/** Default local tag from server/finalize/runner/Dockerfile */
export const DEFAULT_UBUNTU_24_04_IMAGE = 'agent-hub/finalize-runner:ubuntu-24.04';

const RUNS_ON_MAP: Record<string, string | null> = {
  host: null,
  'ubuntu-24.04': DEFAULT_UBUNTU_24_04_IMAGE,
  'ubuntu-latest': DEFAULT_UBUNTU_24_04_IMAGE,
};

/**
 * The `macos` `runs-on` label family: `macos` or `macos-<anything>`.
 *
 * Matched by PATTERN, not an enumerated allowlist, on purpose. GitHub's macOS
 * runner labels are open-ended and keep growing — versioned (`macos-13`,
 * `macos-14`, `macos-15`, `macos-26`, and every future release), sized
 * (`macos-15-large`, `macos-15-xlarge`, `macos-26-xlarge`), arch'd
 * (`macos-14-arm64`), plus `macos-latest*`. An exact-match set silently drops
 * any variant it forgot, and — because an unrecognised bare label falls through
 * to the native-host path with NO platform guard — that dropped label would run
 * macOS steps on a Linux host. Conservatively claiming the whole `macos-*`
 * family closes that hole for current and future variants at once.
 */
const MACOS_RUNS_ON_PATTERN = /^macos(-.+)?$/;

/**
 * True when `runs-on` targets a native macOS runner host — any label in the
 * `macos` family (see {@link MACOS_RUNS_ON_PATTERN}). These jobs run directly on
 * the host, never in a container, so `isContainerRunsOn` is always `false` for
 * them.
 *
 * This is the single source of truth every macOS consumer funnels through
 * (`resolveRunsOnImage` → `isContainerRunsOn`, and `macosRunnerMismatch`), so
 * the family pattern here keeps image resolution and the platform guard in
 * lockstep — a label can never be host-routed by one and unguarded by the other.
 *
 * A fully-qualified image ref (contains `/` or `:`) is never a macOS runner
 * label, so it's excluded here to preserve the image-ref pass-through in
 * `resolveRunsOnImage` (e.g. `ghcr.io/org/macos-tools:v1`).
 */
export function isMacosRunsOn(runsOn: string): boolean {
  const key = runsOn.trim().toLowerCase();
  if (key.includes('/') || key.includes(':')) return false;
  return MACOS_RUNS_ON_PATTERN.test(key);
}

/**
 * Resolve a `runs-on` label to a Docker image reference.
 *
 * Returns `null` when the job runs directly on the host rather than in a
 * container: `runs-on: host` (what `finalize-setup` proposes for lightweight
 * gates that need no Docker), a native macOS label (see {@link isMacosRunsOn} —
 * macOS/Xcode can't run in a Linux container), or an unrecognised bare label.
 */
export function resolveRunsOnImage(runsOn: string): string | null {
  const key = runsOn.trim().toLowerCase();
  if (key === 'host') return null;
  // macOS labels are native-host, never a container image. Resolve them to null
  // explicitly (before the image-ref pass-through below) so intent is clear and
  // a macOS label can never leak into the container path.
  if (isMacosRunsOn(key)) return null;
  const mapped = RUNS_ON_MAP[key];
  if (mapped) {
    if (key === 'ubuntu-24.04' || key === 'ubuntu-latest') {
      return process.env.FINALIZE_RUNNER_IMAGE_UBUNTU_24_04?.trim() || mapped;
    }
    return mapped;
  }
  // Allow fully-qualified image refs for advanced configs
  if (runsOn.includes('/') || runsOn.includes(':')) {
    return runsOn;
  }
  return null;
}

export function isContainerRunsOn(runsOn: string): boolean {
  return resolveRunsOnImage(runsOn) !== null;
}

/** Runner queue class for macOS jobs — only a macOS agent claims these. */
export const MACOS_RUNNER_CLASS = 'macos';
/** Default runner queue class (Linux DinD agents). */
export const DEFAULT_RUNNER_CLASS = 'default';

/**
 * Map a `runs-on` label to the runner queue class that may claim it.
 *
 * The fleet is class-partitioned so a Linux DinD agent never claims a macOS job
 * (and vice versa): the remote backend enqueues under this class and each agent
 * claims only its own class. macOS labels → `macos`; everything else → `default`.
 */
export function runnerClassForRunsOn(runsOn: string): string {
  return isMacosRunsOn(runsOn) ? MACOS_RUNNER_CLASS : DEFAULT_RUNNER_CLASS;
}

/**
 * Guard a macOS `runs-on` job against a Finalize backend that cannot provide a
 * macOS runner.
 *
 * A `runs-on: macos-*` job needs its steps to run natively on a macOS host
 * (there is no macOS container — Xcode can't run in Linux Docker). Whether that
 * is possible depends on the SELECTED BACKEND, not on the Hub coordinator's own
 * `process.platform`:
 *   - the `local` backend runs native jobs on the Hub host, so it advertises
 *     `[process.platform]` — a Mac Hub can satisfy macOS, a Linux Hub cannot;
 *   - a `remote` fleet backend advertises the platforms its runner pool
 *     provides (today none for macOS), independent of where the Hub runs.
 *
 * So this consults the backend's `nativeHostPlatforms` capability. It returns a
 * clear, user-facing reason string when that capability cannot satisfy macOS so
 * the caller fails the job fast; it returns `null` when the job may proceed
 * (`'darwin'` is available) or the label is not a macOS label at all.
 *
 * Pure: the backend kind + platforms are injected, so the decision is fully
 * unit-testable without a real Hub host or backend.
 */
export function macosRunnerMismatch(
  runsOn: string,
  backendKind: string,
  nativeHostPlatforms: readonly NodeJS.Platform[],
): string | null {
  if (!isMacosRunsOn(runsOn)) return null;
  if (nativeHostPlatforms.includes('darwin')) return null;
  const available = nativeHostPlatforms.length > 0 ? nativeHostPlatforms.join(', ') : 'none';
  return (
    `runs-on: ${runsOn.trim()} requires a macOS runner, but the active '${backendKind}' ` +
    `Finalize backend provides no macOS host (native platforms: ${available}). macOS/Xcode ` +
    `cannot run in a Linux container. Run Agent Hub on a macOS host (local backend), or ` +
    `configure a macOS fleet runner, to build/test/deploy iOS apps.`
  );
}
