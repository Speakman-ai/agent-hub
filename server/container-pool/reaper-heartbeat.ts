/**
 * Reaper heartbeat wiring (W4).
 *
 * Glues `reaper.ts` into the system-level cron scheduler. Responsibilities:
 *
 *   1. Resolve the runtime config (repo mapping, GitHub App creds).
 *   2. Build the production `ReaperDockerOps` + `ReaperGitHubOps` adapters.
 *   3. Run one tick against the live DB and pool allocator.
 *   4. Log a structured summary and never throw.
 *
 * The heartbeat is scheduled every 3 min by default (see `REAPER_CRON`).
 * Lower bounds: the reaper queries GitHub once per busy PR-env slot, so
 * running below 60s would hammer the API. Upper bounds: past 5 min a
 * leaked container can consume a full port for longer than a cold
 * restart takes to notice.
 *
 * All IO is constructed lazily behind `getDeps` so an uninstalled docker
 * binary / missing config doesn't crash the scheduler at boot.
 */

import { spawn } from 'child_process';
import type Database from 'better-sqlite3';
import { Reaper, type ReaperDockerOps, type ReaperGitHubOps } from './reaper.js';
import type { PoolAllocator } from './allocator.js';
import type { PrEnvRuntimeConfig } from './pr-env-runtime.js';
import { githubApiRequest } from '../github-app.js';

/** Cron expression — exported for tests. Every 3 minutes. */
export const REAPER_CRON = '*/3 * * * *';

/** Compose project naming convention (from pr-env-builder.ts). */
const PR_ENV_PROJECT_PREFIX = 'agent-hub-pr-';

/** Process-wide reentrancy guard paired with the advisory lock. */
export const reaperLock = { running: false };

/**
 * Latches `true` the first time `docker` spawn returns ENOENT (binary
 * not in PATH). After that, the production adapters short-circuit to a
 * no-op so the reaper isn't spamming the log every 3 minutes when
 * deployed in a runtime image without the docker CLI installed.
 *
 * The latch only resets on process restart — a missing CLI is a
 * deployment-config issue (Dockerfile / socket mount), not a transient
 * runtime fault, so once-per-process logging is the right cadence.
 */
let dockerUnavailable = false;

/**
 * Sentinel error raised by `runDocker` when the docker binary is
 * missing. Caller decides whether to gracefully degrade (production
 * adapters do) or surface (tests assert on it).
 */
export class DockerCliMissingError extends Error {
  constructor(underlying: NodeJS.ErrnoException) {
    super(`docker CLI not available: ${underlying.message}`);
    this.name = 'DockerCliMissingError';
  }
}

/**
 * Test hook — reset the per-process docker-unavailable latch so a fresh
 * test can re-exercise the first-call path. Not used in production.
 */
export function __resetDockerUnavailableForTests(): void {
  dockerUnavailable = false;
}

/** Test hook — read the latch without exposing it as a mutable export. */
export function __isDockerUnavailableForTests(): boolean {
  return dockerUnavailable;
}

/**
 * Production Docker adapter. Lists compose projects matching the PR-env
 * naming convention via `docker ps --filter label=...`, and invokes
 * `docker compose down` against each one.
 *
 * Output format for `docker ps`:
 *   {{.Label "com.docker.compose.project"}}
 *   -> "agent-hub-pr-123"
 *
 * We de-duplicate on the project label (a compose project can have
 * multiple containers) so the reaper iterates one entry per project.
 */
export const defaultDockerOps: ReaperDockerOps = {
  async listPrEnvProjects() {
    // Latched after the first ENOENT — silently return empty so the
    // reaper's other passes (eviction, stuck-draining, stale-port) keep
    // running without each tick logging the same docker-missing warning.
    if (dockerUnavailable) return [];
    let stdout: string;
    try {
      ({ stdout } = await runDocker([
        'ps',
        '--filter',
        `label=com.docker.compose.project`,
        '--format',
        '{{.Label "com.docker.compose.project"}}',
      ]));
    } catch (err) {
      if (err instanceof DockerCliMissingError) {
        dockerUnavailable = true;
        console.warn(
          '[reaper] docker CLI not found in PATH — PR-env orphan-project reaping is disabled ' +
            'until the runtime is reconfigured (install docker in the image or mount the ' +
            'docker socket). This message will not repeat until the process restarts.',
        );
        return [];
      }
      throw err;
    }
    const seen = new Set<string>();
    const out: Array<{ projectName: string; prNumber: number }> = [];
    for (const line of stdout.split('\n')) {
      const name = line.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (!name.startsWith(PR_ENV_PROJECT_PREFIX)) continue;
      const suffix = name.slice(PR_ENV_PROJECT_PREFIX.length);
      const prNumber = Number.parseInt(suffix, 10);
      if (!Number.isFinite(prNumber)) continue;
      out.push({ projectName: name, prNumber });
    }
    return out;
  },
  async composeDown(projectName) {
    // If the CLI's missing, the project can't exist either — the reaper
    // has nothing to tear down. Silently no-op rather than throw.
    if (dockerUnavailable) return;
    try {
      await runDocker([
        'compose',
        '--project-name',
        projectName,
        'down',
        '--remove-orphans',
        '--volumes',
      ]);
    } catch (err) {
      if (err instanceof DockerCliMissingError) {
        dockerUnavailable = true;
        return;
      }
      throw err;
    }
  },
};

