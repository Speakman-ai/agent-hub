/**
 * ECS service pack — two namespaces, one of which the operator has to pay for.
 *
 * Every entry is traceable to the ECS developer guide's *Available metrics and
 * dimensions* page, the CloudWatch *Amazon ECS Container Insights metrics*
 * pages, and the CloudWatch *best practice alarm recommendations* page
 * (verified August 2026). Where they disagree with habit, the docs win.
 *
 * ECS is the first service where a pack has to answer two questions EC2 never
 * raised, and both shape the declarations below.
 *
 * **1. The same metric name means two different things at two dimension sets.**
 * `AWS/ECS` `CPUUtilization` on `ClusterName` is "how much of the cluster's EC2
 * capacity is in use"; on `ClusterName` + `ServiceName` it is "how much of its
 * own reservation this service is using, which can exceed 100%". They are
 * separate series with separate meanings, so they are separate declarations
 * with `dimensions` naming the exact set. The collector binds a metric to a
 * resource only on an exact dimension-set match, which is what keeps a cluster
 * row out of the service query and vice versa.
 *
 * **2. Most of what an operator wants is behind a paid feature.** Task counts,
 * per-service CPU/memory in absolute units, network and storage bytes and
 * restarts all live in `ECS/ContainerInsights`, which publishes nothing until
 * Container Insights is enabled and is then "charged as custom metrics" in the
 * operator's own account (AWS's wording, in a boxed Important). Those metrics
 * carry `requiresFeature: 'containerInsights'`, so the collector skips them for
 * a cluster that does not have it — no billed `GetMetricData` entry for a
 * series that cannot exist — and the UI says why the panel is empty instead of
 * rendering a blank chart.
 *
 * Four doc facts do most of the remaining work and are easy to get wrong:
 *
 *   - **Cluster-level utilization and reservation are EC2-launch-type only.**
 *     "These metrics are only available for clusters with tasks or services
 *     hosted on Amazon EC2 instances. They're not supported on clusters with
 *     tasks hosted on AWS Fargate." A Fargate-only cluster publishes nothing at
 *     `ClusterName`, which is why every cluster-keyed rule below treats missing
 *     data as not breaching.
 *   - **ECS stops publishing when a service has no running tasks.** "These
 *     metrics are collected for resources that have tasks in the `RUNNING`
 *     state. If a cluster, service, or other resource has no running tasks, no
 *     metrics will be reported for that resource during that period." A total
 *     outage is therefore a *gap*, not a zero — see the `RunningTaskCount` rule.
 *   - **`NetworkRxBytes` / `NetworkTxBytes` are a rate, not a total.** AWS
 *     publishes them with unit Bytes/Second despite the name, so they are
 *     gauges stored on `Average`. Summing them would produce a number with no
 *     unit at all.
 *   - **`RestartCount` is only collected for containers with a restart policy.**
 *     Most task definitions have none, so the metric is absent for most
 *     services rather than zero.
 *
 * On the cost projection: `projectMonthlyApiCost` prices a scope as (resources
 * × every metric in the pack), and this pack's metrics split between cluster
 * rows and service rows with most of them gated on a feature. The projection
 * therefore reads high for ECS — which is the direction `infra-cost.ts` states
 * it rounds in, and the safe one for a number whose job is to make an operator
 * think before saving. Making it exact needs the resource *composition* rather
 * than a count, which is a change to the projection's inputs, not to this pack.
 */

import type {
  InfraPackAlertRule,
  InfraPackFeature,
  InfraPackMetric,
  InfraServicePack,
} from './types.js';

/** The cluster-keyed series: one row per ECS cluster in inventory. */
const CLUSTER = Object.freeze(['ClusterName']);
/** The service-keyed series: one row per ECS service in inventory. */
const SERVICE = Object.freeze(['ClusterName', 'ServiceName']);

/** The feature key the `ECS/ContainerInsights` metrics are gated on. */
export const ECS_CONTAINER_INSIGHTS_FEATURE = 'containerInsights';

