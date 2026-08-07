/**
 * Service pack vocabulary — the shape every per-service pack under this
 * directory declares itself in.
 *
 * `service-metric-packs.ts` already answered "what does the collector ask
 * CloudWatch for". A pack answers three more questions that the collector does
 * not care about but an operator staring at an empty chart very much does:
 *
 *   - **Is this statistic even legal for this metric?** CloudWatch will happily
 *     return a `Sum` of `EBSIOBalance%` and the number is meaningless — AWS
 *     documents that the statistic "is not applicable". Recording the
 *     documented statistic list next to the one we store makes that a testable
 *     property instead of a comment.
 *   - **Does this metric exist for this instance at all?** Several `AWS/EC2`
 *     metrics are published only under basic monitoring, only for Nitro
 *     instances, or only for burstable families. A chart that is empty because
 *     the metric structurally cannot exist reads identically to a chart that is
 *     empty because collection is broken, unless something says so.
 *   - **What is deliberately missing, and why?** Memory and disk-usage are the
 *     two metrics every operator looks for first and neither exists from the
 *     hypervisor. Saying that plainly is cheaper than fielding the question.
 *
 * Packs are pure data with no IO and no DB handle, so they are safe to import
 * from a route, the collector, or a test with equal cost.
 */

/**
 * What a metric measures, which is what decides the statistic we store it on.
 *
 * This is not the same question as {@link InfraPackMetric.validStatistics}.
 * That field records what AWS documents as *meaningful*; this one records what
 * the value *is*, and the pack test uses it to reject a statistic that is legal
 * but wrong — averaging a 0/1 failure flag across a 5-minute period dilutes a
 * real failure to `0.2`, and CloudWatch will not stop you.
 */
export type InfraMetricType =
  /** An instantaneous level (CPU percent). Averaging is meaningful; summing is not. */
  | 'gauge'
  /** A total accrued during the period (bytes, operations). `Sum` is the answer. */
  | 'counter'
  /** A per-minute 0/1 check result. `Maximum` so one failing minute survives aggregation. */
  | 'flag'
  /** Remaining credit in a burst bucket. Only the low-water mark matters. */
  | 'balance'
  /**
   * A per-request duration, which is a *distribution* rather than a level.
   *
   * Separate from `gauge` because the summary that answers a question about it
   * is usually not the mean. AWS makes the point itself, on the page that
   * documents ALB `TargetResponseTime`: an app serving most requests from cache
   * in 1-2 ms and the rest in 100-200 ms has a maximum of ~200 ms and an
   * average that "doesn't indicate the distribution of the data". So this is
   * the one metric type where a percentile statistic is legal — see
   * {@link isStatisticValidForMetricType}.
   */
  | 'latency';

/**
 * The named statistics a metric of each type is stored on.
 *
 * Deliberately narrow — one entry per type for `flag` and `counter`, because
 * there is exactly one defensible answer. `gauge`, `balance` and `latency`
 * allow the spread because "how high did it get" and "how low did it get" are
 * both real questions about the same series.
 *
 * Not the whole answer for `latency`: percentiles are legal there too and there
 * are infinitely many of them, so the membership test is
 * {@link isStatisticValidForMetricType} rather than a lookup in this table.
 */
export const STATISTICS_BY_METRIC_TYPE: Readonly<Record<InfraMetricType, readonly string[]>> =
  Object.freeze({
    gauge: Object.freeze(['Average', 'Minimum', 'Maximum']),
    counter: Object.freeze(['Sum']),
    flag: Object.freeze(['Maximum']),
    balance: Object.freeze(['Minimum', 'Maximum']),
    latency: Object.freeze(['Average', 'Minimum', 'Maximum']),
  });

/**
 * AWS's own notation for "any percentile", used verbatim in
 * {@link InfraPackMetric.validStatistics} where the docs print it.
 *
 * The ALB metrics page lists `TargetResponseTime`'s useful statistics as
 * "`Average` and `pNN.NN` (percentiles)" — it names no specific percentile
 * because every one of them is legal. Recording that token rather than guessing
 * a list keeps `validStatistics` a transcription of the docs instead of an
 * interpretation of them, and {@link isStatisticDocumented} expands it.
 */
