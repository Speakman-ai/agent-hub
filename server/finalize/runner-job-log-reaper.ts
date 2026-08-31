/**
 * runner-job-log-reaper.ts: periodic retention prune for `runner_job_logs`.
 *
 * `runner_job_logs` (its own `runner-logs.db`, split out of orgs.db per spec
 * hot-write-isolation) is an append-only spool of CI stdout/stderr frames posted
 * by remote Finalize runner agents. It exists so the UI can replay a job's live
 * output across a Hub restart and so the Runners page can serve step output when
 * no blob is attached. Without a bound it grew without limit (9.23M rows
 * observed) until synchronous SQLite work against the bloated DB stalled the
 * Node event loop.
 *
 * Two passes keep the spool bounded, sharing one per-tick delete budget:
 *
 *  1. **Age**: frames older than the TTL (default 1 day) are deleted.
 *  2. **Size**: if the table is still over `MAX_ROWS` (default 1M), the oldest
 *     remaining frames are evicted. Catches a burst inside the TTL window, which
 *     is how orgs.db hit 1.5 GB with a 147 MB WAL in the incident.
 *
 * Both passes DELETE in small rowid-subquery batches so a single tick never
 * becomes one giant synchronous statement (or checkpoint). A first-run backlog
 * drains across later ticks. Pure SQLite, so NOT docker-gated and NOT tied to
 * the ECS fleet-scaler. It must run on every Hub that has a runner-logs.db.
 *
 * Writes stay on the main thread (spec async-boundary). Volume reduction is
 * the lever; with the dedicated-DB split now shipped, both the flood writes and
 * these prune checkpoints hit `runner-logs.db` rather than orgs.db, so the
 * isolated file stays small and its checkpoints never stall orgs.db requests.
 *
 * Operator env (invalid / <=0 values fall back to the default so a typo cannot
 * wipe the spool or wedge the event loop):
 *
 * | Variable | Default | Role |
 * | --- | --- | --- |
 * | `FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS` | 1 (fractional ok) | Age TTL |
 * | `FINALIZE_RUNNER_JOB_LOG_MAX_ROWS` | 1_000_000 | Size cap (oldest-first) |
 * | `FINALIZE_RUNNER_JOB_LOG_REAP_BATCH_SIZE` | 2_000 (clamped 100..5_000) | Rows per DELETE |
 * | `FINALIZE_RUNNER_JOB_LOG_REAP_MAX_BATCHES` | 25 (clamped 1..50) | DELETEs per tick |
 * | `FINALIZE_RUNNER_JOB_LOG_REAPER_CRON` | every 5 minutes | Cadence |
 */
import cron from 'node-cron';
import {
  pruneOldestRunnerJobLogs,
  pruneRunnerJobLogs,
  RUNNER_JOB_LOG_PRUNE_BATCH_SIZE,
  RUNNER_JOB_LOG_PRUNE_MAX_BATCHES,
} from './runner-queue.js';

/** Default cadence: every 5 minutes. Cheap given `idx_runner_job_logs_at`. */
export const RUNNER_JOB_LOG_REAPER_CRON = '*/5 * * * *';

/**
 * 1 day. Jobs run for minutes; the Runners UI reads recent frames for step
 * output. A day is already generous. The prior 3-day default held ~3M rows /
 * 1.4 GB on a busy fleet (~1M frames/day).
 */
export const DEFAULT_RETENTION_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * ~1 day of frames at the observed ~1M frames/day fill rate. A burst inside
 * the TTL still cannot grow the spool past this; leftover drains next tick.
 */
export const DEFAULT_MAX_ROWS = 1_000_000;
/** Floor so a typo like `1` cannot wipe live-run replay logs. */
const MIN_MAX_ROWS = 10_000;

export const DEFAULT_BATCH_SIZE = RUNNER_JOB_LOG_PRUNE_BATCH_SIZE;
export const DEFAULT_MAX_BATCHES = RUNNER_JOB_LOG_PRUNE_MAX_BATCHES;
const MIN_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 5_000;
const MIN_MAX_BATCHES = 1;
const MAX_MAX_BATCHES = 50;

function resolvePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveClampedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Resolve the retention window (ms) from `FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS`.
 * Falls back to {@link DEFAULT_RETENTION_DAYS} when unset, non-numeric, or <= 0
 * (a typo must never collapse retention to zero and wipe live-run replay logs).
 */
export function resolveRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  const days = resolvePositiveNumber(
    env.FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
  );
  return days * MS_PER_DAY;
}

/** Size cap. Invalid / below {@link MIN_MAX_ROWS} falls back to the default. */
export function resolveMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FINALIZE_RUNNER_JOB_LOG_MAX_ROWS;
  if (raw == null) return DEFAULT_MAX_ROWS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_MAX_ROWS) return DEFAULT_MAX_ROWS;
  return Math.floor(n);
}

export function resolveBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return resolveClampedInt(
    env.FINALIZE_RUNNER_JOB_LOG_REAP_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );
}

export function resolveMaxBatches(env: NodeJS.ProcessEnv = process.env): number {
  return resolveClampedInt(
    env.FINALIZE_RUNNER_JOB_LOG_REAP_MAX_BATCHES,
    DEFAULT_MAX_BATCHES,
    MIN_MAX_BATCHES,
    MAX_MAX_BATCHES,
  );
}

/**
 * Cadence from `FINALIZE_RUNNER_JOB_LOG_REAPER_CRON`. Invalid expressions fall
 * back to {@link RUNNER_JOB_LOG_REAPER_CRON} so a typo cannot disable the reaper.
 */
export function resolveReaperCron(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.FINALIZE_RUNNER_JOB_LOG_REAPER_CRON?.trim();
  if (raw && cron.validate(raw)) return raw;
  return RUNNER_JOB_LOG_REAPER_CRON;
}

export interface RunnerJobLogReaperDeps {
  /** Current epoch ms (injectable for tests). Defaults to `Date.now()`. */
  now?: () => number;
  /** Retention window override (ms). Defaults to the env-resolved value. */
  retentionMs?: number;
  /** Size cap override. Defaults to the env-resolved value. */
  maxRows?: number;
  batchSize?: number;
  maxBatches?: number;
  /** Age-prune seam (injectable for tests). */
  pruneExpired?: typeof pruneRunnerJobLogs;
  /** Size-prune seam (injectable for tests). */
  pruneOldest?: typeof pruneOldestRunnerJobLogs;
  log?: (msg: string) => void;
}

export interface RunnerJobLogReaperResult {
  expiredDeleted: number;
  sizeDeleted: number;
}

/**
 * One reaper tick: drop expired frames first, then evict oldest frames if the
 * table is still over the size cap. The per-tick budget (`batchSize * maxBatches`)
 * is shared across both passes.
 */
export function runRunnerJobLogReaper(deps: RunnerJobLogReaperDeps = {}): RunnerJobLogReaperResult {
  const now = (deps.now ?? Date.now)();
  const retentionMs = deps.retentionMs ?? resolveRetentionMs();
  const maxRows = deps.maxRows ?? resolveMaxRows();
  const batchSize = deps.batchSize ?? resolveBatchSize();
  const maxBatches = deps.maxBatches ?? resolveMaxBatches();
  const pruneExpired = deps.pruneExpired ?? pruneRunnerJobLogs;
  const pruneOldest = deps.pruneOldest ?? pruneOldestRunnerJobLogs;
  const log = deps.log ?? console.log;

  const expiredDeleted = pruneExpired({ cutoff: now - retentionMs, batchSize, maxBatches });

  const remaining = batchSize * maxBatches - expiredDeleted;
  const sizeDeleted =
    remaining > 0
      ? pruneOldest({
          keepRows: maxRows,
          batchSize,
          maxBatches,
          maxDeletes: remaining,
        })
      : 0;

  const deleted = expiredDeleted + sizeDeleted;
  if (deleted > 0) {
    log(
      `[runner-job-log-reaper] pruned ${deleted} log frame(s)` +
        ` (expired=${expiredDeleted} size=${sizeDeleted})`,
    );
  }
  return { expiredDeleted, sizeDeleted };
}