/**
 * Free namespace, published every minute with no opt-in. "Amazon ECS provides
 * free metrics for clusters and services."
 */
const ECS_NS = 'AWS/ECS';
/** Paid namespace, published only while Container Insights is on. */
const CI_NS = 'ECS/ContainerInsights';

/** Everything ECS publishes arrives at 1-minute resolution. */
const ONE_MINUTE = 60;

/** Published for every service, EC2 and Fargate alike. */
const UNIVERSAL = Object.freeze({ universal: true, condition: '' });

/**
 * Cluster-level utilization and reservation exist only where there are EC2
 * container instances to measure. AWS states it twice, once per doc page.
 */
const EC2_LAUNCH_TYPE_ONLY = Object.freeze({
  universal: false,
  condition:
    'Clusters running tasks on EC2 container instances. A Fargate-only cluster has no instance capacity to measure and publishes nothing here.',
});

/** AWS's documented "Useful statistics" for the percentage gauges. */
const GAUGE_STATS = Object.freeze(['Average', 'Minimum', 'Maximum']);
/** The documented list for the byte counters. */
const COUNTER_STATS = Object.freeze(['Sum', 'Average', 'Minimum', 'Maximum']);

/** One free `AWS/ECS` percentage gauge. */
function ecsGauge(
  metricName: string,
  dimensions: readonly string[],
  stat: string,
  appliesTo: InfraPackMetric['appliesTo'],
  description: string,
): InfraPackMetric {
  return {
    namespace: ECS_NS,
    metricName,
    dimensions,
    metricType: 'gauge',
    stat,
    validStatistics: GAUGE_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo,
    requiresFeature: null,
    description,
  };
}

/**
 * One Container Insights metric.
 *
 * Every one of these carries the feature gate, because the namespace itself is
 * what the setting turns on — there is no partially-enabled state where some of
 * them publish and others do not.
 */
function insights(
  metricName: string,
  dimensions: readonly string[],
  metricType: InfraPackMetric['metricType'],
  stat: string,
  description: string,
  appliesTo: InfraPackMetric['appliesTo'] = UNIVERSAL,
): InfraPackMetric {
  return {
    namespace: CI_NS,
    metricName,
    dimensions,
    metricType,
    stat,
    validStatistics: metricType === 'counter' ? COUNTER_STATS : GAUGE_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo,
    requiresFeature: ECS_CONTAINER_INSIGHTS_FEATURE,
    description,
  };
}

