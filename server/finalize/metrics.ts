/**
 * metrics.ts — Finalize Code Changes adoption metrics emitter + reader.
 *
 * See wiki: `finalize-code-changes-architecture-v0` §14
 * (Metrics & Observability).
 *
 * Why this exists
 * ───────────────
 * During the dogfood window we need to answer questions like:
 *   - How many Finalize runs are humans clicking vs. agents auto-firing?
 *   - What fraction of runs complete successfully?
 *   - How long do runs actually take?
 *   - What's the spread on fix-dispatch counts per run?
 *   - Of merged PRs, what share came through Finalize?
 *
 * Answers come from `finalize_metrics`, an append-only event log keyed by
 * project. Each emitter call here writes one row at the moment the event
 * occurs; the read endpoint aggregates the window the caller asked for.
 * There is no UI at v0 — the endpoint + ad-hoc SQL is the dogfood surface.
 *
 * Design notes
 * ────────────
 * - **Counters vs. histograms.** Both are stored as flat rows. A counter
 *   row has `value = 1`; a histogram row has `value = <sample>`. The
 *   reader differentiates by the metric's `MetricKind`.
 * - **Labels.** `labels` is a JSON object string. The reader uses
 *   `json_extract(...)` to fan out per-label groupings.
 * - **Non-fatal writes.** Every emitter is wrapped in try/catch — a DB
 *   hiccup must never crash a finalize run. Errors land on the supplied
 *   `log` sink so they're visible in production logs.
 * - **No async fan-out at v0.** Writes are synchronous against
 *   better-sqlite3; the volume is tiny (a few rows per run).
 */
import type { Stmts } from '../types.js';

// ─── Metric vocabulary ────────────────────────────────────────────────

/**
 * Every metric the Finalize feature emits. Keeping this as a string
 * union (not a CHECK constraint on the DB column) means we can add new
 * metrics without a schema migration; the read API still validates
 * names against this list.
 */
