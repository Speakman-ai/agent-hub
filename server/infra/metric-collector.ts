/**
 * metric-collector.ts — the batched `GetMetricData` poller (decision
 * INFRA-COLLECT).
 *
 * Every tick reads its query list from `infra_resources` (never from
 * `ListMetrics`, which is 25 TPS and omits anything that has not reported in
 * two weeks), turns it into `MetricDataQuery` structures via the service pack,
 * and issues as few `GetMetricData` calls as the API's ceilings allow. The
 * results go to the batched write queue, and what the tick cost is recorded on
 * an `infra_collect_runs` row before the tick is over.
 *
 * Four AWS constraints shape this module, all verified against the
 * `GetMetricData` API reference (August 2026):
 *
 *   - **500 metric queries and 100,800 datapoints per request.** Both are
 *     enforced by {@link batchMetricQueries}, not just the first one — a wide
 *     backfill window blows the datapoint ceiling long before the query
 *     ceiling.
 *   - **Period must track data age or the call returns nothing.** 60s data is
 *     retained 15 days, 300s for 63 days, 3600s for 455. Ask for a 60s period
 *     over a 30-day window and CloudWatch has nothing to give you for the far
 *     end of it. {@link resolvePeriod} is the whole of that rule.
 *   - **`StartTime`/`EndTime` should align to the period and to the hour.**
 *     AWS states this outright: *"For better performance, specify StartTime and
 *     EndTime values that align with the value of the metric's Period and sync
 *     up with the beginning and end of an hour."* {@link alignWindow} does it.
 *   - **Results paginate.** A response carries a `NextToken` whenever the
 *     datapoint ceiling is hit; the same query set has to be re-sent with it.
 *
 * Everything above the AWS call is pure and exported so it is unit-tested
 * directly rather than through a mock client. The IO layer below it holds one
 * invariant worth stating: **one failing target never aborts the tick**, same
 * as inventory sync. An expired role in one region must not cost every other
 * region its metrics.
 */

