/**
 * Map ci.yaml `runs-on` labels to Docker images for Finalize v2 job containers.
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
 * Resolve a `runs-on` label to a Docker image reference.
 * Returns `null` for host execution (v1 / legacy).
 */
export function resolveRunsOnImage(runsOn: string): string | null {
  const key = runsOn.trim().toLowerCase();
  if (key === 'host') return null;
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