export const METRIC_NAMES = [
  /**
   * One row per Finalize run that started.
   * Labels: `{ trigger_source: 'ui_button' | 'agent_block' }`.
   */
  'finalize_run_started',
  /**
   * One row per Finalize run that reached a terminal state.
   * Labels: `{ status, trigger_source }`.
   */
  'finalize_run_completed',
  /**
   * Per completed run: total active seconds billed to the §13 budget.
   * Histogram sample lives in `value`.
   */
  'finalize_run_active_seconds',
  /**
   * Per completed run: wall-clock seconds from `started_at` to terminal.
   * Histogram sample lives in `value`.
   */
  'finalize_run_wall_seconds',
  /**
   * Per completed run: total fix-dispatch loops the run produced.
   * Histogram sample lives in `value`.
   */
  'finalize_fix_dispatch_count',
  /**
   * Reviewer verdict from the review phase.
   * Labels: `{ verdict: 'approved' | 'changes_requested', attempt_index }`.
   */
  'finalize_reviewer_verdict',
  /**
   * One row per CI step the runner actually executed.
   * Labels: `{ step_name, status: 'passed' | 'failed', exit_code }`.
   */
  'finalize_step_result',
  /**
   * Counter — incremented when the stall watchdog parks a run at the
   * 24-hour terminal.
   */
  'finalize_stalled_no_response_count',
  /**
   * One row per merged PR observed in the webhook handler.
   * Labels: `{ source: 'finalize' | 'external' }`.
   */
  'merged_pr_provenance',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/**
 * How the reader aggregates each metric.
 *
 *   - `'counter'` — `count(rows)` per label combination.
 *   - `'histogram'` — counts plus quantile estimates (`p50`, `p95`, `p99`)
 *     and `min`/`max`/`avg` over `value`. Histograms with `< 1` sample
 *     return `null` quantiles to keep clients honest.
 */
export type MetricKind = 'counter' | 'histogram';

const METRIC_KIND: Record<MetricName, MetricKind> = {
  finalize_run_started: 'counter',
  finalize_run_completed: 'counter',
  finalize_run_active_seconds: 'histogram',
  finalize_run_wall_seconds: 'histogram',
  finalize_fix_dispatch_count: 'histogram',
  finalize_reviewer_verdict: 'counter',
  finalize_step_result: 'counter',
  finalize_stalled_no_response_count: 'counter',
  merged_pr_provenance: 'counter',
};

export function getMetricKind(name: MetricName): MetricKind {
  return METRIC_KIND[name];
}

export function isMetricName(value: unknown): value is MetricName {
  return typeof value === 'string' && (METRIC_NAMES as readonly string[]).includes(value);
}

// ─── Emitter surface ──────────────────────────────────────────────────

export interface MetricsDeps {
  stmts: Pick<Stmts, 'insertFinalizeMetric'>;
  /** Defaults to `Date.now`. Injection makes tests deterministic. */
  now?: () => number;
  /** Defaults to `console.warn`. */
  log?: (msg: string) => void;
}

export interface RecordMetricArgs {
  projectId: string;
  name: MetricName;
  /** Optional label map; serialised as JSON. Empty by default. */
  labels?: Record<string, string | number | boolean | null>;
  /** Counter rows omit this (defaults to `1`). Histograms pass the sample. */
  value?: number;
  /** Optional back-link to `finalize_runs.id`. */
  runId?: string | null;
}

/**
 * Lowest-level emitter — every named helper below delegates to this.
 * Catches and logs every error so metric writes can never crash callers.
 *
 * Labels are sorted alphabetically before stringification so callers
 * comparing serialised labels (in assertions, dedup logic, etc.) see a
 * canonical shape regardless of insertion order.
 */
export function recordMetric(deps: MetricsDeps, args: RecordMetricArgs): void {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const value = args.value ?? 1;
  const labelsJson = canonicalLabels(args.labels);
  try {
    deps.stmts.insertFinalizeMetric.run(
      args.projectId,
      args.name,
      labelsJson,
      value,
      args.runId ?? null,
      now(),
    );
  } catch (err) {
    log(
      `[finalize-metrics] insert failed for project=${args.projectId} name=${args.name}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function canonicalLabels(
  labels: Record<string, string | number | boolean | null> | undefined,
): string {
  if (!labels) return '{}';
  const keys = Object.keys(labels).sort();
  const canonical: Record<string, string | number | boolean | null> = {};
  for (const k of keys) canonical[k] = labels[k];
  return JSON.stringify(canonical);
}

// ─── Typed helpers — one per metric ───────────────────────────────────
//
// The orchestrator and phase modules call these by name rather than
// invoking `recordMetric` directly, so the label contract is enforced at
// the type level and a typo on `trigger_source` becomes a TS error
// instead of a silently-dropped row.

export function recordRunStarted(
  deps: MetricsDeps,
  args: {
    projectId: string;
    runId: string;
    triggerSource: 'ui_button' | 'agent_block';
  },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'finalize_run_started',
    labels: { trigger_source: args.triggerSource },
    runId: args.runId,
  });
}

export function recordRunCompleted(
  deps: MetricsDeps,
  args: {
    projectId: string;
    runId: string;
    status: string;
    triggerSource: 'ui_button' | 'agent_block';
  },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'finalize_run_completed',
    labels: { status: args.status, trigger_source: args.triggerSource },
    runId: args.runId,
  });
}

export function recordRunActiveSeconds(
  deps: MetricsDeps,
  args: {
    projectId: string;
    runId: string;
    activeSeconds: number;
    status: string;
  },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'finalize_run_active_seconds',
    labels: { status: args.status },
    value: args.activeSeconds,
    runId: args.runId,
  });
}

export function recordRunWallSeconds(
  deps: MetricsDeps,
  args: {
    projectId: string;
    runId: string;
    wallSeconds: number;
    status: string;
  },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'finalize_run_wall_seconds',
    labels: { status: args.status },
    value: args.wallSeconds,
    runId: args.runId,
  });
}

export function recordFixDispatchCount(
  deps: MetricsDeps,
  args: {
    projectId: string;
    runId: string;
    count: number;
    status: string;
  },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'finalize_fix_dispatch_count',
    labels: { status: args.status },
    value: args.count,
    runId: args.runId,
  });
}

export function recordReviewerVerdict(
  deps: MetricsDeps,
  args: {
    projectId: string;
    runId: string;
    verdict: 'approved' | 'changes_requested';
    /** 1-indexed iteration of the fix-dispatch loop this verdict landed on. */
    attemptIndex: number;
  },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'finalize_reviewer_verdict',
    labels: {
      verdict: args.verdict,
      attempt_index: args.attemptIndex,
    },
    runId: args.runId,
  });
}

export function recordStepResult(
  deps: MetricsDeps,
  args: {
    projectId: string;
    runId: string;
    stepName: string;
    status: 'passed' | 'failed';
    exitCode: number;
  },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'finalize_step_result',
    labels: {
      step_name: args.stepName,
      status: args.status,
      exit_code: args.exitCode,
    },
    runId: args.runId,
  });
}

export function recordStalledNoResponse(
  deps: MetricsDeps,
  args: { projectId: string; runId: string },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'finalize_stalled_no_response_count',
    runId: args.runId,
  });
}

export function recordMergedPrProvenance(
  deps: MetricsDeps,
  args: {
    projectId: string;
    runId?: string | null;
    source: 'finalize' | 'external';
  },
): void {
  recordMetric(deps, {
    projectId: args.projectId,
    name: 'merged_pr_provenance',
    labels: { source: args.source },
    runId: args.runId ?? null,
  });
}

// ─── Aggregation ──────────────────────────────────────────────────────

export interface MetricLabelGroup {
  /** Stringified label map (canonical key order). */
  labels: Record<string, string | number | boolean | null>;
  /** Number of rows matching this label combination. */
  count: number;
}

export interface HistogramSummary {
  /** Number of samples. */
  count: number;
  /** Smallest sample. `null` when `count === 0`. */
  min: number | null;
  /** Largest sample. `null` when `count === 0`. */
  max: number | null;
  /** Arithmetic mean. `null` when `count === 0`. */
  avg: number | null;
  /** 50th-percentile sample (Type 7 / linear interpolation). */
  p50: number | null;
  /** 95th percentile. */
  p95: number | null;
  /** 99th percentile. */
  p99: number | null;
}

export interface CounterAggregate {
  metric: MetricName;
  kind: 'counter';
  /** Sum of all rows. */
  count: number;
  /** Per-label-combination breakdown. */
  groups: MetricLabelGroup[];
}

export interface HistogramAggregate {
  metric: MetricName;
  kind: 'histogram';
  /** Histogram summary across all rows. */
  summary: HistogramSummary;
  /** Per-label-combination breakdown (each with its own summary). */
  groups: Array<{
    labels: Record<string, string | number | boolean | null>;
    summary: HistogramSummary;
  }>;
}

export type MetricAggregate = CounterAggregate | HistogramAggregate;

export interface AggregateOptions {
  /**
   * Restrict the response to a subset of metrics. Unknown names are
   * dropped (no error). Empty / undefined returns every metric.
   */
  metrics?: MetricName[];
}

/**
 * Group rows by `metric_name` and reduce each bucket into a
 * `MetricAggregate`. Pure: callers fetch the rows via
 * `listAllFinalizeMetricsInRange` and pass them here. Keeping the
 * aggregation out of SQL means the same code works against tests'
 * inline arrays and against the production DB.
 */
export function aggregateMetrics(
  rows: ReadonlyArray<{
    metric_name: string;
    labels: string;
    value: number;
  }>,
  opts: AggregateOptions = {},
): MetricAggregate[] {
  const allow = opts.metrics ? new Set<string>(opts.metrics) : null;
  const byMetric = new Map<MetricName, Array<{ labels: string; value: number }>>();
  for (const row of rows) {
    if (!isMetricName(row.metric_name)) continue;
    if (allow && !allow.has(row.metric_name)) continue;
    let bucket = byMetric.get(row.metric_name);
    if (!bucket) {
      bucket = [];
      byMetric.set(row.metric_name, bucket);
    }
    bucket.push({ labels: row.labels, value: row.value });
  }

  // Ensure every requested (or known) metric is represented even if
  // zero rows landed in the window — empty counters / histograms are a
  // signal in themselves and clients shouldn't have to special-case the
  // "key not present" path.
  const wantedMetrics: MetricName[] = (opts.metrics ?? [...METRIC_NAMES]).filter(isMetricName);

  const out: MetricAggregate[] = [];
  for (const metric of wantedMetrics) {
    const bucket = byMetric.get(metric) ?? [];
    const kind = getMetricKind(metric);
    if (kind === 'counter') {
      out.push(buildCounterAggregate(metric, bucket));
    } else {
      out.push(buildHistogramAggregate(metric, bucket));
    }
  }
  return out;
}

function buildCounterAggregate(
  metric: MetricName,
  bucket: ReadonlyArray<{ labels: string; value: number }>,
): CounterAggregate {
  const groups = new Map<string, { labels: Record<string, unknown>; count: number }>();
  for (const row of bucket) {
    const parsed = parseLabels(row.labels);
    const key = JSON.stringify(parsed);
    const entry = groups.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      groups.set(key, { labels: parsed, count: 1 });
    }
  }
  return {
    metric,
    kind: 'counter',
    count: bucket.length,
    groups: [...groups.values()].map((g) => ({
      labels: g.labels as Record<string, string | number | boolean | null>,
      count: g.count,
    })),
  };
}

function buildHistogramAggregate(
  metric: MetricName,
  bucket: ReadonlyArray<{ labels: string; value: number }>,
): HistogramAggregate {
  const all = bucket.map((r) => r.value);
  const groups = new Map<string, { labels: Record<string, unknown>; values: number[] }>();
  for (const row of bucket) {
    const parsed = parseLabels(row.labels);
    const key = JSON.stringify(parsed);
    const entry = groups.get(key);
    if (entry) {
      entry.values.push(row.value);
    } else {
      groups.set(key, { labels: parsed, values: [row.value] });
    }
  }
  return {
    metric,
    kind: 'histogram',
    summary: summarize(all),
    groups: [...groups.values()].map((g) => ({
      labels: g.labels as Record<string, string | number | boolean | null>,
      summary: summarize(g.values),
    })),
  };
}

function parseLabels(json: string): Record<string, unknown> {
  if (!json || json === '{}') return {};
  try {
    const v = JSON.parse(json);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Compute count / min / max / avg / p50 / p95 / p99 over a sample.
 * Quantiles use linear interpolation (Type 7). For `count === 0` every
 * field except `count` is `null` so clients see the absence of data
 * explicitly rather than zero.
 */
export function summarize(values: ReadonlyArray<number>): HistogramSummary {
  if (values.length === 0) {
    return { count: 0, min: null, max: null, avg: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  };
}

function quantile(sortedAsc: ReadonlyArray<number>, q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

// ─── Range parsing ────────────────────────────────────────────────────

/**
 * Hard cap on any range window — 1 year. Applies to both the relative
 * (`<N><m|h|d>`) form and the explicit (`<isoFrom>..<isoTo>`) form so a
 * window cannot pull more rows than is reasonable for an in-memory
 * aggregator. The cap is duration-aware: it bounds the resolved
 * milliseconds, not the literal magnitude of the input number, so
 * `9000m` (~6 days) is accepted and `8760d` (~24 years) is refused.
 */
export const RANGE_MAX_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Parse the `range` query-string passed to the read endpoint. Accepts:
 *   - `1h`, `24h`, `30m`, `7d`, `90d` — relative windows ending now.
 *   - `<isoFrom>..<isoTo>` — explicit `[from, to)` half-open interval.
 *     The `..` separator is used instead of `:` so ISO8601 timestamps
 *     (which contain colons of their own) can be split unambiguously.
 *
 * Returns `null` if the input is unparseable or larger than
 * {@link RANGE_MAX_MS}; the route maps that to 400.
 */
export function parseRange(
  raw: string | undefined | null,
  now: () => number = Date.now,
): { fromMs: number; toMs: number } | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    // Default window: 24h ending now.
    const to = now();
    return { fromMs: to - 24 * 60 * 60 * 1000, toMs: to };
  }
  const rel = /^([0-9]+)\s*(m|h|d)$/i.exec(trimmed);
  if (rel) {
    const value = Number(rel[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = rel[2].toLowerCase();
    const unitMs = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    const windowMs = value * unitMs;
    if (windowMs > RANGE_MAX_MS) return null;
    const to = now();
    return { fromMs: to - windowMs, toMs: to };
  }
  const sep = trimmed.indexOf('..');
  if (sep > 0) {
    const fromIso = trimmed.slice(0, sep);
    const toIso = trimmed.slice(sep + 2);
    const fromMs = Date.parse(fromIso);
    const toMs = Date.parse(toIso);
    if (
      Number.isFinite(fromMs) &&
      Number.isFinite(toMs) &&
      fromMs < toMs &&
      toMs - fromMs <= RANGE_MAX_MS
    ) {
      return { fromMs, toMs };
    }
  }
  return null;
}
