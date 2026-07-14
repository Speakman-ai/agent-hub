/**
 * Dedicated customer-application log store (`logs.db`).
 *
 * Decision LOG-STORE: customer application logs are high-volume and must not
 * contend with Agent Hub operational state. They live in their own SQLite
 * database (WAL) under the data directory, never in `agent-hub.db` or
 * `orgs.db`. This module owns that handle: init/recovery, schema/migrations,
 * bounded batch insert, cursor-paginated query, and the retention/quota
 * cleanup hooks. Ingest endpoints, source-token auth, issue grouping, and the
 * Logs UI are separate epic tickets that build on this store.
 *
 * All public helpers are thin, synchronous wrappers over `better-sqlite3`
 * against a single process-wide handle, so they can be unit-tested against a
 * scratch data dir without booting the server.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import { assertSafeTestDataDir } from '../db-safety.js';
import {
  LOGS_SCHEMA,
  LOGS_FTS_SCHEMA,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_PROJECT_QUOTA_BYTES,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  MIN_PROJECT_QUOTA_BYTES,
  MAX_PROJECT_QUOTA_BYTES,
  MAX_RECORD_BYTES,
  MAX_BATCH_RECORDS,
  MAX_QUERY_LIMIT,
  DEFAULT_QUERY_LIMIT,
} from './logs-schema.js';

let logsDb: Database.Database | null = null;
/** True when the running SQLite build gave us the FTS5 message index. */
let ftsAvailable = false;

/** Test-only override of the `logs.db` location. `null` resets to default. */
let logsDbPathOverride: string | null = null;
export function setLogsDbPathForTests(p: string | null): void {
  logsDbPathOverride = p;
  if (logsDb) {
    try {
      logsDb.close();
    } catch {}
    logsDb = null;
    ftsAvailable = false;
  }
}

/**
 * Accessor for the shared `logs.db` handle. Throws if `initLogsDb()` has not
 * run — every caller is downstream of server startup.
 */
export function getLogsDb(): Database.Database {
  if (!logsDb) {
    throw new Error('logs.db not initialized — call initLogsDb() first');
  }
  return logsDb;
}

/** Whether FTS5 message search is available in this process. */
export function isLogFtsAvailable(): boolean {
  return ftsAvailable;
}

/**
 * Open (or create) `logs.db` under `dataDir`, apply WAL + recovery pragmas,
 * and run the idempotent schema/migrations. Safe to call more than once for
 * the same dir — the second call is a no-op that keeps the cached handle.
 */
export function initLogsDb(dataDir: string): Database.Database {
  // Same fail-closed rail as initDb(): never let a test-runner process open a
  // database outside os.tmpdir(). See server/db-safety.ts.
  assertSafeTestDataDir(dataDir);

  if (logsDb && !logsDbPathOverride) return logsDb;

  const dbPath = logsDbPathOverride || path.join(dataDir, 'logs.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // WAL for concurrent readers alongside the single batch writer. `normal`
  // sync trades a small durability window (last few committed txns on a hard
  // crash) for throughput — acceptable for developer log tail data, and the
  // source app never blocks on our fsync. `wal_autocheckpoint` bounds the WAL
  // so a write burst can't grow it without limit; `busy_timeout` lets a reader
  // wait out the writer instead of throwing SQLITE_BUSY.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');

  // Safe startup/recovery: a prior hard crash can leave the WAL mid-commit.
  // `wal_checkpoint(TRUNCATE)` replays and resets it; `quick_check` surfaces
  // gross corruption in the log. We never throw on a dirty WAL — logs are
  // best-effort and must not block boot (decision LOG-STORE).
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const integrity = db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') {
      console.warn(`[logs] logs.db quick_check returned: ${String(integrity)}`);
    }
  } catch (e) {
    console.warn('[logs] logs.db startup recovery pragma failed:', (e as Error).message);
  }

  db.exec(LOGS_SCHEMA);

  // FTS5 is optional at the SQLite-build level. Degrade to "no message search"
  // rather than failing store init if the extension is missing.
  try {
    db.exec(LOGS_FTS_SCHEMA);
    ftsAvailable = true;
  } catch (e) {
    ftsAvailable = false;
    console.warn('[logs] FTS5 unavailable — log message search disabled:', (e as Error).message);
  }

  logsDb = db;
  return db;
}

