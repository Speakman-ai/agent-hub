/**
 * Schema and bounds for the dedicated customer-application log store
 * (`logs.db`). Epic decision LOG-STORE: customer application logs are
 * high-volume and must NOT contend with Agent Hub operational state, so they
 * live in their own SQLite database under the data directory — never in
 * `agent-hub.db` or `orgs.db`.
 *
 * The DDL lives here as an exported constant so both the runtime store
 * (`logs-db.ts`) and its Vitest coverage share one source of truth for the
 * schema (same pattern as `runner-queue-schema.ts` / `mcp-servers-schema.ts`).
 *
 * Data model: the normalized rows follow the stable OpenTelemetry LogRecord
 * shape (decision LOG-INGEST) — timestamp, observed timestamp, severity
 * number/text, body, resource, attributes, instrumentation scope, trace_id,
 * span_id. High-cardinality facets we filter on (service, environment,
 * trace_id, fingerprint) are promoted to their own columns and indexed; the
 * full resource/attributes/scope blobs are kept as JSON text for fidelity.
 */

/**
 * OpenTelemetry severity numbers. We store the numeric severity so range
 * filters ("ERROR or higher") are index-friendly; `severity_text` keeps the
 * source's original label. See
 * https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 */
export const SEVERITY_NUMBER = {
  UNSPECIFIED: 0,
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
} as const;

/**
 * Records at or above this severity number are eligible for issue grouping
 * (decision LOG-GROUP). Exported here because the store's severity index is
 * the access path a grouping pass will scan.
 */
export const ERROR_SEVERITY_FLOOR = SEVERITY_NUMBER.ERROR;

// ── Store-wide bounds (decision LOG-STORE) ────────────────────────────────
/** Default retention window before the reaper deletes a record, in days. */
export const DEFAULT_RETENTION_DAYS = 7;
/** Operator-configurable retention bounds (inclusive). */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 90;

/** Default per-project on-disk quota before oldest records are evicted. */
export const DEFAULT_PROJECT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB
/** Operator-configurable quota bounds (inclusive). */
export const MIN_PROJECT_QUOTA_BYTES = 64 * 1024 * 1024; // 64 MiB
export const MAX_PROJECT_QUOTA_BYTES = 64 * 1024 * 1024 * 1024; // 64 GiB

/** Largest normalized single record we will persist. */
export const MAX_RECORD_BYTES = 256 * 1024; // 256 KiB
/** Largest batch of records accepted in one ingest call. */
export const MAX_BATCH_RECORDS = 1000;

/**
 * Largest ingest request body we accept (decision LOG-STORE: "Cap requests at
 * 1 MiB"). This is the single ceiling for BOTH the on-the-wire bytes of an
 * uncompressed request AND the DECOMPRESSED size of a gzip request — the body
 * parser bounds an inflated `Content-Encoding: gzip` body to this limit, and the
 * raw gzip-framed path caps its gunzip output to the same value (a
 * decompression-bomb guard). Anything larger is rejected with 413 before any
 * normalization runs.
 */
export const MAX_REQUEST_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Hard ceiling on rows returned by one bounded query, regardless of caller. */
export const MAX_QUERY_LIMIT = 500;
/** Default page size when a query omits `limit`. */
export const DEFAULT_QUERY_LIMIT = 100;

// ── Log-source management bounds (decision LOG-AUTH) ───────────────────────
/** Ingest-token wire prefix — `ahlog_<random>`; identifies the token scheme. */
export const LOG_SOURCE_TOKEN_PREFIX = 'ahlog_';
/** Max length of a source's display name. */
export const MAX_SOURCE_NAME_LENGTH = 100;
/** Max length of the `service_name` / `environment` facets carried on a source. */
export const MAX_SOURCE_FACET_LENGTH = 200;

/**
 * DDL for `logs.db`. Idempotent (`IF NOT EXISTS` throughout) so it doubles as
 * the migration entrypoint. The FTS5 virtual table is created separately in
 * `logs-db.ts` so a build of SQLite without FTS5 degrades to "no message
 * search" instead of failing store init.
 */