import { randomUUID } from 'crypto';
import {
  GetMetricDataCommand,
  type GetMetricDataCommandOutput,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import { getInfraDb, isInfraDbInitialized } from './infra-db.js';
import { INFRA_TERMINAL_RESOURCE_STATES } from './infra-schema.js';
import { getProjectCloudWatchClient } from './aws-clients.js';
import {
  getServiceMetricPack,
  collectableServices,
  type InfraMetricSpec,
} from './service-metric-packs.js';
import {
  estimateGetMetricDataCostUsd,
  effectivePollIntervalSeconds,
  isMetricDue,
  COLLECTOR_TICK_INTERVAL_S,
  type InfraCostDegradation,
} from './infra-cost.js';
import { resolveProjectDegradation, recordCostDegradation } from './infra-cost-store.js';
import type { BroadcastFn } from '../types.js';
import { enqueueInfraMetricPoints } from './infra-write-queue.js';
import {
  compileInfraTagFilter,
  isEmptyInfraTagFilter,
  matchesInfraTagFilter,
} from './tag-filter.js';
import {
  startInfraCollectRun,
  finishInfraCollectRun,
  recordInfraCollectRunProgress,
  isValidCloudWatchPeriod,
  type InfraMetricPointInput,
} from './infra-metric-store.js';
import type { InfraScopeRow } from './inventory-sync.js';

/**
 * Every 5 minutes (decision INFRA-COLLECT), on the 5-minute boundary rather
 * than at an offset like inventory sync uses. The alignment is the point: a
 * tick that fires at :00/:05/:10 produces a window that is already flush with
 * the 60s and 300s period boundaries AWS asks callers to align to, so the
 * rounding in {@link alignWindow} is a no-op instead of throwing away the most
 * recent partial period.
 */
export const INFRA_COLLECT_CRON = '*/5 * * * *';

/** Hard API ceiling: `MetricDataQuery` structures per `GetMetricData` request. */
export const MAX_QUERIES_PER_REQUEST = 500;

/** Hard API ceiling: datapoints per `GetMetricData` request (also `MaxDatapoints`' default). */
export const MAX_DATAPOINTS_PER_REQUEST = 100_800;

/**
 * Pagination cap for one query batch. At the datapoint ceiling this is over 5
 * million datapoints from a single batch, far past anything a collector window
 * can produce. It exists so a looping `NextToken` cannot spin a tick forever.
 */
export const MAX_PAGES_PER_BATCH = 50;

/** Retention tier boundaries, in ms. Straight from the CloudWatch retention table. */
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const SIXTY_THREE_DAYS_MS = 63 * 24 * 60 * 60 * 1000;

/**
 * How far back each tick asks for. Wider than the 5-minute tick interval on
 * purpose: CloudWatch datapoints land late, and a window that only covered the
 * last tick would leave a permanent hole wherever a metric was a minute or two
 * behind. Re-collecting an overlapping window is free of consequence because
 * the store upserts on the series key.
 */
export const DEFAULT_COLLECT_LOOKBACK_MS = 15 * 60 * 1000;

/**
 * How stale an inventory row may be and still be polled. Inventory sync runs
 * hourly, so a day of silence means the resource has been gone for ~24 sweeps.
 * Rows are never deleted (decision INFRA-SCOPE), so without this the collector
 * would keep paying `GetMetricData` for terminated instances forever.
 */
export const MAX_RESOURCE_STALENESS_MS = 24 * 60 * 60 * 1000;

/**
 * Pricing and projection arithmetic live in `infra-cost.ts` (decision
 * INFRA-COST), which is IO-free so the scope editor and the cost endpoint price
 * a tick the same way the collector does. Re-exported here because this is where
 * callers already look for them.
 */
export {
  estimateGetMetricDataCostUsd,
  GET_METRIC_DATA_USD_PER_1000_METRICS,
  getMetricDataPricePer1000,
} from './infra-cost.js';

/** Throttle backoff bounds. Full jitter over an exponentially growing cap. */
export const THROTTLE_BACKOFF_BASE_MS = 500;
export const THROTTLE_BACKOFF_MAX_MS = 20_000;
/** Retries per request after a throttle. Beyond this the batch is an error. */
export const DEFAULT_MAX_THROTTLE_RETRIES = 5;

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * The shortest period CloudWatch still holds data at for a window reaching back
 * to `windowStartMs`.
 *
 * CloudWatch retains 60s data for 15 days, 300s for 63 days, and 3600s for 455
 * days, aggregating each tier into the next as it ages. Requesting a finer
 * period than the tier the data has aged into does not return coarser data — it
 * returns nothing, silently, which is the failure this function exists to
 * prevent.
 *
 * Keyed on the window's **start**, not its end: a query spanning the 15-day
 * boundary can only be answered at the coarser tier, because the old end of it
 * no longer exists at 60s.
 *
 * There is no fourth tier for windows past 455 days. 3600s stays the answer;
 * the data is simply gone, and CloudWatch returning an empty result for it is
 * correct rather than something to work around.
 */
export function resolvePeriod(windowStartMs: number, nowMs: number): number {
  const age = nowMs - windowStartMs;
  if (age <= FIFTEEN_DAYS_MS) return 60;
  if (age <= SIXTY_THREE_DAYS_MS) return 300;
  return 3600;
}

/**
 * The period this metric is actually collectable at: the retention tier, raised
 * to the metric's own emission floor.
 *
 * The **floor** is validated, not just the result. A floor of 45 is currently
 * masked by the 60s tier always winning the `Math.max`, so checking only the
 * output would let a malformed pack entry sit undetected until the day a
 * coarser tier or a finer floor made it the answer. The pack is a hand-written
 * table; catching its typos where they are written is the point.
 */
export function effectivePeriod(
  spec: InfraMetricSpec,
  windowStartMs: number,
  nowMs: number,
): number {
  if (!isValidCloudWatchPeriod(spec.minPeriodSeconds)) {
    throw new Error(
      `metric pack entry ${spec.namespace}/${spec.metricName} has an invalid minPeriodSeconds (${spec.minPeriodSeconds})`,
    );
  }
  // Both inputs are valid periods and the result is the larger of the two, so
  // the store will accept it.
  return Math.max(resolvePeriod(windowStartMs, nowMs), spec.minPeriodSeconds);
}

export interface AlignedWindow {
  startMs: number;
  endMs: number;
}

/**
 * Snap a window to period boundaries, per AWS's own performance guidance.
 *
 * Flooring an epoch timestamp to a multiple of the period is also what syncs it
 * to the hour, because 60, 300 and 3600 all divide 3600 evenly and the epoch
 * itself is an hour boundary. That coincidence is why one rounding satisfies
 * both halves of AWS's advice — it would stop holding for a period like 420s,
 * which {@link resolvePeriod} never returns.
 *
 * `EndTime` is exclusive and `StartTime` inclusive, so a window that rounds to
 * zero width would ask for nothing at all. It is widened back to one period
 * instead, which is the smallest question worth asking.
 */
export function alignWindow(startMs: number, endMs: number, periodSeconds: number): AlignedWindow {
  const step = periodSeconds * 1000;
  const alignedEnd = Math.floor(endMs / step) * step;
  let alignedStart = Math.floor(startMs / step) * step;
  if (alignedStart >= alignedEnd) alignedStart = alignedEnd - step;
  return { startMs: alignedStart, endMs: alignedEnd };
}

/**
 * Datapoints one query can return over a window. Used to bound a batch against
 * the per-request datapoint ceiling before the request is sent, rather than
 * discovering the ceiling as an extra pagination round trip.
 */
export function estimateDatapointsPerQuery(
  startMs: number,
  endMs: number,
  periodSeconds: number,
): number {
  const step = periodSeconds * 1000;
  return Math.max(1, Math.ceil((endMs - startMs) / step));
}

/**
 * Split queries into request-sized batches against **both** API ceilings.
 *
 * The 500-query limit is the one everybody remembers; the 100,800-datapoint
 * limit is the one that actually binds on a wide window. 500 queries over a
 * 15-day 60s window would be 500 × 21,600 = 10.8 million datapoints, so the
 * request would paginate 107 times instead of once. Bounding by datapoints up
 * front turns that into batches that each fit in a single response.
 */
export function batchMetricQueries<T>(
  queries: readonly T[],
  datapointsPerQuery: number,
  maxQueriesPerRequest: number = MAX_QUERIES_PER_REQUEST,
  maxDatapointsPerRequest: number = MAX_DATAPOINTS_PER_REQUEST,
): T[][] {
  if (queries.length === 0) return [];
  const byDatapoints = Math.floor(maxDatapointsPerRequest / Math.max(1, datapointsPerQuery));
  // At least one query per batch even when a single query's window exceeds the
  // datapoint ceiling on its own: that request paginates, which is correct and
  // is what NextToken is for. Refusing to issue it would drop the series.
  const perBatch = Math.max(1, Math.min(maxQueriesPerRequest, byDatapoints));
  const batches: T[][] = [];
  for (let i = 0; i < queries.length; i += perBatch) {
    batches.push(queries.slice(i, i + perBatch));
  }
  return batches;
}

/** CloudWatch error names that mean "you are going too fast", not "you are wrong". */
const THROTTLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'Throttling',
  'ThrottledException',
  'RequestThrottled',
  'RequestThrottledException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'SlowDown',
]);

/**
 * Whether an error is a rate limit worth retrying.
 *
 * Three signals, in order of trustworthiness: the SDK's own `$retryable`
 * classification, HTTP 429, then the error name. The name list is last because
 * `ThrottlingException` arrives as an HTTP **400** from CloudWatch, so status
 * alone cannot carry the decision.
 */
