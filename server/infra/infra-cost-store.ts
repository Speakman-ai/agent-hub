/**
 * infra-cost-store.ts — the persistence half of decision INFRA-COST.
 *
 * `infra-cost.ts` holds the arithmetic and touches nothing; this module reads
 * what a project has actually spent out of the `infra_collect_runs` audit trail
 * and owns the `infra_cost_config` row that turns that number into a brake.
 *
 * One property is enforced rather than assumed: **the degradation notice fires
 * on a state transition, never on every tick.** A collector that broadcast
 * "you are over budget" once per five minutes for the rest of the month would
 * train the operator to ignore the one notice that mattered, which is the same
 * reasoning decision INFRA-ALERT applies to alarm actions.
 * {@link recordCostDegradation} is the single place that decides whether a level
 * is new, and it answers by comparing against the stored level inside the same
 * write.
 */

import { getInfraDb } from './infra-db.js';
import type { InfraCollectRunKind } from './infra-metric-store.js';
import {
  monthStartMs,
  nextMonthStartMs,
  resolveCostDegradation,
  extrapolateMonthlySpendUsd,
  type InfraCostDegradation,
} from './infra-cost.js';

/** The per-project ceiling row, resolved with defaults for a project with none. */
export interface InfraCostConfig {
  projectId: string;
  /** `null` = uncapped. `0` is a real setting meaning "collect nothing". */
  monthlyCeilingUsd: number | null;
  degradationLevel: InfraCostDegradation;
  degradedAt: number | null;
  /**
   * Whether the operator opted this project into billed Cost Explorer polling.
   *
   * Off by default and never inferred. Every other collector reads a signal that
   * costs nothing until a scope row exists; `GetCostAndUsage` bills $0.01 from
   * the first paginated request with no free tier, so turning it on is an
   * explicit act with a name.
   */
  costExplorerEnabled: boolean;
  /** Epoch ms the last Cost Explorer sync started; `null` if it never has. */
  costExplorerSyncedAt: number | null;
  updatedAt: number | null;
  /** False when no row exists and every field above is a default. */
  configured: boolean;
}

interface InfraCostConfigDbRow {
  project_id: string;
  monthly_ceiling_usd: number | null;
  degradation_level: InfraCostDegradation;
  degraded_at: number | null;
  cost_explorer_enabled: number;
  cost_explorer_synced_at: number | null;
  updated_at: number;
}

/**
 * The project's cost config, or the uncapped default when it has no row.
 *
 * Resolved-with-defaults semantics, matching the `deployment_env_*` config
 * tables: a missing row means the default, and the default is not stored. That
 * keeps "the operator has never opened this" distinguishable from "the operator
 * deliberately set no ceiling" via `configured`, which the UI needs in order to
 * word its empty state.
 */
export function getInfraCostConfig(projectId: string): InfraCostConfig {
  const row = getInfraDb()
    .prepare(
      `SELECT project_id, monthly_ceiling_usd, degradation_level, degraded_at,
              cost_explorer_enabled, cost_explorer_synced_at, updated_at
         FROM infra_cost_config
        WHERE project_id = ?`,
    )
    .get(projectId) as InfraCostConfigDbRow | undefined;

  if (!row) {
    return {
      projectId,
      monthlyCeilingUsd: null,
      degradationLevel: 'normal',
      degradedAt: null,
      costExplorerEnabled: false,
      costExplorerSyncedAt: null,
      updatedAt: null,
      configured: false,
    };
  }
  return {
    projectId: row.project_id,
    monthlyCeilingUsd: row.monthly_ceiling_usd,
    degradationLevel: row.degradation_level,
    degradedAt: row.degraded_at,
    costExplorerEnabled: row.cost_explorer_enabled === 1,
    costExplorerSyncedAt: row.cost_explorer_synced_at,
    updatedAt: row.updated_at,
    configured: true,
  };
}

/**
 * Turn billed Cost Explorer polling on or off for a project.
 *
 * Disabling deliberately leaves `cost_explorer_synced_at` and the cached
 * `infra_cost_daily` rows alone. The cache is spend that has already been paid
 * for, and discarding it would mean an operator who toggled the feature off and
 * on again re-bought the same 30 days of history. The read endpoint keeps
 * serving that cache while the flag is off — it just goes stale, which the
 * `syncedAt` timestamp already tells the UI.
 */
