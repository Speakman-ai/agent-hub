/**
 * infra-retention-store.ts — the persistence half of `infra.db`'s retention
 * story (decision INFRA-STORE).
 *
 * `infra-retention-reaper.ts` owns the tick and the shared delete budget; this
 * module owns the `infra_retention_config` row, the byte accounting the quota
 * pass spends against, and the two bounded deletes themselves.
 *
 * Scope is `infra_metric_points` and nothing else. The other two growing tables
 * are deliberately left alone:
 *
 *   - `infra_resources` is bounded by the number of resources that actually
 *     exist, and its own schema comment records why a terminated instance ages
 *     out via a stale `last_seen` instead of being deleted — a row that
 *     vanished would take a chart's axis labels with it mid-render.
 *   - `infra_collect_runs` is the cost audit trail `getInfraSpendToDate()` sums
 *     month-to-date spend from. Deleting a 30-day-old run row on the 31st of a
 *     month would silently drop the first day of that month's spend out of the
 *     ceiling calculation — under-reporting spend, which is the one direction
 *     the cost guardrails must never fail in. If that table ever needs bounding
 *     it needs a retention floor tied to the billing month, not this reaper's
 *     window.
 */

import type Database from 'better-sqlite3';
import { getInfraDb } from './infra-db.js';
import {
  DEFAULT_INFRA_RETENTION_DAYS,
  MIN_INFRA_RETENTION_DAYS,
  MAX_INFRA_RETENTION_DAYS,
  DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
  MIN_INFRA_PROJECT_QUOTA_BYTES,
  MAX_INFRA_PROJECT_QUOTA_BYTES,
  INFRA_METRIC_POINT_BYTES_SQL,
} from './infra-schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows deleted per SQLite statement. The reaper's per-tick budget is far larger
 * than this (metric points expire in the millions per day on a busy project),
 * so the deletes are sliced: one transaction per chunk keeps each write lock
 * short enough that a chart read waits milliseconds rather than the whole pass.
 *
 * Chunking also keeps the `IN (...)` placeholder list a fixed width, so the
 * prepared statement is reused across chunks instead of recompiled per call.
 */
const DELETE_CHUNK = 2_000;

// ── Config resolution ──────────────────────────────────────────────────────

/** Clamp a retention window to the documented bounds; NaN falls back to the default. */
export function clampInfraRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_INFRA_RETENTION_DAYS;
  return Math.min(MAX_INFRA_RETENTION_DAYS, Math.max(MIN_INFRA_RETENTION_DAYS, Math.floor(days)));
}

/** Clamp a byte quota to the documented bounds; NaN falls back to the default. */
export function clampInfraQuotaBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_INFRA_PROJECT_QUOTA_BYTES;
  return Math.min(
    MAX_INFRA_PROJECT_QUOTA_BYTES,
    Math.max(MIN_INFRA_PROJECT_QUOTA_BYTES, Math.floor(bytes)),
  );
}

export interface InfraRetentionConfig {
  projectId: string;
  retentionDays: number;
  quotaBytes: number;
  updatedAt: number | null;
  /** False when no row exists and both values above are code defaults. */
  configured: boolean;
}

interface InfraRetentionConfigDbRow {
  project_id: string;
  retention_days: number;
  quota_bytes: number;
  updated_at: number;
}

/**
 * A project's retention config, or the code defaults when it has no row.
 *
 * Stored values are re-clamped on the way out, so a row written while the
 * documented bounds were wider is interpreted inside today's range rather than
 * granting a project a window the store no longer supports.
 */
export function getInfraRetentionConfig(projectId: string): InfraRetentionConfig {
  const row = getInfraDb()
    .prepare(
      `SELECT project_id, retention_days, quota_bytes, updated_at
         FROM infra_retention_config
        WHERE project_id = ?`,
    )
    .get(projectId) as InfraRetentionConfigDbRow | undefined;

  if (!row) {
    return {
      projectId,
      retentionDays: DEFAULT_INFRA_RETENTION_DAYS,
      quotaBytes: DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
      updatedAt: null,
      configured: false,
    };
  }
  return {
    projectId: row.project_id,
    retentionDays: clampInfraRetentionDays(row.retention_days),
    quotaBytes: clampInfraQuotaBytes(row.quota_bytes),
    updatedAt: row.updated_at,
    configured: true,
  };
}