export function isThrottlingError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    name?: string;
    Code?: string;
    $retryable?: { throttling?: boolean };
    $metadata?: { httpStatusCode?: number };
  };
  if (e.$retryable?.throttling === true) return true;
  if (e.$metadata?.httpStatusCode === 429) return true;
  const name = e.name ?? e.Code;
  return typeof name === 'string' && THROTTLE_ERROR_NAMES.has(name);
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Full-jitter exponential backoff, floored at one base interval.
 *
 * Jitter is not decoration: every batch in a tick throttles at roughly the same
 * moment, and an unjittered backoff would march them all into the next retry
 * simultaneously — a thundering herd that re-throttles as reliably as the first
 * attempt did. AWS's own guidance is to randomise across the whole window.
 *
 * The floor is the one deviation from textbook full jitter, which allows a
 * zero-length sleep. Retrying a rate limit immediately is not a backoff.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? THROTTLE_BACKOFF_BASE_MS;
  const max = opts.maxMs ?? THROTTLE_BACKOFF_MAX_MS;
  const cap = Math.min(max, base * 2 ** Math.max(0, attempt));
  const rand = opts.random ? opts.random() : Math.random();
  return Math.max(base, Math.round(rand * cap));
}

// ─── Query planning ─────────────────────────────────────────────────────────

/** One resource-metric series the collector intends to fetch. */
export interface PlannedQuery {
  resourceKey: string;
  namespace: string;
  metricName: string;
  dimensions: Record<string, string>;
  stat: string;
  periodSeconds: number;
}

/** The subset of an `infra_resources` row the collector queries on. */
export interface CollectableResource {
  resource_key: string;
  account_id: string;
  resource_id: string;
  service: string;
  /** Raw AWS tag array as stored; read only to re-apply the scope's tag filter. */
  tags_json?: string | null;
  /** CloudWatch dimension map for this resource, as written by inventory sync. */
  metric_dimensions_json?: string | null;
  /** Detected provider feature flags, e.g. `{"containerInsights":true}`. */
  features_json?: string | null;
}

/**
 * Parse a JSON object column into a flat map, defensively.
 *
 * Never throws. These columns are written by inventory sync, but a row can
 * predate the column, be hand-edited, or have been written by a build that
 * disagreed about the shape — and none of those are worth failing a whole
 * collection tick over. An unreadable value means "nothing recorded", which is
 * the same fail-closed answer as an absent one.
 */
function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The CloudWatch dimension map recorded for a resource, or `null`.
 *
 * String values only: a dimension value is a string on the wire, and coercing a
 * number or a nested object into one would produce a query that silently
 * matches nothing.
 */
