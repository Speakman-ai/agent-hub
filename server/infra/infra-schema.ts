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
 *   - `infra_retention_config` — the per-project overrides the retention reaper
 *     resolves its age window and byte quota from.
 *   - `infra_alert_rules` / `infra_alerts` / `infra_alert_transitions` — the
 *     threshold rules we evaluate ourselves (decision INFRA-ALERT) and the
 *     open/resolved/ignored lifecycle of what they fired.
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

// ── Retention bounds (decision INFRA-STORE) ────────────────────────────────
/**
 * Default age window before the reaper deletes a metric point, in days.
 *
 * Longer than `logs.db`'s 7 because infra trends are the point: a capacity
 * question ("is this instance busier than it was last month?") is unanswerable
 * inside a one-week window, where a log question rarely reaches back that far.
 */
export const DEFAULT_INFRA_RETENTION_DAYS = 30;
/**
 * Operator-configurable retention bounds, inclusive.
 *
 * The floor is 1 rather than 0 because a 0-day window would delete points as
 * fast as the collector wrote them — paying AWS for data that never survives to
 * be charted. An operator who wants that should disable the scope instead.
 *
 * The ceiling is a year: past that the store is a time-series archive rather
 * than a monitoring window, and the right answer is an export, not a bigger
 * SQLite file. It is deliberately higher than logs' 90-day cap so a
 * year-over-year capacity comparison stays expressible.
 */
export const MIN_INFRA_RETENTION_DAYS = 1;
export const MAX_INFRA_RETENTION_DAYS = 365;

/**
 * Default per-project accounted footprint before the oldest points are evicted.
 *
 * Sized so a typical scoped deployment reaches the age window before it reaches
 * the quota, rather than being silently truncated by it: ~600 series polled at
 * a 60s period is ~864k points/day, and at the ~230-byte accounted size of a
 * point (see {@link INFRA_METRIC_POINT_BYTES_SQL}) 30 days of that is ~6 GiB.
 *
 * For a busier project the quota, not the age window, is what actually bounds
 * the store — that is intended. The window expresses how far back an operator
 * wants to look; the quota expresses how much disk they are willing to spend on
 * it, and the smaller of the two has to win.
 */
export const DEFAULT_INFRA_PROJECT_QUOTA_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB
/**
 * Operator-configurable quota bounds, inclusive.
 *
 * The floor is 1 MiB rather than the 64 MiB `logs.db` uses, because the two
 * stores hold rows of wildly different size: a single log record may be 256
 * KiB, so a 64 MiB floor there is a few hundred records, while a metric point
 * is ~230 bytes and 64 MiB of them is ~290k points. Carrying the logs floor
 * over would deny an operator on a constrained box any meaningful cap at all.
 * 1 MiB is still ~4,500 points — enough to chart — and its only real job is to
 * stop a quota of 0 from evicting data as fast as the collector writes it.
 */
export const MIN_INFRA_PROJECT_QUOTA_BYTES = 1024 * 1024; // 1 MiB
export const MAX_INFRA_PROJECT_QUOTA_BYTES = 256 * 1024 * 1024 * 1024; // 256 GiB

/**
 * Fixed per-row cost folded into the accounted size of a metric point: the
 * row header plus the five fixed-width columns (`id`, `period_s`, `ts_ms`,
 * `value`, and the record overhead SQLite adds per row).
 */
export const INFRA_METRIC_POINT_OVERHEAD_BYTES = 64;

/**
 * SQL expression for the accounted size of one `infra_metric_points` row.
 *
 * Deliberately computed rather than stored in a `byte_size` column the way
 * `log_records` does. A stored column would have to be maintained by the write
 * queue and could drift from the row it describes; this expression is derived
 * from the row itself, so it cannot. Both approaches cost the same to aggregate
 * (SQLite scans the rows either way), so the drift-free one wins.
 *
 * `length()` over TEXT counts characters, which would under-count a non-ASCII
 * dimension value or resource name — exactly the operator-controlled strings
 * most likely to be non-ASCII. Casting to BLOB first makes `length()` return
 * UTF-8 bytes.
 *
 * This measures the row's payload, matching what `log_records.byte_size`
 * accounts for. It excludes index overhead, so the real on-disk footprint of a
 * project is a small multiple of this — which is the safe direction for a
 * quota that must never over-report and evict data a project was entitled to.
 */
