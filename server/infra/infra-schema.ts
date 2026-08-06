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
 *
 * `infra_metric_points`, `infra_collect_runs`, `infra_retention_config` and the
 * alert tables are appended by their own tickets; the DDL is a single
 * idempotent block so those additions are edits to this constant.
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
`;

/**
 * The complete `infra.db` DDL in execution order. Safe to `exec` as one block
 * against a fresh database (hermetic tests, scratch handles); the runtime store
 * runs the two halves separately so reconciliation can sit between them.
 */
export const INFRA_SCHEMA = `${INFRA_TABLES_SCHEMA}\n${INFRA_INDEXES_SCHEMA}`;
