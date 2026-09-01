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
  recoverWalAtStartupBounded,
  registerCheckpointDb,
  unregisterCheckpointDb,
} from '../db-checkpoint.js';

/** Checkpoint-registry label for `logs.db` (shared with the WAL-pressure gate). */
export const LOGS_CHECKPOINT_LABEL = 'logs.db';
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
import type { IssueGrouping } from './log-fingerprint.js';
import { recordIssueOccurrence } from './log-issues-store.js';

let logsDb: Database.Database | null = null;
/** True when the running SQLite build gave us the FTS5 message index. */
let ftsAvailable = false;

/** Test-only override of the `logs.db` location. `null` resets to default. */
let logsDbPathOverride: string | null = null;
export function setLogsDbPathForTests(p: string | null): void {
  logsDbPathOverride = p;
  if (logsDb) {
    try {
      unregisterCheckpointDb(logsDb);
    } catch {}
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
/**
 * Idempotent column migrations for pre-existing `logs.db` files. The
 * `CREATE TABLE IF NOT EXISTS` in {@link LOGS_SCHEMA} only applies its columns
 * to a freshly-created table, so a column added to an existing install needs an
 * explicit `ALTER TABLE`. Each migration probes for its column and adds it only
 * when missing, so re-running init on an up-to-date DB is a no-op.
 */
function migrateLogsSchema(db: Database.Database): void {
  try {
    db.prepare('SELECT analyze_session_id FROM log_issues LIMIT 1').get();
  } catch {
    db.exec('ALTER TABLE log_issues ADD COLUMN analyze_session_id TEXT');
  }
  for (const column of ['fix_card_id', 'fix_session_id']) {
    try {
      db.prepare(`SELECT ${column} FROM log_issues LIMIT 1`).get();
    } catch {
      db.exec(`ALTER TABLE log_issues ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS log_issue_fix_claims (
      project_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, issue_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_log_issue_fix_claim_card
      ON log_issue_fix_claims(card_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_log_issue_fix_claim_session
      ON log_issue_fix_claims(session_id);
  `);
}

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
  // source app never blocks on our fsync. `busy_timeout` lets a reader wait out
  // the writer instead of throwing SQLITE_BUSY. `registerCheckpointDb` applies
  // the shared WAL cadence pragmas (disables main-thread autocheckpoint + sets
  // journal_size_limit) and enrolls this handle in the background off-thread
  // checkpoint sweep, so a write burst is drained without ever running a
  // synchronous checkpoint on the request thread (see server/db-checkpoint.ts).
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  registerCheckpointDb(db, LOGS_CHECKPOINT_LABEL);

  // Safe startup/recovery: a prior hard crash can leave the WAL mid-commit.
  // `recoverWalAtStartupBounded` resets a small dirty WAL synchronously but
  // defers a large one to the off-thread sweep (the handle is already registered
  // above), so boot never pays a giant synchronous checkpoint. `quick_check`
  // surfaces gross corruption. We never throw on a dirty WAL — logs are
  // best-effort and must not block boot (decision LOG-STORE).
  try {
    recoverWalAtStartupBounded(db, 'logs.db');
    const integrity = db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') {
      console.warn(`[logs] logs.db quick_check returned: ${String(integrity)}`);
    }
  } catch (e) {
    console.warn('[logs] logs.db startup recovery pragma failed:', (e as Error).message);
  }

  db.exec(LOGS_SCHEMA);
  migrateLogsSchema(db);

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
      unregisterCheckpointDb(logsDb);
    } catch {}
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
  /**
   * Issue-grouping metadata for an ERROR-or-higher / structured-exception
   * record (decision LOG-GROUP). When present, `insertLogRecords` folds the
   * record into its issue group in the same transaction. Never persisted to
   * `log_records` — only `fingerprint` is a record column; the rest live on the
   * issue row.
   */
  grouping?: IssueGrouping | null;
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
  /** Canonical rows committed by this transaction, in input order. */
  records: LogRecordRow[];
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

  const run = db.transaction((rows: LogRecordInput[]): InsertResult => {
    // Keep every publication candidate local to the transaction. If any later
    // statement throws, better-sqlite3 rolls the DB back and this object never
    // escapes to the writer/live-tail path as a committed-looking result.
    const result: InsertResult = { inserted: 0, rejectedOversize: 0, records: [] };
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
      // Fold group-eligible records into their issue group in the same
      // transaction (decision LOG-GROUP), so a raw row and its aggregate
      // commit or roll back together.
      if (r.fingerprint && r.grouping) {
        recordIssueOccurrence(
          db,
          r.projectId,
          r.grouping,
          Number(info.lastInsertRowid),
          r.timeUnixNano,
          nowMs,
        );
      }
      result.records.push({
        id: Number(info.lastInsertRowid),
        project_id: r.projectId,
        source_id: r.sourceId,
        time_unix_nano: r.timeUnixNano,
        observed_time_unix_nano: r.observedTimeUnixNano ?? null,
        severity_number: r.severityNumber ?? 0,
        severity_text: r.severityText ?? null,
        body: r.body ?? null,
        service_name: r.serviceName ?? null,
        environment: r.environment ?? null,
        trace_id: r.traceId ?? null,
        span_id: r.spanId ?? null,
        fingerprint: r.fingerprint ?? null,
        resource_json: r.resourceJson ?? null,
        attributes_json: r.attributesJson ?? null,
        scope_json: r.scopeJson ?? null,
        byte_size: size,
        ingested_at: nowMs,
      });
      result.inserted++;
    }
    return result;
  });
  return run(records);
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
  /**
   * Ingest-id half of the keyset cursor from a prior page. Paired with
   * `cursorTimeUnixNano` it is the tie-break within one event timestamp; on its
   * own it is resolved to a full keyset by looking up that row's event time.
   */
  cursor?: number;
  /**
   * Event-time half of the keyset cursor: only rows strictly older than
   * `(cursorTimeUnixNano, cursor)` are returned. This is the axis the Live view
   * renders and trims on, so paging on it is what makes a trimmed record
   * recoverable through "Load older".
   */
  cursorTimeUnixNano?: number;
  /** Page size; clamped to [1, MAX_QUERY_LIMIT]. */
  limit?: number;
}