/** Close the handle (tests / shutdown). */
export function closeLogsDb(): void {
  if (logsDb) {
    try {
      logsDb.close();
    } catch {}
    logsDb = null;
    ftsAvailable = false;
  }
}

// ── Retention / quota resolution ──────────────────────────────────────────

export function clampRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.floor(days)));
}

export function clampQuotaBytes(bytes: number): number {
  if (!Number.isFinite(bytes)) return DEFAULT_PROJECT_QUOTA_BYTES;
  return Math.min(MAX_PROJECT_QUOTA_BYTES, Math.max(MIN_PROJECT_QUOTA_BYTES, Math.floor(bytes)));
}

/**
 * Resolve a query page size to a safe, bounded integer. A missing or
 * non-finite (NaN/Infinity) `limit` — e.g. from a malformed API query —
 * falls back to the default rather than binding `NaN` into `LIMIT ?` (which
 * SQLite rejects). Finite values are floored and clamped to
 * `[1, MAX_QUERY_LIMIT]`, mirroring the retention/quota clamp helpers.
 */
export function clampQueryLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  return Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(limit)));
}

export interface RetentionConfig {
  retentionDays: number;
  quotaBytes: number;
}

/** Resolve a project's retention config, falling back to code defaults. */
export function getRetentionConfig(projectId: string): RetentionConfig {
  const row = getLogsDb()
    .prepare('SELECT retention_days, quota_bytes FROM log_retention_config WHERE project_id = ?')
    .get(projectId) as { retention_days: number; quota_bytes: number } | undefined;
  if (!row) {
    return { retentionDays: DEFAULT_RETENTION_DAYS, quotaBytes: DEFAULT_PROJECT_QUOTA_BYTES };
  }
  return { retentionDays: row.retention_days, quotaBytes: row.quota_bytes };
}

/** Upsert a project's retention config, clamping to documented bounds. */
export function setRetentionConfig(
  projectId: string,
  cfg: Partial<RetentionConfig>,
  nowMs: number,
): RetentionConfig {
  const current = getRetentionConfig(projectId);
  const next: RetentionConfig = {
    retentionDays: clampRetentionDays(cfg.retentionDays ?? current.retentionDays),
    quotaBytes: clampQuotaBytes(cfg.quotaBytes ?? current.quotaBytes),
  };
  getLogsDb()
    .prepare(
      `INSERT INTO log_retention_config (project_id, retention_days, quota_bytes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         retention_days = excluded.retention_days,
         quota_bytes    = excluded.quota_bytes,
         updated_at     = excluded.updated_at`,
    )
    .run(projectId, next.retentionDays, next.quotaBytes, nowMs);
  return next;
}

// ── Sources ───────────────────────────────────────────────────────────────

export interface LogSourceInput {
  id: string;
  projectId: string;
  name: string;
  serviceName?: string | null;
  environment?: string | null;
  tokenHash?: string | null;
  tokenPrefix?: string | null;
}