/** Upsert a project's overrides, clamping both values to the documented bounds. */
export function setInfraRetentionConfig(
  projectId: string,
  cfg: Partial<Pick<InfraRetentionConfig, 'retentionDays' | 'quotaBytes'>>,
  nowMs: number = Date.now(),
): InfraRetentionConfig {
  const current = getInfraRetentionConfig(projectId);
  const retentionDays = clampInfraRetentionDays(cfg.retentionDays ?? current.retentionDays);
  const quotaBytes = clampInfraQuotaBytes(cfg.quotaBytes ?? current.quotaBytes);

  getInfraDb()
    .prepare(
      `INSERT INTO infra_retention_config (project_id, retention_days, quota_bytes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         retention_days = excluded.retention_days,
         quota_bytes    = excluded.quota_bytes,
         updated_at     = excluded.updated_at`,
    )
    .run(projectId, retentionDays, quotaBytes, nowMs);

  return getInfraRetentionConfig(projectId);
}

/** Every project that has overridden its defaults, resolved and clamped. */
export function listInfraRetentionOverrides(): InfraRetentionConfig[] {
  const rows = getInfraDb()
    .prepare(
      `SELECT project_id, retention_days, quota_bytes, updated_at
         FROM infra_retention_config`,
    )
    .all() as InfraRetentionConfigDbRow[];
  return rows.map((row) => ({
    projectId: row.project_id,
    retentionDays: clampInfraRetentionDays(row.retention_days),
    quotaBytes: clampInfraQuotaBytes(row.quota_bytes),
    updatedAt: row.updated_at,
    configured: true,
  }));
}

// ── Byte accounting ────────────────────────────────────────────────────────

/**
 * On-disk footprint of `infra.db`, in bytes (page_count × page_size).
 *
 * The reaper uses this as an O(1) gate on the quota pass: no project's
 * accounted bytes can exceed the whole file, so a database smaller than the
 * smallest configured quota cannot contain an over-quota project and the scan
 * is skipped outright. Mirrors `getLogsDbFileBytes()`.
 */
export function getInfraDbFileBytes(): number {
  const db = getInfraDb();
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  if (!Number.isFinite(pageCount) || !Number.isFinite(pageSize)) return 0;
  return pageCount * pageSize;
}

export interface InfraProjectUsage {
  projectId: string;
  points: number;
  bytes: number;
}

/**
 * Accounted bytes and point count for every project holding metric points.
 *
 * One grouped scan for the whole store rather than the logs reaper's
 * project-at-a-time `SUM`, which re-scans the table once per project. The
 * result doubles as the project list, so the quota pass needs no separate
 * `SELECT DISTINCT project_id`.
 */
export function listInfraProjectUsage(): InfraProjectUsage[] {
  const rows = getInfraDb()
    .prepare(
      `SELECT project_id,
              COUNT(*) AS points,
              SUM${INFRA_METRIC_POINT_BYTES_SQL} AS bytes
         FROM infra_metric_points
        GROUP BY project_id`,
    )
    .all() as Array<{ project_id: string; points: number; bytes: number | null }>;
  return rows.map((r) => ({ projectId: r.project_id, points: r.points, bytes: r.bytes ?? 0 }));
}

/** Accounted bytes currently held for one project. */
export function getInfraProjectByteSize(projectId: string): number {
  const row = getInfraDb()
    .prepare(
      `SELECT COALESCE(SUM${INFRA_METRIC_POINT_BYTES_SQL}, 0) AS bytes
         FROM infra_metric_points
        WHERE project_id = ?`,
    )
    .get(projectId) as { bytes: number };
  return row.bytes;
}

// ── Deletes ────────────────────────────────────────────────────────────────

/** Delete metric points by id, sliced into bounded transactions. */
function deleteMetricPointIds(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;

  let i = 0;
  if (ids.length >= DELETE_CHUNK) {
    const chunkStmt = db.prepare(
      `DELETE FROM infra_metric_points WHERE id IN (${new Array(DELETE_CHUNK).fill('?').join(',')})`,
    );
    const runChunk = db.transaction((rowIds: number[]) => {
      chunkStmt.run(...rowIds);
    });
    for (; i + DELETE_CHUNK <= ids.length; i += DELETE_CHUNK) {
      runChunk(ids.slice(i, i + DELETE_CHUNK));
    }
  }
  const tail = ids.slice(i);
  if (tail.length > 0) {
    const tailStmt = db.prepare(
      `DELETE FROM infra_metric_points WHERE id IN (${new Array(tail.length).fill('?').join(',')})`,
    );
    db.transaction((rowIds: number[]) => {
      tailStmt.run(...rowIds);
    })(tail);
  }
}

