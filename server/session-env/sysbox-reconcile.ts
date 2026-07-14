/**
 * Boot-time reconcile sweep for leaked sysbox session containers/volumes.
 *
 * Session envs live only in Hub memory, so after a Hub crash or restart any
 * still-running session container is orphaned — and `docker container prune`
 * (the daily host GC timer) only removes STOPPED containers, so a leaked
 * RUNNING session env would hold CPU, RAM, and its inner-docker graph volume
 * forever. This sweep is the GC-parity piece the old per-session compose
 * teardown had via `docker compose down -v` reconciliation: at boot, every
 * container/volume carrying the session-env label belongs to a dead Hub run
 * and is removed.
 *
 * Volumes are swept independently of containers: a crash between `docker
 * volume create` and `docker run` (or a failed `volume rm` at dispose) leaks
 * a labeled volume with no container.
 */

import {
  buildListSysboxSessionContainersArgv,
  buildListSysboxSessionVolumesArgv,
  buildStopSysboxContainerArgv,
} from './sysbox-exec-args.js';
import { runDockerCommand, type SysboxRunFn } from './sysbox-session-env.js';

export interface SysboxReconcileResult {
  containersRemoved: number;
  volumesRemoved: number;
  errors: string[];
}

export interface SysboxReconcileDeps {
  run?: SysboxRunFn;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

function parseLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Remove every labeled session-env container and graph volume. */
export async function reconcileSysboxSessionEnvs(
  deps: SysboxReconcileDeps = {},
): Promise<SysboxReconcileResult> {
  const run = deps.run ?? runDockerCommand;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const result: SysboxReconcileResult = { containersRemoved: 0, volumesRemoved: 0, errors: [] };

  const containers = await run(buildListSysboxSessionContainersArgv());
  if (!containers.ok) {
    result.errors.push(`list containers failed: ${containers.stderr.trim()}`);
  } else {
    for (const id of parseLines(containers.stdout)) {
      const rm = await run(buildStopSysboxContainerArgv(id));
      if (rm.ok) {
        result.containersRemoved += 1;
      } else {
        result.errors.push(`rm container ${id} failed: ${rm.stderr.trim()}`);
      }
    }
  }

  const volumes = await run(buildListSysboxSessionVolumesArgv());
  if (!volumes.ok) {
    result.errors.push(`list volumes failed: ${volumes.stderr.trim()}`);
  } else {
    for (const name of parseLines(volumes.stdout)) {
      // The list already yields full volume names — remove them verbatim.
      const rm = await run(['docker', 'volume', 'rm', '-f', name]);
      if (rm.ok) {
        result.volumesRemoved += 1;
      } else {
        result.errors.push(`rm volume ${name} failed: ${rm.stderr.trim()}`);
      }
    }
  }

  if (result.containersRemoved > 0 || result.volumesRemoved > 0) {
    log(
      `[session-env] reconcile: removed ${result.containersRemoved} leaked session container(s), ` +
        `${result.volumesRemoved} graph volume(s)`,
    );
  }
  for (const err of result.errors) warn(`[session-env] reconcile: ${err}`);
  return result;
}
