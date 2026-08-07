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
  /**
   * The exact dimension-name set the series is keyed on, e.g. `['InstanceId']`
   * or `['ClusterName', 'ServiceName']`. The collector binds it to a resource
   * only when the resource's own recorded dimensions are this same set.
   */
  dimensions: readonly string[];
  /**
   * Dimension values the series is additionally pinned to, when the dimension
   * names alone do not identify it. Absent for almost every metric; see
   * {@link InfraPackMetric.dimensionValues} for the S3 case that forces it.
   */
  dimensionValues?: Readonly<Record<string, string>>;
  /** Provider feature the resource must have for this metric to exist, or `null`. */
  requiresFeature: string | null;
  /**
   * The shortest period this metric is actually published at. The collector
   * never requests a period below this even when the retention tier would
   * allow one.
   */
  minPeriodSeconds: number;
}

/** The collector's fields, taken from a pack metric declaration. */
function toMetricSpec(metric: InfraPackMetric): InfraMetricSpec {
  return {
    namespace: metric.namespace,
    metricName: metric.metricName,
    stat: metric.stat,
    dimensions: metric.dimensions,
    dimensionValues: metric.dimensionValues,
    requiresFeature: metric.requiresFeature,
    minPeriodSeconds: metric.minPeriodSeconds,
  };
}

/**
 * Service token → the metrics the collector requests for each of its resources.
 *
 * Derived metrics are filtered out here, and this is the only place that
 * filtering happens. A derived series (see {@link InfraPackMetric.derived}) is a
 * real series that the Hub computes — quota utilization is the case in hand —
 * so it belongs in the pack catalog the Metrics tab and rule editor read, but
 * asking CloudWatch for it would bill a `GetMetricData` entry against a
 * namespace AWS does not publish and return nothing, every tick, forever.
 */
export const INFRA_SERVICE_METRIC_PACKS: Readonly<Record<string, readonly InfraMetricSpec[]>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(INFRA_SERVICE_PACKS).map(([service, pack]) => [
        service,
        Object.freeze(pack.metrics.filter((m) => !m.derived).map(toMetricSpec)),
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
  // ECS publishes everything — free and Container Insights alike — at 1-minute
  // resolution with no paid opt-in, so there is no reason to ask for less. The
  // collector tick raises this to its own cadence anyway; the 60 records what
  // the service deserves if the tick ever gets finer.
  ecs: 60,
  // The three networking services are INFRA-COST's named 1-minute class ("ALB,
  // NAT … can be tight"), and all three publish at 60s: ELB "measures and sends
  // its metrics in 60-second intervals", and "NAT gateway metrics are sent to
  // CloudWatch at 1-minute intervals". Asking for less would stale a signal
  // whose whole value is catching a target going unhealthy or a port pool
  // running dry before the next deploy does.
  alb: 60,
  nlb: 60,
  natgw: 60,
  // RDS is named in INFRA-COST's 1-minute class, and unlike EC2 it needs no
  // qualification: AWS "automatically sends metric data to CloudWatch in
  // 1-minute periods" for every RDS metric, with no basic-vs-detailed split and
  // no per-instance opt-in to pay for. So the tier and every metric's own floor
  // agree at 60, and the only thing raising the effective interval is the
  // collector tick.
  rds: 60,
  // Lambda publishes everything at 1-minute resolution — "Lambda sends metric
  // data to CloudWatch in 1-minute intervals" — and charges nothing for it:
  // "there's no additional charge for these metrics". The whole cost of
  // monitoring Lambda is our own GetMetricData bill, which is a function of how
  // many series the pack declares rather than of this tier.
  lambda: 60,
  // S3 is deliberately not in INFRA-COST's 1-minute class, and the entry is
  // here to record that rather than to change anything: 300 is the default and
  // also the collector tick, so it is the finest cadence anything can run at.
  // The interesting number for S3 is per-metric, not per-service — the daily
  // storage metrics floor at 86,400s and are polled once a day, while the paid
  // request metrics publish every minute and are polled every tick. A single
  // service tier could serve neither.
  s3: 300,
  // AWS/Usage is published at 1-minute resolution for every service that
  // publishes it at all, so 60 is both the tier and every metric's floor.
  //
  // Worth being explicit about the cost, because "quotas" sounds like something
  // that changes slowly and therefore could be polled rarely. The two things
  // being watched here do not: a ThrottleCount is a rate that is only visible
  // in the minute it happened, and the resource counts this catches are the
  // ones that move fast enough to surprise you — an autoscaling group climbing
  // toward a vCPU quota gets there in minutes, and a 5-minute poll would find
  // out about it up to four minutes after the launches started failing.
  //
  // The bill is small and bounded because the population is: one billed metric
  // per quota per tick, and only quotas that carry a UsageMetric are ever
  // inventoried, which is a few dozen rather than the thousands of rows a
  // resource-bearing service produces.
  quota: 60,
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
