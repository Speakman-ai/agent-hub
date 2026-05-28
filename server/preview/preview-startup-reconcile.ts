import { spawnSync, type SpawnSyncReturns } from 'child_process';
import type { Database } from 'better-sqlite3';
import { removeComposeProjectVolumes } from './preview-compose-volumes.js';

export interface StartupReconcileLogger {
  log: (message: string) => void;
  warn: (message: string) => void;
}

export interface StartupReconcileDeps {
  db: Database;
  spawnSyncFn?: typeof spawnSync;
  logger?: StartupReconcileLogger;
}

export interface StartupReconcileResult {
  liveProjects: number;
  trackedProjects: number;
  orphanProjects: number;
  removedProjects: number;
  failedProjects: number;
}

const COMPOSE_PROJECT_PREFIX = 'agenthub-session-';

export function reconcileStartupOrphanComposeProjects(
  deps: StartupReconcileDeps,
): StartupReconcileResult {
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
  const logger = deps.logger ?? { log: (m) => console.log(m), warn: (m) => console.warn(m) };
  const live = listLiveComposeProjects(spawnSyncFn);
  const tracked = listTrackedComposeProjects(deps.db);
  const orphanProjects = [...live].filter((name) => !tracked.has(name));

  let removedProjects = 0;
  let failedProjects = 0;

  for (const composeProjectName of orphanProjects) {
    const ok = cleanupComposeProject(composeProjectName, spawnSyncFn, logger);
    if (ok) removedProjects++;
    else failedProjects++;
  }

  if (orphanProjects.length > 0) {
    logger.log(
      `[preview] startup: compose reconcile live=${live.size} tracked=${tracked.size} orphaned=${orphanProjects.length} removed=${removedProjects} failed=${failedProjects}`,
    );
  }

  return {
    liveProjects: live.size,
    trackedProjects: tracked.size,
    orphanProjects: orphanProjects.length,
    removedProjects,
    failedProjects,
  };
}

function listTrackedComposeProjects(db: Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT compose_project_name
         FROM worktree_preview_groups
        WHERE compose_project_name IS NOT NULL
          AND compose_project_name != ''`,
    )
    .all() as Array<{ compose_project_name: string }>;
  return new Set(
    rows
      .map((r) => r.compose_project_name.trim())
      .filter((name) => name.startsWith(COMPOSE_PROJECT_PREFIX)),
  );
}

function listLiveComposeProjects(spawnSyncFn: typeof spawnSync): Set<string> {
  try {
    const out: SpawnSyncReturns<string> = spawnSyncFn(
      'docker',
      [
        'ps',
        '-a',
        '--filter',
        'label=com.docker.compose.project',
        '--format',
        '{{.Label "com.docker.compose.project"}}',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (out.status !== 0) return new Set();
    return new Set(
      String(out.stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((name) => name.startsWith(COMPOSE_PROJECT_PREFIX)),
    );
  } catch {
    return new Set();
  }
}

function cleanupComposeProject(
  composeProjectName: string,
  spawnSyncFn: typeof spawnSync,
  logger: StartupReconcileLogger,
): boolean {
  const containerIds = listIdsByLabel('ps', composeProjectName, spawnSyncFn);
  if (containerIds.length > 0) {
    const rmRes = spawnSyncFn('docker', ['rm', '-f', ...containerIds], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (rmRes.status !== 0) {
      const detail = (rmRes.stderr ?? '').trim() || rmRes.error?.message || 'unknown error';
      logger.warn(
        `[preview] startup: failed removing orphan containers for ${composeProjectName}: ${detail}`,
      );
      return false;
    }
  }

  const networkIds = listIdsByLabel('network', composeProjectName, spawnSyncFn);
  if (networkIds.length > 0) {
    const netRes = spawnSyncFn('docker', ['network', 'rm', ...networkIds], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (netRes.status !== 0) {
      const detail = (netRes.stderr ?? '').trim() || netRes.error?.message || 'unknown error';
      logger.warn(
        `[preview] startup: failed removing orphan networks for ${composeProjectName}: ${detail}`,
      );
    }
  }

  removeComposeProjectVolumes({
    composeProjectName,
    spawnSync: spawnSyncFn,
    logger: { warn: logger.warn },
  });
  return true;
}

function listIdsByLabel(
  resource: 'ps' | 'network',
  composeProjectName: string,
  spawnSyncFn: typeof spawnSync,
): string[] {
  const args =
    resource === 'ps'
      ? ['ps', '-aq', '--filter', `label=com.docker.compose.project=${composeProjectName}`]
      : [
          'network',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${composeProjectName}`,
        ];
  try {
    const out: SpawnSyncReturns<string> = spawnSyncFn('docker', args, {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (out.status !== 0) return [];
    return String(out.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
