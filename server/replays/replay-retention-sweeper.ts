/**
 * replay-retention-sweeper.ts — periodic TTL garbage collection for session
 * replays.
 *
 * Session replays (record-on-error today, continuous/Datadog-parity later) are
 * gzipped blobs in the artifact store plus a `session_replays` index row. Until
 * now NOTHING expired them: every captured replay accumulated forever, so a
 * busy deployment grows storage without bound. This sweeper enforces a
 * retention window (`config.replayRetentionDays`), the same way Datadog Session
 * Replay defaults to a 30-day TTL.
 *
 * Policy:
 *   - Retention is OFF unless `replayRetentionDays > 0`. With it unset (the
 *     default) the sweep is a no-op — matching the off/opt-in posture.
 *   - Only UNLINKED replays are deleted. A replay attached to a support ticket
 *     or kanban card (`support_ticket_id` / `card_id`) is an intentional triage
 *     artifact; expiring it would silently destroy investigation history, so
 *     those are excluded by the query and never swept.
 *   - Deletion is blob-first via `deleteReplay`, which removes the artifact-store
 *     object and then the index row, so we never strand a row pointing at a
 *     missing blob (and an idempotent store.delete tolerates an already-gone
 *     object on retry).
 *   - Work is bounded per sweep (`maxPerSweep`) so a large backlog drains over
 *     several ticks instead of blocking the event loop on thousands of blob
 *     deletes at once. Oldest-first ordering means the longest-lived captures go
 *     first.
 */

import { deleteReplay } from './replay-store.js';
import type { AppConfig, SessionReplayRow, Stmts } from '../types.js';

/** Default cadence: sweep every 6 hours. Retention is a slow-moving TTL, not a
 *  realtime concern, so an infrequent sweep keeps overhead negligible. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Default ceiling on deletions per sweep so a huge backlog can't wedge the loop
 *  on one tick. A backlog larger than this drains across subsequent sweeps. */
export const DEFAULT_MAX_PER_SWEEP = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ReplayRetentionDeps {
  stmts: Stmts;
  config: AppConfig;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional structured logger. Defaults to console.error. */
  log?: (msg: string) => void;
}

export interface RetentionSweepResult {
  /** Whether retention is enabled (replayRetentionDays > 0). */
  enabled: boolean;
  /** ISO cutoff; rows older than this were eligible. Null when disabled. */
  cutoff: string | null;
  /** Number of replays whose blob + row were removed this sweep. */
  deleted: number;
  /** Replays matched but whose deletion threw (left for the next sweep). */
  failed: number;
}

/**
 * Format an epoch-ms instant as the SQLite `datetime('now')` text format
 * (`YYYY-MM-DD HH:MM:SS`, UTC) so a string `<` comparison against the stored
 * `created_at` column is correct. SQLite stores these as UTC text with no
 * timezone suffix; ISO's `T`/`Z`/millis would not collate against that.
 */
export function toSqliteUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Run one retention sweep. Deletes up to `maxPerSweep` expired, unlinked
 * replays. Safe to call when retention is disabled (returns immediately with
 * `enabled: false`). Never throws for an individual blob-delete failure — it
 * counts the failure and moves on so one bad object can't stall the whole sweep.
 */
export async function runReplayRetentionSweep(
  deps: ReplayRetentionDeps,
  maxPerSweep: number = DEFAULT_MAX_PER_SWEEP,
): Promise<RetentionSweepResult> {
  const { stmts, config } = deps;
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const now = deps.now ?? Date.now;

  const days = config.replayRetentionDays;
  if (!Number.isFinite(days) || days <= 0) {
    return { enabled: false, cutoff: null, deleted: 0, failed: 0 };
  }

  const cutoff = toSqliteUtc(now() - days * MS_PER_DAY);
  const rows = stmts.getExpiredUnlinkedSessionReplays.all(
    cutoff,
    Math.max(1, Math.trunc(maxPerSweep)),
  ) as SessionReplayRow[];

  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deleteReplay({ stmts, config }, row);
      deleted += 1;
    } catch (err) {
      failed += 1;
      log(`[replay-retention] failed to delete replay ${row.id}: ${(err as Error).message}`);
    }
  }

  if (deleted > 0 || failed > 0) {
    log(
      `[replay-retention] swept ${deleted} expired replay(s) older than ${cutoff} ` +
        `(${days}d retention)${failed ? `, ${failed} failed` : ''}`,
    );
  }

  return { enabled: true, cutoff, deleted, failed };
}

/**
 * Launch the periodic retention sweeper. Mirrors `startStalePrChecker`: the
 * first run is scheduled one interval ahead (nothing is freshly expired at
 * boot), the timer is `unref`'d so it never keeps the process alive, and the
 * returned function clears it. Returns a no-op stopper when retention is
 * disabled so callers don't have to special-case the config.
 */
export function startReplayRetentionSweeper(
  deps: ReplayRetentionDeps,
  intervalMs: number = RETENTION_SWEEP_INTERVAL_MS,
): () => void {
  if (!Number.isFinite(deps.config.replayRetentionDays) || deps.config.replayRetentionDays <= 0) {
    return () => {};
  }
  const timer = setInterval(() => {
    runReplayRetentionSweep(deps).catch((err) => {
      const log = deps.log ?? ((msg: string) => console.error(msg));
      log(`[replay-retention] sweep failed: ${(err as Error).message}`);
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
