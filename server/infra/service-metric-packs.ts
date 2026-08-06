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
 * Adding a service is adding an entry to {@link INFRA_SERVICE_METRIC_PACKS};
 * the collector picks it up with no further wiring, and a service with no pack
 * is simply not collected.
 */

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

/**
 * EC2 (`AWS/EC2`, dimension `InstanceId`).
 *
 * The split between 60s and 300s entries is the documented one, not a guess:
 * status check metrics are "available at a 1-minute frequency at no charge",
 * while everything else follows the monitoring mode — "by default, each data
 * point covers the 5 minutes that follow the start time of activity for the
 * instance. If you've enabled detailed monitoring, each data point covers the
 * next minute". We floor at the *basic* rate because detailed monitoring is a
 * paid, per-instance opt-in we cannot detect from the describe call and must
 * not assume on the operator's behalf (INFRA-COST surfaces it as a
 * recommendation instead).
 *
 * `DiskRead*` / `DiskWrite*` are deliberately absent: those are instance-store
 * metrics, so on the EBS-only instance types most fleets run they report 0 or
 * nothing at all, and a chart of a metric that structurally cannot have data is
 * worse than no chart.
 */
const EC2_METRICS: readonly InfraMetricSpec[] = [
  {
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    stat: 'Average',
    dimension: 'InstanceId',
    minPeriodSeconds: 300,
  },
  // Maximum, not Average: these are 0/1 flags, and averaging a single failed
  // minute across a 5-minute period dilutes it to 0.2 — a real failure that no
  // longer looks like one.
  {
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed',
    stat: 'Maximum',
    dimension: 'InstanceId',
    minPeriodSeconds: 60,
  },
  {
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed_Instance',
    stat: 'Maximum',
    dimension: 'InstanceId',
    minPeriodSeconds: 60,
  },
  {
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed_System',
    stat: 'Maximum',
    dimension: 'InstanceId',
    minPeriodSeconds: 60,
  },
  // Sum, because the published value is bytes *during the period*; averaging it
  // answers a question nobody asked.
  {
    namespace: 'AWS/EC2',
    metricName: 'NetworkIn',
    stat: 'Sum',
    dimension: 'InstanceId',
    minPeriodSeconds: 300,
  },
  {
    namespace: 'AWS/EC2',
    metricName: 'NetworkOut',
    stat: 'Sum',
    dimension: 'InstanceId',
    minPeriodSeconds: 300,
  },
];

/** Service token → the metrics the collector requests for each of its resources. */
export const INFRA_SERVICE_METRIC_PACKS: Readonly<Record<string, readonly InfraMetricSpec[]>> =
  Object.freeze({
    ec2: EC2_METRICS,
  });

/** The pack for a service, or an empty list when the service has none yet. */
export function getServiceMetricPack(service: string): readonly InfraMetricSpec[] {
  return INFRA_SERVICE_METRIC_PACKS[service] ?? [];
}

/** Service tokens the collector knows how to query. */
export function collectableServices(): string[] {
  return Object.keys(INFRA_SERVICE_METRIC_PACKS).sort();
}
