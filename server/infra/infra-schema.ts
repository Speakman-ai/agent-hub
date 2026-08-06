/**
 * Schema for the dedicated AWS infrastructure-monitoring store (`infra.db`).
 *
 * Decision INFRA-STORE: metric points arrive at collector cadence across every
 * monitored resource, which is a fundamentally different write profile from
 * Agent Hub's operational state. They live in their own SQLite database under
 * the data directory — never in `agent-hub.db` or `orgs.db` — exactly as
 * `logs.db` does for customer application logs.
 *
 * The DDL lives here as an exported constant so the runtime store
 * (`infra-db.ts`) and its Vitest coverage share one source of truth (same
 * pattern as `logs-schema.ts` / `deployment-env-config-schema.ts`).
 *
 * This module owns the two tables the rest of the epic reads from:
 *
 *   - `infra_scopes` — the per-project collection allowlist (decision
 *     INFRA-SCOPE). Nothing is polled until a scope row exists.
 *   - `infra_resources` — the describe-API-derived inventory the collector
 *     builds its query list from, so the hot path never paginates ListMetrics.
 *   - `infra_metric_points` — the time series itself, mirroring CloudWatch's
 *     own 60s/300s/3600s rollup tiers rather than recomputing them.
 *   - `infra_collect_runs` — the per-tick audit trail INFRA-COST reads to keep
 *     AWS API spend a visible, capped quantity.
 *   - `infra_cost_config` — the per-project spend ceiling and the collector's
 *     current degradation level, which is what turns that audit trail from a
 *     record into a brake.
 *
 * `infra_retention_config` and the alert tables are appended by their own
 * tickets; the DDL is a single idempotent block so those additions are edits to
 * this constant.
 */

/** Filename of the store under the data dir. */
export const INFRA_DB_FILENAME = 'infra.db';

/**
 * Separator for the derived resource key. Every component is percent-encoded
 * before joining, so this byte can never appear inside one — the key stays
 * injective even for resource ids that are full ARNs (`:` / `/` heavy).
 */
export const INFRA_RESOURCE_KEY_SEPARATOR = '|';

/**
 * `dimensions_hash` value for a metric point carrying no dimensions. A literal
 * sentinel rather than the hash of an empty object so the overwhelmingly common
 * case stays readable in the table and costs no digest.
 */
export const INFRA_EMPTY_DIMENSIONS_HASH = '-';

/**
 * Bounds for the batched metric-point writer (`infra-write-queue.ts`), each
 * overridable at runtime:
 *
 *   - `INFRA_WRITE_QUEUE_MAX_POINTS`      — queue depth cap (backpressure)
 *   - `INFRA_WRITE_QUEUE_FLUSH_POINTS`    — points per write transaction
 *   - `INFRA_WRITE_QUEUE_FLUSH_INTERVAL_MS` — background flush cadence
 *
 * The depth default is sized to hold several full collector ticks: one tick may
 * issue up to 500 GetMetricData queries (decision INFRA-COLLECT), each
 * returning a window's worth of datapoints, so a single tick can be tens of
 * thousands of points. The flush default is larger than the logs queue's
 * because a metric point is a handful of small columns rather than a log body.
 */
export const DEFAULT_INFRA_WRITE_QUEUE_MAX_POINTS = 200_000;
export const DEFAULT_INFRA_WRITE_QUEUE_FLUSH_POINTS = 2_000;
export const DEFAULT_INFRA_WRITE_QUEUE_FLUSH_INTERVAL_MS = 250;

/**
 * Table DDL for `infra.db`, kept separate from the index DDL below.
 *
 * `initInfraDb()` executes the tables, reconciles additive column drift, and
 * only then creates the indexes. That ordering matters: a `CREATE INDEX` over a
 * column a later ticket added would throw on an older install if it ran in the
 * same block as the `CREATE TABLE IF NOT EXISTS` that no-ops on that install —
 * the documented limitation in `schema-reconcile.ts` ("indexes over freshly
 * added columns still need the column ordered ahead of them"). Splitting the
 * two halves orders it structurally instead of per-migration.
 *
 * Idempotent (`IF NOT EXISTS` throughout) so it doubles as the migration
 * entrypoint — both halves re-execute on every boot.
 */