const ECS_PACK_METRICS: readonly InfraPackMetric[] = Object.freeze([
  // ── Free, cluster-keyed (AWS/ECS) ────────────────────────────────────────
  ecsGauge(
    'CPUUtilization',
    CLUSTER,
    'Average',
    EC2_LAUNCH_TYPE_ONLY,
    'Percentage of the cluster’s registered EC2 CPU capacity in use by running tasks.',
  ),
  ecsGauge(
    'MemoryUtilization',
    CLUSTER,
    'Average',
    EC2_LAUNCH_TYPE_ONLY,
    'Percentage of the cluster’s registered EC2 memory in use by running tasks.',
  ),
  ecsGauge(
    'CPUReservation',
    CLUSTER,
    'Average',
    EC2_LAUNCH_TYPE_ONLY,
    'Percentage of the cluster’s registered CPU that tasks have reserved. Reservation, not use — a cluster can be fully reserved and idle, and it still cannot place another task.',
  ),
  ecsGauge(
    'MemoryReservation',
    CLUSTER,
    'Average',
    EC2_LAUNCH_TYPE_ONLY,
    'Percentage of the cluster’s registered memory that tasks have reserved. This is what runs out first on most EC2 clusters, and what blocks a deployment from placing new tasks.',
  ),

  // ── Free, service-keyed (AWS/ECS) ────────────────────────────────────────
  ecsGauge(
    'CPUUtilization',
    SERVICE,
    'Average',
    UNIVERSAL,
    'Percentage of the CPU the service’s tasks reserved that they are actually using. Can exceed 100%: a task may burst past its reservation up to the task limit.',
  ),
  ecsGauge(
    'MemoryUtilization',
    SERVICE,
    'Average',
    UNIVERSAL,
    'Percentage of the memory the service’s tasks reserved that they are actually using. Supported on both EC2 and Fargate, unlike the cluster-level metric.',
  ),
  ecsGauge(
    'LiveTaskCount',
    SERVICE,
    // Minimum, not Average: the question this metric answers is "did the
    // service lose tasks", and a five-minute average of a fleet that dropped to
    // one task for a minute reports a number that never happened.
    'Minimum',
    UNIVERSAL,
    'Tasks in the ACTIVATING, RUNNING or DEACTIVATING state for the service. The only task count AWS publishes for free — the rest are Container Insights metrics.',
  ),

  // ── Container Insights, service-keyed ────────────────────────────────────
  insights(
    'RunningTaskCount',
    SERVICE,
    'gauge',
    // Same reasoning as LiveTaskCount: a trough that lasted one minute is the
    // event, and averaging it away is how an outage stops looking like one.
    'Minimum',
    'Tasks in the RUNNING state for the service. Nothing is published at all while the count is zero, so a total outage arrives as a gap rather than a 0.',
  ),
  insights(
    'DesiredTaskCount',
    SERVICE,
    'gauge',
    'Maximum',
    'Tasks the service is trying to run. Charted beside RunningTaskCount so the deficit is visible, though CloudWatch publishes no metric for the difference itself.',
  ),
  insights(
    'PendingTaskCount',
    SERVICE,
    'gauge',
    'Maximum',
    'Tasks the scheduler has accepted but not yet placed. A count that stays above zero is the observable form of "the service cannot reach its desired count".',
  ),
  insights(
    'CpuUtilized',
    SERVICE,
    'gauge',
    'Average',
    'CPU units the service’s tasks are using. Raw units, not a percentage — AWS publishes this one with no unit at all.',
  ),
  insights(
    'CpuReserved',
    SERVICE,
    'gauge',
    'Average',
    'CPU units the service’s tasks have reserved. The denominator for CpuUtilized.',
  ),
  insights(
    'MemoryUtilized',
    SERVICE,
    'gauge',
    'Average',
    'Memory the service’s tasks are using. Labelled Megabytes by AWS, but the values are MiB.',
  ),
  insights(
    'MemoryReserved',
    SERVICE,
    'gauge',
    'Average',
    'Memory the service’s tasks have reserved, in MiB. The denominator for MemoryUtilized.',
  ),
  insights(
    'EphemeralStorageUtilized',
    SERVICE,
    'gauge',
    // Maximum: a disk that filled up at any point in the period filled up, and
    // the average across the period is the number that hides it.
    'Maximum',
    'Ephemeral task storage in use, in GB.',
    Object.freeze({
      universal: false,
      condition: 'Tasks on Fargate platform version 1.4.0 or later.',
    }),
  ),
  insights(
    'EphemeralStorageReserved',
    SERVICE,
    'gauge',
    'Average',
    'Ephemeral task storage allocated, in GB. Without it EphemeralStorageUtilized is an absolute number with nothing to compare against.',
    Object.freeze({
      universal: false,
      condition: 'Tasks on Fargate platform version 1.4.0 or later.',
    }),
  ),
  insights(
    'NetworkRxBytes',
    SERVICE,
    // A gauge, despite the name: AWS publishes this with unit Bytes/Second, so
    // it is already a rate. Storing it on Sum would add rates together and
    // produce a figure with no meaning.
    'gauge',
    'Average',
    'Inbound network throughput for the service’s tasks, in bytes per second — a rate, not a total, despite the metric name.',
    Object.freeze({
      universal: false,
      condition: 'Tasks using the awsvpc or bridge network mode.',
    }),
  ),
  insights(
    'NetworkTxBytes',
    SERVICE,
    'gauge',
    'Average',
    'Outbound network throughput for the service’s tasks, in bytes per second. Same rate caveat as NetworkRxBytes.',
    Object.freeze({
      universal: false,
      condition: 'Tasks using the awsvpc or bridge network mode.',
    }),
  ),
  insights(
    'StorageReadBytes',
    SERVICE,
    'counter',
    'Sum',
    'Bytes the service’s tasks read from container storage during the period. A total, unlike the network metrics.',
  ),
  insights(
    'StorageWriteBytes',
    SERVICE,
    'counter',
    'Sum',
    'Bytes the service’s tasks wrote to container storage during the period.',
  ),
  insights(
    'RestartCount',
    SERVICE,
    'counter',
    'Sum',
    'Container restarts in the service during the period. Collected only for containers with a restart policy in the task definition, so it is absent — not zero — for everything else.',
    Object.freeze({
      universal: false,
      condition: 'Containers with a restart policy configured in the task definition.',
    }),
  ),

  // ── Container Insights, cluster-keyed ────────────────────────────────────
  insights(
    'TaskCount',
    CLUSTER,
    'gauge',
    'Average',
    'Tasks running in the cluster across every service and standalone task.',
  ),
  insights('ServiceCount', CLUSTER, 'gauge', 'Average', 'Services running in the cluster.'),
]);