export const INFRA_METRIC_POINT_BYTES_SQL = `(
  ${INFRA_METRIC_POINT_OVERHEAD_BYTES}
  + length(CAST(project_id AS BLOB))
  + length(CAST(resource_key AS BLOB))
  + length(CAST(namespace AS BLOB))
  + length(CAST(metric_name AS BLOB))
  + length(CAST(dimensions_hash AS BLOB))
  + length(CAST(stat AS BLOB))
  + length(CAST(COALESCE(dimensions_json, '') AS BLOB))
)`;

// ── Alert lifecycle bounds (decision INFRA-ALERT) ──────────────────────────
/**
 * Severity levels a rule can fire at, ordered most to least urgent.
 *
 * Deliberately not CloudWatch vocabulary — CloudWatch has no severity concept
 * at all, only alarm state. Severity is ours, and it exists because
 * INFRA-NOTIFY routes on `(severity, channel)` rows: without it every alert
 * would have to page every channel.
 */
export const INFRA_ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type InfraAlertSeverity = (typeof INFRA_ALERT_SEVERITIES)[number];

/** Severity a rule gets when the operator does not choose one. */
export const DEFAULT_INFRA_ALERT_SEVERITY: InfraAlertSeverity = 'warning';

/**
 * Operator-facing lifecycle of a fired alert, identical to a log issue's
 * (`log-issues-store.ts`). Decision INFRA-ALERT: "it should look the same to
 * the user as a log issue does."
 */
export const INFRA_ALERT_STATUSES = ['open', 'resolved', 'ignored'] as const;
export type InfraAlertStatus = (typeof INFRA_ALERT_STATUSES)[number];

/** Delivery channels for an alert transition. */
export const INFRA_ALERT_CHANNELS = ['in_app', 'push', 'email'] as const;
export type InfraAlertChannel = (typeof INFRA_ALERT_CHANNELS)[number];

/**
 * Defaults are resolved in code and are intentionally not stored.  Critical
 * alerts page every channel, warnings page the live channels, and informational
 * alerts stay in the product.  An operator can override any individual row.
 */
export const DEFAULT_INFRA_ALERT_CHANNELS: Readonly<
  Record<InfraAlertSeverity, readonly InfraAlertChannel[]>
> = {
  critical: ['in_app', 'push', 'email'],
  warning: ['in_app', 'push'],
  info: ['in_app'],
};

/**
 * Transition rows retained per alert before the oldest are trimmed.
 *
 * The history table is the one alert table with unbounded growth: a flapping
 * resource writes two rows per collector tick indefinitely, and the retention
 * reaper deliberately owns `infra_metric_points` and nothing else. Trimming on
 * insert bounds it at the only moment the row count is already known, so the
 * table can never need a second reaper pass.
 *
 * 200 is sized to hold a full weekend of flapping (two transitions per 5-minute
 * tick is ~576/day, so 200 is roughly the last 8 hours of the worst case) while
 * a healthy alert's entire lifetime is a handful of rows. Past that the useful
 * artifact is the aggregate on the alert row — occurrence count, true first and
 * last seen — not the individual flap.
 */
export const INFRA_ALERT_TRANSITION_HISTORY_LIMIT = 200;

/** Actor recorded when recurrence reopens a resolved alert. */
export const INFRA_ALERT_RECURRENCE_ACTOR = 'system:recurrence';
/** Actor recorded when the evaluator moves an alert out of ALARM. */
export const INFRA_ALERT_RECOVERY_ACTOR = 'system:recovery';
/** Actor recorded for a state change that did not change the operator status. */
export const INFRA_ALERT_EVALUATOR_ACTOR = 'system:evaluator';

