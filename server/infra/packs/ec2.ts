/**
 * EC2 service pack (`AWS/EC2`, dimension `InstanceId`).
 *
 * Every entry below is traceable to the *CloudWatch metrics that are available
 * for your instances* page of the EC2 user guide (verified August 2026), and
 * the thresholds to the CloudWatch *best practice alarm recommendations* page.
 * Where the two disagree with habit, the docs win — that is the whole point of
 * decision INFRA-ALERT's "encode AWS's own published guidance rather than round
 * numbers".
 *
 * Three doc facts do most of the work here and are easy to get wrong:
 *
 *   - **Status checks are free at 1-minute resolution.** "By default, status
 *     check metrics are available at a 1-minute frequency at no charge." They
 *     do not require detailed monitoring, which is why the highest-value EC2
 *     signal is also the cheapest one and why the default alarm lives on it.
 *   - **`EBSIOBalance%` / `EBSByteBalance%` are basic-monitoring-only, and
 *     `Sum` is not applicable to them.** AWS states both outright. A pack that
 *     stored them on `Sum` would produce a chart that is arithmetically valid
 *     and semantically meaningless.
 *   - **CPU credit metrics are 5-minute-only.** "CPU credit metrics are
 *     available at a 5-minute frequency only" — no amount of detailed
 *     monitoring makes `CPUCreditBalance` a 1-minute series.
 *
 * On metrics that do not apply to every instance: `infra_resources` records an
 * instance id, not an instance type or hypervisor generation, so the collector
 * cannot prune a T-family-only metric from an m5's query list. Those metrics
 * are declared with an `appliesTo` condition the UI renders and are still
 * requested — an inapplicable metric returns an empty series and costs one
 * `GetMetricData` entry, which INFRA-COST surfaces in the pre-save projection
 * rather than hiding. Pruning them needs an instance-type column on the
 * inventory row, which is a separate change.
 */

import type { InfraPackAlertRule, InfraPackMetric, InfraServicePack } from './types.js';

/**
 * Every `AWS/EC2` metric here is keyed on the instance alone. The fleet-wide
 * dimensions (`AutoScalingGroupName`, `ImageId`, `InstanceType`) are declared
 * on the pack for the UI to explain, but nothing is collected on them: an
 * inventory row is one instance, and a per-ASG series would be billed once per
 * member of the group for the same number.
 */
const INSTANCE_ID = Object.freeze(['InstanceId']);

/** Every instance publishes it, whatever the family or hypervisor. */
const UNIVERSAL = Object.freeze({ universal: true, condition: '' });

/**
 * "Additional Amazon EBS metrics for volumes that are attached to Nitro-based
 * instances that are not bare metal instances." Current-generation families are
 * all Nitro, so this is the common case rather than the exception.
 */
const NITRO_ONLY = Object.freeze({
  universal: false,
  condition: 'Nitro-based instances only, excluding bare metal.',
});

/**
 * "Available only for some `*.4xlarge` instance sizes and smaller that burst to
 * their maximum performance for only 30 minutes at least once every 24 hours."
 */
const EBS_BURST_ONLY = Object.freeze({
  universal: false,
  condition:
    'Instances with an EBS burst bucket — some *.4xlarge sizes and smaller. Larger instances have sustained performance and publish nothing here.',
});

/** Burstable performance (T-family) instances only. */
const BURSTABLE_ONLY = Object.freeze({
  universal: false,
  condition: 'Burstable performance (T-family) instances only.',
});

/** AWS's documented "Meaningful statistics" for the status check metrics. Note: no `Sum`. */
const STATUS_CHECK_STATS = Object.freeze(['Average', 'Minimum', 'Maximum']);
/** The documented list for the byte/operation counters. */
const COUNTER_STATS = Object.freeze(['Sum', 'Average', 'Minimum', 'Maximum']);

/**
 * One status check metric. All four share every field but the name and the
 * scope of what they check, and writing them out four times invites a typo in
 * the one field that must not drift (`stat`).
 */
function statusCheck(
  metricName: string,
  description: string,
  appliesTo: InfraPackMetric['appliesTo'] = UNIVERSAL,
): InfraPackMetric {
  return {
    namespace: 'AWS/EC2',
    metricName,
    dimensions: INSTANCE_ID,
    metricType: 'flag',
    // Maximum, not Average: these are 0/1 per-minute flags, and averaging one
    // failed minute across a 5-minute period reports 0.2 — a real failure that
    // no longer looks like one.
    stat: 'Maximum',
    validStatistics: STATUS_CHECK_STATS,
    minPeriodSeconds: 60,
    availability: 'either',
    appliesTo,
    requiresFeature: null,
    description,
  };
}

