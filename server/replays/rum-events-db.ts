/**
 * rum-events-db.ts — dedicated SQLite store for the RUM segment-ingest event
 * tables (`rum_segments` + `rum_sessions`).
 *
 * The segmented RUM path is the app's other hot-write flood (sibling to the
 * `runner_job_logs` spool). Every ~5s / ~60KB the browser recorder flushes ONE
 * view-scoped segment, and each flush is one INSERT into `rum_segments` plus a
 * read-modify-write rollup UPSERT into `rum_sessions`. At scale that stream
 * dwarfs the control-plane write rate. It used to live in the per-org primary
 * `agent-hub.db` alongside sessions, messages, kanban, wiki, and every other
 * request-path table — so a WAL checkpoint or write burst on the ingest stream
 * synchronously stalled unrelated primary-DB requests.
 *
 * Per spec `hot-write-isolation`, these two tables move into their own DB file
 * (`rum.db`) with their own connection + WAL, one file per org data dir (beside
 * that org's `agent-hub.db`). A checkpoint on this file no longer blocks a
 * request reading/writing `agent-hub.db`, and retention keeps the file small.
 *
 * What stays in the primary DB: `session_replays` (record-on-error monolithic
 * index, JOINed with `support_tickets` and the playlist tables), the playlist
 * tables, and `project_rum_clients` (low-churn ingest credentials). Those are
 * cross-table-JOINed and low-churn, so they are NOT eligible to move — the
 * ingest event tables here are only ever queried single-table (or self-JOINed
 * `rum_segments`↔`rum_sessions`), never across the file boundary.
 *
 * Pure leaf-ish module: imports only better-sqlite3 + node stdlib so `db.ts`
 * can wire it in without an import cycle. Prepared statements for these tables
 * are still built inside `db.ts` (against the handle this module returns) so
 * they land in the shared `Stmts` object and the store code is unchanged.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';

/**
 * DDL for the isolated ingest tables. Identical shape (columns + indexes) to
 * the tables that previously lived in the primary `agent-hub.db` schema, so
 * migrated rows drop straight in. See `db.ts` history for the per-column intent.
 */
export const RUM_EVENTS_SCHEMA = `
  -- rum_segments: the append-only segment manifest for 'segmented' captures.
  -- Each row indexes ONE gzipped S3 object holding a view-scoped slice of rrweb
  -- events. S3 is the byte source of truth; this table is the pointer + metadata
  -- index playback lists and orders by. Append is O(1): one PUT + one INSERT.
  -- The UNIQUE (session_id, view_id, index_in_view) makes an index-slot
  -- double-write fail instead of silently clobbering a segment.
  CREATE TABLE IF NOT EXISTS rum_segments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    view_id TEXT NOT NULL,
    project_id TEXT,
    index_in_view INTEGER NOT NULL,
    has_full_snapshot INTEGER NOT NULL DEFAULT 0,
    start_ts INTEGER NOT NULL DEFAULT 0,
    end_ts INTEGER NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 0,
    byte_size INTEGER NOT NULL DEFAULT 0,
    storage_kind TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    storage_bucket TEXT,
    storage_region TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rum_segments_slot
    ON rum_segments(session_id, view_id, index_in_view);
  -- Playback manifest: chronological across views, sequential within a view.
  CREATE INDEX IF NOT EXISTS idx_rum_segments_session
    ON rum_segments(session_id, start_ts, index_in_view);
  -- Retention sweep: age-ordered scan for the orphan-segment reconciliation pass.
  CREATE INDEX IF NOT EXISTS idx_rum_segments_created_at
    ON rum_segments(created_at);
  -- Per-tenant BASE-retention override sweep: seeks straight to the tenant's
  -- aged orphan segments instead of scanning the whole global age range.
  CREATE INDEX IF NOT EXISTS idx_rum_segments_project_created
    ON rum_segments(project_id, created_at);

  -- rum_sessions: the session-grain metadata row the RUM dashboard lists and
  -- filters on (Datadog "session" grain). One row per client-minted session id,
  -- carrying rollup aggregates maintained incrementally as segments ingest.
  -- Per-user identity (usr_*) folds LAST-non-null; enriched request facets
  -- (device_type/browser/os/geo_country) fold FIRST-non-null. The (project_id, *)
  -- indexes back the tenant-scoped list query and each facet/username filter.
  CREATE TABLE IF NOT EXISTS rum_sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    time_spent INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    action_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    frustration_count INTEGER NOT NULL DEFAULT 0,
    usr_id TEXT,
    usr_email TEXT,
    usr_name TEXT,
    usr_attributes TEXT,
    device_type TEXT,
    browser TEXT,
    os TEXT,
    geo_country TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_project
    ON rum_sessions(project_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_email
    ON rum_sessions(project_id, usr_email);
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_id
    ON rum_sessions(project_id, usr_id);
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_usr_name
    ON rum_sessions(project_id, usr_name);
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_device_type
    ON rum_sessions(project_id, device_type);
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_browser
    ON rum_sessions(project_id, browser);
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_os
    ON rum_sessions(project_id, os);
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_geo_country
    ON rum_sessions(project_id, geo_country);
  -- Retention sweep: age-ordered scan for the expired-session pass.
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_updated_at
    ON rum_sessions(updated_at);
  -- Per-tenant BASE-retention override sweep: seeks straight to the tenant's
  -- rows in age order instead of scanning the whole global age range.
  CREATE INDEX IF NOT EXISTS idx_rum_sessions_project_updated
    ON rum_sessions(project_id, updated_at);
`;