/** Paging bounds for the alert list, mirroring `log-issues-store.ts`. */
export const MAX_INFRA_ALERT_LIST_LIMIT = 200;
export const DEFAULT_INFRA_ALERT_LIST_LIMIT = 50;

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

  -- Per-project retention / quota overrides for the reaper (decision
  -- INFRA-STORE). Absent row → the code defaults
  -- (DEFAULT_INFRA_RETENTION_DAYS / DEFAULT_INFRA_PROJECT_QUOTA_BYTES), which
  -- are not stored, matching log_retention_config and the deployment_env_*
  -- config tables.
  --
  -- Both columns are clamped in TypeScript before they land here rather than by
  -- a CHECK constraint: the documented bounds move as the store is tuned, and a
  -- CHECK cannot be widened without rebuilding the table. The reaper re-clamps
  -- on read, so a row written before a bound narrowed is still interpreted
  -- inside the current range.
  CREATE TABLE IF NOT EXISTS infra_retention_config (
    project_id     TEXT PRIMARY KEY,
    retention_days INTEGER NOT NULL,
    quota_bytes    INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  -- Threshold rules we evaluate in our own poller (decision INFRA-ALERT: do
  -- NOT provision real CloudWatch alarms + SNS in the monitored account).
  --
  -- The threshold columns are spelled in PutMetricAlarm's own parameter names
  -- so a row round-trips to the console vocabulary without a mapping table.
  -- Operators will diff our state against the console; a rule they cannot read
  -- back in AWS's words is a rule they cannot check our work on.
  --
  -- The scope selector is a *predicate* over infra_resources, not a resource
  -- list: one rule covering "every EC2 instance in us-east-2" must automatically
  -- cover an instance the inventory sync discovers tomorrow. service is required
  -- because it decides which metric namespace the rule can even apply to;
  -- account_id / region / resource_key are each NULL for "any", so a rule
  -- narrows from a whole service down to one resource without a schema change.
  CREATE TABLE IF NOT EXISTS infra_alert_rules (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT,

    -- ── Scope selector ──
    service             TEXT NOT NULL,
    account_id          TEXT,
    region              TEXT,
    -- Pin to exactly one resource. NULL = every resource matching the rest of
    -- the selector.
    resource_key        TEXT,
    -- Optional tag predicate as JSON ({ "Key": ["v1","v2"] }), same shape and
    -- same parser as infra_scopes.tag_filter_json. NULL = no filter.
    tag_filter_json     TEXT,

    -- ── Series ──
    namespace           TEXT NOT NULL,
    metric_name         TEXT NOT NULL,
    stat                TEXT NOT NULL,
    period_s            INTEGER NOT NULL,

    -- ── Threshold (PutMetricAlarm parameter names) ──
    threshold           REAL NOT NULL,
    -- No anomaly-detection operators: we fit no model, so there is no threshold
    -- *pair* for them to compare against. See INFRA_COMPARISON_OPERATORS.
    comparison_operator TEXT NOT NULL CHECK (comparison_operator IN (
      'GreaterThanOrEqualToThreshold', 'GreaterThanThreshold',
      'LessThanThreshold', 'LessThanOrEqualToThreshold'
    )),
    -- N: periods compared over.
    evaluation_periods  INTEGER NOT NULL,
    -- M of N. NULL = N (consecutive alarm), which is AWS's own default.
    datapoints_to_alarm INTEGER,
    treat_missing_data  TEXT NOT NULL DEFAULT 'missing' CHECK (treat_missing_data IN (
      'missing', 'notBreaching', 'breaching', 'ignore'
    )),

    severity            TEXT NOT NULL DEFAULT 'warning'
      CHECK (severity IN ('critical', 'warning', 'info')),
    -- A disabled rule is retained, not deleted: deleting it would cascade away
    -- the alert rows that carry the incident history the operator muted it over.
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );

  -- One row per (rule, resource) — the fired-alert lifecycle. Same shape as
  -- log_issues (decision INFRA-ALERT: "it should look the same to the user as a
  -- log issue does"), which is why status and state are two separate columns:
  --
  --   state  — what the metric says right now (CloudWatch's OK / ALARM /
  --            INSUFFICIENT_DATA). Owned by the evaluator.
  --   status — what the operator has decided about it (open / resolved /
  --            ignored). Owned by the human, except for the two automatic
  --            moves recurrence and recovery make.
  --
  -- Collapsing them would make "I already know, stop paging me" indistinguishable
  -- from "the metric came back", and an ignored alert would un-mute itself on the
  -- next breach — the exact behaviour ignoring exists to prevent.
  --
  -- ON DELETE CASCADE is right here where infra_metric_points deliberately
  -- refuses a foreign key: an alert without its rule has no threshold to be read
  -- against and no way to be re-evaluated, so it is not data being lost to an
  -- ordering race, it is data with no remaining meaning.
  CREATE TABLE IF NOT EXISTS infra_alerts (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL,
    rule_id           TEXT NOT NULL REFERENCES infra_alert_rules(id) ON DELETE CASCADE,
    -- Joins to infra_resources.resource_key. No foreign key, for the same
    -- reason infra_metric_points has none: an alert must survive its resource
    -- aging out of the inventory, or a terminated instance would take the
    -- record of why it was terminated with it.
    resource_key      TEXT NOT NULL,

    state             TEXT NOT NULL DEFAULT 'OK'
      CHECK (state IN ('OK', 'ALARM', 'INSUFFICIENT_DATA')),
    -- Why the evaluator landed there (INFRA_ALARM_REASONS). "ALARM" without
    -- "and it was the premature rule, on one breaching datapoint" is exactly
    -- the ambiguity that sends an operator to the console to check our work.
    reason            TEXT,
    -- Observation timestamp the current state was decided from. The staleness
    -- guard reads this: an out-of-order evaluation older than it updates the
    -- aggregates but must not rewrite the state a newer observation set.
    state_updated_at  INTEGER NOT NULL,

    status            TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'resolved', 'ignored')),
    status_updated_at INTEGER,
    -- User id, or one of the system:* actors. NULL until status first moves.
    status_updated_by TEXT,

    -- True min/max over every ALARM observation, held with MIN()/MAX() so a
    -- late-arriving datapoint cannot narrow the window it actually covered.
    first_seen        INTEGER NOT NULL,
    last_seen         INTEGER NOT NULL,
    -- ALARM observations recorded, including out-of-order ones.
    occurrence_count  INTEGER NOT NULL DEFAULT 1,
    -- Breaching datapoints and metric value behind the most recent non-stale
    -- evaluation, for rendering the alert without re-querying the series.
    last_value        REAL,
    breaching_datapoints INTEGER,

    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    -- One alert per (rule, resource): a second breach is a recurrence on the
    -- existing row, never a second row, or the list would be a firehose.
    UNIQUE (rule_id, resource_key)
  );

  -- Append-only transition history behind one alert. Written on a state change
  -- and on a status change, each capturing both, so the timeline reads as
  -- complete snapshots rather than half-updates that have to be replayed to
  -- interpret.
  --
  -- Trimmed to INFRA_ALERT_TRANSITION_HISTORY_LIMIT rows per alert on insert —
  -- see that constant for why this table bounds itself instead of joining the
  -- retention reaper's pass.
  CREATE TABLE IF NOT EXISTS infra_alert_transitions (
    id          INTEGER PRIMARY KEY,
    alert_id    TEXT NOT NULL REFERENCES infra_alerts(id) ON DELETE CASCADE,
    project_id  TEXT NOT NULL,
    from_state  TEXT NOT NULL,
    to_state    TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status   TEXT NOT NULL,
    reason      TEXT,
    -- User id, or one of the system:* actors.
    actor       TEXT NOT NULL,
    at_ms       INTEGER NOT NULL,
    -- Null until every configured delivery path has been attempted. This
    -- makes a committed transition recoverable after a process crash between
    -- the alert write and notification fan-out.
    notification_delivered_at_ms INTEGER
  );

  -- Per-project alert delivery overrides. Missing rows resolve to the
  -- severity defaults above; storing only overrides keeps a future default
  -- change from requiring a migration of every project.
  CREATE TABLE IF NOT EXISTS infra_alert_routing (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    channel     TEXT NOT NULL CHECK (channel IN ('in_app', 'push', 'email')),
    enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (project_id, severity, channel)
  );

  -- Email delivery is deliberately an outbox: SMTP is transient and an
  -- alert transition must not be lost because a provider was unavailable.
  CREATE TABLE IF NOT EXISTS infra_alert_outbox (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    alert_id        TEXT NOT NULL,
    severity        TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    transition_key  TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body_text       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sending', 'sent', 'error')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    sent_at         TEXT,
    next_attempt_at TEXT,
    last_error      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (transition_key, recipient_email)
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
  -- Oldest-first *within* one project, for the reaper's two per-project paths:
  -- the age pass over a project that overrode its window, and the quota pass
  -- evicting a single project down to its byte ceiling.
  --
  -- Not redundant with either index above. The chart index leads with
  -- (project_id, resource_key), so it cannot order a whole project by time, and
  -- the global ts index cannot seek within one project. Without this, SQLite
  -- answers both queries by scanning the chart index and then sorting the
  -- project's entire history in a temp b-tree — on every tick, for a table that
  -- is expected to hold tens of millions of rows.
  CREATE INDEX IF NOT EXISTS idx_infra_metric_points_project_ts
    ON infra_metric_points(project_id, ts_ms);

  CREATE INDEX IF NOT EXISTS idx_infra_collect_runs_project
    ON infra_collect_runs(project_id, started_at DESC);

  -- The rule editor lists a project's rules; the evaluator loads only the
  -- enabled ones. enabled trails project_id so one composite serves both.
  CREATE INDEX IF NOT EXISTS idx_infra_alert_rules_project
    ON infra_alert_rules(project_id, enabled);
  -- The evaluator's inner loop: "which rules apply to this service?" Without
  -- it, every tick scans every rule in the project once per resource.
  CREATE INDEX IF NOT EXISTS idx_infra_alert_rules_project_service
    ON infra_alert_rules(project_id, service);

  -- Alerts list: most-recently-seen first, optionally filtered by status. The
  -- keyset cursor is (last_seen DESC, id DESC), so last_seen must be the
  -- ordering column here or every page pays a temp-b-tree sort.
  CREATE INDEX IF NOT EXISTS idx_infra_alerts_project_last_seen
    ON infra_alerts(project_id, last_seen DESC);
  CREATE INDEX IF NOT EXISTS idx_infra_alerts_project_status
    ON infra_alerts(project_id, status, last_seen DESC);
  -- Cascade target and the evaluator's per-tick lookup. The UNIQUE (rule_id,
  -- resource_key) constraint already indexes rule_id, but only as its leading
  -- column — this serves "every alert for this resource", which the resource
  -- detail view asks across rules.
  CREATE INDEX IF NOT EXISTS idx_infra_alerts_resource
    ON infra_alerts(project_id, resource_key);

  -- History read (newest first) and the trim's oldest-first delete, from one
  -- index read in either direction.
  CREATE INDEX IF NOT EXISTS idx_infra_alert_transitions_alert
    ON infra_alert_transitions(alert_id, at_ms DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_infra_alert_transitions_pending
    ON infra_alert_transitions(notification_delivered_at_ms, id);
  CREATE INDEX IF NOT EXISTS idx_infra_alert_routing_project
    ON infra_alert_routing(project_id, severity, channel);
  CREATE INDEX IF NOT EXISTS idx_infra_alert_outbox_status
    ON infra_alert_outbox(status, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_infra_alert_outbox_project
    ON infra_alert_outbox(project_id, created_at DESC);
`;

/**
 * The complete `infra.db` DDL in execution order. Safe to `exec` as one block
 * against a fresh database (hermetic tests, scratch handles); the runtime store
 * runs the two halves separately so reconciliation can sit between them.
 */
export const INFRA_SCHEMA = `${INFRA_TABLES_SCHEMA}\n${INFRA_INDEXES_SCHEMA}`;