function recordedDimensions(
  resource: Pick<CollectableResource, 'metric_dimensions_json'>,
): Record<string, string> | null {
  const parsed = parseJsonObject(resource.metric_dimensions_json);
  if (!parsed) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The one dimension name a service's whole pack agrees on, or `null`.
 *
 * This is what makes the fallback below safe. EC2 keys every metric on
 * `InstanceId`, so a row with no recorded dimension map has exactly one
 * possible reading. ECS does not — a cluster is keyed on `ClusterName` and a
 * service on `ClusterName` + `ServiceName` — so binding an ECS resource id to
 * whichever single dimension happened to come first would query the wrong
 * series and be billed for it.
 */
function unambiguousServiceDimension(service: string): string | null {
  const specs = getServiceMetricPack(service);
  if (specs.length === 0) return null;
  const names = new Set(specs.flatMap((spec) => [...spec.dimensions]));
  if (names.size !== 1) return null;
  return specs.every((spec) => spec.dimensions.length === 1) ? [...names][0]! : null;
}

/**
 * The dimension map to plan a resource's queries from.
 *
 * Normally the map inventory sync recorded. The fallback covers rows written
 * before the column existed: an EC2 row on an install mid-upgrade must keep
 * collecting exactly what it collected yesterday, and the hourly sweep fills
 * the column in shortly after. It only applies where the service's pack has a
 * single unambiguous dimension, so it can never misbind a multi-dimension
 * service; such a resource is simply not collected until it is re-described.
 */
export function resolveResourceDimensions(
  resource: Pick<CollectableResource, 'metric_dimensions_json' | 'resource_id' | 'service'>,
): Record<string, string> | null {
  const recorded = recordedDimensions(resource);
  if (recorded) return recorded;
  const dimension = unambiguousServiceDimension(resource.service);
  return dimension ? { [dimension]: resource.resource_id } : null;
}

/** Whether a resource has a provider feature turned on. */
export function resourceHasFeature(
  resource: Pick<CollectableResource, 'features_json'>,
  feature: string,
): boolean {
  return parseJsonObject(resource.features_json)?.[feature] === true;
}

/**
 * Bind one pack metric to one resource, or `null` when it does not apply.
 *
 * Three rules, and all of them are about not paying for a series that cannot
 * exist:
 *
 *   - **The dimension set must match exactly.** CloudWatch keys a series on its
 *     full dimension combination, so `AWS/ECS` `CPUUtilization` at
 *     `ClusterName` and at `ClusterName` + `ServiceName` are different numbers.
 *     A subset match would bill an ECS cluster row for the service-level query
 *     and return nothing.
 *   - **A pinned dimension value must match too.** Rare, and S3 is the reason:
 *     `NumberOfObjects` exists only at `StorageType=AllStorageTypes` and
 *     `BucketSizeBytes` exists at every other storage class and not there, both
 *     on the same dimension names. Without the value check each bucket would
 *     carry one permanently empty billed series per storage class.
 *   - **A gated metric needs the feature recorded as on.** An unrecorded
 *     feature counts as off, which is the fail-closed direction: the cost of
 *     guessing wrong towards "on" is a billed request for a series the account
 *     does not publish, repeated every tick forever.
 */
export function bindMetricDimensions(
  spec: InfraMetricSpec,
  // Structural, not `CollectableResource`: the alert sweep resolves the same
  // binding to decide which stored series a rule evaluates on, and it carries a
  // narrower row than the collector does. One binding function is the point —
  // a rule that evaluated a different series from the one collected would be
  // reporting on numbers nobody asked for.
  resource: Pick<CollectableResource, 'features_json'>,
  dimensions: Record<string, string> | null,
): Record<string, string> | null {
  if (spec.requiresFeature && !resourceHasFeature(resource, spec.requiresFeature)) return null;
  if (!dimensions) return null;

  const recorded = Object.keys(dimensions);
  if (recorded.length !== spec.dimensions.length) return null;
  const bound: Record<string, string> = {};
  for (const name of spec.dimensions) {
    const value = dimensions[name];
    if (value === undefined) return null;
    // A pinned value is part of the series identity, so a mismatch means the
    // metric does not apply to this resource — not that it should be queried
    // with the pack's value instead. Overriding would ask CloudWatch about a
    // different resource entirely.
    if (spec.dimensionValues?.[name] !== undefined && spec.dimensionValues[name] !== value) {
      return null;
    }
    bound[name] = value;
  }
  return bound;
}

export interface PlanQueriesOptions {
  /** Collector cadence in ms; a metric cannot be due more often than this. */
  tickIntervalMs?: number;
  /**
   * Cost-degradation level for the project (decision INFRA-COST). `widened`
   * stretches every metric's poll interval; `paused` never reaches here,
   * because a paused project is skipped before a client is even built.
   */
  degradation?: InfraCostDegradation;
}

/**
 * The cross product of in-scope resources and their service pack, minus the
 * metrics that do not apply to the resource and the ones that are not due on
 * this tick.
 *
 * Applicability comes first (see {@link bindMetricDimensions}): a metric whose
 * dimension set does not match the resource, or whose paid feature is off, is
 * not a query at all. The due filter is then the query-side half of
 * INFRA-COST's "poll intervals are tiered per service, not global".
 * `GetMetricData` bills per metric *requested*, so re-asking for a 5-minute
 * metric every minute — or an S3 daily storage metric every 5 minutes — is
 * money spent on datapoints CloudWatch has not published yet.
 * `effectivePollIntervalSeconds` resolves what each metric is actually worth
 * asking for, and {@link isMetricDue} answers whether this tick is the one,
 * statelessly, by bucketing the wall clock.
 *
 * Ordering is deterministic (resources in the order the caller supplied, then
 * pack order) so batch boundaries are reproducible and a test can assert on
 * them without guessing at a hash order.
 */
export function planQueries(
  resources: readonly CollectableResource[],
  windowStartMs: number,
  nowMs: number,
  opts: PlanQueriesOptions = {},
): PlannedQuery[] {
  const tickIntervalMs = opts.tickIntervalMs ?? COLLECTOR_TICK_INTERVAL_S * 1000;
  const planned: PlannedQuery[] = [];
  for (const resource of resources) {
    // Resolved once per resource rather than once per metric: a pack can carry
    // two dozen entries and the map is the same for all of them.
    const dimensions = resolveResourceDimensions(resource);
    for (const spec of getServiceMetricPack(resource.service)) {
      // Applicability first, cadence second. A metric this resource cannot
      // publish is skipped whether or not this tick would have been its turn,
      // and asking the cheaper question first keeps the due-bucket arithmetic
      // off resources it can only be discarded for.
      const bound = bindMetricDimensions(spec, resource, dimensions);
      if (!bound) continue;
      const intervalS = effectivePollIntervalSeconds(resource.service, spec, {
        tickIntervalSeconds: tickIntervalMs / 1000,
        degradation: opts.degradation,
      });
      if (!isMetricDue(intervalS * 1000, nowMs, tickIntervalMs)) continue;
      planned.push({
        resourceKey: resource.resource_key,
        namespace: spec.namespace,
        metricName: spec.metricName,
        dimensions: bound,
        stat: spec.stat,
        periodSeconds: effectivePeriod(spec, windowStartMs, nowMs),
      });
    }
  }
  return planned;
}

/**
 * Group planned queries by period.
 *
 * One request carries a single `StartTime`/`EndTime` pair but a per-query
 * `Period`, so mixing periods in one request means the window can only be
 * aligned to one of them. Grouping keeps every request aligned to the period it
 * carries, and costs at most three requests' worth of extra batching because
 * {@link resolvePeriod} only ever yields 60, 300 or 3600 (raised to a pack
 * entry's floor).
 */
export function groupQueriesByPeriod(
  queries: readonly PlannedQuery[],
): Map<number, PlannedQuery[]> {
  const groups = new Map<number, PlannedQuery[]>();
  for (const q of queries) {
    const bucket = groups.get(q.periodSeconds);
    if (bucket) bucket.push(q);
    else groups.set(q.periodSeconds, [q]);
  }
  return groups;
}

/**
 * Build the wire structures for one batch, plus the id → plan map to decode the
 * response with.
 *
 * Ids are positional (`m0`, `m1`, …) rather than derived from the series:
 * CloudWatch requires an id matching `^[a-z][a-zA-Z0-9_]*$` and unique within
 * the request, and a resource id or metric name sanitised into that alphabet
 * can collide. A positional id cannot.
 */
export function buildMetricDataQueries(batch: readonly PlannedQuery[]): {
  queries: MetricDataQuery[];
  byId: Map<string, PlannedQuery>;
} {
  const queries: MetricDataQuery[] = [];
  const byId = new Map<string, PlannedQuery>();
  batch.forEach((plan, index) => {
    const id = `m${index}`;
    byId.set(id, plan);
    queries.push({
      Id: id,
      MetricStat: {
        Metric: {
          Namespace: plan.namespace,
          MetricName: plan.metricName,
          Dimensions: Object.entries(plan.dimensions).map(([Name, Value]) => ({ Name, Value })),
        },
        Period: plan.periodSeconds,
        Stat: plan.stat,
      },
    });
  });
  return { queries, byId };
}

/**
 * Decode one `MetricDataResult` into storable points.
 *
 * `Timestamps` and `Values` are parallel arrays; the shorter one wins so a
 * truncated response cannot pair a timestamp with the wrong value.
 */
export function pointsFromResult(
  result: MetricDataResult,
  plan: PlannedQuery,
  projectId: string,
): InfraMetricPointInput[] {
  const timestamps = result.Timestamps ?? [];
  const values = result.Values ?? [];
  const n = Math.min(timestamps.length, values.length);
  const points: InfraMetricPointInput[] = [];
  for (let i = 0; i < n; i += 1) {
    const raw = timestamps[i];
    const tsMs = raw instanceof Date ? raw.getTime() : Number(raw);
    points.push({
      projectId,
      resourceKey: plan.resourceKey,
      namespace: plan.namespace,
      metricName: plan.metricName,
      dimensions: plan.dimensions,
      stat: plan.stat,
      periodSeconds: plan.periodSeconds,
      tsMs,
      value: values[i],
    });
  }
  return points;
}

// ─── Collection ─────────────────────────────────────────────────────────────

/** Just enough of a `CloudWatchClient` to fetch metric data; keeps tests SDK-free. */
export interface CloudWatchMetricDataClient {
  send(command: GetMetricDataCommand): Promise<GetMetricDataCommandOutput>;
}

/** One (project, profile, region) the tick collects for, and its scope rows. */
export interface CollectTarget {
  projectId: string;
  profileName: string;
  region: string;
  scopes: InfraScopeRow[];
}

export interface InfraMetricCollectionOptions {
  /** Injected clock so tests can pin the window. */
  nowMs?: number;
  /** Window depth; defaults to {@link DEFAULT_COLLECT_LOOKBACK_MS}. */
  lookbackMs?: number;
  /** Test seam: build the CloudWatch client for a target. */
  cloudWatchClientFactory?: (target: CollectTarget) => CloudWatchMetricDataClient;
  /** Test seam: where committed points go. Defaults to the shared write queue. */
  enqueue?: (points: InfraMetricPointInput[]) => { enqueued: number; dropped: number };
  /** Test seam: backoff sleep. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: jitter source. */
  random?: () => number;
  maxThrottleRetries?: number;
  /**
   * Collector cadence in ms, used to decide which metrics are due this tick.
   * Defaults to {@link INFRA_COLLECT_CRON}'s interval.
   */
  tickIntervalMs?: number;
  /**
   * In-app notice sink for a cost-ceiling transition (decision INFRA-COST /
   * INFRA-NOTIFY). Optional so a test — or a Hub with no WebSocket server yet —
   * degrades silently rather than throwing inside the guardrail.
   */
  broadcast?: BroadcastFn;
  /**
   * Test seam: resolve a project's degradation level without the store. Also
   * the escape hatch for a caller that has already priced the tick.
   */
  resolveDegradation?: (projectId: string) => InfraCostDegradation;
}

export interface InfraMetricCollectionResult {
  /** (project, profile, region) groups this tick considered. */
  targets: number;
  /** Targets that completed without throwing. */
  collected: number;
  /** Targets that failed; their errors were logged and swallowed. */
  failed: number;
  /** `GetMetricData` requests issued, pagination pages included. */
  queriesIssued: number;
  /** Metrics requested — the billed quantity, summed across requests. */
  metricsRequested: number;
  datapointsReturned: number;
  pointsEnqueued: number;
  /** Points refused by the write queue's depth cap. */
  pointsDropped: number;
  throttles: number;
  /** Per-metric failures reported in a response, plus batches that gave up. */
  errors: number;
  estimatedCostUsd: number;
  /** Targets skipped because their project is paused on its cost ceiling. */
  skipped: number;
  /** Projects the tick found past their ceiling, by level (decision INFRA-COST). */
  degraded: { widened: number; paused: number };
}

/** Per-target counters, folded into the run row and the tick result. */
interface TargetCounters {
  queriesIssued: number;
  metricsRequested: number;
  datapointsReturned: number;
  pointsEnqueued: number;
  pointsDropped: number;
  throttles: number;
  errors: number;
}

function freshCounters(): TargetCounters {
  return {
    queriesIssued: 0,
    metricsRequested: 0,
    datapointsReturned: 0,
    pointsEnqueued: 0,
    pointsDropped: 0,
    throttles: 0,
    errors: 0,
  };
}

function describeTarget(target: CollectTarget): string {
  return `${target.projectId}/${target.profileName}/${target.region}`;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A backoff sleep must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref();
  });