export function setInfraCostExplorerEnabled(
  projectId: string,
  enabled: boolean,
  nowMs: number = Date.now(),
): InfraCostConfig {
  getInfraDb()
    .prepare(
      `INSERT INTO infra_cost_config (project_id, cost_explorer_enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         cost_explorer_enabled = excluded.cost_explorer_enabled,
         updated_at = excluded.updated_at`,
    )
    .run(projectId, enabled ? 1 : 0, nowMs);
  return getInfraCostConfig(projectId);
}

/**
 * Stamp the start of a Cost Explorer sync.
 *
 * Written **before** the first billed request, not after the last one. A sync
 * that dies mid-sweep has still spent money, and a timestamp only written on
 * success would let a crash loop re-issue the whole paginated sweep on the very
 * next tick — the failure mode where the cadence guard costs the most and
 * protects the least.
 */
export function recordCostExplorerSyncStart(projectId: string, nowMs: number = Date.now()): void {
  getInfraDb()
    .prepare(
      `INSERT INTO infra_cost_config (project_id, cost_explorer_synced_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         cost_explorer_synced_at = excluded.cost_explorer_synced_at,
         updated_at = excluded.updated_at`,
    )
    .run(projectId, nowMs, nowMs);
}

/** Every project that opted into Cost Explorer polling. */
export function listCostExplorerEnabledProjects(): string[] {
  const rows = getInfraDb()
    .prepare(
      'SELECT project_id FROM infra_cost_config WHERE cost_explorer_enabled = 1 ORDER BY project_id',
    )
    .all() as Array<{ project_id: string }>;
  return rows.map((r) => r.project_id);
}

/**
 * Set (or clear) a project's monthly ceiling.
 *
 * Writing the ceiling deliberately does **not** reset `degradation_level`. The
 * level is a fact about spend that has already happened, and recomputing it is
 * the collector's job on its next tick — clearing it here would let an operator
 * un-pause a project by re-saving the same ceiling, and the next tick would
 * immediately pause it again after issuing one more round of billed requests.
 */
export function setInfraCostCeiling(
  projectId: string,
  monthlyCeilingUsd: number | null,
  nowMs: number = Date.now(),
): InfraCostConfig {
  getInfraDb()
    .prepare(
      `INSERT INTO infra_cost_config (project_id, monthly_ceiling_usd, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         monthly_ceiling_usd = excluded.monthly_ceiling_usd,
         updated_at = excluded.updated_at`,
    )
    .run(projectId, monthlyCeilingUsd, nowMs);
  return getInfraCostConfig(projectId);
}

/**
 * Persist the level the collector is acting on, reporting whether it changed.
 *
 * The return value is what gates the in-app notice. The read and the write are
 * in one transaction so two ticks racing on the same project cannot both observe
 * the old level and both broadcast the same transition.
 */
export function recordCostDegradation(
  projectId: string,
  level: InfraCostDegradation,
  nowMs: number = Date.now(),
): { changed: boolean; previous: InfraCostDegradation } {
  const db = getInfraDb();
  const run = db.transaction((): { changed: boolean; previous: InfraCostDegradation } => {
    const row = db
      .prepare('SELECT degradation_level FROM infra_cost_config WHERE project_id = ?')
      .get(projectId) as { degradation_level: InfraCostDegradation } | undefined;
    const previous: InfraCostDegradation = row?.degradation_level ?? 'normal';
    if (previous === level) return { changed: false, previous };

    db.prepare(
      `INSERT INTO infra_cost_config (project_id, degradation_level, degraded_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET
         degradation_level = excluded.degradation_level,
         degraded_at = excluded.degraded_at,
         updated_at = excluded.updated_at`,
    ).run(projectId, level, level === 'normal' ? null : nowMs, nowMs);
    return { changed: true, previous };
  });
  return run();
}

// ─── Spend to date ──────────────────────────────────────────────────────────

