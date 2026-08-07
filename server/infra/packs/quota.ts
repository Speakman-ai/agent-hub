/**
 * Service quota headroom — the `AWS/Usage` metric pack.
 *
 * The failure mode this exists for is the one where nothing is down and you
 * still cannot launch anything: the account has run out of a quota. No
 * per-service alarm fires, because no service is unhealthy.
 *
 * Facts verified against AWS documentation in August 2026:
 *
 *   - Usage metrics are published in `AWS/Usage` at 1-minute resolution, with
 *     the dimensions `Service`, `Class`, `Type` and `Resource`. The documented
 *     metric names are `CallCount`, `ResourceCount` and `ThrottleCount`.
 *     https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Usage-Metrics.html
 *   - Utilization is `m1/SERVICE_QUOTA(m1)*100`, alarmed static Greater than 80.
 *     https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Quotas-Visualize-Alarms.html
 *
 * ## A quota is inventoried as a resource
 *
 * `infra_resources` rows for this pack are quotas, not machines, minted by
 * `quota-sync.ts` from `ListServiceQuotas`. Only quotas that carry a
 * `UsageMetric` become rows — that field is absent for the large majority of
 * quotas, which is ordinary rather than an error.
 *
 * Modelling a quota as a resource is what buys scoping, retention, charting and
 * CloudWatch-parity alert evaluation with no parallel implementation of any of
 * them. It works because `AWS/Usage` has exactly one dimension-name set for the
 * whole namespace, and a pack metric must declare exactly one.
 *
 * ## Why each metric is gated on a feature
 *
 * A quota's `UsageMetric` names **one** metric. But all three declarations
 * below share the same dimension set, so `bindMetricDimensions` would bind all
 * three to every quota resource — and every `GetMetricData` entry is billed
 * whether or not the series exists. A `ResourceCount` quota would be charged
 * for two queries that return nothing, every tick, forever.
 *
 * The feature-gate mechanism already does exactly the right thing here (skip
 * the metric for a resource whose flags do not carry it, fail closed when
 * unrecorded), so each metric is gated on a `usage:<MetricName>` flag that
 * `quota-sync.ts` records from the quota's own `UsageMetric`. The flags describe
 * which metric AWS publishes for the quota rather than a paid AWS feature,
 * which is the one way this pack's features read differently from ECS Container
 * Insights or S3 request metrics.
 */

import {
  DEFAULT_QUOTA_UTILIZATION_THRESHOLD,
  QUOTA_SERVICE_TOKEN,
  QUOTA_USAGE_DIMENSIONS,
  QUOTA_USAGE_NAMESPACE,
  QUOTA_USAGE_PERIOD_SECONDS,
  QUOTA_UTILIZATION_EXPRESSION,
} from '../quota-catalog.js';
import type {
  InfraPackAlertRule,
  InfraPackDimension,
  InfraPackFeature,
  InfraPackMetric,
  InfraServicePack,
} from './types.js';

/** Namespace for series the Hub derives; deliberately not an `AWS/` name. */
export const QUOTA_DERIVED_NAMESPACE = 'AgentHub/ServiceQuotas';

/** The derived utilization series, in percent of the applied quota. */
export const QUOTA_UTILIZATION_METRIC_NAME = 'QuotaUtilization';

/**
 * Statistic the derived utilization series is stored on.
 *
 * One utilization value is computed per collected usage datapoint, so within a
 * 1-minute period `Maximum` is that value exactly. Naming it `Maximum` rather
 * than mirroring the underlying usage statistic keeps the derived series on one
 * statistic regardless of whether it came from a `Sum` of calls or a `Maximum`
 * of resources — the percentage means the same thing either way, and a series
 * whose stat varied per quota could not carry a single default alert rule.
 */
export const QUOTA_UTILIZATION_STAT = 'Maximum';

/** `features_json` flag marking which usage metric a quota publishes. */
export function quotaUsageFeatureKey(metricName: string): string {
  return `usage:${metricName}`;
}

const USAGE_METRICS_DOC =
  'https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Usage-Metrics.html';

/**
 * Every quota row publishes exactly one of the three usage metrics, so no
 * single one of them is universal across the service's resources.
 */
const ONE_PER_QUOTA = Object.freeze({
  universal: false,
  condition: 'the quota’s UsageMetric names this metric; each quota names exactly one',
});

const UNIVERSAL = Object.freeze({ universal: true, condition: '' });

function usageFeature(metricName: string): InfraPackFeature {
  return Object.freeze({
    key: quotaUsageFeatureKey(metricName),
    label: `${metricName} usage metric`,
    whenOff: `This quota does not publish ${metricName}; Service Quotas named a different usage metric for it, so the series does not exist and is not queried.`,
    costNote:
      'None. This flag records which usage metric AWS publishes for the quota, not a paid AWS feature to turn on. It exists so a quota is not billed for GetMetricData entries that could only ever return nothing.',
    docsUrl: USAGE_METRICS_DOC,
  });
}

