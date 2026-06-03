/**
 * finalize-reaper.ts — periodic safety-net cleanup for Finalize DinD runners.
 *
 * Per-job teardown (`stopJobContainer`) already `docker rm -f -v`s the runner
 * and removes its named graph volume. But when a run is HARD-killed — OOM,
 * ENOSPC, or the Hub process dies — that teardown never runs, leaking the
 * privileged runner container plus its multi-GB `<container>-graph` volume.
 * On a long-lived host those accumulate until the disk fills (the failure mode
 * that motivated this module).
 *
 * This reaper mirrors `preview-reaper`: a once-a-minute tick that
 *   1. removes finalize runner containers whose run is no longer active
 *      (terminal or absent in the DB) and past a short grace window, and
 *   2. sweeps any orphaned `finalize-*-graph` volumes not attached to a
 *      container (also catches the historical named-volume leak).
 *
 * Active runs (those with `ended_at IS NULL`) and their containers/volumes are
 * never touched. Docker ops are injected so the tick is unit-testable without
 * shelling out.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Label every finalize runner container carries (set in buildStartJobContainerArgv). */
export const FINALIZE_RUN_ID_LABEL = 'agent-hub.finalize.run_id';

/** Runs every minute, same cadence as the preview reaper. */
export const FINALIZE_REAPER_CRON = '* * * * *';

export interface FinalizeReaperConfig {
  /**
   * Skip containers younger than this. Guards against a race where a runner is
   * created a tick before its run row is observable as active.
   */
  graceMs: number;
}

export const DEFAULT_FINALIZE_REAPER_CONFIG: FinalizeReaperConfig = {
  graceMs: 120_000,
};

export interface FinalizeContainerInfo {
  name: string;
  runId: string | null;
  createdAtMs: number | null;
}

/** Docker operations, injectable so the reaper can be unit-tested. */
export interface FinalizeReaperDocker {
  /** `docker ps -a` filtered to finalize runner containers. */
  listFinalizeContainers(): Promise<FinalizeContainerInfo[]>;
  /** Names of all `finalize-*-graph` volumes. */
  listFinalizeGraphVolumes(): Promise<string[]>;
  /** `docker rm -f -v <name>` (force-remove the runner container). */
  removeContainer(name: string): Promise<void>;
  /** `docker volume rm <name>` — MUST reject if the volume is still in use. */
  removeVolume(name: string): Promise<void>;
}

export interface FinalizeReaperDeps {
  /** Run ids that are still in progress (`ended_at IS NULL`) — never reaped. */
  activeRunIds: () => Set<string>;
  docker?: FinalizeReaperDocker;
  config?: Partial<FinalizeReaperConfig>;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  now?: () => number;
}

export interface FinalizeReaperTickResult {
  containersReaped: string[];
  volumesReaped: string[];
  /** Containers left alone because their run is active or they're within grace. */
  skipped: number;
}

const FINALIZE_GRAPH_VOLUME_RE = /^finalize-.*-graph$/;

export const defaultFinalizeReaperDocker: FinalizeReaperDocker = {
  async listFinalizeContainers(): Promise<FinalizeContainerInfo[]> {
    const { stdout } = await execFileAsync('docker', [
      'ps',
      '-a',
      '--filter',
      `label=${FINALIZE_RUN_ID_LABEL}`,
      '--format',
      `{{.Names}}\t{{.Label "${FINALIZE_RUN_ID_LABEL}"}}\t{{.CreatedAt}}`,
    ]);
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, runId, createdAt] = line.split('\t');
        const t = createdAt ? Date.parse(createdAt) : NaN;
        return {
          name,
          runId: runId || null,
          createdAtMs: Number.isFinite(t) ? t : null,
        };
      });
  },
  async listFinalizeGraphVolumes(): Promise<string[]> {
    const { stdout } = await execFileAsync('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((n) => FINALIZE_GRAPH_VOLUME_RE.test(n));
  },
  async removeContainer(name: string): Promise<void> {
    await execFileAsync('docker', ['rm', '-f', '-v', name]);
  },
  async removeVolume(name: string): Promise<void> {
    // No `-f`: `docker volume rm` rejects an in-use volume, which is exactly the
    // signal we want (an active run's graph volume must be left alone).
    await execFileAsync('docker', ['volume', 'rm', name]);
  },
};

/**
 * One reaper tick. Best-effort: every docker call is guarded so a single
 * failure (e.g. a volume removed between list and rm) never aborts the sweep.
 */
export async function runFinalizeReaper(
  deps: FinalizeReaperDeps,
): Promise<FinalizeReaperTickResult> {
  const config = { ...DEFAULT_FINALIZE_REAPER_CONFIG, ...(deps.config ?? {}) };
  const logger = deps.logger ?? {
    log: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
  };
  const docker = deps.docker ?? defaultFinalizeReaperDocker;
  const now = deps.now ?? (() => Date.now());
  const active = deps.activeRunIds();

  const result: FinalizeReaperTickResult = {
    containersReaped: [],
    volumesReaped: [],
    skipped: 0,
  };

  // Phase 1: orphaned runner containers (run terminal/absent, past grace window).
  let containers: FinalizeContainerInfo[] = [];
  try {
    containers = await docker.listFinalizeContainers();
  } catch (err) {
    logger.warn(`[finalize-reaper] list containers failed: ${(err as Error).message}`);
  }
  for (const c of containers) {
    const runActive = c.runId != null && active.has(c.runId);
    const withinGrace = c.createdAtMs != null && now() - c.createdAtMs < config.graceMs;
    if (runActive || withinGrace) {
      result.skipped += 1;
      continue;
    }
    try {
      await docker.removeContainer(c.name);
      result.containersReaped.push(c.name);
    } catch (err) {
      logger.warn(`[finalize-reaper] remove container ${c.name} failed: ${(err as Error).message}`);
    }
  }

  // Phase 2: orphaned graph volumes. Removing the container above frees its
  // named volume; an in-use volume (active run) rejects removal and is skipped.
  let volumes: string[] = [];
  try {
    volumes = await docker.listFinalizeGraphVolumes();
  } catch (err) {
    logger.warn(`[finalize-reaper] list volumes failed: ${(err as Error).message}`);
  }
  for (const v of volumes) {
    try {
      await docker.removeVolume(v);
      result.volumesReaped.push(v);
    } catch {
      // In-use (active run) or already gone — leave it.
    }
  }

  if (result.containersReaped.length || result.volumesReaped.length) {
    logger.log(
      `[finalize-reaper] reaped ${result.containersReaped.length} container(s), ` +
        `${result.volumesReaped.length} graph volume(s)`,
    );
  }
  return result;
}