export interface InfraSpendToDate {
  /** First epoch ms of the UTC month the figures cover. */
  monthStartMs: number;
  /** Summed `estimated_cost_usd` over the month's runs. */
  monthToDateUsd: number;
  metricsRequested: number;
  queriesIssued: number;
  datapointsReturned: number;
  throttles: number;
  errors: number;
  runs: number;
  /**
   * The month-to-date figure split by which billed API spent it.
   *
   * `monthToDateUsd` stays the total, because that total is what the ceiling
   * compares against — the two APIs draw on one budget. This breakdown exists so
   * the operator can act on the number: "$4 of your $5 went to Cost Explorer" is
   * a sentence that leads somewhere, where "$5" alone is not.
   */
  byKind: Record<InfraCollectRunKind, number>;
  /** Straight-line extrapolation of the month-to-date figure to month end. */
  extrapolatedMonthUsd: number;
  /**
   * Runs stamped beyond the end of this month — only reachable through clock
   * skew, since a run row is written with the wall clock at tick start.
   *
   * Reported rather than silently excluded: their spend is real but cannot be
   * attributed to this month without double-counting it when that month
   * arrives, and a number that is quietly wrong is worse than one that says so.
   * A non-zero value here means the host clock needs looking at.
   */
  futureDatedRuns: number;
}

interface SpendDbRow {
  cost: number | null;
  metrics: number | null;
  queries: number | null;
  datapoints: number | null;
  throttles: number | null;
  errors: number | null;
  runs: number | null;
}

/**
 * What a project has spent on `GetMetricData` so far this calendar month.
 *
 * Summed over `started_at`, not `finished_at`. A tick that crashed mid-run never
 * gets a `finished_at`, and a spend audit that only counted completed ticks
 * would under-report exactly the runs most likely to have been retried — the
 * expensive ones. The window is the **UTC** calendar month because AWS bills on
 * UTC months, and matching the Hub's local timezone instead would put the
 * ceiling out of phase with the bill it is guarding.
 *
 * The window is half-open, `[monthStart, nextMonthStart)`. The upper bound is
 * what makes a run row belong to **exactly one** billing month: without it, a
 * row that a forward clock skew stamped into next month was summed into this
 * month's total *and* again into that month's when it arrived. Double-counted
 * spend can pause collection against budget that was never actually spent.
 *
 * The bound is deliberately the month boundary and **not** `nowMs`. A run row
 * is written when a tick *starts* and the money is spent during it, so on a
 * clock running a second or two fast a legitimate in-flight tick is briefly
 * future-dated. Excluding it would drop real spend from the ceiling — the
 * under-reporting direction this module refuses everywhere else. Bounding at
 * the month boundary fixes the double count without ever discarding spend.
 *
 * Rows stamped beyond this month are still counted — in `futureDatedRuns`, not
 * in the totals — because a clock-integrity problem the operator cannot see is
 * one they cannot fix.
 */