/**
 * Production GitHub adapter. Uses the existing GitHub App credential flow
 * via `githubApiRequest` so tokens are cached across the app. Returns
 * null on any non-2xx response (which includes 404 for deleted repos)
 * so the reaper defers rather than evicting on an ambiguous signal.
 */
export function makeGitHubOps(config: PrEnvRuntimeConfig): ReaperGitHubOps {
  return {
    async getPrState(repoFullName, prNumber) {
      try {
        const res = (await githubApiRequest(`/repos/${repoFullName}/pulls/${prNumber}`, {
          method: 'GET',
          appId: config.github.appId,
          privateKey: config.github.privateKey,
          installationId: config.github.installationId,
        })) as { state?: string; draft?: boolean };
        if (res.state === 'closed') return 'closed';
        if (res.draft === true) return 'draft';
        if (res.state === 'open') return 'open';
        return null;
      } catch (err) {
        // 404 → PR gone (deleted repo / wrong number). Signal null so
        // the reaper defers; a later pass with fresh state wins.
        const msg = (err as Error).message ?? '';
        if (/\b(404|Not Found)\b/i.test(msg)) return null;
        throw err;
      }
    },
  };
}

export interface ReaperHeartbeatDeps {
  db: Database.Database;
  allocator: PoolAllocator;
  /** Lazy config resolver — null disables the heartbeat. */
  getConfig: () => PrEnvRuntimeConfig | null;
  /** Override the default repo for a slot's PR. Optional. */
  getRepoForSlot?: (slotId: string, prNumber: number) => string;
  /** Test hook — inject the adapters directly. */
  docker?: ReaperDockerOps;
  github?: ReaperGitHubOps;
  logger?: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

/**
 * Run one reaper tick. Returns the structured result (`null` when the
 * feature is disabled or a previous tick is still running). Never
 * throws — scheduler callers expect best-effort runs.
 */
export async function runReaperHeartbeat(deps: ReaperHeartbeatDeps) {
  const logger = deps.logger ?? {
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
  if (reaperLock.running) {
    logger.log('[reaper] skipped — previous tick still running');
    return null;
  }
  const config = deps.getConfig();
  if (!config) {
    logger.log('[reaper] skipped — prEnv feature is disabled');
    return null;
  }

  reaperLock.running = true;
  try {
    const docker = deps.docker ?? defaultDockerOps;
    const github = deps.github ?? makeGitHubOps(config);
    const reaper = new Reaper({
      db: deps.db,
      allocator: deps.allocator,
      docker,
      github,
      config: {
        defaultRepoFullName: config.repoFullName,
      },
      getRepoForSlot: deps.getRepoForSlot,
      logger,
    });
    reaper.init();
    const result = await reaper.run();
    if (result.skipped) {
      logger.log('[reaper] tick skipped (lock held)');
    } else {
      logger.log(
        `[reaper] tick: evictions=${result.webhookDropEvictions} ` +
          `crashedScaffolds=${result.crashedScaffolds} ` +
          `stuckDraining=${result.stuckDraining} ` +
          `orphanedProjects=${result.orphanedProjects} ` +
          `stalePortsReleased=${result.stalePortsReleased}`,
      );
      for (const note of result.notes) logger.log(`[reaper] ${note}`);
    }
    return result;
  } catch (err) {
    logger.error(`[reaper] heartbeat threw: ${(err as Error).message}`);
    return null;
  } finally {
    reaperLock.running = false;
  }
}

// ─── Internal: docker CLI runner ───────────────────────────────────────────

function runDocker(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', Array.from(args), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (b) => (stdout += String(b)));
    proc.stderr?.on('data', (b) => (stderr += String(b)));
    proc.on('error', (err) => {
      // ENOENT here means the docker binary itself wasn't found —
      // distinct from "docker ran and returned non-zero". Translate to
      // a typed error so the production adapter can disable itself.
      const errno = err as NodeJS.ErrnoException;
      if (errno?.code === 'ENOENT') {
        reject(new DockerCliMissingError(errno));
        return;
      }
      reject(err);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`docker ${args.join(' ')} failed (${code}): ${stderr}`));
    });
  });
}