export const INFRA_TABLES_SCHEMA = `
  -- Per-project collection allowlist (decision INFRA-SCOPE). One row per
  -- (profile, region, service) triple the operator explicitly opted into, with
  -- an optional tag filter. Auto-discovering an entire account would produce a
  -- surprise AWS bill and a throttling storm in someone else's account, so the
  -- absence of a row means "do not poll", never "poll everything".
  --
  -- Keyed on profile_name rather than account_id because the profile is what
  -- the operator picks in the UI and what INFRA-CRED resolves credentials from.
  -- account_id is the resolved identity behind that profile, filled in once
  -- sts:GetCallerIdentity has run; it stays NULL until then rather than
  -- blocking scope creation on a live AWS call.
  CREATE TABLE IF NOT EXISTS infra_scopes (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    profile_name    TEXT NOT NULL,
    account_id      TEXT,
    region          TEXT NOT NULL,
    -- Service token (e.g. 'ec2', 'rds', 'elbv2'). Deliberately free text with
    -- no CHECK: the service list grows every ticket, and a CHECK constraint
    -- cannot be widened without rebuilding the table.
    service         TEXT NOT NULL,
    -- Optional tag filter as JSON ({ "Key": ["v1","v2"] }). NULL = no filter.
    tag_filter_json TEXT,
    -- Operator pause switch. A disabled scope is retained (a pause, not a
    -- delete) so its inventory and history survive being switched back on.
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE (project_id, profile_name, region, service)
  );

  -- Resource inventory, built from the per-service describe APIs (decision
  -- INFRA-SCOPE). ListMetrics omits any metric with no data in the past two
  -- weeks, so it is a list of *reporting* resources and can never be the
  -- inventory — hence describe-first, persisted here.
  --
  -- resource_key is the derived, stable join key metric points and alert rows
  -- reference (see infraResourceKey in infra-db.ts). The UNIQUE below restates
  -- the same tuple as a database-enforced guarantee, so a bug in key derivation
  -- surfaces as a constraint violation instead of silently merging two
  -- resources into one chart.
  --
  -- Rows are aged out by a stale last_seen, not deleted: a terminated instance
  -- must fade from the UI rather than vanish out from under a chart mid-render.
  CREATE TABLE IF NOT EXISTS infra_resources (
    resource_key TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    account_id   TEXT NOT NULL,
    region       TEXT NOT NULL,
    service      TEXT NOT NULL,
    resource_id  TEXT NOT NULL,
    name         TEXT,
    -- Full tag set as JSON. Untrusted, operator- or third-party-controlled
    -- text (decision INFRA-WIZARD) — never interpolated into prompt text.
    tags_json    TEXT,
    -- Optional join key to the rest of Agent Hub. log_records, log_sources and
    -- every deployment_env_* table already carry an environment label, so a
    -- future "this deploy, these hosts, these logs" view needs no schema change.
    environment  TEXT,
    -- Provider lifecycle state ('running', 'stopped', 'terminated', …).
    state        TEXT,
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    UNIQUE (project_id, account_id, region, service, resource_id)
  );

  -- The time series (decision INFRA-STORE). One row per datapoint CloudWatch
  -- returned, stored at the tier it was requested at rather than downsampled
  -- locally: CloudWatch already rolls up server-side on 60s/300s/3600s, and a
  -- rollup pipeline here would be a second source of truth for data we do not
  -- own.
  --
  -- The natural key is (resource, series, period, timestamp). Re-collecting an
  -- overlapping window is routine — a tick retries, or the operator widens a
  -- range — so the writer upserts on that key. Without it, every retry would
  -- double the points behind a chart.
  --
  -- \`id\` exists so the retention reaper can select-then-delete by rowid in
  -- bounded batches (the same shape as log_records) instead of issuing an
  -- unbounded range delete that would hold the write lock for a whole pass.
  CREATE TABLE IF NOT EXISTS infra_metric_points (
    id              INTEGER PRIMARY KEY,
    project_id      TEXT NOT NULL,
    -- Joins to infra_resources.resource_key. Deliberately NOT a foreign key:
    -- an in-flight tick may land points for a resource whose inventory row the
    -- sync has not written yet, and losing telemetry to an ordering race is
    -- worse than briefly holding points for an unlisted resource.
    resource_key    TEXT NOT NULL,
    namespace       TEXT NOT NULL,
    metric_name     TEXT NOT NULL,
    -- Stable digest of the dimension set, so the natural key stays a fixed
    -- width no matter how many dimensions a series carries. '-' when there are
    -- none (INFRA_EMPTY_DIMENSIONS_HASH).
    dimensions_hash TEXT NOT NULL,
    -- The dimensions themselves, for display. Untrusted, operator- or
    -- third-party-controlled text (decision INFRA-WIZARD).
    dimensions_json TEXT,
    -- CloudWatch statistic the value was requested with ('Average', 'Maximum',
    -- 'Sum', 'p99', …). Part of the key: the same metric polled on two stats is
    -- two series, not one series that overwrites itself.
    stat            TEXT NOT NULL,
    -- Requested period in seconds. Part of the key because the collector picks
    -- the period from the window's age (60s within 15 days, 300s within 63,
    -- 3600s beyond), so one metric legitimately has points at several tiers.
    period_s        INTEGER NOT NULL,
    ts_ms           INTEGER NOT NULL,
    value           REAL NOT NULL
  );

  -- Per-tick collector audit (decision INFRA-COST). GetMetricData is billed per
  -- 1,000 metrics requested and is never in the free tier, so what a tick cost
  -- has to be recorded at the moment it is spent rather than reconstructed from
  -- a bill weeks later.
  CREATE TABLE IF NOT EXISTS infra_collect_runs (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    -- NULL until sts:GetCallerIdentity has resolved the profile, mirroring
    -- infra_scopes.account_id.
    account_id          TEXT,
    region              TEXT,
    started_at          INTEGER NOT NULL,
    -- NULL while the tick is still running; a row that never gets one is a
    -- crashed tick, which is itself the signal.
    finished_at         INTEGER,
    duration_ms         INTEGER,
    queries_issued      INTEGER NOT NULL DEFAULT 0,
    -- Billing quantity: metrics *requested*, which is what AWS charges for,
    -- not datapoints returned.
    metrics_requested   INTEGER NOT NULL DEFAULT 0,
    datapoints_returned INTEGER NOT NULL DEFAULT 0,
    points_written      INTEGER NOT NULL DEFAULT 0,
    throttles           INTEGER NOT NULL DEFAULT 0,
    errors              INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd  REAL NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running', 'ok', 'partial', 'failed')),
    error_message       TEXT
  );

  -- Per-project AWS API spend ceiling and the collector's current response to it
  -- (decision INFRA-COST: "A per-project monthly cost ceiling. On breach the
  -- collector degrades - widens the interval, then pauses - and raises an in-app
  -- notice. It never silently keeps spending.").
  --
  -- Keyed by project, not by scope, even though the ticket text says "in
  -- infra_scopes". A ceiling is a property of the budget, and infra_scopes is
  -- UNIQUE (project_id, profile_name, region, service) — storing a per-project
  -- number there would give it one copy per scope row with no defined winner,
  -- and adding a scope would silently resurrect whichever stale value that row
  -- was created with. One row per project is the same shape the retention
  -- override table uses and the same shape the deployment_env_* config tables
  -- use for per-environment settings.
  --
  -- The absence of a row means "no ceiling", not "ceiling of zero". Scoping is
  -- already an explicit opt-in whose projected monthly cost is shown before
  -- save, so an implicit ceiling nobody chose would pause monitoring the
  -- operator deliberately turned on — a silent outage traded for a bill they had
  -- already been quoted.
  CREATE TABLE IF NOT EXISTS infra_cost_config (
    project_id          TEXT PRIMARY KEY,
    -- NULL = uncapped. A ceiling of 0 is a real setting meaning "collect
    -- nothing", and is distinct from NULL.
    monthly_ceiling_usd REAL,
    -- Last degradation level the collector acted on. Persisted so the in-app
    -- notice fires on a state TRANSITION rather than on every tick — the same
    -- rule the alert evaluator holds to (decision INFRA-ALERT).
    degradation_level   TEXT NOT NULL DEFAULT 'normal'
      CHECK (degradation_level IN ('normal', 'widened', 'paused')),
    -- Epoch ms the level last changed. NULL while it has never left 'normal'.
    degraded_at         INTEGER,
    updated_at          INTEGER NOT NULL
  );
`;