/**
 * Container Insights, stated as what it is: an AWS-side paid feature we can
 * recommend but cannot enable, whose absence is the reason a panel is empty.
 */
const ECS_FEATURES: readonly InfraPackFeature[] = Object.freeze([
  {
    key: ECS_CONTAINER_INSIGHTS_FEATURE,
    label: 'Container Insights',
    whenOff:
      'The ECS/ContainerInsights metrics — task counts, absolute CPU and memory, ephemeral storage, network and storage bytes, container restarts — are not published for this cluster, so they are not collected and their charts would be empty. Enable it per cluster with `aws ecs update-cluster-settings --cluster <name> --settings name=containerInsights,value=enabled`, or account-wide with `put-account-setting`.',
    costNote:
      'AWS charges Container Insights metrics as CloudWatch custom metrics, and Container Insights also writes performance log events to a log group billed as ingestion and storage. Both land on your AWS bill, not on Agent Hub. Enhanced observability adds a per-task and per-container dimension to many of these series, multiplying the custom-metric count by task cardinality.',
    docsUrl:
      'https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cloudwatch-container-insights.html',
  },
]);

/**
 * The default rule pack (decision INFRA-ALERT).
 *
 * Templates only — nothing here is inserted into `infra_alert_rules` on its
 * own. Where AWS publishes a recommendation for ECS it is used verbatim, right
 * down to its uniform period 60 / 5 of 5 shape.
 *
 * The `treatMissingData` choices carry most of the weight, because ECS is a
 * service where absence is the normal state for a majority of series: a
 * Fargate-only cluster never publishes the cluster-keyed metrics, a service
 * with no restart policy never publishes `RestartCount`, and every Container
 * Insights series is absent until an operator pays for it. Under the default
 * `missing` treatment each of those would sit in INSUFFICIENT_DATA forever,
 * which teaches operators that the state column is noise.
 */