/** Enabled scope rows on a service the collector has a metric pack for. */
function listCollectableScopes(): InfraScopeRow[] {
  const services = collectableServices();
  if (services.length === 0) return [];
  const placeholders = services.map(() => '?').join(', ');
  return getInfraDb()
    .prepare(
      `SELECT id, project_id, profile_name, account_id, region, service, tag_filter_json
         FROM infra_scopes
        WHERE enabled = 1 AND service IN (${placeholders})
        ORDER BY project_id, profile_name, region, service`,
    )
    .all(...services) as InfraScopeRow[];
}

/**
 * Group scopes into (project, profile, region) targets.
 *
 * The grouping is what makes batching work: two scopes on the same account and
 * region but different services share a CloudWatch client, a run row, and — the
 * point — the same 500-query requests, instead of each paying its own round
 * trips for a handful of queries.
 */
export function groupScopesIntoTargets(scopes: readonly InfraScopeRow[]): CollectTarget[] {
  const targets = new Map<string, CollectTarget>();
  for (const scope of scopes) {
    // JSON, not a delimiter join: a profile name is free text, and two
    // distinct targets collapsing into one would poll one profile's scopes
    // with the other's credentials, reading and billing the wrong AWS account.
    const key = JSON.stringify([scope.project_id, scope.profile_name, scope.region]);
    const existing = targets.get(key);
    if (existing) existing.scopes.push(scope);
    else
      targets.set(key, {
        projectId: scope.project_id,
        profileName: scope.profile_name,
        region: scope.region,
        scopes: [scope],
      });
  }
  return [...targets.values()];
}

/**
 * Resources one scope should be polled for.
 *
 * Terminated and long-unseen rows are excluded rather than deleted: inventory
 * keeps them so a chart retains its subject (decision INFRA-SCOPE), but
 * `GetMetricData` bills per metric requested whether or not the resource still
 * exists, so continuing to ask about them is pure spend.
 *
 * **The scope's tag filter is re-applied here**, even though inventory sync
 * already pushed it into the describe call. Inventory rows are never deleted,
 * so a *narrowed* filter leaves rows behind that AWS would no longer return —
 * and the collector would keep billing for them until they aged out a day
 * later. Two scopes on the same region and service under different profiles
 * have the inverse problem: each would otherwise collect the union of both
 * filters, mixing telemetry the operator separated on purpose.
 *
 * Filtering is in JS rather than SQL because the predicate is EC2 glob matching
 * over a JSON tag array, which SQLite cannot express. A scope's tag set is
 * tiny and the patterns are compiled once per scope, not once per row.
 *
 * Throws on a malformed filter — the caller counts the scope as failed. The
 * fail-closed direction is the whole point: falling back to "no filter" would
 * turn an operator typo into a billed sweep of every resource in the region.
 */
