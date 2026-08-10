/**
 * infra-fleet.ts — the read behind the fleet dashboard.
 *
 * The Metrics tab answers "show me this one series on this one resource", which
 * is the right shape for investigating something and the wrong shape for
 * noticing it. Answering "is anything wrong" through that surface costs a click
 * per resource and another per metric, so nobody does it and the module gets
 * used as an inventory list instead.
 *
 * This assembles the opposite read: every compute resource in scope, each
 * carrying its two or three headline series already resolved to a latest value
 * and a sparkline, in a fixed number of SQL scans — one per distinct series,
 * not one per resource per series. That bound is the reason this module exists
 * rather than a loop over the existing single-series readers.
 */

import {
  listInfraResources,
  type InfraResourceListQuery,
  type InfraResourceRow,
} from './infra-resource-store.js';
import { queryInfraSparklines, type InfraSparklinePoint } from './infra-metric-store.js';
import { aggregationForStat } from './infra-metric-read.js';
import {
  headlineMetricsForResource,
  INFRA_FLEET_SERVICES,
  type InfraHeadlineMetric,
  type InfraHeadlineUnit,
} from './headline-metrics.js';

/** Resources rendered on one dashboard before the caller has to narrow. */
export const DEFAULT_FLEET_LIMIT = 60;
/** Hard ceiling. Beyond this a dashboard is a list, and a list is the browser. */
export const MAX_FLEET_LIMIT = 200;

/** Sparkline points per tile. Wide enough to read a trend, not a chart. */
export const FLEET_SPARKLINE_POINTS = 48;

/** Default dashboard window. Long enough to show a shape, short enough to be now. */
export const DEFAULT_FLEET_WINDOW_MS = 3 * 60 * 60 * 1000;
export const MIN_FLEET_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FLEET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface InfraFleetQuery {
  projectId: string;
  /** Defaults to {@link INFRA_FLEET_SERVICES}. Unknown tokens contribute nothing. */
  services?: readonly string[];
  region?: string;
  environment?: string;
  /** Drop rows not described since this epoch ms — the "still exists" filter. */
  seenSinceMs?: number;
  windowMs?: number;
  limit?: number;
  /** Injectable for tests; the route passes nothing and gets the wall clock. */
  nowMs?: number;
}

/** One headline series, resolved for one resource. */
export interface InfraFleetMetric {
  metricName: string;
  namespace: string;
  stat: string;
  label: string;
  unit: InfraHeadlineUnit;
  description: string;
  /**
   * Most recent bucket value, or null when the series reported nothing in the
   * window. Null is a real answer — "collected, nothing came back" — and is
   * rendered differently from a zero.
   */
  latest: number | null;
  /** Wall-clock of {@link latest}, null when there is none. */
  latestTsMs: number | null;
  min: number | null;
  max: number | null;
  points: readonly InfraSparklinePoint[];
}

export interface InfraFleetResource {
  resourceKey: string;
  service: string;
  resourceId: string;
  name: string | null;
  region: string;
  accountId: string;
  environment: string | null;
  state: string | null;
  lastSeen: number;
  /**
   * The resource's CloudWatch dimension map and detected paid features.
   *
   * Carried so a card can hand the Metrics tab everything it needs to open a
   * full chart — the availability notices there are keyed on both — without a
   * second fetch of the row the dashboard already read.
   */
  metricDimensions: Record<string, unknown> | null;
  features: Record<string, unknown> | null;
  metrics: readonly InfraFleetMetric[];
}

export interface InfraFleetPage {
  fromMs: number;
  toMs: number;
  bucketSeconds: number;
  services: readonly string[];
  resources: readonly InfraFleetResource[];
  /** More resources matched than `limit`. The caller narrows or opens Resources. */
  truncated: boolean;
}

function clampWindow(windowMs: number | undefined): number {
  if (windowMs == null || !Number.isFinite(windowMs)) return DEFAULT_FLEET_WINDOW_MS;
  return Math.min(MAX_FLEET_WINDOW_MS, Math.max(MIN_FLEET_WINDOW_MS, Math.floor(windowMs)));
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_FLEET_LIMIT;
  return Math.min(MAX_FLEET_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Bucket width for a window, so a tile always holds about the same number of
 * points however wide the window is. Floored at the collector's finest tier —
 * a bucket narrower than the storage period holds at most one point and just
 * makes the line jagged with no extra information in it.
 */
export function fleetBucketSeconds(windowMs: number): number {
  return Math.max(60, Math.floor(windowMs / 1000 / FLEET_SPARKLINE_POINTS));
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Operator- and third-party-controlled text (decision INFRA-WIZARD). A row
    // whose JSON does not parse degrades to "no dimensions recorded", which the
    // headline resolver already handles, rather than failing the whole page.
    return {};
  }
}

function booleanFlags(raw: string | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parseJsonObject(raw))) {
    if (value === true) out[key] = true;
  }
  return out;
}

/** Stable identity of a series, used to collapse the per-series scans. */
function seriesId(metric: InfraHeadlineMetric): string {
  return `${metric.namespace}|${metric.metricName}|${metric.stat}`;
}

/** The response's self-description: what was asked for, after clamping. */
export interface InfraFleetEnvelope {
  fromMs: number;
  toMs: number;
  bucketSeconds: number;
  services: readonly string[];
}

/**
 * Resolve a request into the window, bucket width and service list the answer
 * is stated in.
 *
 * Extracted so the empty response and the populated one cannot disagree. They
 * did: the route's uninitialised-database branch hard-coded `bucketSeconds: 60`
 * and a fixed default window, so a client that asked for 24 hours was told the
 * bucket width was 60s and the window was 3h purely because the infra database
 * had never been opened. `bucketSeconds` is documented as *the width this
 * response's points are bucketed at*, and a field that means something
 * different depending on server-side storage state is not a contract.
 */