/** One of the four Nitro EBS byte/operation counters. */
function ebsCounter(metricName: string, description: string): InfraPackMetric {
  return {
    namespace: 'AWS/EC2',
    metricName,
    dimensions: INSTANCE_ID,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: COUNTER_STATS,
    // EBS I/O counters follow the instance's monitoring mode; we floor at the
    // basic rate because detailed monitoring is a paid opt-in we cannot detect
    // from the describe call and must not assume on the operator's behalf.
    minPeriodSeconds: 300,
    availability: 'either',
    appliesTo: NITRO_ONLY,
    requiresFeature: null,
    description,
  };
}

/**
 * One of the two EBS burst-bucket balances.
 *
 * `Minimum` because the question is "how close to empty did the bucket get" —
 * an average across a period hides the trough that actually throttled the
 * workload. `Sum` is absent from `validStatistics` because AWS says it "is not
 * applicable to this metric", not because we chose to leave it out.
 */
function ebsBalance(metricName: string, description: string): InfraPackMetric {
  return {
    namespace: 'AWS/EC2',
    metricName,
    dimensions: INSTANCE_ID,
    metricType: 'balance',
    stat: 'Minimum',
    validStatistics: Object.freeze(['Minimum', 'Maximum']),
    minPeriodSeconds: 300,
    // "This metric is available for basic monitoring only." Enabling detailed
    // monitoring does not upgrade this series, it removes it.
    availability: 'basic-only',
    appliesTo: EBS_BURST_ONLY,
    requiresFeature: null,
    description,
  };
}

const EC2_PACK_METRICS: readonly InfraPackMetric[] = Object.freeze([
  {
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: INSTANCE_ID,
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: Object.freeze(['Average', 'Minimum', 'Maximum']),
    minPeriodSeconds: 300,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Percentage of physical CPU time the instance used. Guest and hypervisor time combined, so it can differ from what top reports inside the instance.',
  },

  statusCheck(
    'StatusCheckFailed',
    'Whether the instance failed any status check in the last minute. 0 passed, 1 failed.',
  ),
  statusCheck(
    'StatusCheckFailed_Instance',
    'Whether the instance status check failed — a problem inside the instance, such as an exhausted file system or a kernel that will not boot.',
  ),
  statusCheck(
    'StatusCheckFailed_System',
    'Whether the system status check failed — a problem with the underlying AWS host or network that only AWS can fix.',
  ),
  statusCheck(
    'StatusCheckFailed_AttachedEBS',
    'Whether the attached EBS volumes are reachable and able to complete I/O. Detects storage-subsystem and connectivity faults the other two checks miss.',
    NITRO_ONLY,
  ),

  {
    namespace: 'AWS/EC2',
    metricName: 'NetworkIn',
    dimensions: INSTANCE_ID,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: COUNTER_STATS,
    minPeriodSeconds: 300,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description: 'Bytes received on all network interfaces during the period.',
  },
  {
    namespace: 'AWS/EC2',
    metricName: 'NetworkOut',
    dimensions: INSTANCE_ID,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: COUNTER_STATS,
    minPeriodSeconds: 300,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description: 'Bytes sent on all network interfaces during the period.',
  },

  ebsCounter('EBSReadOps', 'Read operations completed against all attached EBS volumes.'),
  ebsCounter('EBSWriteOps', 'Write operations completed against all attached EBS volumes.'),
  ebsCounter('EBSReadBytes', 'Bytes read from all attached EBS volumes.'),
  ebsCounter('EBSWriteBytes', 'Bytes written to all attached EBS volumes.'),

  ebsBalance(
    'EBSIOBalance%',
    'Percentage of I/O credits left in the burst bucket. At 0 the instance is throttled to its baseline IOPS.',
  ),
  ebsBalance(
    'EBSByteBalance%',
    'Percentage of throughput credits left in the burst bucket. At 0 the instance is throttled to its baseline throughput.',
  ),

  {
    namespace: 'AWS/EC2',
    metricName: 'CPUCreditBalance',
    dimensions: INSTANCE_ID,
    metricType: 'balance',
    // Minimum for the same reason the EBS balances use it: the trough is the
    // event. A T-instance that hit zero mid-period was throttled mid-period,
    // whatever the average says.
    stat: 'Minimum',
    validStatistics: COUNTER_STATS,
    // "CPU credit metrics are available at a 5-minute frequency only" — this
    // floor is a property of the metric, not of the monitoring mode, so
    // detailed monitoring does not lower it.
    minPeriodSeconds: 300,
    availability: 'either',
    appliesTo: BURSTABLE_ONLY,
    requiresFeature: null,
    description:
      'CPU credits the instance has accrued and not spent. At 0 a standard T-instance is capped at its baseline; an unlimited one starts paying for surplus credits.',
  },

  {
    namespace: 'AWS/EC2',
    metricName: 'InstanceEBSIOPSExceededCheck',
    dimensions: INSTANCE_ID,
    metricType: 'flag',
    stat: 'Maximum',
    validStatistics: COUNTER_STATS,
    minPeriodSeconds: 60,
    availability: 'either',
    appliesTo: NITRO_ONLY,
    requiresFeature: null,
    description:
      'Whether the workload tried to drive more IOPS than the instance type allows in the last minute. 1 means EBS throttled it at the instance, not the volume.',
  },
  {
    namespace: 'AWS/EC2',
    metricName: 'InstanceEBSThroughputExceededCheck',
    dimensions: INSTANCE_ID,
    metricType: 'flag',
    stat: 'Maximum',
    validStatistics: COUNTER_STATS,
    minPeriodSeconds: 60,
    availability: 'either',
    appliesTo: NITRO_ONLY,
    requiresFeature: null,
    description:
      'Whether the workload tried to drive more EBS throughput than the instance type allows in the last minute. Same instance-level ceiling as the IOPS check.',
  },
]);