function listScopeResources(scope: InfraScopeRow, nowMs: number): CollectableResource[] {
  const tagFilter = compileInfraTagFilter(scope.tag_filter_json);
  const terminal = INFRA_TERMINAL_RESOURCE_STATES.map(() => '?').join(', ');
  const clauses = [
    'project_id = ?',
    'region = ?',
    'service = ?',
    'last_seen >= ?',
    // LOWER(), because the providers disagree on case: EC2 says `terminated`
    // and ECS says `INACTIVE`. A literal comparison would keep billing for
    // every deleted ECS service until it aged out a day later.
    `(state IS NULL OR LOWER(state) NOT IN (${terminal}))`,
  ];
  const params: (string | number)[] = [
    scope.project_id,
    scope.region,
    scope.service,
    nowMs - MAX_RESOURCE_STALENESS_MS,
    ...INFRA_TERMINAL_RESOURCE_STATES,
  ];
  // A scope's account_id stays NULL until sts:GetCallerIdentity has run for its
  // profile; until then the (project, region, service) triple is the whole
  // filter, which is what inventory sync wrote the rows under anyway.
  if (scope.account_id) {
    clauses.push('account_id = ?');
    params.push(scope.account_id);
  }
  const rows = getInfraDb()
    .prepare(
      `SELECT resource_key, account_id, resource_id, service, tags_json,
              metric_dimensions_json, features_json
         FROM infra_resources
        WHERE ${clauses.join(' AND ')}
        ORDER BY resource_id`,
    )
    .all(...params) as CollectableResource[];

  if (isEmptyInfraTagFilter(tagFilter)) return rows;
  return rows.filter((row) => matchesInfraTagFilter(row.tags_json ?? null, tagFilter));
}

/**
 * Send one request, retrying only throttles.
 *
 * A non-throttle error propagates immediately: retrying an `AccessDenied` or a
 * malformed query just spends the backoff budget on an outcome that cannot
 * change, and hides the real error behind a timeout.
 */
async function sendWithThrottleRetry(
  client: CloudWatchMetricDataClient,
  command: GetMetricDataCommand,
  counters: TargetCounters,
  opts: InfraMetricCollectionOptions,
): Promise<GetMetricDataCommandOutput> {
  const maxRetries = opts.maxThrottleRetries ?? DEFAULT_MAX_THROTTLE_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.send(command);
    } catch (err) {
      if (!isThrottlingError(err) || attempt >= maxRetries) throw err;
      counters.throttles += 1;
      await sleep(backoffDelayMs(attempt, { random: opts.random }));
    }
  }
}

/**
 * Issue one batch, following `NextToken`, and hand the points to the queue.
 *
 * `onProgress` is invoked after every page — that is, after every billed
 * request — so the run row's spend is durable before the next request is sent.
 * See {@link recordInfraCollectRunProgress} for why finishing-time accounting
 * alone is not enough.
 */
async function collectBatch(
  client: CloudWatchMetricDataClient,
  projectId: string,
  batch: readonly PlannedQuery[],
  window: AlignedWindow,
  counters: TargetCounters,
  opts: InfraMetricCollectionOptions,
  onProgress: () => void = () => {},
): Promise<void> {
  const { queries, byId } = buildMetricDataQueries(batch);
  let nextToken: string | undefined;
  let pages = 0;
  /**
   * Series that came back `PartialData` on the page we just read.
   *
   * Reset every page, because `PartialData` mid-pagination is the *normal*
   * case, not a fault: AWS defines it as "an incomplete set of data points were
   * returned. You can use the NextToken value that was returned and repeat your
   * request to get more data points." Counting it as an error on sight would
   * flag every multi-page tick. Only what is still partial once pagination has
   * run out is genuinely an incomplete window.
   */
  let partialSeries: string[] = [];

  do {
    const command = new GetMetricDataCommand({
      MetricDataQueries: queries,
      StartTime: new Date(window.startMs),
      EndTime: new Date(window.endMs),
      // Oldest-first so a paginated batch stores the far end of the window
      // first; if the page cap is ever hit, what is missing is the newest
      // slice, which the next tick re-collects anyway.
      ScanBy: 'TimestampAscending',
      ...(nextToken ? { NextToken: nextToken } : {}),
    });

    const out = await sendWithThrottleRetry(client, command, counters, opts);
    // Counted per request, not per batch: every page re-sends the full query
    // set and is billed for it.
    counters.queriesIssued += 1;
    counters.metricsRequested += queries.length;

    for (const message of out.Messages ?? []) {
      console.warn(`[infra-metric-collector] ${projectId}: ${message.Code} ${message.Value}`);
    }

    const points: InfraMetricPointInput[] = [];
    partialSeries = [];
    for (const result of out.MetricDataResults ?? []) {
      const plan = result.Id ? byId.get(result.Id) : undefined;
      if (!plan) continue;
      if (result.StatusCode === 'InternalError' || result.StatusCode === 'Forbidden') {
        counters.errors += 1;
        console.warn(
          `[infra-metric-collector] ${projectId}: ${plan.namespace}/${plan.metricName} returned ${result.StatusCode}`,
        );
        continue;
      }
      // Recorded, not skipped: the datapoints in a PartialData result are real,
      // there are just fewer of them than the window asked for. Whether that
      // gap gets closed is decided after the pagination loop.
      if (result.StatusCode === 'PartialData') {
        partialSeries.push(`${plan.namespace}/${plan.metricName}`);
      }
      points.push(...pointsFromResult(result, plan, projectId));
    }

    counters.datapointsReturned += points.length;
    if (points.length > 0) {
      const enqueue = opts.enqueue ?? enqueueInfraMetricPoints;
      const { enqueued, dropped } = enqueue(points);
      counters.pointsEnqueued += enqueued;
      counters.pointsDropped += dropped;
    }

    // Before the next request goes out: this page is already billed, so its
    // cost must be durable even if the process does not survive to send the
    // one after it.
    onProgress();

    nextToken = out.NextToken ?? undefined;
    pages += 1;
  } while (nextToken && pages < MAX_PAGES_PER_BATCH);

  if (nextToken) {
    // The page cap already explains any outstanding PartialData, so it is not
    // counted twice.
    counters.errors += 1;
    console.warn(
      `[infra-metric-collector] ${projectId}: stopped at the ${MAX_PAGES_PER_BATCH}-page cap; this window is incomplete`,
    );
  } else if (partialSeries.length > 0) {
    // Pagination is exhausted and CloudWatch still calls these incomplete.
    // There is no further token to follow, so the stored window really does
    // have holes in it — the run must not report `ok`.
    counters.errors += partialSeries.length;
    console.warn(
      `[infra-metric-collector] ${projectId}: ${partialSeries.length} series returned PartialData with no further NextToken; ` +
        `these windows are incomplete: ${[...new Set(partialSeries)].join(', ')}`,
    );
  }
}

