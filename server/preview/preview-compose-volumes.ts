/**
 * Belt-and-suspenders cleanup for compose-managed preview volumes.
 *
 * `docker compose down -v` should drop project-scoped named volumes, but
 * when `down` fails (disk full, hung daemon, corrupt postgres) Agent Hub
 * still deletes the DB row to reclaim the host port — volumes can leak.
 * This module removes volumes by compose project name after every stop.
 */
import { spawnSync, type SpawnSyncReturns } from 'child_process';

/** Named volumes declared in Webapp `compose.preview.yml` (and peers). */
export const COMPOSE_PROJECT_VOLUME_SUFFIXES = [
  'preview-postgres-data',
  'preview-frontend-node-modules',
] as const;

export type ComposeVolumeCleanupLogger = {
  warn: (message: string) => void;
};

export type RemoveComposeProjectVolumesDeps = {
  composeProjectName: string;
  spawnSync?: typeof spawnSync;
  logger?: ComposeVolumeCleanupLogger;
};

export function expectedComposeProjectVolumeNames(composeProjectName: string): string[] {
  return COMPOSE_PROJECT_VOLUME_SUFFIXES.map((suffix) => `${composeProjectName}_${suffix}`);
}

export function buildDockerVolumeLsByProjectArgs(composeProjectName: string): string[] {
  return [
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${composeProjectName}`,
  ];
}

export function buildDockerVolumeRmArgs(volumeName: string): string[] {
  return ['volume', 'rm', '-f', volumeName];
}

/** Parse `docker volume ls -q` stdout (one name per line). */
export function parseDockerVolumeLsOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function listComposeProjectVolumeNames(
  composeProjectName: string,
  spawnSyncFn: typeof spawnSync = spawnSync,
): string[] {
  const names = new Set<string>(expectedComposeProjectVolumeNames(composeProjectName));
  try {
    const result: SpawnSyncReturns<string> = spawnSyncFn(
      'docker',
      buildDockerVolumeLsByProjectArgs(composeProjectName),
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    for (const name of parseDockerVolumeLsOutput(result.stdout ?? '')) {
      names.add(name);
    }
  } catch {
    // `docker volume ls` unavailable — still attempt known suffix names.
  }
  return [...names];
}

/**
 * Best-effort `docker volume rm -f` for every volume tied to a compose
 * project. Idempotent: missing volumes are ignored by Docker.
 */
export function removeComposeProjectVolumes(deps: RemoveComposeProjectVolumesDeps): void {
  const spawnSyncFn = deps.spawnSync ?? spawnSync;
  const logger = deps.logger;
  const names = listComposeProjectVolumeNames(deps.composeProjectName, spawnSyncFn);
  if (names.length === 0) return;

  for (const name of names) {
    try {
      const result = spawnSyncFn('docker', buildDockerVolumeRmArgs(name), {
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (result.status !== 0) {
        const detail = (result.stderr ?? '').trim() || result.error?.message || 'unknown error';
        logger?.warn(`[preview-compose] volume rm ${name} failed: ${detail}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.warn(`[preview-compose] volume rm ${name} threw: ${msg}`);
    }
  }
}