/** Default filename beside `agent-hub.db` in each org's data dir. */
export const RUM_EVENTS_DB_FILENAME = 'rum.db';

/**
 * One handle per org data dir. Like the primary `agent-hub.db` registry in
 * `db.ts`, prior handles stay open across org switches so in-flight prepared
 * statements captured against an old connection can still run.
 */
const registry = new Map<string, Database.Database>();
let current: Database.Database | null = null;

/**
 * Override the `rum.db` location — for tests only. Pass `null` to reset back to
 * the default (`<dir>/rum.db`). Closes any open handles so the next init is clean.
 */
let pathOverride: string | null = null;
export function setRumEventsDbPathForTests(p: string | null): void {
  pathOverride = p;
  closeRumEventsDb();
}

/** Close every open handle (test teardown / re-init). Safe to call when empty. */
export function closeRumEventsDb(): void {
  for (const handle of registry.values()) {
    try {
      handle.close();
    } catch {}
  }
  registry.clear();
  current = null;
}

/**
 * Accessor for the RUM events handle bound to the current org context (set by
 * the most recent {@link initRumEventsDb}). Throws if init hasn't run.
 */
export function getRumEventsDb(): Database.Database {
  if (!current) {
    throw new Error('rum.db not initialized — call initRumEventsDb() first');
  }
  return current;
}

/** Resolve the on-disk path for `rum.db` given the org data dir (honours override). */
export function resolveRumEventsDbPath(dir: string): string {
  return pathOverride || path.join(dir, RUM_EVENTS_DB_FILENAME);
}

/**
 * Open (or select) the dedicated RUM events DB for `dir` (the same org data dir
 * that holds `agent-hub.db`). Idempotent + cached per dir: a repeat call for a
 * known dir just re-selects the cached handle as current. Returns the handle so
 * `db.ts` can prepare the ingest statements against it.
 */
