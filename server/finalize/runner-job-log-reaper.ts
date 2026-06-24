/**
 * runner-job-log-reaper.ts — periodic retention prune for `runner_job_logs`.
 *
 * `runner_job_logs` (orgs.db) is an append-only spool of transient CI
 * stdout/stderr frames posted by remote Finalize runner agents. It exists only
 * so the UI can replay a job's live output across a Hub restart mid-stream; no
 * code reads it once the job ends. Nothing ever deleted from it, so on a busy
 * fleet it grew without bound (9.23M rows observed) until synchronous SQLite
 * reads against the bloated DB stalled the Node event loop — the recurring
 * "pages load slowly" incident that was being band-aided with manual purges.
 *
 * This reaper deletes frames older than a configurable TTL on a fixed cadence,
 * mirroring `preview-reaper` / `finalize-reaper`. It is NOT docker-gated (a pure
 * SQLite DELETE) and NOT tied to the ECS fleet-scaler (which only runs when
 * autoscaling is configured) — it must run on every Hub that has an orgs.db.
 *
 * Deletion is batched inside {@link pruneRunnerJobLogs} so a large first-run
 * backlog drains across several ticks instead of one event-loop-blocking
 * statement.
 */
import { pruneRunnerJobLogs } from './runner-queue.js';

/** Runs every 5 minutes — frequent enough to keep the spool bounded, cheap given the age index. */
export const RUNNER_JOB_LOG_REAPER_CRON = '*/5 * * * *';

const DEFAULT_RETENTION_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve the retention window (ms) from `FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS`.
 * Falls back to {@link DEFAULT_RETENTION_DAYS} when unset, non-numeric, or <= 0
 * (a typo must never collapse retention to zero and wipe live-run replay logs).
 */
export function resolveRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS;
  const days = raw == null ? NaN : Number(raw);
  const resolved = Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
  return resolved * MS_PER_DAY;
}

export interface RunnerJobLogReaperDeps {
  /** Current epoch ms (injectable for tests). Defaults to `Date.now()`. */
  now?: () => number;
  /** Retention window override (ms). Defaults to the env-resolved value. */
  retentionMs?: number;
  /** Prune implementation seam (injectable for tests). */
  prune?: typeof pruneRunnerJobLogs;
  log?: (msg: string) => void;
}

/** One reaper tick: prune frames older than the retention window. */
export function runRunnerJobLogReaper(deps: RunnerJobLogReaperDeps = {}): number {
  const now = (deps.now ?? Date.now)();
  const retentionMs = deps.retentionMs ?? resolveRetentionMs();
  const prune = deps.prune ?? pruneRunnerJobLogs;
  const deleted = prune({ cutoff: now - retentionMs });
  if (deleted > 0) {
    (deps.log ?? console.log)(`[runner-job-log-reaper] pruned ${deleted} expired log frame(s)`);
  }
  return deleted;
}