export interface LogQueryPage {
  records: LogRecordRow[];
  /** Ingest-id half of the cursor for the next (older) page; null at the end. */
  nextCursor: number | null;
  /** Event-time half of that cursor; null at the end. */
  nextCursorTimeUnixNano: number | null;
}

export interface LogQuerySincePage {
  /** Records newer than the supplied cursor, ordered oldest-first for replay. */
  records: LogRecordRow[];
  /** Cursor to use for the next bounded replay page, or null when caught up. */
  nextCursor: number | null;
}

/**
 * Project-scoped, newest-first, cursor-paginated query (decision LOG-QUERY).
 * Always bounded: the effective limit is clamped to `MAX_QUERY_LIMIT` no
 * matter what the caller passes, so a query can never scan the whole table
 * into memory.
 *
 * "Newest" means **newest by event time**, keyset-paginated on
 * `(time_unix_nano, id)` descending. Ingest id alone is the wrong axis here:
 * a delayed batch lands with high ids and old event times, so an id-ordered
 * page can hand back rows that are nowhere near the chronological tail, and an
 * id-predicated page can skip rows the caller still needs. Since the Live view
 * renders and trims on event time, paging on the same axis is what guarantees
 * a record trimmed from the client tail is exactly one "Load older" away.
 *
 * `id` remains the tie-break inside one timestamp and the stable opaque token,
 * so the pair is a total order over the table.
 *
 * A caller that supplies only `cursor` (the pre-keyset shape) is upgraded, not
 * degraded: that row's event time is looked up and the full keyset is used. If
 * the row is gone (purged, or another project's id) the query falls back to the
 * legacy `id <` predicate, which is the best positioning still available.
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
    // Resolve a bare id cursor into the keyset it stands for.
    const cursorTime =
      q.cursorTimeUnixNano ??
      (
        db
          .prepare('SELECT time_unix_nano AS t FROM log_records WHERE id = ? AND project_id = ?')
          .get(q.cursor, q.projectId) as { t: number } | undefined
      )?.t;
    if (cursorTime == null) {
      where.push('r.id < ?');
      params.push(q.cursor);
    } else {
      where.push('(r.time_unix_nano < ? OR (r.time_unix_nano = ? AND r.id < ?))');
      params.push(cursorTime, cursorTime, q.cursor);
    }
  }

  // Fetch one extra row to decide whether a further page exists.
  const sql = `SELECT r.* FROM ${from} WHERE ${where.join(' AND ')}
      ORDER BY r.time_unix_nano DESC, r.id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit + 1) as LogRecordRow[];

  let nextCursor: number | null = null;
  let nextCursorTimeUnixNano: number | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    const last = rows[rows.length - 1]!;
    nextCursor = last.id;
    nextCursorTimeUnixNano = last.time_unix_nano;
  }
  return { records: rows, nextCursor, nextCursorTimeUnixNano };
}

/**
 * Bounded reconnect backfill for a live tail. Unlike the historical query
 * above, this returns rows strictly *newer* than `cursor`, oldest-first, so a
 * client can advance its last-seen cursor without reordering the live stream.
 * The project predicate is deliberately first: a cursor obtained from another
 * project can never reveal that project's rows.
 *
 * `sinceUnixNano` bounds the seed to a recent time window. On the initial
 * subscribe (`cursor = 0`) this stops the backfill from replaying the entire
 * retained history oldest-first (which made the Live view fill with ancient
 * records before the newest arrived); paging from a recent cursor it is a
 * no-op, since those rows are already newer than the window.
 */
