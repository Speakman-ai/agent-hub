/**
 * log-retention-reaper.ts — periodic retention + quota prune for `logs.db`.
 *
 * Customer application logs are high-volume (decision LOG-STORE). Two bounds
 * keep the dedicated store from growing without limit:
 *
 *  1. **Time retention** — records older than each project's window
 *     (default 7 days) are deleted.
 *  2. **Per-project quota** — a project over its byte quota (default 5 GiB)
 *     has its oldest records evicted down to the quota.
 *
 * Both are batched inside the store helpers so a large first-run backlog
 * drains across several ticks rather than one event-loop-blocking DELETE. Pure
 * SQLite against `logs.db` — never touches `agent-hub.db` / `orgs.db`, and is
 * not docker- or fleet-gated, so it runs on every Hub.
 */

import { getLogsDb, pruneExpiredLogRecords, enforceProjectQuota } from './logs-db.js';

/** Runs every 10 minutes — frequent enough to bound the store, cheap given the time index. */
export const LOG_RETENTION_REAPER_CRON = '*/10 * * * *';

/** Per-tick deletion budget shared across both passes. */
const MAX_DELETES_PER_TICK = 5000;

export interface LogReaperResult {
  expiredDeleted: number;
  quotaDeleted: number;
}

/**
 * One reaper tick: drop expired records first, then enforce per-project
 * quotas on whatever remains. `nowMs` is injectable for deterministic tests.
 *
 * The `MAX_DELETES_PER_TICK` budget is SHARED across both passes and across
 * every project: the expiry pass spends first, then the remaining budget is
 * drawn down project-by-project by quota enforcement. This keeps one tick
 * bounded to a single event-loop-friendly slice even with a large
 * multi-project backlog — the leftover drains on subsequent ticks.
 */
export function runLogRetentionReaper(
  nowMs: number = Date.now(),
  maxDeletes: number = MAX_DELETES_PER_TICK,
): LogReaperResult {
  let remaining = maxDeletes;

  const expiredDeleted = pruneExpiredLogRecords(nowMs, remaining);
  remaining -= expiredDeleted;

  let quotaDeleted = 0;
  if (remaining > 0) {
    const projects = getLogsDb()
      .prepare('SELECT DISTINCT project_id FROM log_records')
      .all() as Array<{ project_id: string }>;
    for (const { project_id } of projects) {
      if (remaining <= 0) break;
      const deleted = enforceProjectQuota(project_id, remaining);
      quotaDeleted += deleted;
      remaining -= deleted;
    }
  }

  return { expiredDeleted, quotaDeleted };
}