export function fleetEnvelope(
  query: Pick<InfraFleetQuery, 'services' | 'windowMs' | 'nowMs'>,
): InfraFleetEnvelope {
  const nowMs = query.nowMs ?? Date.now();
  const windowMs = clampWindow(query.windowMs);
  return {
    fromMs: nowMs - windowMs,
    toMs: nowMs,
    bucketSeconds: fleetBucketSeconds(windowMs),
    services: (query.services?.length ? query.services : INFRA_FLEET_SERVICES).filter((service) =>
      INFRA_FLEET_SERVICES.includes(service),
    ),
  };
}

/**
 * A fleet page with nothing in it, stated in the same terms a populated one
 * would be. For the callers that know there is nothing to read — an infra
 * database that was never opened — without having to restate the envelope.
 */
export function emptyInfraFleet(
  query: Pick<InfraFleetQuery, 'services' | 'windowMs' | 'nowMs'>,
): InfraFleetPage {
  return { ...fleetEnvelope(query), resources: [], truncated: false };
}

/**
 * One page of the fleet, resources and their headline series together.
 *
 * Scan count is `distinct series`, which is bounded by the headline catalog
 * (currently eight across the three services) and does not grow with the number
 * of resources on the page. That is the whole point: the previous surface cost
 * one HTTP request and one scan per resource per metric.
 */
export function buildInfraFleet(query: InfraFleetQuery): InfraFleetPage {
  const { fromMs, toMs: nowMs, bucketSeconds, services } = fleetEnvelope(query);
  const limit = clampLimit(query.limit);

  // One list read per service rather than one with an `IN`: the store's list
  // query takes a scalar `service`, and widening it would change a filter the
  // Resources browser and its facets share. Three cheap keyset reads beat a
  // shared-surface change nobody else asked for.
  const rows: InfraResourceRow[] = [];
  let truncated = false;
  for (const service of services) {
    const listQuery: InfraResourceListQuery = {
      projectId: query.projectId,
      service,
      region: query.region,
      environment: query.environment,
      seenSinceMs: query.seenSinceMs,
      // Over-fetch by one so "there are more" is known without a COUNT.
      limit: limit + 1,
    };
    const page = listInfraResources(listQuery);
    if (page.resources.length > limit) {
      truncated = true;
      page.resources.length = limit;
    }
    rows.push(...page.resources);
  }

  // Most-recently-described first, matching the browser, then bounded. A
  // dashboard whose card order changed between two services would read as
  // grouped by service, which it deliberately is not.
  rows.sort((a, b) => b.last_seen - a.last_seen || (a.resource_key < b.resource_key ? 1 : -1));
  if (rows.length > limit) {
    truncated = true;
    rows.length = limit;
  }

  const perResourceMetrics = new Map<string, readonly InfraHeadlineMetric[]>();
  const batches = new Map<string, { metric: InfraHeadlineMetric; resourceKeys: string[] }>();
  for (const row of rows) {
    const dimensionNames = Object.keys(parseJsonObject(row.metric_dimensions_json));
    const metrics = headlineMetricsForResource(
      row.service,
      dimensionNames,
      booleanFlags(row.features_json),
    );
    perResourceMetrics.set(row.resource_key, metrics);
    for (const metric of metrics) {
      const id = seriesId(metric);
      const batch = batches.get(id);
      if (batch) batch.resourceKeys.push(row.resource_key);
      else batches.set(id, { metric, resourceKeys: [row.resource_key] });
    }
  }

  const seriesPoints = new Map<string, Map<string, InfraSparklinePoint[]>>();
  for (const [id, batch] of batches) {
    seriesPoints.set(
      id,
      queryInfraSparklines({
        projectId: query.projectId,
        resourceKeys: batch.resourceKeys,
        namespace: batch.metric.namespace,
        metricName: batch.metric.metricName,
        stat: batch.metric.stat,
        startMs: fromMs,
        endMs: nowMs,
        bucketSeconds,
        maxPointsPerResource: FLEET_SPARKLINE_POINTS,
        aggregate: aggregationForStat(batch.metric.stat),
      }),
    );
  }

  const resources: InfraFleetResource[] = rows.map((row) => ({
    resourceKey: row.resource_key,
    service: row.service,
    resourceId: row.resource_id,
    name: row.name,
    region: row.region,
    accountId: row.account_id,
    environment: row.environment,
    state: row.state,
    lastSeen: row.last_seen,
    metricDimensions: row.metric_dimensions_json
      ? parseJsonObject(row.metric_dimensions_json)
      : null,
    features: row.features_json ? parseJsonObject(row.features_json) : null,
    metrics: (perResourceMetrics.get(row.resource_key) ?? []).map((metric) => {
      const points = seriesPoints.get(seriesId(metric))?.get(row.resource_key) ?? [];
      const values = points.map((p) => p.value);
      const last = points.length > 0 ? points[points.length - 1] : null;
      return {
        metricName: metric.metricName,
        namespace: metric.namespace,
        stat: metric.stat,
        label: metric.label,
        unit: metric.unit,
        description: metric.description,
        latest: last ? last.value : null,
        latestTsMs: last ? last.tsMs : null,
        min: values.length > 0 ? Math.min(...values) : null,
        max: values.length > 0 ? Math.max(...values) : null,
        points,
      };
    }),
  }));

  return { fromMs, toMs: nowMs, bucketSeconds, services, resources, truncated };
}