export const LOGS_SCHEMA = `
  -- Named ingest sources. Identity (org/project/source) is derived from the
  -- source token at ingest time (decision LOG-AUTH); this table is the
  -- registry the token resolves to. Token hashing / rotation lifecycle is
  -- owned by the LOG-AUTH ticket — the store only persists the columns.
  CREATE TABLE IF NOT EXISTS log_sources (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    name          TEXT NOT NULL,
    service_name  TEXT,
    environment   TEXT,
    token_hash    TEXT,
    token_prefix  TEXT,
    created_at    INTEGER NOT NULL,
    rotated_at    INTEGER,
    revoked_at    INTEGER,
    UNIQUE (project_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_log_sources_project ON log_sources(project_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_log_sources_token_hash
    ON log_sources(token_hash) WHERE token_hash IS NOT NULL;

  -- Append-only audit of source/token lifecycle events (decision LOG-AUTH:
  -- "audit credential lifecycle"). One row per create / update / rotate /
  -- revoke / delete, attributed to the acting Agent Hub user. Never holds a
  -- token or its hash — only that a lifecycle event happened, by whom, when.
  CREATE TABLE IF NOT EXISTS log_source_audit (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    source_id     TEXT,
    action        TEXT NOT NULL,
    actor_user_id TEXT,
    detail        TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_log_source_audit_project
    ON log_source_audit(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_log_source_audit_source
    ON log_source_audit(source_id, created_at DESC);

  -- Per-project retention / quota overrides. Absent row → code defaults
  -- (DEFAULT_RETENTION_DAYS / DEFAULT_PROJECT_QUOTA_BYTES).
  CREATE TABLE IF NOT EXISTS log_retention_config (
    project_id     TEXT PRIMARY KEY,
    retention_days INTEGER NOT NULL,
    quota_bytes    INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  -- Normalized OTel LogRecord rows. \`id\` is the implicit rowid: monotonic,
  -- so (project_id, id DESC) is the newest-first cursor the query contract
  -- (decision LOG-QUERY) pages on, and id is a stable opaque cursor token.
  CREATE TABLE IF NOT EXISTS log_records (
    id                       INTEGER PRIMARY KEY,
    project_id               TEXT NOT NULL,
    source_id                TEXT NOT NULL,
    time_unix_nano           INTEGER NOT NULL,
    observed_time_unix_nano  INTEGER,
    severity_number          INTEGER NOT NULL DEFAULT 0,
    severity_text            TEXT,
    body                     TEXT,
    service_name             TEXT,
    environment              TEXT,
    trace_id                 TEXT,
    span_id                  TEXT,
    fingerprint              TEXT,
    resource_json            TEXT,
    attributes_json          TEXT,
    scope_json               TEXT,
    byte_size                INTEGER NOT NULL DEFAULT 0,
    ingested_at              INTEGER NOT NULL
  );

  -- Access paths (decision LOG-STORE: time/project/source/severity indexes).
  -- Every read is project-scoped and newest-first, so project_id leads and
  -- id DESC tie-breaks each composite index into the cursor order.
  CREATE INDEX IF NOT EXISTS idx_log_records_project_id
    ON log_records(project_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_log_records_project_time
    ON log_records(project_id, time_unix_nano DESC);
  CREATE INDEX IF NOT EXISTS idx_log_records_project_source
    ON log_records(project_id, source_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_log_records_project_severity
    ON log_records(project_id, severity_number, id DESC);
  CREATE INDEX IF NOT EXISTS idx_log_records_project_trace
    ON log_records(project_id, trace_id) WHERE trace_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_log_records_project_fingerprint
    ON log_records(project_id, fingerprint) WHERE fingerprint IS NOT NULL;
  -- Retention reaper scans oldest-first across all projects.
  CREATE INDEX IF NOT EXISTS idx_log_records_time
    ON log_records(time_unix_nano);
`;

/**
 * FTS5 index over the log body for message search (decision LOG-STORE).
 * `content_rowid='id'` aligns the FTS rowid with `log_records.id`; the store
 * maintains it manually inside the insert/delete transactions (same trick as
 * `wiki_pages_fts` / `code_chunks_fts`) rather than with triggers, so a batch
 * insert stays a single prepared-statement loop.
 */
export const LOGS_FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS log_records_fts USING fts5(
    body,
    project_id UNINDEXED,
    content_rowid='id'
  );
`;