/** Collect one (project, profile, region), recording a run row for the attempt. */
async function collectTarget(
  target: CollectTarget,
  opts: InfraMetricCollectionOptions,
  nowMs: number,
  degradation: InfraCostDegradation = 'normal',
): Promise<TargetCounters> {
  const counters = freshCounters();
  const lookbackMs = opts.lookbackMs ?? DEFAULT_COLLECT_LOOKBACK_MS;
  const windowStartMs = nowMs - lookbackMs;

  const resources: CollectableResource[] = [];
  for (const scope of target.scopes) {
    try {
      resources.push(...listScopeResources(scope, nowMs));
    } catch (err) {
      // A scope with an unreadable tag filter is skipped, not widened. Counting
      // it keeps the failure visible even on a target where every other scope
      // collected fine — and even when it was the only scope, because these
      // counters are folded into the tick result whether or not a run row opens.
      counters.errors += 1;
      console.warn(
        `[infra-metric-collector] ${describeTarget(target)}/${scope.service}: skipping scope —`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const planned = planQueries(resources, windowStartMs, nowMs, {
    tickIntervalMs: opts.tickIntervalMs ?? COLLECTOR_TICK_INTERVAL_S * 1000,
    degradation,
  });
  // No run row for a target with nothing to ask about. An audit table whose
  // rows are mostly empty ticks makes the ticks that cost money harder to find.
  if (planned.length === 0) return counters;

  const accountId =
    resources.find((r) => r.account_id)?.account_id ??
    target.scopes.find((s) => s.account_id)?.account_id ??
    null;

  const runId = randomUUID();
  startInfraCollectRun({
    id: runId,
    projectId: target.projectId,
    accountId,
    region: target.region,
    startedAt: nowMs,
  });

  let status: 'ok' | 'partial' | 'failed' = 'ok';
  let errorMessage: string | null = null;

  /**
   * Counters already written to the run row, so each flush persists only what
   * is new. Cost is priced on the *delta* and added; because the price is
   * linear in metrics requested, summing per-flush costs is identical to
   * pricing the total once, with no drift to reconcile.
   */
  const persisted = freshCounters();
  const flushProgress = (): void => {
    const delta = {
      queriesIssued: counters.queriesIssued - persisted.queriesIssued,
      metricsRequested: counters.metricsRequested - persisted.metricsRequested,
      datapointsReturned: counters.datapointsReturned - persisted.datapointsReturned,
      pointsWritten: counters.pointsEnqueued - persisted.pointsEnqueued,
      throttles: counters.throttles - persisted.throttles,
      errors: counters.errors - persisted.errors,
    };
    if (Object.values(delta).every((n) => n === 0)) return;
    recordInfraCollectRunProgress(runId, {
      ...delta,
      // Priced at the target's own region: GovCloud and São Paulo are above the
      // $0.01 list rate, and a ceiling fed by a us-east-1 estimate would under-
      // report a São Paulo scope by 40%.
      estimatedCostUsd: estimateGetMetricDataCostUsd(delta.metricsRequested, target.region),
    });
    Object.assign(persisted, counters);
  };

  try {
    const client = opts.cloudWatchClientFactory
      ? opts.cloudWatchClientFactory(target)
      : getProjectCloudWatchClient(target.projectId, {
          profileName: target.profileName,
          region: target.region,
        });

    for (const [periodSeconds, queries] of groupQueriesByPeriod(planned)) {
      // The window scales with the period rather than being the same 15 minutes
      // for every tier. A metric published daily and polled daily would find
      // nothing in a 15-minute window — the poll would be billed and return an
      // empty series forever. Three periods of headroom absorbs CloudWatch's
      // publication latency at every tier, and costs nothing extra: billing is
      // per metric requested, and a wider window adds datapoints to the same
      // request, not requests.
      const groupStartMs = Math.min(windowStartMs, nowMs - 3 * periodSeconds * 1000);
      const window = alignWindow(groupStartMs, nowMs, periodSeconds);
      const perQuery = estimateDatapointsPerQuery(window.startMs, window.endMs, periodSeconds);
      for (const batch of batchMetricQueries(queries, perQuery)) {
        await collectBatch(client, target.projectId, batch, window, counters, opts, flushProgress);
      }
    }
    if (counters.errors > 0 || counters.pointsDropped > 0) status = 'partial';
  } catch (err) {
    status = 'failed';
    counters.errors += 1;
    errorMessage = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(errorMessage), { counters });
  } finally {
    // Catches whatever the last page did not: throttles counted during a retry
    // that then failed, the page-cap / PartialData errors tallied after the
    // pagination loop, and the `errors += 1` from the catch above.
    flushProgress();
    finishInfraCollectRun(runId, {
      // Real wall clock, so `duration_ms` measures the tick rather than the
      // difference between two points on an injected clock. A test that pins
      // `nowMs` pins this too, or every run row it writes claims to have taken
      // however long ago the fixture epoch is.
      finishedAt: opts.nowMs === undefined ? Date.now() : opts.nowMs,
      status,
      errorMessage,
    });
  }

  return counters;
}

function fold(
  result: InfraMetricCollectionResult,
  counters: TargetCounters,
  region?: string | null,
): void {
  result.queriesIssued += counters.queriesIssued;
  result.metricsRequested += counters.metricsRequested;
  result.datapointsReturned += counters.datapointsReturned;
  result.pointsEnqueued += counters.pointsEnqueued;
  result.pointsDropped += counters.pointsDropped;
  result.throttles += counters.throttles;
  result.errors += counters.errors;
  // Accumulated per target rather than priced once from the tick's metric total,
  // because the rate is regional. A tick spanning us-east-1 and sa-east-1 has no
  // single price to multiply by.
  result.estimatedCostUsd += estimateGetMetricDataCostUsd(counters.metricsRequested, region);
}

/**
 * The level to run a project at, persisted, with an in-app notice on a change.
 *
 * The notice fires on the **transition**, never on the level — a "you are over
 * budget" toast every five minutes for the rest of the month teaches the
 * operator to dismiss the one that mattered. `recordCostDegradation` decides
 * whether the level is new inside its own write, so two ticks cannot both
 * announce the same transition.
 *
 * Fails open to `normal`. A guardrail whose bookkeeping throws must not be able
 * to take metric collection down with it — the ceiling exists to bound spend,
 * not to become a new way for the collector to stop working.
 */
function resolveDegradationFor(
  projectId: string,
  opts: InfraMetricCollectionOptions,
  nowMs: number,
): InfraCostDegradation {
  try {
    // Inside the guard, not ahead of it: `runInfraMetricCollection` is
    // documented as never throwing, and an injected resolver is no more
    // trustworthy than the store path it stands in for.
    if (opts.resolveDegradation) return opts.resolveDegradation(projectId);
    const { level, spend, config } = resolveProjectDegradation(projectId, nowMs);
    const { changed, previous } = recordCostDegradation(projectId, level, nowMs);
    if (changed) {
      const spent = spend.monthToDateUsd.toFixed(2);
      const ceiling = config.monthlyCeilingUsd?.toFixed(2) ?? 'none';
      console.warn(
        `[infra-metric-collector] ${projectId}: AWS API spend degradation ${previous} → ${level} ` +
          `($${spent} month-to-date against a $${ceiling} ceiling)`,
      );
      // Resource identifiers and dollar figures only — never the profile, the
      // account id, or anything else Admin-gated. A broadcast fans out to every
      // connected client of the project (decision INFRA-NOTIFY).
      opts.broadcast?.({
        type: 'infra_cost_degradation',
        projectId,
        level,
        previousLevel: previous,
        monthToDateUsd: spend.monthToDateUsd,
        monthlyCeilingUsd: config.monthlyCeilingUsd,
        changedAt: nowMs,
      });
    }
    return level;
  } catch (err) {
    console.warn(
      `[infra-metric-collector] ${projectId}: cost-ceiling check failed, collecting normally —`,
      err instanceof Error ? err.message : String(err),
    );
    return 'normal';
  }
}

/**
 * Run one metric-collection tick across every enabled scope.
 *
 * Never throws. A target that fails is counted, logged, and stepped over — same
 * contract as inventory sync, and for the same reason: one region with an
 * expired role must not cost every other region its telemetry. Targets run
 * sequentially, which also keeps a large deployment from fanning enough
 * concurrent `GetMetricData` calls at one account to throttle itself.
 */
export async function runInfraMetricCollection(
  opts: InfraMetricCollectionOptions = {},
): Promise<InfraMetricCollectionResult> {
  const result: InfraMetricCollectionResult = {
    targets: 0,
    collected: 0,
    failed: 0,
    queriesIssued: 0,
    metricsRequested: 0,
    datapointsReturned: 0,
    pointsEnqueued: 0,
    pointsDropped: 0,
    throttles: 0,
    errors: 0,
    estimatedCostUsd: 0,
    skipped: 0,
    degraded: { widened: 0, paused: 0 },
  };
  // Scheduled unconditionally at boot, but infra.db only exists once
  // initInfraDb() has run. A no-op beats a thrown tick.
  if (!isInfraDbInitialized()) return result;

  const targets = groupScopesIntoTargets(listCollectableScopes());
  result.targets = targets.length;
  const nowMs = opts.nowMs ?? Date.now();

  // Resolved once per project, not once per target: month-to-date spend is a
  // project-wide sum, so re-reading it for each of a project's regions would
  // issue the same aggregate query several times and — worse — let two targets
  // of one project act on different levels within a single tick.
  const levels = new Map<string, InfraCostDegradation>();
  for (const target of targets) {
    if (levels.has(target.projectId)) continue;
    levels.set(target.projectId, resolveDegradationFor(target.projectId, opts, nowMs));
  }
  for (const level of levels.values()) {
    if (level === 'widened') result.degraded.widened += 1;
    else if (level === 'paused') result.degraded.paused += 1;
  }

  for (const target of targets) {
    const degradation = levels.get(target.projectId) ?? 'normal';
    // A paused project is stepped over before a CloudWatch client exists, so
    // the pause costs nothing. No run row either: an audit row recording zero
    // spend every five minutes would bury the ticks that did spend.
    if (degradation === 'paused') {
      result.skipped += 1;
      continue;
    }
    try {
      fold(result, await collectTarget(target, opts, nowMs, degradation), target.region);
      result.collected += 1;
    } catch (err) {
      result.failed += 1;
      // The partial counters survive the failure: a target that throttled and
      // then failed still spent money, and a cost audit that forgets the spend
      // of failed ticks under-reports exactly when it matters most.
      const partial = (err as { counters?: TargetCounters }).counters;
      if (partial) fold(result, partial, target.region);
      else result.errors += 1;
      console.warn(
        `[infra-metric-collector] ${describeTarget(target)} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}