const QUOTA_FEATURES: readonly InfraPackFeature[] = Object.freeze([
  usageFeature('CallCount'),
  usageFeature('ResourceCount'),
  usageFeature('ThrottleCount'),
]);

const QUOTA_METRICS: readonly InfraPackMetric[] = Object.freeze([
  // ── Collected from CloudWatch ────────────────────────────────────
  Object.freeze({
    namespace: QUOTA_USAGE_NAMESPACE,
    metricName: 'ResourceCount',
    dimensions: QUOTA_USAGE_DIMENSIONS,
    metricType: 'gauge',
    // A level, not a rate: the count of things that exist right now. Maximum is
    // what AWS recommends for resource counts and is the only safe choice for a
    // headroom question — an Average across the period would smooth away the
    // peak that is precisely the moment you could not launch.
    stat: 'Maximum',
    validStatistics: Object.freeze(['Average', 'Minimum', 'Maximum', 'Sum', 'SampleCount']),
    minPeriodSeconds: QUOTA_USAGE_PERIOD_SECONDS,
    availability: 'either',
    appliesTo: ONE_PER_QUOTA,
    requiresFeature: quotaUsageFeatureKey('ResourceCount'),
    description:
      'How many of the quota’s resource exist right now (vCPUs, VPCs, tables). Compared against the applied quota to give headroom.',
  }),
  Object.freeze({
    namespace: QUOTA_USAGE_NAMESPACE,
    metricName: 'CallCount',
    dimensions: QUOTA_USAGE_DIMENSIONS,
    metricType: 'counter',
    // A rate: calls that happened during the period. Sum is the only statistic
    // that answers "how many", which is what a rate quota is expressed in.
    stat: 'Sum',
    validStatistics: Object.freeze(['Sum', 'Average', 'Minimum', 'Maximum', 'SampleCount']),
    minPeriodSeconds: QUOTA_USAGE_PERIOD_SECONDS,
    availability: 'either',
    appliesTo: ONE_PER_QUOTA,
    requiresFeature: quotaUsageFeatureKey('CallCount'),
    description:
      'API calls made against the quota in the period. The Resource dimension names the operation being counted.',
  }),
  Object.freeze({
    namespace: QUOTA_USAGE_NAMESPACE,
    metricName: 'ThrottleCount',
    dimensions: QUOTA_USAGE_DIMENSIONS,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: Object.freeze(['Sum', 'Average', 'Minimum', 'Maximum', 'SampleCount']),
    minPeriodSeconds: QUOTA_USAGE_PERIOD_SECONDS,
    availability: 'either',
    appliesTo: ONE_PER_QUOTA,
    requiresFeature: quotaUsageFeatureKey('ThrottleCount'),
    description:
      'Calls AWS rejected for exceeding the rate quota. Unlike the other two this is not headroom, it is the quota already being hit.',
  }),

  // ── Derived by the Hub ───────────────────────────────────────────
  Object.freeze({
    namespace: QUOTA_DERIVED_NAMESPACE,
    metricName: QUOTA_UTILIZATION_METRIC_NAME,
    dimensions: QUOTA_USAGE_DIMENSIONS,
    metricType: 'gauge',
    stat: QUOTA_UTILIZATION_STAT,
    validStatistics: Object.freeze(['Average', 'Minimum', 'Maximum']),
    minPeriodSeconds: QUOTA_USAGE_PERIOD_SECONDS,
    availability: 'either',
    // Every quota that reached inventory has both a usage metric and an applied
    // quota value, so utilization is defined for all of them.
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    derived: true,
    description: `Usage as a percentage of the applied quota, computed as AWS documents it (${QUOTA_UTILIZATION_EXPRESSION}) with the quota value read from ListServiceQuotas. Not fetched from CloudWatch.`,
  }),
]);

const QUOTA_DIMENSIONS: readonly InfraPackDimension[] = Object.freeze([
  Object.freeze({
    name: 'Service',
    detailedMonitoringOnly: false,
    description:
      'The AWS service the quota belongs to, as CloudWatch spells it (e.g. "EC2"). Not always the Service Quotas ServiceCode.',
  }),
  Object.freeze({
    name: 'Class',
    detailedMonitoringOnly: false,
    description:
      'The class of resource being tracked, e.g. "Standard/OnDemand" for EC2 vCPUs. API usage metrics use "None".',
  }),
  Object.freeze({
    name: 'Type',
    detailedMonitoringOnly: false,
    description:
      'What kind of thing is counted — "Resource" for a count of things, "API" for calls.',
  }),
  Object.freeze({
    name: 'Resource',
    detailedMonitoringOnly: false,
    description:
      'The specific resource or API operation being tracked, e.g. "vCPU" or the operation name for a CallCount.',
  }),
]);

