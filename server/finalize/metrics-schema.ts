/**
 * SQLite DDL for the Finalize Code Changes adoption-metrics table.
 *
 * One row per event. The table is intentionally append-only: counters
 * and histograms are derived at read time via SQL aggregations, not
 * pre-aggregated buckets. That keeps the write path branch-free and
 * lets us slice arbitrarily during the dogfood window without a
 * schema change. The full event vocabulary lives in
 * `server/finalize/metrics.ts` (TypeScript enums + emitter helpers).
 *
 * Columns:
 *   - `project_id` — scopes every read; required.
 *   - `metric_name` — see `MetricName` in metrics.ts. The enum lives in
 *     TS (not a CHECK) so we don't have to rebuild the table when a
 *     metric is added; the API validates names server-side.
 *   - `labels` — JSON object string. The reader projects values out of
 *     this via `json_extract` for label-grouped aggregates (trigger_source,
 *     verdict, step_name, status, etc.). Empty `'{}'` for label-free
 *     counters.
 *   - `value` — for counters this is `1.0`; for histograms it's the
 *     observed sample (seconds for `_seconds` metrics, exit codes etc.
 *     stay on labels). Stored as REAL so we don't lose sub-second
 *     precision when wall-time samples land.
 *   - `run_id` — optional back-link to the originating finalize_runs row.
 *     Indexed so the read endpoint can answer per-run queries cheaply
 *     (e.g. "how many fix dispatches did run X log?"). Nullable because
 *     `merged_pr_provenance` events are emitted from the webhook handler
 *     and may not have a corresponding finalize_runs row (external PRs).
 *   - `observed_at` — unix-millis (server clock). Indexed for range queries.
 *
 * Two composite indexes cover the read paths:
 *   - `(project_id, observed_at)` — primary range slice.
 *   - `(project_id, metric_name, observed_at)` — per-metric range slice.
 *
 * See wiki: `finalize-code-changes-architecture-v0` §14 (Metrics &
 * Observability) for the contract.
 */

export const FINALIZE_METRICS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS finalize_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '{}',
    value REAL NOT NULL DEFAULT 1,
    run_id TEXT,
    observed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_finalize_metrics_project_time
    ON finalize_metrics(project_id, observed_at);
  CREATE INDEX IF NOT EXISTS idx_finalize_metrics_project_metric_time
    ON finalize_metrics(project_id, metric_name, observed_at);
  CREATE INDEX IF NOT EXISTS idx_finalize_metrics_run
    ON finalize_metrics(run_id) WHERE run_id IS NOT NULL;
`;