/**
 * Age pass: delete metric points older than each project's retention window,
 * oldest first, bounded by `maxDeletes`.
 *
 * The main scan runs against the global `idx_infra_metric_points_ts` index, so
 * it starts at the single oldest point in the store and walks forward across
 * every project that has not overridden its window — a project that has been
 * collecting for a year is drained before one that started yesterday,
 * regardless of which rows SQLite happens to have written where. Projects with
 * an override are then drained in their own oldest-first pass with whatever
 * budget is left, so a large default-window backlog defers (never cancels)
 * their pass to a subsequent tick.
 *
 * The cutoff is always applied **in SQL**, never by filtering rows in
 * TypeScript afterwards. That is load-bearing rather than tidy: a single global
 * query using the loosest cutoff would re-scan the same non-expired prefix
 * every tick whenever one project holds old data under a long override, and
 * would never reach the expired rows of a project behind it. Applied in SQL,
 * every returned row is deletable, so the budget is never spent on a row the
 * pass then declines to delete.
 *
 * Projects without an override are handled in one query, and each project that
 * *has* one gets its own. Grouping several overriding projects into a single
 * `project_id IN (...)` looks cheaper and is not: SQLite serves one
 * `project_id = ?` from `idx_infra_metric_points_project_ts` already ordered,
 * but an `IN` over several adds `USE TEMP B-TREE FOR ORDER BY` — sorting each
 * project's whole history, every tick. The number of overriding projects is
 * small by construction (an operator configured each one by hand).
 *
 * In the common case (no overrides at all) this is a single query whose `NOT
 * IN` filter drops away entirely, seeking straight to the oldest expired point
 * and stopping as soon as the budget is met.
 */
export function pruneExpiredInfraMetricPoints(nowMs: number, maxDeletes: number): number {
  if (maxDeletes <= 0) return 0;
  const db = getInfraDb();
  const overrides = listInfraRetentionOverrides();
  const overridden = overrides.map((o) => o.projectId);
  const toDelete: number[] = [];

  const collect = (sql: string, params: unknown[]): void => {
    const remaining = maxDeletes - toDelete.length;
    if (remaining <= 0) return;
    const ids = db.prepare(sql).all(...params, remaining) as Array<{ id: number }>;
    for (const { id } of ids) toDelete.push(id);
  };

  // Default-window group: every project without an override, in one query.
  const exclusion =
    overridden.length > 0
      ? ` AND project_id NOT IN (${new Array(overridden.length).fill('?').join(',')})`
      : '';
  collect(
    `SELECT id FROM infra_metric_points
      WHERE ts_ms < ?${exclusion}
      ORDER BY ts_ms ASC LIMIT ?`,
    [nowMs - DEFAULT_INFRA_RETENTION_DAYS * DAY_MS, ...overridden],
  );

  // One query per overriding project, each an ordered index range.
  for (const { projectId, retentionDays } of overrides) {
    collect(
      `SELECT id FROM infra_metric_points
        WHERE project_id = ? AND ts_ms < ?
        ORDER BY ts_ms ASC LIMIT ?`,
      [projectId, nowMs - retentionDays * DAY_MS],
    );
  }

  deleteMetricPointIds(db, toDelete);
  return toDelete.length;
}

/**
 * Quota pass: evict one project's oldest metric points until its accounted
 * bytes fall to or below its resolved quota. Bounded by `maxDeletes`.
 *
 * `storedBytes` lets the caller pass the total {@link listInfraProjectUsage}
 * already computed, so a reaper tick scans the table once instead of once per
 * over-quota project. Omit it and the sum is recomputed.
 *
 * Eviction is oldest-first by `ts_ms`, served in order by
 * `idx_infra_metric_points_project_ts`. Ordering by `id` (insertion order)
 * would agree except where a widened window backfilled older points, but SQLite
 * has no index in that order for a single project and answers it by sorting the
 * project's whole history in a temp b-tree — so the correct order is also the
 * cheap one here.
 */
export function enforceInfraProjectQuota(
  projectId: string,
  maxDeletes: number,
  storedBytes?: number,
): number {
  if (maxDeletes <= 0) return 0;
  const db = getInfraDb();
  const { quotaBytes } = getInfraRetentionConfig(projectId);
  let stored = storedBytes ?? getInfraProjectByteSize(projectId);
  if (stored <= quotaBytes) return 0;

  const rows = db
    .prepare(
      `SELECT id, ${INFRA_METRIC_POINT_BYTES_SQL} AS byte_size
         FROM infra_metric_points
        WHERE project_id = ?
        ORDER BY ts_ms ASC LIMIT ?`,
    )
    .all(projectId, maxDeletes) as Array<{ id: number; byte_size: number }>;

  const toDelete: number[] = [];
  for (const row of rows) {
    if (stored <= quotaBytes) break;
    toDelete.push(row.id);
    stored -= row.byte_size;
  }

  deleteMetricPointIds(db, toDelete);
  return toDelete.length;
}