const QUOTA_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  Object.freeze({
    name: 'Quota utilization above 80%',
    description:
      'Usage has passed 80% of the applied quota, which is where AWS’s own console walkthrough puts the alarm.',
    namespace: QUOTA_DERIVED_NAMESPACE,
    metricName: QUOTA_UTILIZATION_METRIC_NAME,
    stat: QUOTA_UTILIZATION_STAT,
    dimensions: QUOTA_USAGE_DIMENSIONS,
    periodS: QUOTA_USAGE_PERIOD_SECONDS,
    threshold: DEFAULT_QUOTA_UTILIZATION_THRESHOLD,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 3,
    // Utilization is only undefined when we could not read the quota or the
    // usage. That is "we do not know", which is what INSUFFICIENT_DATA means,
    // and treating it as notBreaching would report healthy headroom we never
    // measured.
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS documents the expression m1/SERVICE_QUOTA(m1)*100 with a static threshold of Greater than 80. Evaluated 3-of-5 on 1-minute data rather than on a single datapoint because usage counts are republished each minute and a lone spike near the line is not yet a capacity problem; three minutes inside five is. Warning rather than critical because 80% is a lead indicator — there is still headroom, and the point is to request an increase before there is not.',
  }),
  Object.freeze({
    name: 'Quota throttling',
    description: 'AWS is rejecting calls for exceeding this rate quota.',
    namespace: QUOTA_USAGE_NAMESPACE,
    metricName: 'ThrottleCount',
    stat: 'Sum',
    dimensions: QUOTA_USAGE_DIMENSIONS,
    periodS: QUOTA_USAGE_PERIOD_SECONDS,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 3,
    // AWS/Usage publishes ThrottleCount only when a throttle happened, so a
    // period with no datapoint is a period with no throttling. Treating it as
    // missing would leave a healthy account permanently INSUFFICIENT_DATA.
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'Any throttle is a rate quota already being enforced, so the threshold is 0 rather than a round number. 3-of-5 rather than 1-of-1 because a single throttled call is normal backoff behaviour in most SDKs and pages nobody usefully; sustained throttling is the signal. notBreaching is required because the metric is absent, not zero, when nothing is throttled.',
  }),
]);

export const QUOTA_PACK: InfraServicePack = Object.freeze({
  service: QUOTA_SERVICE_TOKEN,
  label: 'Service Quotas',
  metrics: QUOTA_METRICS,
  dimensions: QUOTA_DIMENSIONS,
  features: QUOTA_FEATURES,
  absentMetrics: Object.freeze([
    Object.freeze({
      label: 'Quotas for services that publish no usage metrics',
      reason:
        'Only around 17 AWS services integrate usage metrics with Service Quotas, and within those, most individual quotas still carry no UsageMetric. A quota with no UsageMetric has nothing in CloudWatch to measure it, so it cannot be given headroom at any price.',
      remedy:
        'None available to us. The applied quota value is still readable via ListServiceQuotas, but current usage is not published anywhere, so utilization is undefined rather than zero.',
    }),
    Object.freeze({
      label: 'Quotas applied per-resource rather than per-account',
      reason:
        'ListServiceQuotas returns account-level quotas by default. Resource-level quotas (QuotaAppliedAtLevel RESOURCE) key on a resource context that AWS/Usage dimensions do not carry, so a usage series cannot be matched to the right applied value.',
      remedy:
        'Sync requests account-level quotas explicitly rather than ALL, so a resource-level quota is never inventoried with an account-level limit it would be measured wrongly against.',
    }),
    Object.freeze({
      label: 'Utilization as a CloudWatch metric-math series',
      reason:
        'SERVICE_QUOTA() is a metric-math function. Our collector emits MetricStat-only queries because an expression result carries no namespace, metric name or dimensions and infra_metric_points requires all three. AWS also does not document SERVICE_QUOTA as supported cross-account, which is the shape a monitoring role has.',
      remedy:
        'Utilization is derived Hub-side with the same arithmetic, substituting the ListServiceQuotas applied value for SERVICE_QUOTA(m1). This additionally yields absolute headroom (limit minus usage), which the metric-math form cannot express.',
    }),
    Object.freeze({
      label: 'Sub-minute quota usage',
      reason:
        'AWS/Usage is published at 1-minute resolution. A burst that exhausts a rate quota inside a single minute is visible only as that minute’s aggregate.',
      remedy: null,
    }),
  ]),
  defaultAlertRules: QUOTA_DEFAULT_ALERT_RULES,
});
