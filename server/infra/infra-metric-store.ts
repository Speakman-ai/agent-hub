/**
 * infra-metric-store.ts — reads and writes for `infra_metric_points` and the
 * `infra_collect_runs` audit trail.
 *
 * The write path is deliberately the only thing that touches SQLite on the
 * collector's behalf, and it is called from the batch queue
 * (`infra-write-queue.ts`), never inline from a tick. Two properties matter
 * here and are enforced rather than assumed:
 *
 *   - **Overlap idempotence.** Re-collecting a window that was already stored
 *     is routine (a retry, a widened range, two overlapping schedules). The
 *     insert upserts on the natural series key so a retry corrects values in
 *     place instead of doubling the points behind a chart.
 *   - **Commit-then-publish.** The committed rows are built inside the
 *     transaction closure and only escape when SQLite committed, so a
 *     downstream consumer (alert evaluation) can never observe a point that a
 *     rolled-back transaction never durably wrote.
 */

import { createHash } from 'crypto';
import { getInfraDb } from './infra-db.js';
import { INFRA_EMPTY_DIMENSIONS_HASH } from './infra-schema.js';

/** One CloudWatch datapoint, as the collector hands it to the write queue. */
export interface InfraMetricPointInput {
  projectId: string;
  /** Derived key from `infraResourceKey()`; joins to `infra_resources`. */
  resourceKey: string;
  namespace: string;
  metricName: string;
  /** Dimension set for the series. Omitted / empty means an undimensioned metric. */
  dimensions?: Record<string, string> | null;
  /** CloudWatch statistic the value was requested with ('Average', 'p99', …). */
  stat: string;
  /** Requested period in seconds (60 / 300 / 3600 per INFRA-COLLECT). */
  periodSeconds: number;
  tsMs: number;
  value: number;
}

/** A committed row, as published downstream after the transaction. */
export interface InfraMetricPointRow {
  id: number;
  projectId: string;
  resourceKey: string;
  namespace: string;
  metricName: string;
  dimensionsHash: string;
  dimensionsJson: string | null;
  stat: string;
  periodSeconds: number;
  tsMs: number;
  value: number;
}

export interface InfraMetricInsertResult {
  /** Points durably written (a corrected overlap counts as written). */
  inserted: number;
  /** Points refused by validation. Never throws the whole batch away for one. */
  rejected: number;
  /** The committed rows, present only when the transaction committed. */
  points: InfraMetricPointRow[];
}

/**
 * Stable digest of a dimension set.
 *
 * Keys are sorted so `{A,B}` and `{B,A}` are the same series, and each
 * key/value is length-prefixed before joining so `{"ab":"c"}` and `{"a":"bc"}`
 * cannot canonicalize to the same string. Truncated to 16 hex chars (64 bits):
 * the population being distinguished is the handful of dimension sets on one
 * metric of one resource, not a global namespace.
 */
