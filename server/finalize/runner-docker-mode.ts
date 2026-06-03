/**
 * How ubuntu-24.04 finalize runners reach Docker for nested compose.
 *
 * - `dind` (default): privileged job container with its own dockerd — GHA parity.
 * - `host-socket`: legacy per-step containers mounting the host docker.sock.
 */
export type FinalizeRunnerDockerMode = 'dind' | 'host-socket';

export function resolveRunnerDockerMode(): FinalizeRunnerDockerMode {
  const raw = process.env.FINALIZE_RUNNER_DOCKER_MODE?.trim().toLowerCase();
  if (raw === 'host-socket') return 'host-socket';
  return 'dind';
}

export function isDindRunnerMode(): boolean {
  return resolveRunnerDockerMode() === 'dind';
}
