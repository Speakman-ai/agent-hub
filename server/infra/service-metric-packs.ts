/**
 * Per-service metric packs — what the collector asks CloudWatch for, per
 * resource, for each service in an operator's scope allowlist.
 *
 * This is the query-side sibling of the alert rule packs (decision
 * INFRA-ALERT): the same "encode AWS's published guidance rather than round
 * numbers" rule applies, and every entry below is traceable to the service's
 * own CloudWatch metrics documentation rather than to habit.
 *
 * Two fields carry the non-obvious weight:
 *
 *   - **`stat`** is part of the stored series key, so a metric polled on two
 *     statistics is two series. Each entry names the one statistic that metric
 *     is actually meaningful on, which is why `StatusCheckFailed` is `Maximum`
 *     (a 0/1 flag where any failure inside the period must survive
 *     aggregation) and `CPUUtilization` is `Average`.
 *   - **`minPeriodSeconds`** is the metric's emission floor, and it exists
 *     because of decision INFRA-COST: "Poll intervals are tiered per service,
 *     not global … 5-minute-class (base EC2 CPU under basic monitoring) cannot
 *     go below their emission rate." Asking for a 60s period on a metric
 *     published every 5 minutes does not produce 1-minute data — it produces a
 *     60s-tier series that is empty for four buckets out of five, which reads
 *     as a gap to the alert evaluator and stores a resolution we never had.
 *
 * Adding a service is adding a file under `packs/` and one line to
 * {@link INFRA_SERVICE_PACKS}; the collector picks it up with no further
 * wiring, and a service with no pack is simply not collected.
 *
 * The declarations themselves live in `packs/` — this module is the collector's
 * narrow view of them. A pack carries what an operator needs (documented
 * statistics, monitoring-mode availability, which instances publish a metric at
 * all, what is structurally absent and why); the collector needs five of those
 * fields and none of the prose, so {@link toMetricSpec} projects the pack down
 * to exactly that. Keeping the projection one-way means an explanatory field
 * can be added to a pack without touching the query path.
 */

import { INFRA_SERVICE_PACKS, type InfraPackMetric } from './packs/index.js';

/** One metric the collector requests per in-scope resource. */
export interface InfraMetricSpec {
  /** CloudWatch namespace, e.g. `AWS/EC2`. */
  namespace: string;
  metricName: string;
  /** CloudWatch statistic ('Average', 'Maximum', 'Sum', 'p99', …). */
  stat: string;
  /** Dimension name the resource's own id binds to, e.g. `InstanceId`. */
  dimension: string;
  /**
   * The shortest period this metric is actually published at. The collector
   * never requests a period below this even when the retention tier would
   * allow one.
   */
  minPeriodSeconds: number;
}

/** The collector's five fields, taken from a pack metric declaration. */
function toMetricSpec(metric: InfraPackMetric): InfraMetricSpec {
  return {
    namespace: metric.namespace,
    metricName: metric.metricName,
    stat: metric.stat,
    dimension: metric.dimension,
    minPeriodSeconds: metric.minPeriodSeconds,
  };
}

/** Service token → the metrics the collector requests for each of its resources. */
export const INFRA_SERVICE_METRIC_PACKS: Readonly<Record<string, readonly InfraMetricSpec[]>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(INFRA_SERVICE_PACKS).map(([service, pack]) => [
        service,
        Object.freeze(pack.metrics.map(toMetricSpec)),
      ]),
    ),
  );

/** The pack for a service, or an empty list when the service has none yet. */
export function getServiceMetricPack(service: string): readonly InfraMetricSpec[] {
  return INFRA_SERVICE_METRIC_PACKS[service] ?? [];
}

/** Service tokens the collector knows how to query. */
export function collectableServices(): string[] {
  return Object.keys(INFRA_SERVICE_METRIC_PACKS).sort();
}

/**
 * How often the collector *wants* to ask each service for data, before the
 * per-metric emission floor is applied.
 *
 * This is the "tiered per service, not global" half of decision INFRA-COST. The
 * tier expresses appetite — how fresh this service's signals need to be — and is
 * always the weaker of the two constraints, because
 * {@link effectiveServicePollIntervalSeconds} raises it to the metric's own
 * `minPeriodSeconds`. A tier can therefore never cause over-polling; it can only
 * ask for *less* than the emission rate allows.
 *
 * A service with no entry falls back to {@link DEFAULT_SERVICE_POLL_INTERVAL_S},
 * so adding a metric pack without a tier is safe rather than unbounded.
 *
 * A tier finer than the collector's own tick cadence cannot be honoured — the
 * tick is the shortest interval anything can be requested at — so the cost
 * projection and the collector both raise it to the tick interval as well. The
 * tier below is therefore a statement of what the service *deserves*, not a
 * promise about what fires today.
 */
export const DEFAULT_SERVICE_POLL_INTERVAL_S = 300;

export const INFRA_SERVICE_POLL_TIERS: Readonly<Record<string, number>> = Object.freeze({
  // EC2 carries both classes at once, which is exactly why the floor is
  // per-metric and not per-service: status checks are published every minute at
  // no charge, while CPU/network under basic monitoring are published every five
  // minutes. A single service-level number could only serve one of them, and
  // whichever it served would either stale the status checks or bill four
  // wasted requests out of five for CPU.
  ec2: 60,
});

/** The tier for a service, or the default when it has none. */
export function servicePollTierSeconds(service: string): number {
  return INFRA_SERVICE_POLL_TIERS[service] ?? DEFAULT_SERVICE_POLL_INTERVAL_S;
}

/**
 * How often this one metric is actually worth requesting: the service's tier,
 * floored at the metric's own publication rate.
 *
 * The floor is the load-bearing half. `GetMetricData` bills per metric
 * *requested*, not per datapoint returned, so asking for a 5-minute metric every
 * minute costs five times as much and returns the same series — four of every
 * five requests are billed for data that does not exist yet. Flooring at
 * `minPeriodSeconds` is what makes "no 1-minute polling of 5-minute
 * basic-monitoring metrics, no frequent polling of S3 daily storage metrics" a
 * property of the code rather than of whoever last edited the tier table.
 */
export function effectiveServicePollIntervalSeconds(
  service: string,
  spec: InfraMetricSpec,
): number {
  return Math.max(servicePollTierSeconds(service), spec.minPeriodSeconds);
}