/**
 * The default rule pack (decision INFRA-ALERT).
 *
 * Templates only — nothing here is inserted into `infra_alert_rules` on its
 * own. They exist so the rule editor opens on AWS's published recommendation
 * rather than a blank form.
 */
const EC2_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  {
    name: 'EC2 status check failed',
    description: 'The instance failed a status check in two consecutive minutes.',
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed',
    stat: 'Maximum',
    dimensions: INSTANCE_ID,
    // AWS's recommendation says period 300; we use 60 because the metric is
    // published every minute at no charge and a 5-minute period delays the page
    // by four minutes for nothing. Evaluation periods and datapoints are kept
    // at the recommended 2, so the alarm still needs two consecutive failures.
    periodS: 60,
    threshold: 1,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 2,
    datapointsToAlarm: 2,
    // A stopped or terminating instance stops publishing; treating that gap as
    // breaching would page on every planned shutdown.
    treatMissingData: 'missing',
    severity: 'critical',
    rationale:
      'AWS best-practice alarm: Maximum, threshold 1, GreaterThanOrEqualToThreshold, 2 of 2. "When a status check fails, the value of this metric is 1." Status checks are published every minute at no charge, so the period is tightened from the doc\'s 300s to 60s.',
  },
  {
    name: 'EC2 attached EBS status check failed',
    description: 'Attached EBS volumes have been unreachable for ten consecutive minutes.',
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed_AttachedEBS',
    stat: 'Maximum',
    dimensions: INSTANCE_ID,
    periodS: 60,
    threshold: 1,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    // 10 of 10, straight from the recommendation. Longer than the plain status
    // check on purpose: transient EBS reachability blips resolve themselves and
    // AWS's own guidance is that this one should be slow to fire.
    evaluationPeriods: 10,
    datapointsToAlarm: 10,
    treatMissingData: 'missing',
    severity: 'critical',
    rationale:
      'AWS best-practice alarm, verbatim: Maximum, threshold 1, GreaterThanOrEqualToThreshold, period 60, 10 of 10.',
  },
  {
    name: 'EC2 sustained high CPU',
    description: 'CPU has averaged above 80% for fifteen minutes.',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    stat: 'Average',
    dimensions: INSTANCE_ID,
    periodS: 300,
    threshold: 80,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS best-practice alarm: Average, threshold 80, GreaterThanThreshold, period 300, 3 of 3. The doc\'s own justification: "Typically, you can set the threshold for CPU utilization to 70-80%." Three consecutive periods is what makes it sustained rather than a burst.',
  },
  {
    name: 'EC2 EBS I/O burst balance depleted',
    description: 'The EBS I/O credit bucket has been near empty for fifteen minutes.',
    namespace: 'AWS/EC2',
    metricName: 'EBSIOBalance%',
    // Minimum, and Sum is not merely unusual here — AWS documents it as not
    // applicable to this metric.
    stat: 'Minimum',
    dimensions: INSTANCE_ID,
    periodS: 300,
    // 20% rather than 0: at zero the instance is already throttled, which makes
    // the alarm a report rather than a warning. 20% of a bucket that drains in
    // 30 minutes of sustained burst is roughly six minutes of headroom left.
    threshold: 20,
    comparisonOperator: 'LessThanThreshold',
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    // notBreaching, not missing: the overwhelming majority of instances have no
    // burst bucket and publish nothing at all. Under 'missing' every one of them
    // would sit in INSUFFICIENT_DATA forever, which trains operators to ignore
    // the state column.
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'No AWS-published alarm exists for this metric. The statistic is forced by the doc ("The Sum statistic is not applicable"); the threshold is set above zero because zero is the point at which throttling has already started.',
  },
  {
    name: 'EC2 EBS throughput burst balance depleted',
    description: 'The EBS throughput credit bucket has been near empty for fifteen minutes.',
    namespace: 'AWS/EC2',
    metricName: 'EBSByteBalance%',
    stat: 'Minimum',
    dimensions: INSTANCE_ID,
    periodS: 300,
    threshold: 20,
    comparisonOperator: 'LessThanThreshold',
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'The throughput twin of the I/O burst balance rule, and identical for the same reasons.',
  },
]);