/** Insert a log source. Throws on a duplicate (project_id, name). */
export function insertLogSource(src: LogSourceInput, nowMs: number): void {
  getLogsDb()
    .prepare(
      `INSERT INTO log_sources
         (id, project_id, name, service_name, environment, token_hash, token_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      src.id,
      src.projectId,
      src.name,
      src.serviceName ?? null,
      src.environment ?? null,
      src.tokenHash ?? null,
      src.tokenPrefix ?? null,
      nowMs,
    );
}

// ── Records ───────────────────────────────────────────────────────────────

export interface LogRecordInput {
  projectId: string;
  sourceId: string;
  timeUnixNano: number;
  observedTimeUnixNano?: number | null;
  severityNumber?: number;
  severityText?: string | null;
  body?: string | null;
  serviceName?: string | null;
  environment?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  fingerprint?: string | null;
  resourceJson?: string | null;
  attributesJson?: string | null;
  scopeJson?: string | null;
  /**
   * Pre-computed normalized byte size. When the ingest normalizer has already
   * sized (and oversize-filtered) the record, the writer reuses this instead of
   * recomputing; absent, `insertLogRecords` computes it from the text columns.
   */
  byteSize?: number;
}

export interface LogRecordRow {
  id: number;
  project_id: string;
  source_id: string;
  time_unix_nano: number;
  observed_time_unix_nano: number | null;
  severity_number: number;
  severity_text: string | null;
  body: string | null;
  service_name: string | null;
  environment: string | null;
  trace_id: string | null;
  span_id: string | null;
  fingerprint: string | null;
  resource_json: string | null;
  attributes_json: string | null;
  scope_json: string | null;
  byte_size: number;
  ingested_at: number;
}

/** UTF-8 byte length of a value, treating null/undefined as zero. */
function byteLen(s: string | null | undefined): number {
  return s ? Buffer.byteLength(s, 'utf8') : 0;
}

/**
 * Approximate normalized on-disk footprint of a record: the sum of its
 * variable-length text columns. Used for the per-project quota accounting;
 * an exact page count is not needed, only a stable proportional measure.
 */
export function recordByteSize(r: LogRecordInput): number {
  return (
    byteLen(r.body) +
    byteLen(r.severityText) +
    byteLen(r.serviceName) +
    byteLen(r.environment) +
    byteLen(r.traceId) +
    byteLen(r.spanId) +
    byteLen(r.fingerprint) +
    byteLen(r.resourceJson) +
    byteLen(r.attributesJson) +
    byteLen(r.scopeJson)
  );
}

export interface InsertResult {
  /** Rows actually written. */
  inserted: number;
  /** Rows rejected because they exceeded MAX_RECORD_BYTES. */
  rejectedOversize: number;
}

/**
 * Insert a batch of normalized records in one transaction, maintaining the
 * FTS index in lockstep. Records above `MAX_RECORD_BYTES` are dropped and
 * counted rather than aborting the batch (partial success — decision
 * LOG-STORE). Batches above `MAX_BATCH_RECORDS` throw: the caller (ingest
 * endpoint) is expected to have already chunked and returned 4xx.
 */
export function insertLogRecords(records: LogRecordInput[], nowMs: number): InsertResult {
  if (records.length > MAX_BATCH_RECORDS) {
    throw new Error(`batch of ${records.length} exceeds MAX_BATCH_RECORDS (${MAX_BATCH_RECORDS})`);
  }
  const db = getLogsDb();
  const insertRec = db.prepare(
    `INSERT INTO log_records
       (project_id, source_id, time_unix_nano, observed_time_unix_nano,
        severity_number, severity_text, body, service_name, environment,
        trace_id, span_id, fingerprint, resource_json, attributes_json,
        scope_json, byte_size, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = ftsAvailable
    ? db.prepare('INSERT INTO log_records_fts (rowid, body, project_id) VALUES (?, ?, ?)')
    : null;

  const result: InsertResult = { inserted: 0, rejectedOversize: 0 };
  const run = db.transaction((rows: LogRecordInput[]) => {
    for (const r of rows) {
      const size = r.byteSize ?? recordByteSize(r);
      if (size > MAX_RECORD_BYTES) {
        result.rejectedOversize++;
        continue;
      }
      const info = insertRec.run(
        r.projectId,
        r.sourceId,
        r.timeUnixNano,
        r.observedTimeUnixNano ?? null,
        r.severityNumber ?? 0,
        r.severityText ?? null,
        r.body ?? null,
        r.serviceName ?? null,
        r.environment ?? null,
        r.traceId ?? null,
        r.spanId ?? null,
        r.fingerprint ?? null,
        r.resourceJson ?? null,
        r.attributesJson ?? null,
        r.scopeJson ?? null,
        size,
        nowMs,
      );
      if (insertFts && r.body) {
        insertFts.run(info.lastInsertRowid as number, r.body, r.projectId);
      }
      result.inserted++;
    }
  });
  run(records);
  return result;
}

// ── Bounded query ─────────────────────────────────────────────────────────

export interface LogQuery {
  projectId: string;
  /** Inclusive lower bound on time_unix_nano. */
  startTimeUnixNano?: number;
  /** Inclusive upper bound on time_unix_nano. */
  endTimeUnixNano?: number;
  sourceId?: string;
  serviceName?: string;
  environment?: string;
  /** Minimum severity number (inclusive) — e.g. ERROR floor. */
  minSeverityNumber?: number;
  traceId?: string;
  fingerprint?: string;
  /** FTS5 MATCH query over the body. Ignored when FTS is unavailable. */
  text?: string;
  /** Opaque cursor from a prior page: only rows with id < cursor are returned. */
  cursor?: number;
  /** Page size; clamped to [1, MAX_QUERY_LIMIT]. */
  limit?: number;
}

export interface LogQueryPage {
  records: LogRecordRow[];
  /** Cursor to pass as `cursor` for the next (older) page, or null at the end. */
  nextCursor: number | null;
}

/**
 * Project-scoped, newest-first, cursor-paginated query (decision LOG-QUERY).
 * Always bounded: the effective limit is clamped to `MAX_QUERY_LIMIT` no
 * matter what the caller passes, so a query can never scan the whole table
 * into memory.
 */
export function queryLogRecords(q: LogQuery): LogQueryPage {
  const db = getLogsDb();
  const limit = clampQueryLimit(q.limit);

  const where: string[] = ['r.project_id = ?'];
  const params: Array<string | number> = [q.projectId];

  const useFts = Boolean(q.text) && ftsAvailable;
  const from = useFts ? 'log_records r JOIN log_records_fts f ON f.rowid = r.id' : 'log_records r';
  if (useFts) {
    // Column-specific FTS5 MATCH against the indexed `body` column (the only
    // indexed FTS column — `project_id` is UNINDEXED). Matching a concrete
    // column avoids the ambiguity of the hidden table-name operand under a
    // table alias.
    where.push('f.body MATCH ?');
    params.push(q.text as string);
  }

  if (q.startTimeUnixNano != null) {
    where.push('r.time_unix_nano >= ?');
    params.push(q.startTimeUnixNano);
  }
  if (q.endTimeUnixNano != null) {
    where.push('r.time_unix_nano <= ?');
    params.push(q.endTimeUnixNano);
  }
  if (q.sourceId) {
    where.push('r.source_id = ?');
    params.push(q.sourceId);
  }
  if (q.serviceName) {
    where.push('r.service_name = ?');
    params.push(q.serviceName);
  }
  if (q.environment) {
    where.push('r.environment = ?');
    params.push(q.environment);
  }
  if (q.minSeverityNumber != null) {
    where.push('r.severity_number >= ?');
    params.push(q.minSeverityNumber);
  }
  if (q.traceId) {
    where.push('r.trace_id = ?');
    params.push(q.traceId);
  }
  if (q.fingerprint) {
    where.push('r.fingerprint = ?');
    params.push(q.fingerprint);
  }
  if (q.cursor != null) {
    where.push('r.id < ?');
    params.push(q.cursor);
  }

  // Fetch one extra row to decide whether a further page exists.
  const sql = `SELECT r.* FROM ${from} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit + 1) as LogRecordRow[];

  let nextCursor: number | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    nextCursor = rows[rows.length - 1].id;
  }
  return { records: rows, nextCursor };
}

/** Total bytes currently stored for a project (quota accounting). */
export function getProjectByteSize(projectId: string): number {
  const row = getLogsDb()
    .prepare('SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM log_records WHERE project_id = ?')
    .get(projectId) as { bytes: number };
  return row.bytes;
}

/**
 * On-disk footprint of logs.db, in bytes (page_count × page_size). Used for the
 * `dbBytes` health gauge (decision LOG-SCOPE). Reflects the main database file;
 * the WAL is checkpointed into it periodically (see `wal_autocheckpoint`).
 */
export function getLogsDbFileBytes(): number {
  const db = getLogsDb();
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  if (!Number.isFinite(pageCount) || !Number.isFinite(pageSize)) return 0;
  return pageCount * pageSize;
}

/**
 * Retention lag: records for a project that are already past its retention
 * window but not yet reaped (a healthy Hub keeps this near zero; a growing
 * value means the reaper is falling behind — decision LOG-SCOPE). Uses the
 * (project_id, time_unix_nano) index so it is an index-only COUNT, no scan.
 */
export function countExpiredLogRecords(projectId: string, nowMs: number): number {
  const { retentionDays } = getRetentionConfig(projectId);
  const cutoffNano = (nowMs - retentionDays * 24 * 60 * 60 * 1000) * 1_000_000;
  const row = getLogsDb()
    .prepare('SELECT COUNT(*) AS n FROM log_records WHERE project_id = ? AND time_unix_nano < ?')
    .get(projectId, cutoffNano) as { n: number };
  return row.n;
}

// ── Cleanup hooks ─────────────────────────────────────────────────────────

/** Delete a set of record ids and their FTS rows in one transaction. */
function deleteRecordIds(db: Database.Database, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const delRec = db.prepare(`DELETE FROM log_records WHERE id IN (${placeholders})`);
  const delFts = ftsAvailable
    ? db.prepare(`DELETE FROM log_records_fts WHERE rowid IN (${placeholders})`)
    : null;
  const run = db.transaction((rowIds: number[]) => {
    if (delFts) delFts.run(...rowIds);
    delRec.run(...rowIds);
  });
  run(ids);
}

/**
 * Retention reaper: delete records older than each project's retention
 * window. Bounded per call by `maxDeletes` so a large backlog drains across
 * several ticks instead of holding one long write transaction. Returns the
 * number of records deleted.
 */
export function pruneExpiredLogRecords(nowMs: number, maxDeletes = 5000): number {
  const db = getLogsDb();
  const dayMs = 24 * 60 * 60 * 1000;

  // Resolve each project's cutoff, then collect the oldest expired ids up to
  // the per-call budget. `time_unix_nano` is nanoseconds; cutoffs are ms → ns.
  const projects = db.prepare('SELECT DISTINCT project_id FROM log_records').all() as Array<{
    project_id: string;
  }>;

  const toDelete: number[] = [];
  for (const { project_id } of projects) {
    if (toDelete.length >= maxDeletes) break;
    const { retentionDays } = getRetentionConfig(project_id);
    const cutoffNano = (nowMs - retentionDays * dayMs) * 1_000_000;
    const remaining = maxDeletes - toDelete.length;
    const ids = db
      .prepare(
        `SELECT id FROM log_records
          WHERE project_id = ? AND time_unix_nano < ?
          ORDER BY id ASC LIMIT ?`,
      )
      .all(project_id, cutoffNano, remaining) as Array<{ id: number }>;
    for (const { id } of ids) toDelete.push(id);
  }

  deleteRecordIds(db, toDelete);
  return toDelete.length;
}

/**
 * Quota reaper: for a single project, evict the oldest records until its
 * stored bytes drop to or below the resolved quota. Bounded per call by
 * `maxDeletes`. Returns the number of records deleted.
 */
export function enforceProjectQuota(projectId: string, maxDeletes = 5000): number {
  const db = getLogsDb();
  const { quotaBytes } = getRetentionConfig(projectId);
  let stored = getProjectByteSize(projectId);
  if (stored <= quotaBytes) return 0;

  const rows = db
    .prepare(
      `SELECT id, byte_size FROM log_records
        WHERE project_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(projectId, maxDeletes) as Array<{ id: number; byte_size: number }>;

  const toDelete: number[] = [];
  for (const row of rows) {
    if (stored <= quotaBytes) break;
    toDelete.push(row.id);
    stored -= row.byte_size;
  }
  deleteRecordIds(db, toDelete);
  return toDelete.length;
}