/**
 * Index DDL for `infra.db`. Executed after {@link INFRA_TABLES_SCHEMA} and
 * after additive column reconciliation, so an index over a column added by a
 * later ticket is created against the repaired table rather than throwing on
 * an install whose tables predate the edit.
 */
export const INFRA_INDEXES_SCHEMA = `
  CREATE INDEX IF NOT EXISTS idx_infra_scopes_project
    ON infra_scopes(project_id);
  -- The collector and inventory-sync ticks both read "enabled scopes for a
  -- project"; enabled trails project_id so the composite serves both.
  CREATE INDEX IF NOT EXISTS idx_infra_scopes_project_enabled
    ON infra_scopes(project_id, enabled);

  -- Every read is project-scoped (index convention mirrors logs.db: project_id
  -- leads each composite). The inventory browser filters by service and region
  -- and sorts most-recently-seen first.
  CREATE INDEX IF NOT EXISTS idx_infra_resources_project_service
    ON infra_resources(project_id, service, last_seen DESC);
  CREATE INDEX IF NOT EXISTS idx_infra_resources_project_region
    ON infra_resources(project_id, region, service);
  CREATE INDEX IF NOT EXISTS idx_infra_resources_project_environment
    ON infra_resources(project_id, environment) WHERE environment IS NOT NULL;
  -- Global oldest-first scan for the aging/retention pass, which walks across
  -- projects rather than within one.
  CREATE INDEX IF NOT EXISTS idx_infra_resources_last_seen
    ON infra_resources(last_seen);

  -- Upsert target and the guarantee behind overlap idempotence: re-collecting a
  -- window that was already stored updates the existing point instead of
  -- appending a second one. resource_key already embeds project_id, so this is
  -- unique with or without the leading column; project_id leads anyway to match
  -- the store-wide convention and to serve per-project delete scans.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_metric_points_series
    ON infra_metric_points(
      project_id, resource_key, namespace, metric_name,
      dimensions_hash, stat, period_s, ts_ms
    );
  -- Chart reads: one metric on one resource over a bounded range, newest first.
  CREATE INDEX IF NOT EXISTS idx_infra_metric_points_chart
    ON infra_metric_points(project_id, resource_key, metric_name, ts_ms DESC);
  -- Global oldest-first scan for the retention reaper, which walks across
  -- projects rather than within one.
  CREATE INDEX IF NOT EXISTS idx_infra_metric_points_ts
    ON infra_metric_points(ts_ms);

  CREATE INDEX IF NOT EXISTS idx_infra_collect_runs_project
    ON infra_collect_runs(project_id, started_at DESC);
`;

/**
 * The complete `infra.db` DDL in execution order. Safe to `exec` as one block
 * against a fresh database (hermetic tests, scratch handles); the runtime store
 * runs the two halves separately so reconciliation can sit between them.
 */
export const INFRA_SCHEMA = `${INFRA_TABLES_SCHEMA}\n${INFRA_INDEXES_SCHEMA}`;