export function queryLogRecordsSince(
  projectId: string,
  cursor: number,
  limit?: number,
  sinceUnixNano?: number,
): LogQuerySincePage {
  const effectiveLimit = clampQueryLimit(limit);
  const where = ['project_id = ?', 'id > ?'];
  const params: Array<string | number> = [projectId, cursor];
  if (sinceUnixNano != null) {
    where.push('time_unix_nano >= ?');
    params.push(sinceUnixNano);
  }
  const rows = getLogsDb()
    .prepare(
      `SELECT * FROM log_records
        WHERE ${where.join(' AND ')}
        ORDER BY id ASC LIMIT ?`,
    )
    .all(...params, effectiveLimit + 1) as LogRecordRow[];
  let nextCursor: number | null = null;
  if (rows.length > effectiveLimit) {
    rows.length = effectiveLimit;
    nextCursor = rows[rows.length - 1]!.id;
  }
  return { records: rows, nextCursor };
}

/**
 * Initial live-tail seed: the `limit` chronologically newest rows inside the
 * window, returned oldest-first so a client can append them straight into
 * render order.
 *
 * A fresh subscribe must not walk the window from its oldest edge. On a busy
 * project that meant replaying the whole retention window into the browser
 * page-by-page, so the Live view opened on hours-old records and only reached
 * the actual tail after every intermediate page had streamed. Seeding from the
 * newest edge makes the first frame the tail; `queryLogRecords` ("Load older")
 * walks backwards on demand.
 *
 * "Newest" is by **event time**, matching how the client orders and caps the
 * rendered tail. Selecting by ingest id instead reopens the very bug this seed
 * exists to fix whenever event times are non-monotonic: let 100 current rows be
 * ingested and then a delayed batch of 500 older-timestamped rows arrive, and
 * `ORDER BY id DESC LIMIT 500` hands back only the delayed batch, so the Live
 * view opens away from the chronological tail again. Ordering on
 * `(time_unix_nano, id)` makes the seed the actual tail; id stays the tie-break
 * within a timestamp and the cursor token.
 *
 * The returned `cursor` is the project's **max committed ingest id at seed
 * time**, which is deliberately NOT the max id among the returned rows. The
 * event-time cutoff excludes rows that can hold far higher ids: a delayed batch
 * ingested late with old event times sits above every row in the seed. Handing
 * back the page's max would leave the client resubscribing below those rows, so
 * the next reconnect would drain `id > cursor` and splice already-known,
 * old-event-time records into the live tail as if they were new. The cursor is
 * therefore "everything already ingested has been considered"; excluded rows
 * stay reachable through the event-time "Load older" path, which is the only
 * path that positions them correctly anyway.
 *
 * The max-id read happens AFTER the page select on purpose. Anything committed
 * in between is by definition after the caller installed its live subscription,
 * so it reaches the client through the live queue and is deduped by id there;
 * reading the id first could only ever produce a cursor that is too low.
 */
export interface LogTailSeed {
  /** Chronologically newest rows in the window, oldest-first. */
  records: LogRecordRow[];
  /** Live resubscribe cursor: max committed ingest id for the project. */
  cursor: number;
}