export function getInfraSpendToDate(
  projectId: string,
  nowMs: number = Date.now(),
): InfraSpendToDate {
  const start = monthStartMs(nowMs);
  const end = nextMonthStartMs(nowMs);
  const db = getInfraDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0)  AS cost,
              COALESCE(SUM(metrics_requested), 0)   AS metrics,
              COALESCE(SUM(queries_issued), 0)      AS queries,
              COALESCE(SUM(datapoints_returned), 0) AS datapoints,
              COALESCE(SUM(throttles), 0)           AS throttles,
              COALESCE(SUM(errors), 0)              AS errors,
              COUNT(*)                              AS runs
         FROM infra_collect_runs
        WHERE project_id = ? AND started_at >= ? AND started_at < ?`,
    )
    .get(projectId, start, end) as SpendDbRow;

  // Uses the same (project_id, started_at DESC) index as the sum above.
  const future = db
    .prepare(
      'SELECT COUNT(*) AS n FROM infra_collect_runs WHERE project_id = ? AND started_at >= ?',
    )
    .get(projectId, end) as { n: number };

  // Same index, same window, one extra grouped pass. Kept separate from the
  // aggregate above rather than folded into it because the total must stay
  // correct for a `kind` value this build has never heard of: a row written by a
  // newer process, or by a ticket that adds a third billed API, still lands in
  // `monthToDateUsd` and still counts against the ceiling. Only the attribution
  // breakdown ignores it.
  const kindRows = getInfraDb()
    .prepare(
      `SELECT kind, COALESCE(SUM(estimated_cost_usd), 0) AS cost
         FROM infra_collect_runs
        WHERE project_id = ? AND started_at >= ? AND started_at < ?
        GROUP BY kind`,
    )
    .all(projectId, start, end) as Array<{ kind: string; cost: number | null }>;
  const byKind: Record<InfraCollectRunKind, number> = { metrics: 0, cost_explorer: 0 };
  for (const kindRow of kindRows) {
    if (kindRow.kind === 'metrics' || kindRow.kind === 'cost_explorer') {
      byKind[kindRow.kind] = kindRow.cost ?? 0;
    }
  }

  const monthToDateUsd = row.cost ?? 0;
  return {
    monthStartMs: start,
    monthToDateUsd,
    byKind,
    metricsRequested: row.metrics ?? 0,
    queriesIssued: row.queries ?? 0,
    datapointsReturned: row.datapoints ?? 0,
    throttles: row.throttles ?? 0,
    errors: row.errors ?? 0,
    runs: row.runs ?? 0,
    futureDatedRuns: future.n ?? 0,
    extrapolatedMonthUsd: extrapolateMonthlySpendUsd(monthToDateUsd, nowMs, start),
  };
}

/**
 * The level the collector should run this project at right now, from stored
 * spend and the stored ceiling. Read-only — {@link recordCostDegradation} is
 * what commits it.
 */
export function resolveProjectDegradation(
  projectId: string,
  nowMs: number = Date.now(),
): { level: InfraCostDegradation; spend: InfraSpendToDate; config: InfraCostConfig } {
  const config = getInfraCostConfig(projectId);
  const spend = getInfraSpendToDate(projectId, nowMs);
  return {
    level: resolveCostDegradation(spend.monthToDateUsd, config.monthlyCeilingUsd),
    spend,
    config,
  };
}

// ─── Run history ────────────────────────────────────────────────────────────

export interface InfraCollectRunRow {
  id: string;
  projectId: string;
  accountId: string | null;
  region: string | null;
  startedAt: number;
  kind: InfraCollectRunKind;
  finishedAt: number | null;
  durationMs: number | null;
  queriesIssued: number;
  metricsRequested: number;
  datapointsReturned: number;
  pointsWritten: number;
  throttles: number;
  errors: number;
  estimatedCostUsd: number;
  status: string;
  errorMessage: string | null;
}

/** Upper bound on a run-history page; the cost view shows a recent tail, not an archive. */
export const MAX_COLLECT_RUNS_PER_QUERY = 200;

/**
 * How far back {@link getLatestInfraCollectRun} looks, in milliseconds.
 *
 * Bounding that lookup by *time* rather than by a row count is what makes it
 * correct, not merely cheap. The two kinds of run are written at wildly
 * different rates: a metric tick every five minutes per (account, region), a
 * Cost Explorer sweep three times a day. On a project with a handful of scoped
 * regions the newest few hundred rows are therefore all metric ticks, and a
 * row-count window would report "never synced" for a project syncing perfectly
 * well.
 *
 * Seven days comfortably spans the eight-hour sync cadence, so a project that is
 * running at all always has a run inside the window, while one that genuinely
 * stopped reads as stopped instead of showing a stale success from last month.
 */
export const LATEST_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Column list shared by every `infra_collect_runs` read. */
const COLLECT_RUN_COLUMNS = `id, project_id, account_id, region, started_at, kind, finished_at,
        duration_ms, queries_issued, metrics_requested, datapoints_returned, points_written,
        throttles, errors, estimated_cost_usd, status, error_message`;

function queryCollectRuns(tail: string, params: unknown[]): InfraCollectRunRow[] {
  const rows = getInfraDb()
    .prepare(`SELECT ${COLLECT_RUN_COLUMNS} FROM infra_collect_runs ${tail}`)
    .all(...params) as Record<string, never>[];

  return rows.map((r) => {
    const row = r as unknown as {
      id: string;
      project_id: string;
      account_id: string | null;
      region: string | null;
      started_at: number;
      kind: string;
      finished_at: number | null;
      duration_ms: number | null;
      queries_issued: number;
      metrics_requested: number;
      datapoints_returned: number;
      points_written: number;
      throttles: number;
      errors: number;
      estimated_cost_usd: number;
      status: string;
      error_message: string | null;
    };
    return {
      id: row.id,
      projectId: row.project_id,
      accountId: row.account_id,
      region: row.region,
      startedAt: row.started_at,
      // Normalized on read, not trusted from the column. The column has no CHECK
      // constraint (it was added by the additive reconciler, which cannot carry
      // one), so an unrecognised value reads back as what it functionally is on
      // an older row: a metric tick.
      kind: row.kind === 'cost_explorer' ? 'cost_explorer' : 'metrics',
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      queriesIssued: row.queries_issued,
      metricsRequested: row.metrics_requested,
      datapointsReturned: row.datapoints_returned,
      pointsWritten: row.points_written,
      throttles: row.throttles,
      errors: row.errors,
      estimatedCostUsd: row.estimated_cost_usd,
      status: row.status,
      errorMessage: row.error_message,
    };
  });
}

/** Most recent collector ticks for a project, newest first. */
export function listInfraCollectRuns(projectId: string, limit = 20): InfraCollectRunRow[] {
  const capped =
    Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), MAX_COLLECT_RUNS_PER_QUERY)
      : 20;
  return queryCollectRuns('WHERE project_id = ? ORDER BY started_at DESC LIMIT ?', [
    projectId,
    capped,
  ]);
}

/**
 * The most recent run of one kind, or null if there is none in the lookback
 * window.
 *
 * Filtered on `kind`, which is deliberately unindexed (see `infra-schema.ts`:
 * an index over a column the additive reconciler added would throw on any
 * install older than that column). SQLite therefore walks the
 * `(project_id, started_at DESC)` index newest-first and discards non-matching
 * rows, which is the right plan here provided the walk terminates.
 * {@link LATEST_RUN_LOOKBACK_MS} is what terminates it.
 */
export function getLatestInfraCollectRun(
  projectId: string,
  kind: InfraCollectRunKind,
  nowMs: number = Date.now(),
): InfraCollectRunRow | null {
  const rows = queryCollectRuns(
    'WHERE project_id = ? AND kind = ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1',
    [projectId, kind, nowMs - LATEST_RUN_LOOKBACK_MS],
  );
  return rows[0] ?? null;
}

/** Enabled scope rows for a project, with the resource count each currently matches. */
export interface InfraScopeResourceCount {
  id: string;
  profileName: string;
  region: string;
  service: string;
  resourceCount: number;
}

/**
 * Scope rows joined to a live count of the inventory each one matches.
 *
 * The count is the same population the collector will bill for: terminated and
 * long-unseen rows are excluded, because `listScopeResources` excludes them too
 * and a projection that counted them would quote a price for requests the
 * collector is never going to issue.
 *
 * The scope's tag filter is **not** applied here. Re-applying EC2 glob matching
 * per row is a JS-side filter the collector pays once per tick; doing it inside
 * a projection that the scope editor calls on every keystroke would be the wrong
 * trade, and the unfiltered count errs high — the safe direction for a number
 * being compared against a ceiling.
 */
export function listScopeResourceCounts(
  projectId: string,
  staleAfterMs: number,
  nowMs: number = Date.now(),
): InfraScopeResourceCount[] {
  const rows = getInfraDb()
    .prepare(
      `SELECT s.id            AS id,
              s.profile_name  AS profile_name,
              s.region        AS region,
              s.service       AS service,
              (SELECT COUNT(*)
                 FROM infra_resources r
                WHERE r.project_id = s.project_id
                  AND r.region = s.region
                  AND r.service = s.service
                  AND r.last_seen >= ?
                  AND (r.state IS NULL OR r.state != 'terminated')
                  AND (s.account_id IS NULL OR r.account_id = s.account_id)
              ) AS resource_count
         FROM infra_scopes s
        WHERE s.project_id = ? AND s.enabled = 1
        ORDER BY s.profile_name, s.region, s.service`,
    )
    .all(nowMs - staleAfterMs, projectId) as {
    id: string;
    profile_name: string;
    region: string;
    service: string;
    resource_count: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    profileName: r.profile_name,
    region: r.region,
    service: r.service,
    resourceCount: r.resource_count,
  }));
}