export const PERCENTILE_STATISTIC_TOKEN = 'pNN.NN';

/**
 * CloudWatch's percentile statistic syntax: `p` then 0-100, up to two decimals.
 *
 * "You can specify any percentile, using up to two decimal places (for example,
 * p95.45)." The upper bound is spelled separately because `p100` has three
 * digits where every other legal value has one or two.
 */
const PERCENTILE_STATISTIC = /^p(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/;

/** Whether a statistic string is a CloudWatch percentile such as `p99` or `p95.45`. */
export function isPercentileStatistic(stat: string): boolean {
  return PERCENTILE_STATISTIC.test(stat);
}

/**
 * Metric types whose value is a distribution, so a percentile of it means
 * something.
 *
 * A percentile of a `counter` is nonsense (the 99th percentile of a per-period
 * total is a statement about the periods, not the thing being counted), and a
 * percentile of a `flag` is a diluted 0/1. Gating on the type is what stops a
 * future pack storing `p99` of `StatusCheckFailed` and calling it monitoring.
 */
const PERCENTILE_METRIC_TYPES: ReadonlySet<InfraMetricType> = new Set<InfraMetricType>(['latency']);

/** Whether this statistic is one the metric's *type* can meaningfully be stored on. */
export function isStatisticValidForMetricType(metricType: InfraMetricType, stat: string): boolean {
  if (STATISTICS_BY_METRIC_TYPE[metricType].includes(stat)) return true;
  return PERCENTILE_METRIC_TYPES.has(metricType) && isPercentileStatistic(stat);
}

/**
 * Whether the metric's stored statistic is one AWS documents as meaningful
 * for it, expanding {@link PERCENTILE_STATISTIC_TOKEN} to any percentile.
 *
 * The sibling of {@link isStatisticValidForMetricType}: that one asks whether
 * the statistic suits the *kind* of value, this one asks whether AWS says the
 * statistic is meaningful for this specific metric. Both have to hold.
 */
export function isStatisticDocumented(metric: InfraPackMetric): boolean {
  if (metric.validStatistics.includes(metric.stat)) return true;
  return (
    metric.validStatistics.includes(PERCENTILE_STATISTIC_TOKEN) &&
    isPercentileStatistic(metric.stat)
  );
}

/**
 * Which EC2 monitoring mode publishes a metric at all.
 *
 * Basic (5-minute) monitoring is the default and free; detailed (1-minute) is a
 * paid per-instance opt-in. Most metrics exist under both and only change
 * resolution, but a handful genuinely exist under one and not the other —
 * `EBSIOBalance%` is documented as "available for basic monitoring only", so
 * turning detailed monitoring on makes that chart go blank, which is the
 * opposite of what an operator paying for it expects.
 */
export type InfraMonitoringAvailability = 'either' | 'basic-only' | 'detailed-only';

/**
 * Which resources within the service publish this metric.
 *
 * We cannot check this at collection time — `infra_resources` records the
 * instance id, not its type or hypervisor generation — so this is documentation
 * the UI renders rather than a filter the collector applies. An inapplicable
 * metric costs a `GetMetricData` entry and returns an empty series; INFRA-COST
 * makes that visible in the projection rather than hiding it.
 */
export interface InfraMetricApplicability {
  /** `true` when every resource in the service publishes it. */
  universal: boolean;
  /** Rendered next to the metric when `universal` is false. Empty when it is. */
  condition: string;
}

/**
 * A paid or opt-in provider feature a metric depends on.
 *
 * Distinct from {@link InfraMetricApplicability}, which describes resources
 * that structurally cannot publish a metric. A feature is something the
 * operator can turn on and be billed for, so the honest UI answer is not "this
 * does not exist" but "this exists, it is off, and here is what switching it on
 * costs you". ECS Container Insights is the first of these; EC2 detailed
 * monitoring is the obvious second.
 *
 * The `key` is matched against the flags inventory sync records per resource,
 * so a metric gated on a feature is never *requested* for a resource that does
 * not have it — an empty chart with an explanation is cheaper than an empty
 * chart with a bill.
 */
export interface InfraPackFeature {
  /** Matched against the resource's recorded feature flags, e.g. `containerInsights`. */
  key: string;
  label: string;
  /** What is unavailable while it is off. Operator-facing, one or two sentences. */
  whenOff: string;
  /** What turning it on costs. AWS bills this in the operator's account, not ours. */
  costNote: string;
  /** AWS's own page for the feature, so the cost claim is checkable. */
  docsUrl: string;
}

/** One metric a pack declares, with everything needed to explain it. */
export interface InfraPackMetric {
  /** CloudWatch namespace, e.g. `AWS/EC2`. */
  namespace: string;
  metricName: string;
  /**
   * The **exact** dimension-name set this series is keyed on, e.g.
   * `['InstanceId']` or `['ClusterName', 'ServiceName']`.
   *
   * Exact, not a subset: CloudWatch treats every dimension combination as its
   * own series, so `AWS/ECS` `CPUUtilization` on `ClusterName` and the same
   * metric on `ClusterName` + `ServiceName` are two different numbers
   * measuring two different things. The collector binds a metric to a resource
   * only when the resource's recorded dimensions are exactly this set, which is
   * what keeps an ECS cluster row from being billed for the service-level query
   * and vice versa.
   */
  dimensions: readonly string[];
  /**
   * Dimension **values** this series is additionally pinned to, when the
   * dimension names alone do not identify it.
   *
   * Absent for almost every metric, because a dimension set normally is the
   * identity: `InstanceId` takes whatever value the instance has. S3 is the
   * exception that forces the field. `AWS/S3` `BucketSizeBytes` and
   * `NumberOfObjects` are both keyed on `BucketName` + `StorageType`, but AWS
   * documents `NumberOfObjects`' only valid storage-type filter as
   * `AllStorageTypes`, and `AllStorageTypes` is not among `BucketSizeBytes`'
   * filters. The two metrics live at the same dimension *names* and at disjoint
   * dimension *values*.
   *
   * Without this, a `StandardStorage` row would be billed a `GetMetricData`
   * entry for an object count that does not exist there, and the
   * `AllStorageTypes` row one for a byte total that does not exist there — two
   * permanently empty charts per bucket, which is exactly the "empty because
   * broken or empty because impossible?" ambiguity these packs exist to remove.
   *
   * The collector treats a mismatch as "this metric does not apply to this
   * resource", identically to a dimension-name mismatch. See
   * `bindMetricDimensions`.
   */
  dimensionValues?: Readonly<Record<string, string>>;
  metricType: InfraMetricType;
  /** The statistic the collector requests and the store keys on. */
  stat: string;
  /** Every statistic AWS documents as meaningful for this metric, verbatim. */
  validStatistics: readonly string[];
  /** The metric's publication floor. Never request a period below it. */
  minPeriodSeconds: number;
  availability: InfraMonitoringAvailability;
  appliesTo: InfraMetricApplicability;
  /**
   * The {@link InfraPackFeature} key this metric needs, or `null` when it is
   * published unconditionally.
   *
   * A gated metric is skipped entirely for a resource whose flags do not carry
   * the feature. That is a cost decision as much as a correctness one: every
   * `GetMetricData` entry is billed whether or not the series exists.
   */
  requiresFeature: string | null;
  /**
   * True when this series is computed by the Hub rather than fetched from
   * CloudWatch. Absent means false, which is the case for every metric AWS
   * actually publishes.
   *
   * A pack is the catalog of every series that exists for a service — that is
   * what the Metrics tab and the alert rule editor read — but not every such
   * series is something to ask CloudWatch for. Service quota utilization is the
   * case that forces the distinction: AWS documents it as the metric-math
   * expression `m1/SERVICE_QUOTA(m1)*100`, and our collector emits
   * `MetricStat`-only queries, so the percentage is derived Hub-side from a
   * collected usage metric and a quota limit read from Service Quotas.
   *
   * Declaring it here rather than inventing a parallel catalog is what lets a
   * derived series be charted and alarmed on by the existing machinery. The one
   * thing it must not do is reach the collector: a `GetMetricData` entry for a
   * namespace AWS does not publish is billed and returns nothing forever, so
   * {@link INFRA_SERVICE_METRIC_PACKS} filters these out.
   *
   * Whoever writes the derived points owns keeping them consistent with the
   * declaration here — same namespace, metric name, stat and dimension set —
   * because nothing downstream can tell a Hub-written point from a collected
   * one, which is exactly what makes charts and alerts work unchanged.
   */
  derived?: boolean;
  /** One line, operator-facing. Rendered beside the metric in the chart picker. */
  description: string;
}

/** A dimension the service's metrics can be sliced by. */
export interface InfraPackDimension {
  name: string;
  /**
   * `true` when the dimension is only populated for instances with detailed
   * monitoring enabled. Slicing by it on a basic-monitoring fleet returns
   * nothing at all, which looks like a broken query.
   */
  detailedMonitoringOnly: boolean;
  description: string;
}

/**
 * A metric an operator will look for and not find, with the reason.
 *
 * These are not failures. They are structural absences, and stating them is the
 * only way an empty Metrics tab is distinguishable from a broken one.
 */
export interface InfraPackAbsentMetric {
  /** What the operator was looking for, in their words ("Memory utilization"). */
  label: string;
  /** Why it is not here. Plain language, no AWS jargon where avoidable. */
  reason: string;
  /** How to get it, when there is a way. `null` when there is none. */
  remedy: string | null;
}

/**
 * A rule the pack recommends for the service, in `InfraAlertRuleInput` terms.
 *
 * Templates, not rows: nothing here is written to `infra_alert_rules` on its
 * own. They exist so the rule editor can offer AWS's published guidance instead
 * of a blank form, and so "what should I alarm on" has an answer that is not a
 * round number somebody liked.
 */
export interface InfraPackAlertRule {
  /** Stable within the pack. Used as the rule name when an operator applies it. */
  name: string;
  description: string;
  namespace: string;
  metricName: string;
  stat: string;
  /**
   * The dimension set of the series this rule evaluates, matching one of the
   * pack's metric declarations.
   *
   * Not redundant with `metricName`: a pack may declare the same metric at two
   * levels — `AWS/ECS` `CPUUtilization` is one number for a cluster and another
   * for a service — and a rule that named only the metric would be ambiguous
   * about which of the two 80% means anything for.
   */
  dimensions: readonly string[];
  periodS: number;
  threshold: number;
  comparisonOperator:
    | 'GreaterThanOrEqualToThreshold'
    | 'GreaterThanThreshold'
    | 'LessThanThreshold'
    | 'LessThanOrEqualToThreshold';
  evaluationPeriods: number;
  datapointsToAlarm: number;
  treatMissingData: 'missing' | 'notBreaching' | 'breaching' | 'ignore';
  severity: 'critical' | 'warning' | 'info';
  /** Where the numbers come from. Cited so a reviewer can check them. */
  rationale: string;
}

/** Everything one service declares. */
export interface InfraServicePack {
  /** Scope-allowlist service token, e.g. `ec2`. */
  service: string;
  /** Display name for the UI, e.g. `EC2`. */
  label: string;
  metrics: readonly InfraPackMetric[];
  dimensions: readonly InfraPackDimension[];
  absentMetrics: readonly InfraPackAbsentMetric[];
  /** Opt-in provider features this service's metrics are gated on. Often empty. */
  features: readonly InfraPackFeature[];
  defaultAlertRules: readonly InfraPackAlertRule[];
}