export function queryLogTailSeed(
  projectId: string,
  limit?: number,
  sinceUnixNano?: number,
): LogTailSeed {
  const db = getLogsDb();
  const effectiveLimit = clampQueryLimit(limit);
  const where = ['project_id = ?'];
  const params: Array<string | number> = [projectId];
  if (sinceUnixNano != null) {
    where.push('time_unix_nano >= ?');
    params.push(sinceUnixNano);
  }
  const rows = db
    .prepare(
      `SELECT * FROM log_records
        WHERE ${where.join(' AND ')}
        ORDER BY time_unix_nano DESC, id DESC LIMIT ?`,
    )
    .all(...params, effectiveLimit) as LogRecordRow[];
  // Index seek on (project_id, id DESC), not a scan. Deliberately unbounded by
  // the time window: the cursor tracks *ingest progress*, not what the view
  // shows. Scoping it to the window would leave out-of-window high-id rows
  // permanently below the cursor, so every later reconnect would re-scan them.
  // Excluding them from the view is the window filter's job, applied on the
  // live push and the reconnect drain alike.
  const latest = db
    .prepare('SELECT id FROM log_records WHERE project_id = ? ORDER BY id DESC LIMIT 1')
    .get(projectId) as { id: number } | undefined;
  return { records: rows.reverse(), cursor: latest?.id ?? 0 };
}

/** Total bytes currently stored for a project (quota accounting). */
export function getProjectByteSize(projectId: string): number {
  const row = getLogsDb()
    .prepare('SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM log_records WHERE project_id = ?')
    .get(projectId) as { bytes: number };
  return row.bytes;
}

/**
 * Latest ingest wall-clock time (ms) per source for a project, keyed by
 * `source_id`. Sources with no records yet are absent from the map. The
 * `(project_id, source_id, id DESC)` index groups the rows per source cheaply;
 * SQLite still reads each group's matching rows to compute `MAX(ingested_at)`
 * (the aggregate column is not the index sort key), so cost scales with the
 * project's record count. Use the batch form only for the multi-source list
 * path; single-source fetches must use {@link getLastIngestAtForSource}.
 */
export function getLastIngestAtBySource(projectId: string): Map<string, number> {
  const rows = getLogsDb()
    .prepare(
      `SELECT source_id, MAX(ingested_at) AS last
         FROM log_records WHERE project_id = ? GROUP BY source_id`,
    )
    .all(projectId) as Array<{ source_id: string; last: number | null }>;
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.last != null) map.set(r.source_id, r.last);
  }
  return map;
}

/**
 * Latest ingest wall-clock time (ms) for a single source, or `null` if it has
 * never ingested. Scoped to one `(project_id, source_id)` so the
 * `(project_id, source_id, id DESC)` index seeks straight to that source's
 * newest row (`ORDER BY id DESC LIMIT 1`) — an index seek, not a project-wide
 * grouped scan. Use this on the single-source get path (rotate/revoke/delete
 * responses) instead of {@link getLastIngestAtBySource}.
 */
export function getLastIngestAtForSource(projectId: string, sourceId: string): number | null {
  const row = getLogsDb()
    .prepare(
      `SELECT ingested_at AS last
         FROM log_records
        WHERE project_id = ? AND source_id = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(projectId, sourceId) as { last: number | null } | undefined;
  return row?.last ?? null;
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
 * Manual purge: delete EVERY log record (and its FTS row) for a single project
 * in one transaction, returning the number of records removed. This backs the
 * user-initiated "Clear logs" action in the Logs module — distinct from the
 * age/quota reapers, which only evict a bounded oldest slice.
 *
 * Scope is deliberately the raw record stream (`log_records` + `log_records_fts`).
 * Grouped error Issues (`log_issues`) are a separate surface with their own
 * resolve/ignore lifecycle and links to live Fix/Analyze sessions, so they are
 * intentionally left intact — clearing the tail must not silently tear down an
 * in-flight investigation. The FTS rows are removed first (by the record ids
 * about to be deleted) so the message index never dangles past the records.
 */
export function purgeProjectLogRecords(projectId: string): number {
  const db = getLogsDb();
  const delFts = ftsAvailable
    ? db.prepare(
        'DELETE FROM log_records_fts WHERE rowid IN (SELECT id FROM log_records WHERE project_id = ?)',
      )
    : null;
  const delRec = db.prepare('DELETE FROM log_records WHERE project_id = ?');
  const run = db.transaction((pid: string): number => {
    if (delFts) delFts.run(pid);
    return delRec.run(pid).changes;
  });
  return run(projectId);
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