export function infraDimensionsHash(dimensions?: Record<string, string> | null): string {
  if (!dimensions) return INFRA_EMPTY_DIMENSIONS_HASH;
  const keys = Object.keys(dimensions).sort();
  if (keys.length === 0) return INFRA_EMPTY_DIMENSIONS_HASH;
  const canonical = keys
    .map((k) => {
      const v = String(dimensions[k]);
      return `${k.length}:${k}=${v.length}:${v}`;
    })
    .join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Canonical JSON for storage, or `null` when the series has no dimensions. */
function dimensionsJson(dimensions?: Record<string, string> | null): string | null {
  if (!dimensions) return null;
  const keys = Object.keys(dimensions).sort();
  if (keys.length === 0) return null;
  const ordered: Record<string, string> = {};
  for (const k of keys) ordered[k] = String(dimensions[k]);
  return JSON.stringify(ordered);
}

/** Sub-minute periods CloudWatch accepts, for high-resolution metrics only. */
const HIGH_RESOLUTION_PERIODS_S = new Set([1, 5, 10, 20, 30]);

/**
 * Whether `periodSeconds` is a period CloudWatch would actually accept.
 *
 * This is AWS's own grammar for `MetricStat.Period`, verified against the API
 * reference (August 2026): *"For metrics with regular resolution, a period can
 * be as short as one minute (60 seconds) and must be a multiple of 60. For
 * high-resolution metrics that are collected at intervals of less than one
 * minute, the period can be 1, 5, 10, 20, 30, 60, or any multiple of 60."*
 * Type Integer, valid range minimum 1.
 *
 * Deliberately **no upper bound**: AWS documents none, and inventing a ceiling
 * they do not publish would silently drop data a legitimate long-window query
 * asks for. The minimum and the multiple-of-60 rule are real published
 * constraints; a ceiling would be a guess.
 *
 * Exported so the collector derives its requested period from the same
 * predicate the store validates against, rather than the two drifting apart.
 */
export function isValidCloudWatchPeriod(periodSeconds: number): boolean {
  if (!Number.isInteger(periodSeconds) || periodSeconds < 1) return false;
  return HIGH_RESOLUTION_PERIODS_S.has(periodSeconds) || periodSeconds % 60 === 0;
}

/**
 * Whether a point is storable. A malformed point is dropped and counted, not
 * thrown: one bad datapoint in a 50,000-point tick must not cost the tick.
 *
 * `periodSeconds` and `tsMs` must be **integers**, not merely finite. Both are
 * part of the natural series key, and the write path used to floor them — so a
 * caller that computed a fractional period landed `period_s = 0` (a period
 * `0.5` floors to `0`), which is not a period CloudWatch can ever return, sorts
 * as its own phantom series, and is indistinguishable from real data once
 * stored. Rejecting is right where flooring silently fabricated a row.
 *
 * `value` is checked for finiteness because CloudWatch can hand back `NaN` for
 * an expression result, and SQLite would store that as NULL in a NOT NULL REAL
 * column — a constraint failure that would take the whole transaction with it.
 */
function isStorable(p: InfraMetricPointInput): boolean {
  return (
    typeof p.projectId === 'string' &&
    p.projectId.length > 0 &&
    typeof p.resourceKey === 'string' &&
    p.resourceKey.length > 0 &&
    typeof p.namespace === 'string' &&
    p.namespace.length > 0 &&
    typeof p.metricName === 'string' &&
    p.metricName.length > 0 &&
    typeof p.stat === 'string' &&
    p.stat.length > 0 &&
    isValidCloudWatchPeriod(p.periodSeconds) &&
    // A non-positive epoch is not a timestamp AWS can have emitted, and it
    // would sort ahead of every real point in both the chart index and the
    // reaper's oldest-first scan.
    Number.isInteger(p.tsMs) &&
    p.tsMs > 0 &&
    Number.isFinite(p.value)
  );
}

/** A validated point with its derived columns, keyed by the natural series key. */
interface NormalizedPoint {
  row: Omit<InfraMetricPointRow, 'id'>;
  json: string | null;
}

/**
 * The natural series key as a single injective string. JSON encoding is what
 * makes it injective: a metric named `a|b` and a stat of `c` cannot produce the
 * same key as a metric `a` with stat `b|c`.
 */
function seriesKey(r: Omit<InfraMetricPointRow, 'id' | 'value' | 'dimensionsJson'>): string {
  return JSON.stringify([
    r.projectId,
    r.resourceKey,
    r.namespace,
    r.metricName,
    r.dimensionsHash,
    r.stat,
    r.periodSeconds,
    r.tsMs,
  ]);
}

/**
 * Write a batch of metric points in one transaction, upserting on the natural
 * series key. Returns the committed rows so the caller can publish downstream
 * only after the commit.
 */
export function insertInfraMetricPoints(points: InfraMetricPointInput[]): InfraMetricInsertResult {
  if (points.length === 0) return { inserted: 0, rejected: 0, points: [] };

  const db = getInfraDb();
  const stmt = db.prepare(`
    INSERT INTO infra_metric_points (
      project_id, resource_key, namespace, metric_name,
      dimensions_hash, dimensions_json, stat, period_s, ts_ms, value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (project_id, resource_key, namespace, metric_name,
                 dimensions_hash, stat, period_s, ts_ms)
    DO UPDATE SET
      value = excluded.value,
      dimensions_json = excluded.dimensions_json
    RETURNING id
  `);

  // Both counters are returned from the transaction rather than accumulated in
  // an enclosing closure, so a re-entered transaction body cannot double-count
  // what the caller reports.
  const run = db.transaction(
    (batch: InfraMetricPointInput[]): { committed: InfraMetricPointRow[]; rejected: number } => {
      // Kept local to the transaction: these only escape on commit, so a
      // rolled-back batch can never be published as if it were durable.
      const committed: InfraMetricPointRow[] = [];
      let rejected = 0;

      // Collapse duplicate series keys *within* the batch, last value wins.
      // A flush drains points enqueued by several ticks, and two overlapping
      // ticks routinely land the same (series, timestamp) in one window.
      // Stepping the upsert twice would report two written rows where one row
      // exists — inflating both the INFRA-COST audit and `stats.written` — and
      // would publish the superseded value to alert evaluation as if it were
      // durable, when the second write had already overwritten it.
      const deduped = new Map<string, NormalizedPoint>();
      for (const p of batch) {
        if (!isStorable(p)) {
          rejected += 1;
          continue;
        }
        const row = {
          projectId: p.projectId,
          resourceKey: p.resourceKey,
          namespace: p.namespace,
          metricName: p.metricName,
          dimensionsHash: infraDimensionsHash(p.dimensions),
          dimensionsJson: dimensionsJson(p.dimensions),
          stat: p.stat,
          // No flooring: `isStorable` guarantees both are integers, and
          // normalizing here is what previously turned an invalid period into
          // a plausible-looking stored row.
          periodSeconds: p.periodSeconds,
          tsMs: p.tsMs,
          value: p.value,
        };
        deduped.set(seriesKey(row), { row, json: row.dimensionsJson });
      }

      for (const { row, json } of deduped.values()) {
        const written = stmt.get(
          row.projectId,
          row.resourceKey,
          row.namespace,
          row.metricName,
          row.dimensionsHash,
          json,
          row.stat,
          row.periodSeconds,
          row.tsMs,
          row.value,
        ) as { id: number } | undefined;
        if (!written) continue;
        committed.push({ id: written.id, ...row });
      }
      return { committed, rejected };
    },
  );

  const { committed, rejected } = run(points);
  return { inserted: committed.length, rejected, points: committed };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export interface InfraMetricQuery {
  projectId: string;
  resourceKey: string;
  metricName: string;
  /** Inclusive lower bound. */
  startMs: number;
  /** Inclusive upper bound. */
  endMs: number;
  namespace?: string;
  stat?: string;
  periodSeconds?: number;
  dimensionsHash?: string;
  /** Clamped to {@link MAX_METRIC_POINTS_PER_QUERY}. */
  limit?: number;
}

/**
 * Upper bound on a single range read. A chart is a few hundred points wide; an
 * unbounded read of a 30-day 60s series would be 43,200 rows per series and is
 * never what a caller wants.
 */
export const MAX_METRIC_POINTS_PER_QUERY = 5_000;

/**
 * Points in a bounded range, oldest first (chart order). Uses the
 * `(project_id, resource_key, metric_name, ts_ms DESC)` index.
 *
 * **This is a union across every series matching the filters, not one series.**
 * `(project, resource, metric)` names a series only once `namespace`, `stat`,
 * `period_s` and `dimensions_hash` are also pinned — and leaving `periodSeconds`
 * open is the case that bites, because the collector legitimately stores one
 * metric at several period tiers (60s within 15 days, 300s within 63, 3600s
 * beyond). A 30-day read with no period filter interleaves two tiers at
 * duplicate timestamps with different semantics, and the row limit is spent on
 * the redundancy, silently truncating the far end of the requested range.
 *
 * A chart caller should pin all four. The filters stay optional because the
 * inventory and alert paths legitimately want the union.
 */
export function queryInfraMetricPoints(q: InfraMetricQuery): InfraMetricPointRow[] {
  const db = getInfraDb();
  const clauses = [
    'project_id = ?',
    'resource_key = ?',
    'metric_name = ?',
    'ts_ms >= ?',
    'ts_ms <= ?',
  ];
  const params: (string | number)[] = [
    q.projectId,
    q.resourceKey,
    q.metricName,
    Math.floor(q.startMs),
    Math.floor(q.endMs),
  ];
  if (q.namespace) {
    clauses.push('namespace = ?');
    params.push(q.namespace);
  }
  if (q.stat) {
    clauses.push('stat = ?');
    params.push(q.stat);
  }
  if (typeof q.periodSeconds === 'number') {
    clauses.push('period_s = ?');
    params.push(Math.floor(q.periodSeconds));
  }
  if (q.dimensionsHash) {
    clauses.push('dimensions_hash = ?');
    params.push(q.dimensionsHash);
  }

  const limit =
    Number.isFinite(q.limit) && (q.limit as number) > 0
      ? Math.min(Math.floor(q.limit as number), MAX_METRIC_POINTS_PER_QUERY)
      : MAX_METRIC_POINTS_PER_QUERY;

  // Newest-first in SQL so the limit truncates the far end of the range rather
  // than the recent end, then reversed for chart order.
  const rows = db
    .prepare(
      `SELECT id, project_id, resource_key, namespace, metric_name,
              dimensions_hash, dimensions_json, stat, period_s, ts_ms, value
         FROM infra_metric_points
        WHERE ${clauses.join(' AND ')}
        ORDER BY ts_ms DESC
        LIMIT ?`,
    )
    .all(...params, limit) as InfraMetricPointDbRow[];

  return rows.map(mapPointRow).reverse();
}

/** One aggregated bucket, carrying every aggregate a caller might draw at. */
export interface InfraMetricBucketRow {
  /** Bucket's left edge, floored to a multiple of the bucket width. */
  tsMs: number;
  minValue: number;
  maxValue: number;
  sumValue: number;
  /** Source datapoints folded into this bucket. */
  count: number;
}

export interface InfraMetricBucketQuery extends InfraMetricQuery {
  /** Bucket width. Points are grouped by `floor(ts_ms / width)`. */
  bucketSeconds: number;
  /** Buckets returned before the range is considered truncated. */
  maxBuckets: number;
}

export interface InfraMetricBucketPage {
  buckets: InfraMetricBucketRow[];
  /**
   * The window held more buckets than `maxBuckets`. The caller widened its
   * period too little; the returned buckets are the *oldest* that fit.
   */
  truncated: boolean;
}

/**
 * Aggregate a bounded range into fixed-width buckets, oldest first.
 *
 * The grouping happens in SQL rather than over the rows in JavaScript, and that
 * is the difference between a chart that works and one that does not. The
 * collector polls a 15-minute lookback every tick, so `resolvePeriod` is always
 * evaluated on a fresh window and every stored point lands at the finest tier —
 * 60s. A 30-day read is 43,200 rows for a single series, eight times
 * {@link MAX_METRIC_POINTS_PER_QUERY}, so fetching the rows and folding them
 * here would draw a month-long chart out of its most recent three and a half
 * days with nothing to say so.
 *
 * All four aggregates come back from one scan because computing them together
 * is free; which one is drawn is the caller's decision (`selectBucketValue`),
 * and a `Maximum` series averaged into its buckets would erase the spike that
 * is the entire reason someone charted it.
 *
 * Buckets are floored to a multiple of the width — the same alignment
 * `alignWindow()` gives the collector — so an instant lands in the same bucket
 * across two requests with different windows and the chart does not shimmer
 * when its range is nudged.
 *
 * Empty buckets are **absent, not zero-filled**: no observation is not a
 * measurement of zero, and the difference is an idle instance versus one that
 * stopped reporting.
 */
export function queryInfraMetricBuckets(q: InfraMetricBucketQuery): InfraMetricBucketPage {
  const db = getInfraDb();
  const clauses = [
    'project_id = ?',
    'resource_key = ?',
    'metric_name = ?',
    'ts_ms >= ?',
    'ts_ms <= ?',
  ];
  const params: (string | number)[] = [
    q.projectId,
    q.resourceKey,
    q.metricName,
    Math.floor(q.startMs),
    Math.floor(q.endMs),
  ];
  if (q.namespace) {
    clauses.push('namespace = ?');
    params.push(q.namespace);
  }
  if (q.stat) {
    clauses.push('stat = ?');
    params.push(q.stat);
  }
  if (typeof q.periodSeconds === 'number') {
    clauses.push('period_s = ?');
    params.push(Math.floor(q.periodSeconds));
  }
  if (q.dimensionsHash) {
    clauses.push('dimensions_hash = ?');
    params.push(q.dimensionsHash);
  }

  const step = Math.max(1, Math.floor(q.bucketSeconds)) * 1000;
  const maxBuckets = Math.max(1, Math.floor(q.maxBuckets));

  // `CAST(? AS INTEGER)` is load-bearing, not decoration: better-sqlite3 binds
  // a JavaScript number as a double, and `ts_ms / 300000.0` is *float*
  // division, so the multiply puts every point back on its own timestamp and
  // no bucketing happens at all. Casting the divisor makes SQLite use integer
  // division, which floors — exact here because `ts_ms` is a positive integer
  // by the write path's own validation.
  const rows = db
    .prepare(
      `SELECT (ts_ms / CAST(? AS INTEGER)) * CAST(? AS INTEGER) AS bucket_ts,
              MIN(value) AS min_value,
              MAX(value) AS max_value,
              SUM(value) AS sum_value,
              COUNT(*)   AS n
         FROM infra_metric_points
        WHERE ${clauses.join(' AND ')}
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
        LIMIT ?`,
    )
    .all(step, step, ...params, maxBuckets + 1) as Array<{
    bucket_ts: number;
    min_value: number;
    max_value: number;
    sum_value: number;
    n: number;
  }>;

  const truncated = rows.length > maxBuckets;
  if (truncated) rows.length = maxBuckets;

  return {
    buckets: rows.map((r) => ({
      tsMs: r.bucket_ts,
      minValue: r.min_value,
      maxValue: r.max_value,
      sumValue: r.sum_value,
      count: r.n,
    })),
    truncated,
  };
}

interface InfraMetricPointDbRow {
  id: number;
  project_id: string;
  resource_key: string;
  namespace: string;
  metric_name: string;
  dimensions_hash: string;
  dimensions_json: string | null;
  stat: string;
  period_s: number;
  ts_ms: number;
  value: number;
}

function mapPointRow(r: InfraMetricPointDbRow): InfraMetricPointRow {
  return {
    id: r.id,
    projectId: r.project_id,
    resourceKey: r.resource_key,
    namespace: r.namespace,
    metricName: r.metric_name,
    dimensionsHash: r.dimensions_hash,
    dimensionsJson: r.dimensions_json,
    stat: r.stat,
    periodSeconds: r.period_s,
    tsMs: r.ts_ms,
    value: r.value,
  };
}

/** Count of stored points for a project (retention + tests). */
export function countInfraMetricPoints(projectId: string): number {
  const row = getInfraDb()
    .prepare('SELECT COUNT(*) AS n FROM infra_metric_points WHERE project_id = ?')
    .get(projectId) as { n: number };
  return row.n;
}

// ─── Collect-run audit (decision INFRA-COST) ────────────────────────────────

export interface InfraCollectRunStart {
  id: string;
  projectId: string;
  accountId?: string | null;
  region?: string | null;
  startedAt: number;
}

/**
 * Counter deltas for one increment of an open run row.
 *
 * Every field is an amount to **add**, not a total to set, so a caller can
 * flush after each billed request without having to know what it flushed
 * before.
 */
export interface InfraCollectRunProgress {
  queriesIssued?: number;
  metricsRequested?: number;
  datapointsReturned?: number;
  pointsWritten?: number;
  throttles?: number;
  errors?: number;
  estimatedCostUsd?: number;
}

export interface InfraCollectRunFinish {
  finishedAt: number;
  status: 'ok' | 'partial' | 'failed';
  errorMessage?: string | null;
}

/**
 * Open an audit row for a tick. Written before the tick does any AWS work, so a
 * process that dies mid-tick leaves a `running` row behind — that orphan is the
 * only evidence the tick ever started, and losing it would make a crash loop
 * look like an idle collector.
 */
export function startInfraCollectRun(run: InfraCollectRunStart): void {
  getInfraDb()
    .prepare(
      `INSERT INTO infra_collect_runs (id, project_id, account_id, region, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
    )
    .run(run.id, run.projectId, run.accountId ?? null, run.region ?? null, run.startedAt);
}

/**
 * Add a tick's latest counters onto an open run row.
 *
 * **Spend is accounted incrementally, as it is incurred, rather than once at
 * the end.** A `GetMetricData` request is billed the moment AWS answers it, so
 * an audit trail that only learns the cost when the tick finishes has a window
 * where money has been spent and nothing durably records it. An in-process
 * error still closes the row through the collector's `finally`, but a hard kill
 * — SIGKILL, an OOM, the host rebooting — does not run `finally` at all, and
 * the row would be left claiming zero cost for requests AWS has already
 * charged for.
 *
 * That gap is worst exactly where it matters most. In a crash loop each restart
 * issues a fresh round of billed requests, none of them are ever counted, and
 * the ceiling that exists to stop runaway spend never trips because
 * month-to-date spend reads as zero. Paying one indexed `UPDATE` by primary key
 * per AWS round trip is a rounding error against the network call it follows.
 *
 * `+=` rather than `=` so the caller flushes deltas and never has to reconcile
 * against what it wrote last.
 */
export function recordInfraCollectRunProgress(id: string, delta: InfraCollectRunProgress): void {
  getInfraDb()
    .prepare(
      `UPDATE infra_collect_runs
          SET queries_issued      = queries_issued + ?,
              metrics_requested   = metrics_requested + ?,
              datapoints_returned = datapoints_returned + ?,
              points_written      = points_written + ?,
              throttles           = throttles + ?,
              errors              = errors + ?,
              estimated_cost_usd  = estimated_cost_usd + ?
        WHERE id = ?`,
    )
    .run(
      delta.queriesIssued ?? 0,
      delta.metricsRequested ?? 0,
      delta.datapointsReturned ?? 0,
      delta.pointsWritten ?? 0,
      delta.throttles ?? 0,
      delta.errors ?? 0,
      delta.estimatedCostUsd ?? 0,
      id,
    );
}

/**
 * Close an audit row.
 *
 * Terminal fields only. The counters belong to
 * {@link recordInfraCollectRunProgress}, which has already persisted them as
 * the spend was incurred — writing absolute totals here as well would make two
 * writers for one column, and they could only ever disagree.
 */
export function finishInfraCollectRun(id: string, result: InfraCollectRunFinish): void {
  getInfraDb()
    .prepare(
      `UPDATE infra_collect_runs
          SET finished_at = ?,
              duration_ms = ? - started_at,
              status = ?,
              error_message = ?
        WHERE id = ?`,
    )
    .run(result.finishedAt, result.finishedAt, result.status, result.errorMessage ?? null, id);
}