/** The EC2 pack. */
export const EC2_PACK: InfraServicePack = Object.freeze({
  service: 'ec2',
  label: 'EC2',
  metrics: EC2_PACK_METRICS,
  dimensions: Object.freeze([
    {
      name: 'InstanceId',
      detailedMonitoringOnly: false,
      description: 'One instance. This is the dimension every collected series is keyed on.',
    },
    {
      name: 'AutoScalingGroupName',
      detailedMonitoringOnly: false,
      description:
        'Every instance in an Auto Scaling group. Available under basic monitoring as well as detailed.',
    },
    {
      name: 'ImageId',
      detailedMonitoringOnly: true,
      description:
        'Every instance running one AMI. Published only for instances with detailed monitoring enabled.',
    },
    {
      name: 'InstanceType',
      detailedMonitoringOnly: true,
      description:
        'Every instance of one type. Published only for instances with detailed monitoring enabled.',
    },
  ]),
  // Detailed monitoring is a paid opt-in and would fit the feature vocabulary,
  // but `DescribeInstances` reports it per instance and inventory sync does not
  // record it yet, so nothing here can be gated on it honestly. Until it is,
  // the monitoring-mode caveats stay documentation (`availability`) rather than
  // a collection gate.
  features: Object.freeze([]),
  absentMetrics: Object.freeze([
    {
      label: 'Memory utilization',
      reason:
        'EC2 has no memory metric. The hypervisor cannot see inside the guest, so there is nothing for AWS to publish.',
      remedy:
        'Install the CloudWatch agent on the instance. It publishes memory to the CWAgent namespace as custom metrics, which AWS bills separately.',
    },
    {
      label: 'Disk-space used',
      reason:
        'Same reason as memory: file system usage is a guest-side fact the hypervisor cannot observe.',
      remedy:
        'The CloudWatch agent publishes disk_used_percent to the CWAgent namespace, again as billed custom metrics.',
    },
    {
      label: 'Disk I/O (DiskReadOps, DiskWriteOps, DiskReadBytes, DiskWriteBytes)',
      reason:
        'These AWS/EC2 metrics cover instance store volumes only. Instances backed solely by EBS — which is nearly all of them — report 0 or nothing at all.',
      remedy:
        'Use the EBS metrics in this pack (EBSReadOps, EBSWriteOps, EBSReadBytes, EBSWriteBytes), which measure the volumes actually attached.',
    },
    {
      label: '1-minute CPU and network resolution',
      reason:
        'Under the default basic monitoring these metrics are published every 5 minutes. Status checks are the exception and are always 1-minute at no charge.',
      remedy:
        'Enable detailed monitoring on the instance. AWS bills it per instance, and it does not apply to CPU credit metrics, which are 5-minute only regardless.',
    },
  ]),
  defaultAlertRules: EC2_DEFAULT_ALERT_RULES,
});
