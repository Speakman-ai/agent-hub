/**
 * Fleet prewarm: scale the remote runner fleet while a Finalize run is still in
 * review, so agents are booted by the time CI enqueues its shards.
 *
 * Finalize runs CI only after the reviewer approves, and the queue-depth scaler
 * only grows the fleet once shards are enqueued. Without a prewarm every run
 * pays EC2 launch + ECS placement + image pull after review is already done.
 *
 * A run reserves the number of fleet shards its ci.yaml will enqueue. The
 * scaler adds each reservation's unmet part to its queue depth:
 *
 *   demand(run) = max(0, reserved - distinct shards enqueued since the reservation)
 *
 * "Since the reservation" is a runner_jobs rowid watermark taken when the
 * reservation is created and kept across resizes. A later fix round reuses the
 * run id, so earlier rounds' rows must not count against it.
 *
 * Shards are counted distinctly (job_id + matrix_key) in ANY state, within the
 * reservation's runner class: retry rows of one shard count once, a finished
 * shard keeps counting, and native jobs in other classes never count. So the
 * prewarm never double-counts real jobs, never re-inflates the fleet as shards
 * complete, and while a `warmup` job runs (or retries) alone the remaining
 * reservation keeps the other agents warm for the shards that follow it.
 *
 * Reservations live in memory: a Hub restart drops them, which only costs the
 * prewarm. A TTL backstops a run that never releases (crash between reserve and
 * the orchestrator's release paths).
 */
import { jobInstanceKey } from './base-drift-policy.js';
import { matrixKeyFromRow } from './ci-config-jobs.js';
import type { CiConfig } from './ci-config-jobs.js';
import { DEFAULT_RUNNER_CLASS, isContainerRunsOn } from './runner-images.js';
import { runnerJobWatermark, runnerShardsEnqueuedSince } from './runner-queue.js';
import type { RunnerClassFilter } from './runner-queue.js';

/** Queue reads the prewarm needs; injectable so unit tests skip the DB. */
export interface PrewarmQueue {
  watermark(): number;
  shardsEnqueuedSince(args: {
    runId: string;
    runnerClass: string;
    sinceRowid: number;
    orgId?: string;
  }): number;
}

export const DB_PREWARM_QUEUE: PrewarmQueue = {
  watermark: runnerJobWatermark,
  shardsEnqueuedSince: runnerShardsEnqueuedSince,
};

/** Longest a reservation may hold the fleet up without a release. */
export const PREWARM_TTL_MS = 60 * 60_000;

interface Reservation {
  runnerClass: string;
  count: number;
  orgId?: string;
  /** runner_jobs rowid watermark when this reservation was created. */
  sinceRowid: number;
  expiresAt: number;
}

const reservations = new Map<string, Reservation>();

/** `FINALIZE_FLEET_PREWARM=0|false|off|no` turns the prewarm off. On by default. */
export function fleetPrewarmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FINALIZE_FLEET_PREWARM?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Fleet agents a CI config will claim: one per container (Linux DinD) matrix
 * instance. Native macOS and `host` jobs never land on the ECS fleet. Pass
 * `skip` (keys from `jobInstanceKey`) to leave out instances that will not run:
 * dropped by test selection, or reused / carried over from an earlier round.
 */
export function fleetShardCount(
  config: Pick<CiConfig, 'jobs'>,
  skip?: ReadonlySet<string>,
): number {
  let n = 0;
  for (const [jobId, job] of Object.entries(config.jobs)) {
    if (!isContainerRunsOn(job.runsOn)) continue;
    for (const row of job.matrixInclude) {
      if (skip?.has(jobInstanceKey(jobId, matrixKeyFromRow(row)))) continue;
      n++;
    }
  }
  return n;
}

/**
 * Reserve (or resize) a run's prewarm. A count of 0 releases it. A new
 * reservation takes the queue watermark; a resize keeps the one it has.
 */
export function reserveFleetPrewarm(
  runId: string,
  opts: {
    count: number;
    runnerClass?: string;
    orgId?: string;
    now?: number;
    queue?: PrewarmQueue;
  },
): void {
  if (opts.count <= 0) {
    reservations.delete(runId);
    return;
  }
  const sinceRowid =
    reservations.get(runId)?.sinceRowid ?? (opts.queue ? opts.queue.watermark() : 0);
  reservations.set(runId, {
    runnerClass: opts.runnerClass ?? DEFAULT_RUNNER_CLASS,
    count: opts.count,
    ...(opts.orgId ? { orgId: opts.orgId } : {}),
    sinceRowid,
    expiresAt: (opts.now ?? Date.now()) + PREWARM_TTL_MS,
  });
}

export function releaseFleetPrewarm(runId: string): void {
  reservations.delete(runId);
}

/**
 * Set a run's reservation from its CI config: reserve the fleet shards it will
 * enqueue, or release when the prewarm does not apply (local backend, opted
 * out, no config, nothing for the fleet). Returns the reserved count.
 */
export function syncFleetPrewarm(
  runId: string,
  config: Pick<CiConfig, 'jobs'> | null,
  opts: {
    runnerClass?: string;
    orgId?: string;
    skip?: ReadonlySet<string>;
    env?: NodeJS.ProcessEnv;
    now?: number;
    queue?: PrewarmQueue;
  } = {},
): number {
  const env = opts.env ?? process.env;
  const remote = (env.FINALIZE_RUNNER_BACKEND ?? 'local').toLowerCase() === 'remote';
  const count =
    config && remote && fleetPrewarmEnabled(env) ? fleetShardCount(config, opts.skip) : 0;
  try {
    reserveFleetPrewarm(runId, {
      count,
      ...(opts.runnerClass ? { runnerClass: opts.runnerClass } : {}),
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      queue: opts.queue ?? DB_PREWARM_QUEUE,
    });
  } catch (err) {
    // The prewarm only saves cold-start time; an unreadable queue must never
    // fail the Finalize run that asked for it.
    reservations.delete(runId);
    console.warn(`[fleet-prewarm] run=${runId} skipped: ${(err as Error).message}`);
    return 0;
  }
  return count;
}

function classMatches(filter: RunnerClassFilter | undefined, runnerClass: string): boolean {
  if (!filter) return true;
  if (filter.include) return filter.include.includes(runnerClass);
  return !(filter.exclude ?? []).includes(runnerClass);
}

/**
 * Unmet prewarm demand for the pool serving `filter`, pruning expired
 * reservations.
 */
export function fleetPrewarmDemand(
  filter: RunnerClassFilter | undefined,
  queue: PrewarmQueue,
  now: number = Date.now(),
): number {
  let demand = 0;
  for (const [runId, r] of reservations) {
    if (r.expiresAt <= now) {
      reservations.delete(runId);
      continue;
    }
    if (!classMatches(filter, r.runnerClass)) continue;
    const enqueued = queue.shardsEnqueuedSince({
      runId,
      runnerClass: r.runnerClass,
      sinceRowid: r.sinceRowid,
      ...(r.orgId ? { orgId: r.orgId } : {}),
    });
    demand += Math.max(0, r.count - enqueued);
  }
  return demand;
}

export function __resetFleetPrewarmForTests(): void {
  reservations.clear();
}