const ECS_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  {
    name: 'ECS service has no running tasks',
    description: 'The service has been down to zero running tasks for five minutes.',
    namespace: CI_NS,
    metricName: 'RunningTaskCount',
    // AWS's recommendation says Average. Minimum at the same 60s period is the
    // identical number — there is one datapoint per period — and stays correct
    // when the evaluator reads a coarser tier, where an Average would dilute a
    // one-minute outage into a passing score.
    stat: 'Minimum',
    dimensions: SERVICE,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'LessThanOrEqualToThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    // Not `breaching`, despite ECS publishing nothing while a service is at
    // zero tasks. A rule with no `resourceKey` matches every ECS resource in
    // the project, including cluster rows and services in clusters without
    // Container Insights, none of which ever publish this series — under
    // `breaching` every one of them would page immediately. Pin the rule to one
    // service and switch to `breaching` to catch the total-outage gap.
    treatMissingData: 'missing',
    severity: 'critical',
    rationale:
      'AWS best-practice alarm: RunningTaskCount, threshold 0, LESS_THAN_OR_EQUAL_TO_THRESHOLD, period 60, 5 of 5. The doc\'s own justification: "If the running task count is 0, the Amazon ECS service will be unavailable." Statistic tightened from Average to Minimum so a coarser evaluation period cannot average an outage away.',
  },
  {
    name: 'ECS service cannot place tasks',
    description: 'Tasks have been stuck pending for five minutes.',
    namespace: CI_NS,
    metricName: 'PendingTaskCount',
    stat: 'Maximum',
    dimensions: SERVICE,
    periodS: 60,
    threshold: 1,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    // The overwhelming majority of services have nothing pending and publish
    // nothing here; `missing` would park all of them in INSUFFICIENT_DATA.
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'No AWS-published alarm exists for this metric. It is the evaluable half of a running-versus-desired deficit: CloudWatch publishes RunningTaskCount and DesiredTaskCount as separate series and no metric for the difference, so the deficit itself needs a metric-math expression, which this rule model does not evaluate. Tasks that stay pending for five minutes are the scheduler telling you it cannot reach the desired count.',
  },
  {
    name: 'ECS cluster memory reservation saturated',
    description: 'Tasks have reserved over 80% of the cluster’s memory for five minutes.',
    namespace: ECS_NS,
    metricName: 'MemoryReservation',
    stat: 'Average',
    dimensions: CLUSTER,
    periodS: 60,
    threshold: 80,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    // Cluster reservation is EC2-launch-type only. A Fargate-only cluster
    // publishes nothing, and `missing` would leave it alarming-adjacent forever.
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'AWS best-practice alarm, verbatim: Average, threshold 80, GREATER_THAN_THRESHOLD, period 60, 5 of 5. "Set the threshold for memory reservation to 80%." Reservation rather than utilization because reservation is what stops the scheduler placing the next task, whether or not the memory is being used.',
  },
  {
    name: 'ECS cluster CPU reservation saturated',
    description: 'Tasks have reserved over 80% of the cluster’s CPU for five minutes.',
    namespace: ECS_NS,
    metricName: 'CPUReservation',
    stat: 'Average',
    dimensions: CLUSTER,
    periodS: 60,
    threshold: 80,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'AWS best-practice alarm, verbatim: Average, threshold 80, GREATER_THAN_THRESHOLD, period 60, 5 of 5. "Set the threshold for CPU reservation to 80%. Alternatively, you can choose a lower value based on cluster characteristics."',
  },
  {
    name: 'ECS container restarts',
    description: 'A container in the service restarted.',
    namespace: CI_NS,
    metricName: 'RestartCount',
    stat: 'Sum',
    dimensions: SERVICE,
    periodS: 60,
    threshold: 1,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    // 1 of 1, not the 5 of 5 the other rules use. RestartCount is a per-period
    // count, so requiring five consecutive breaching periods would demand a
    // restart every minute for five minutes and miss the single crash-loop
    // restart that is the whole signal.
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    // Collected only for containers with a restart policy configured, so most
    // services publish nothing at all here.
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'No AWS-published alarm exists for this metric. AWS documents it as "The number of times a container in an Amazon ECS task has been restarted", collected per period, so any non-zero value is a restart that happened rather than a level to be sustained.',
  },
  {
    name: 'ECS service CPU saturated',
    description: 'The service has used over 80% of its reserved CPU for five minutes.',
    namespace: ECS_NS,
    metricName: 'CPUUtilization',
    stat: 'Average',
    dimensions: SERVICE,
    periodS: 60,
    threshold: 80,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS best-practice alarm, verbatim: Average, threshold 80, GREATER_THAN_THRESHOLD, period 60, 5 of 5. "Set the threshold to about 80-85%." Note the service-level metric can exceed 100% — a task may burst past its reservation — so this is a saturation warning, not a ceiling.',
  },
  {
    name: 'ECS service memory saturated',
    description: 'The service has used over 80% of its reserved memory for five minutes.',
    namespace: ECS_NS,
    metricName: 'MemoryUtilization',
    stat: 'Average',
    dimensions: SERVICE,
    periodS: 60,
    threshold: 80,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS best-practice alarm, verbatim: Average, threshold 80, GREATER_THAN_THRESHOLD, period 60, 5 of 5. "Set the threshold to about 80%." A task that reaches its memory hard limit is killed by the agent, so this one leads somewhere concrete.',
  },
]);