export function initRumEventsDb(dir: string): Database.Database {
  const dbPath = resolveRumEventsDbPath(dir);
  const cached = registry.get(dbPath);
  if (cached) {
    current = cached;
    return cached;
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Hot-write tables with a concurrent reader (playback / dashboard list) + the
  // migration's cross-connection ATTACH write; a short busy wait avoids spurious
  // `SQLITE_BUSY` under that light contention.
  db.pragma('busy_timeout = 5000');
  db.exec(RUM_EVENTS_SCHEMA);
  registry.set(dbPath, db);
  current = db;
  return db;
}

/**
 * One-time migration off the legacy primary `agent-hub.db` copies of the ingest
 * tables. Runs on the *primary* connection (the native owner, so the DROP never
 * fights a cross-connection lock): for each of `rum_segments` / `rum_sessions`
 * still present in the primary DB, ATTACH the dedicated `rum.db`, copy the rows
 * in, and drop the legacy table so the primary DB stops carrying (and
 * checkpointing) the flood — but ONLY after the copy is verified complete.
 *
 * Fresh installs are a no-op: the primary schema no longer creates these tables,
 * so they won't exist there. Column-skew safe: a legacy primary table predating
 * a later column (e.g. the usr or enrichment additions) is copied by the
 * intersection of its own columns with the destination schema — no heal-ALTER on
 * the primary side is needed, and the destination fills absent columns with its
 * own defaults.
 *
 * Data-loss safe (unlike the transient `runner_job_logs` spool): these tables
 * are the DURABLE RUM dashboard index/metadata, so the source is dropped only
 * after every source row is proven migrated — a destination row exists with the
 * same primary key AND identical values across every shared column (NULL-safe).
 * Key existence alone is NOT proof: `INSERT OR IGNORE` never overwrites a
 * pre-existing destination row, so a divergent row (a partial migration then a
 * live rollup update, a rollback, or a restored primary DB paired with an
 * existing `rum.db`) would satisfy a key check while the source values it would
 * discard differ. Any mismatch — that case, a row silently skipped by a
 * destination constraint, a partial copy, corruption, or an ATTACH/exec failure
 * — preserves the legacy table and retries on the next startup (the copy is
 * non-destructive: `INSERT OR IGNORE` is idempotent by PK and never clobbers the
 * destination). The only cost of a blocked drop is the primary DB keeping the
 * flood table one more boot; it is never traded for permanent metadata loss, and
 * a genuinely divergent restore is left for an operator rather than auto-merged.
 *
 * Must be called AFTER {@link initRumEventsDb} for the same dir (the destination
 * tables have to exist to receive rows).
 */
export function migrateLegacyRumEventsFromPrimary(primaryDb: Database.Database, dir: string): void {
  const dest = resolveRumEventsDbPath(dir);
  const present = (table: string): boolean =>
    primaryDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) !==
    undefined;
  // Column names of `table` in the given attached schema, via the table-valued
  // pragma function (its 2nd arg selects the schema — plain `PRAGMA table_info`
  // can't reach an attached DB's tables).
  const columnsIn = (schema: string, table: string): string[] =>
    (
      primaryDb.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{
        name: string;
      }>
    ).map((c) => c.name);

  if (!present('rum_segments') && !present('rum_sessions')) return;

  // Each table's primary key, used to verify the copy row-for-row before drop.
  const PRIMARY_KEY: Record<string, string> = {
    rum_segments: 'id',
    rum_sessions: 'session_id',
  };

  // SQLite string-literal escaping for the ATTACH path (single quotes doubled).
  const attachPath = dest.replace(/'/g, "''");
  try {
    primaryDb.exec(`ATTACH DATABASE '${attachPath}' AS rumev`);
    for (const table of ['rum_segments', 'rum_sessions']) {
      if (!present(table)) continue;
      const pk = PRIMARY_KEY[table];
      let verified = false;
      try {
        // Copy only the columns the legacy table and the destination share, so a
        // legacy table missing a newer column still migrates its rows intact.
        const destCols = new Set(columnsIn('rumev', table));
        const shared = columnsIn('main', table).filter((c) => destCols.has(c));
        if (shared.length) {
          const cols = shared.join(', ');
          primaryDb.exec(
            `INSERT OR IGNORE INTO rumev.${table} (${cols})
               SELECT ${cols} FROM main.${table}`,
          );
          // Root-cause guard: a source row is proven migrated ONLY when the
          // destination holds a row with the SAME primary key AND identical
          // values across every shared column (NULL-safe `IS`). Checking key
          // existence alone is insufficient — `INSERT OR IGNORE` never
          // overwrites a pre-existing destination row, so a divergent row (a
          // partial migration then a live rollup update, a rollback, or a
          // restored primary DB paired with an existing rum.db) would pass a
          // key-only check and the differing source values would be discarded.
          // A value mismatch (or a silently-skipped row) leaves `unmigrated > 0`
          // and blocks the drop, preserving the source non-destructively.
          const valueMatch = shared.map((c) => `d.${c} IS src.${c}`).join(' AND ');
          const unmigrated = (
            primaryDb
              .prepare(
                `SELECT COUNT(*) AS n FROM main.${table} src
                   WHERE NOT EXISTS (
                     SELECT 1 FROM rumev.${table} d
                      WHERE d.${pk} = src.${pk} AND ${valueMatch}
                   )`,
              )
              .get() as { n: number }
          ).n;
          verified = unmigrated === 0;
        }
      } catch {
        // Copy/verify failed (corrupt legacy rows, disk pressure, …). Leave the
        // source table in place so its rows are not lost; retry next startup.
        verified = false;
      }
      if (verified) {
        primaryDb.exec(`DROP TABLE IF EXISTS main.${table}`);
      } else {
        console.warn(
          `[rum-events-db] legacy ${table} copy incomplete; preserving source table for retry on next startup`,
        );
      }
    }
    primaryDb.exec(`DETACH DATABASE rumev`);
  } catch {
    // ATTACH/DETACH failed entirely — best-effort. Still detach so a half-open
    // attachment can't wedge later statements on this connection.
    try {
      primaryDb.exec(`DETACH DATABASE rumev`);
    } catch {}
  }
}