/** The ECS pack. */
export const ECS_PACK: InfraServicePack = Object.freeze({
  service: 'ecs',
  label: 'ECS',
  metrics: ECS_PACK_METRICS,
  dimensions: Object.freeze([
    {
      name: 'ClusterName',
      detailedMonitoringOnly: false,
      description:
        'One cluster. Every ECS metric is filtered by it, and it is the whole dimension set for the cluster-level series.',
    },
    {
      name: 'ServiceName',
      detailedMonitoringOnly: false,
      description:
        'One service within a cluster, always paired with ClusterName. Daemon metrics use a `daemon:` prefix on the value.',
    },
    {
      name: 'TaskDefinitionFamily',
      detailedMonitoringOnly: false,
      description:
        'Container Insights metrics grouped by task definition family instead of by service. Not collected: inventory is keyed on clusters and services, and a family series would duplicate spend on the same numbers.',
    },
    {
      name: 'TaskId',
      detailedMonitoringOnly: false,
      description:
        'Per-task series, published only with Container Insights enhanced observability. Not collected: task ids churn on every deployment, so the series count grows without bound and each one is a billed custom metric.',
    },
  ]),
  features: ECS_FEATURES,
  absentMetrics: Object.freeze([
    {
      label: 'Running-versus-desired task deficit',
      reason:
        'CloudWatch publishes RunningTaskCount and DesiredTaskCount as two separate series and nothing for the difference. Alarming on the deficit itself requires a metric-math expression, which this rule engine does not evaluate.',
      remedy:
        'Use the two shipped rules instead: "ECS service has no running tasks" catches a total outage, and "ECS service cannot place tasks" catches the scheduler failing to reach the desired count. Both series are also charted side by side on the Metrics tab.',
    },
    {
      label: 'Per-container and per-task metrics',
      reason:
        'Container-level CPU, memory, network and health status, and per-task percentages, are published only with Container Insights enhanced observability.',
      remedy:
        'Set the cluster setting to `enhanced` rather than `enabled`. Agent Hub does not collect the per-task series even then: task ids change on every deployment, and each new series is a separately billed custom metric.',
    },
    {
      label: 'Cluster CPU and memory on a Fargate-only cluster',
      reason:
        'Cluster-level utilization and reservation measure registered EC2 container instances. A cluster whose tasks all run on Fargate has none, so AWS publishes nothing at the cluster dimension.',
      remedy:
        'Use the service-level CPUUtilization and MemoryUtilization metrics, which are supported on both EC2 and Fargate.',
    },
    {
      label: 'EC2 container-instance filesystem and CPU (instance_* metrics)',
      reason:
        'These are published by a CloudWatch agent deployed onto the container instances themselves, not by the cluster setting. Turning Container Insights on does not produce them.',
      remedy:
        'Deploy the CloudWatch agent to the cluster as a daemon service. It publishes to ECS/ContainerInsights as custom metrics, billed in your account.',
    },
  ]),
  defaultAlertRules: ECS_DEFAULT_ALERT_RULES,
});
