/**
 * RDS pack — the service where the metrics are free and the statistics are not
 * written down.
 *
 * Every entry is traceable to the RDS user guide's *Amazon CloudWatch metrics
 * for Amazon RDS*, *Amazon CloudWatch dimensions for Amazon RDS* and *Monitoring
 * Amazon RDS metrics with Amazon CloudWatch* pages, to the Aurora user guide's
 * *Amazon CloudWatch metrics for Amazon Aurora*, and to the CloudWatch
 * *recommended alarms* page's RDS section (verified August 2026).
 *
 * Three facts shape this pack.
 *
 * **1. RDS is 1-minute and on by default.** AWS: "By default, Amazon RDS
 * automatically sends metric data to CloudWatch in 1-minute periods." There is
 * no basic-vs-detailed split to reason about the way EC2 has one, and no
 * per-instance opt-in to bill for, so every metric here floors at 60s and every
 * `availability` is `either`. That makes RDS the cheapest service in the epic to
 * monitor well: the resolution an operator wants is the resolution they already
 * have.
 *
 * **2. AWS publishes no valid-statistics column for RDS.** The EC2 and S3
 * metric tables name the statistics each metric is meaningful on; the RDS table
 * has four columns — Metric, Description, Applies to, Units — and no fifth. So
 * {@link InfraPackMetric.validStatistics} here cannot be a transcription the way
 * it is in the other packs. It is derived, from two sources that are still AWS's
 * own words rather than ours:
 *
 *   - the metric's documented **unit**, which decides what an aggregate of it
 *     can mean (a `Percent` or a `Bytes` level supports Average/Minimum/Maximum
 *     and not Sum; `Seconds` of per-operation latency additionally supports
 *     percentiles), and
 *   - the statistic **AWS's own recommended alarm** for that metric evaluates,
 *     which is a published statement that the statistic is meaningful. That is
 *     where the `p90` on the two latency metrics comes from, and it is why they
 *     carry {@link PERCENTILE_STATISTIC_TOKEN}.
 *
 * `Sum` is absent from every entry below, deliberately. There is no metric in
 * this pack that accrues during a period: they are all levels sampled at the end
 * of one, and a sum of sixty samples of "how much memory is free" is a number
 * with no referent.
 *
 * **3. `rds` is one scope token over two products.** Aurora publishes into the
 * same namespace — the Aurora user guide opens with "The `AWS/RDS` namespace
 * includes the following metrics that apply to database entities running on
 * Amazon Aurora" — and `DescribeDBInstances` returns Aurora cluster members
 * alongside provisioned instances. So a single `rds` scope holds rows of both
 * kinds, and the metrics they publish are not the same set. `FreeStorageSpace`
 * is the sharp edge: an Aurora instance has no such thing, because its storage
 * is a shared cluster volume that grows on its own. Every metric that splits
 * this way says so in {@link InfraMetricApplicability.condition}, and every
 * default rule over one treats missing data as not breaching, for the reason the
 * NAT gateway and S3 packs give: an unpinned rule matches every row in the
 * service, and under `missing` the rows that structurally cannot publish the
 * series would sit in INSUFFICIENT_DATA forever and teach operators that the
 * state column is noise.
 *
 * On what is *not* here: the OS-level numbers an operator asks for first —
 * memory breakdown, per-process CPU, per-device disk I/O — do not exist in this
 * namespace at all. They come from Enhanced Monitoring, which AWS "delivers ...
 * into your Amazon CloudWatch Logs account" rather than into CloudWatch metrics.
 * That is a different product with a different bill, and `absentMetrics` says so
 * rather than leaving four empty charts.
 */

import { PERCENTILE_STATISTIC_TOKEN } from './types.js';
import type {
  InfraMetricApplicability,
  InfraPackAlertRule,
  InfraPackMetric,
  InfraServicePack,
} from './types.js';

const NS = 'AWS/RDS';

/**
 * The instance-level series. One row per DB instance in inventory.
 *
 * `DBInstanceIdentifier` is the only dimension collected. The other four AWS
 * documents — `DatabaseClass`, `EngineName`, `SourceRegion` and the
 * `DbInstanceIdentifier, VolumeName` pair — are aggregations across instances or
 * a slice below one, and neither is a row this inventory holds. See
 * {@link RDS_PACK.dimensions}.
 */
const INSTANCE = Object.freeze(['DBInstanceIdentifier']);

/** "Amazon RDS sends metrics and dimensions to Amazon CloudWatch every minute." */
const ONE_MINUTE = 60;

const UNIVERSAL: InfraMetricApplicability = Object.freeze({ universal: true, condition: '' });

/**
 * A level in percent or bytes: Average is the trend, Minimum and Maximum are the
 * two edges of the period. Sum is omitted because these do not accrue.
 */
const LEVEL_STATS = Object.freeze(['Average', 'Minimum', 'Maximum']);

/**
 * The same three plus percentiles, for the two per-operation latency metrics.
 *
 * The percentile arm is not a guess: AWS's own recommended alarms for
 * `ReadLatency` and `WriteLatency` are both evaluated on `p90`, which is a
 * published statement that a percentile of these series means something. It also
 * matches why the metric is a distribution rather than a level — AWS describes
 * both as "the average amount of time taken per disk I/O operation", so a single
 * datapoint already summarises many operations.
 */
const LATENCY_STATS = Object.freeze(['Average', 'Minimum', 'Maximum', PERCENTILE_STATISTIC_TOKEN]);

/**
 * Aurora instances do not publish this series. Stated per metric because the
 * `rds` scope holds both kinds of row and the chart is otherwise empty with no
 * explanation.
 */
const PROVISIONED_ONLY: InfraMetricApplicability = Object.freeze({
  universal: false,
  condition:
    'Published by provisioned RDS DB instances, not by Aurora cluster members. Aurora storage is a shared cluster volume that grows automatically, so there is no per-instance free-space figure to report; Aurora publishes the cluster-level VolumeBytesUsed and AuroraVolumeBytesLeftTotal instead, and the instance-level FreeLocalStorage for its ephemeral local disk. A single rds scope holds rows of both kinds, so this series is present on some of them and structurally absent on the rest.',
});

const RDS_METRICS: readonly InfraPackMetric[] = Object.freeze([
  {
    namespace: NS,
    metricName: 'CPUUtilization',
    dimensions: INSTANCE,
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: LEVEL_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Percentage of CPU in use on the DB instance. Read it beside DatabaseConnections: CPU that climbs with connections is load, CPU that climbs without them is usually one bad query plan. Sustained highs are the signal, not spikes — AWS notes that "random spikes in CPU consumption might not hamper database performance".',
  },
  {
    namespace: NS,
    metricName: 'DatabaseConnections',
    dimensions: INSTANCE,
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: LEVEL_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Client network connections to the database. Not every session: AWS excludes engine-internal sessions, parallel-execution sessions, job-scheduler sessions and RDS’s own connections from the count. The ceiling this is heading for is a function of the instance class and the engine’s max-connections parameter, so the number that matters is the ratio rather than the count.',
  },
  {
    namespace: NS,
    metricName: 'FreeStorageSpace',
    dimensions: INSTANCE,
    metricType: 'gauge',
    // Minimum, matching AWS's own recommended alarm. The low-water mark is the
    // whole question for a storage-full metric: an Average over a minute that
    // briefly touched zero reads as comfortable.
    stat: 'Minimum',
    validStatistics: LEVEL_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: PROVISIONED_ONLY,
    requiresFeature: null,
    description:
      'Bytes of allocated storage still free. Running this to zero takes the instance down, and it is the RDS outage that is most obviously preventable in advance. Note the RDS console displays this in MB or GB while CloudWatch stores bytes, so a threshold copied from the console reads a million times too small here.',
  },
  {
    namespace: NS,
    metricName: 'FreeableMemory',
    dimensions: INSTANCE,
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: LEVEL_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Bytes of memory available. AWS is specific about what that means on Linux engines: "For MariaDB, MySQL, Oracle, and PostgreSQL DB instances, this metric reports the value of the MemAvailable field of /proc/meminfo" — so it already accounts for reclaimable page cache and is not the same as free memory. Falling to zero rejects connections rather than slowing them down.',
  },
  {
    namespace: NS,
    metricName: 'ReadLatency',
    dimensions: INSTANCE,
    metricType: 'latency',
    // p90, matching AWS's recommended alarm. An Average of per-operation
    // latency hides exactly the tail that a user notices.
    stat: 'p90',
    validStatistics: LATENCY_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Seconds per disk read operation, at the 90th percentile. Seconds, not milliseconds — AWS documents the unit as Seconds, so its own "higher than 20 milliseconds is likely a cause for investigation" guidance is 0.02 on this axis. Rising here with flat ReadIOPS usually means the storage is throttling rather than the workload growing.',
  },
  {
    namespace: NS,
    metricName: 'WriteLatency',
    dimensions: INSTANCE,
    metricType: 'latency',
    stat: 'p90',
    validStatistics: LATENCY_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Seconds per disk write operation, at the 90th percentile. Same unit trap as ReadLatency. Write latency that rises while read latency does not is often commit or log-flush pressure rather than the volume as a whole.',
  },
  {
    namespace: NS,
    metricName: 'DiskQueueDepth',
    dimensions: INSTANCE,
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: LEVEL_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Outstanding read and write requests waiting on the disk. The corroborating metric for a latency rise: a queue that grows alongside ReadLatency or WriteLatency means the storage is saturated, while latency that rises with an empty queue points at the individual operations getting slower.',
  },
  {
    namespace: NS,
    metricName: 'BurstBalance',
    dimensions: INSTANCE,
    // A credit bucket, so the only interesting question is how low it got.
    metricType: 'balance',
    stat: 'Minimum',
    validStatistics: LEVEL_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: Object.freeze({
      universal: false,
      condition:
        'AWS defines this as "the percent of General Purpose SSD (gp2) burst-bucket I/O credits available", so it belongs to gp2 volumes. An instance on gp3, io1, io2 or magnetic storage has no burst bucket to report on and publishes nothing here, as does an Aurora cluster member. Which storage type an instance uses is not recorded on the inventory row, so this is documentation the UI renders rather than a filter the collector applies.',
    }),
    requiresFeature: null,
    description:
      'Percentage of the gp2 burst-bucket I/O credits still available. A gp2 volume under 1 TiB serves a baseline of 3 IOPS per GiB and borrows from this bucket to exceed it, so a balance draining toward zero is a warning that sustained I/O is about to be capped at the baseline — which arrives as a latency cliff rather than a gradual slowdown.',
  },
  {
    namespace: NS,
    metricName: 'ReplicaLag',
    dimensions: INSTANCE,
    metricType: 'gauge',
    // Maximum, matching AWS's recommended alarm: lag is a worst case, and an
    // average over the period understates the exposure a failover would find.
    stat: 'Maximum',
    validStatistics: LEVEL_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: Object.freeze({
      universal: false,
      condition:
        'Published by read replicas and by Multi-AZ DB cluster readers, not by a standalone writer. AWS: "For read replica configurations, the amount of time a read replica DB instance lags behind the source DB instance. Applies to MariaDB, Microsoft SQL Server, MySQL, Oracle, and PostgreSQL read replicas." Aurora reports its own AuroraReplicaLag in milliseconds instead, so an Aurora reader is silent on this series.',
    }),
    requiresFeature: null,
    description:
      'Seconds a read replica trails its source. This is the data-loss window: if the primary fails now, everything committed inside this many seconds is what the replica is missing. It is also the correctness bound on reading from the replica, since a query served there sees the world this far in the past.',
  },
  {
    namespace: NS,
    metricName: 'MaximumUsedTransactionIDs',
    dimensions: INSTANCE,
    metricType: 'gauge',
    // Average, matching AWS's recommended alarm. The series is monotonic
    // between vacuums, so within a 60-second period the three statistics
    // differ by roughly the transaction rate — the choice is about matching the
    // console, not about resolution.
    stat: 'Average',
    validStatistics: LEVEL_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: Object.freeze({
      universal: false,
      condition:
        'PostgreSQL only — the RDS metric table lists its "Applies to" as PostgreSQL, and no other engine has transaction ID wraparound to report. Every MySQL, MariaDB, Oracle, SQL Server and Db2 instance in the same scope publishes nothing here.',
    }),
    requiresFeature: null,
    description:
      'Age of the oldest unvacuumed transaction, in transaction IDs. The one metric in this pack that predicts an outage rather than describing one: PostgreSQL forces the database into read-only mode to avoid transaction ID wraparound, which Aurora PostgreSQL documents as happening at 2,146,483,648. RDS tunes autovacuum adaptively once this passes autovacuum_freeze_max_age or 500,000,000, whichever is greater, but AWS still says plainly that "transaction ID wraparound is still possible even when Amazon RDS tunes the autovacuum parameters. We encourage you to implement an Amazon CloudWatch alarm for transaction ID wraparound."',
  },
]);

/**
 * Default rules (decision INFRA-ALERT).
 *
 * Every recommended alarm AWS publishes over a metric this pack collects ships
 * here, with its statistic, period, comparison operator and M-of-N verbatim.
 * Where AWS gives a number it is used unchanged; where AWS says "depends on your
 * situation" the threshold below is a **unit standing in for the number you have
 * to supply**, derived from AWS's own threshold-justification text and labelled
 * as such in the rationale. These are templates for the rule editor, never rows
 * anything creates on its own.
 *
 * The recommended alarms that are absent are absent because the metric is —
 * `EBSByteBalance%`, `EBSIOBalance%`, `FreeLocalStorage`, `DBLoad`,
 * `AuroraVolumeBytesLeftTotal` and `AuroraBinlogReplicaLag` are all outside the
 * ten series this pack declares, and `absentMetrics` carries the reason for
 * each.
 *
 * Missing-data treatment splits on whether every row in an `rds` scope can
 * publish the series. It is `missing` — CloudWatch's own default, so our state
 * column matches the console an operator will diff it against — for the metrics
 * every DB instance emits, and `notBreaching` for the ones that are engine-,
 * storage- or role-specific. Pin a rule to one resource to get the console's
 * exact behaviour in every case.
 */
const RDS_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  {
    name: 'RDS instance CPU saturated',
    description: 'CPU has been above 90% for five consecutive minutes.',
    namespace: NS,
    metricName: 'CPUUtilization',
    stat: 'Average',
    dimensions: INSTANCE,
    periodS: 60,
    threshold: 90,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS recommended alarm, verbatim: Average, threshold 90.0, GREATER_THAN_THRESHOLD, period 60, 5 datapoints of 5. Intent: "This alarm is used to detect consistent high CPU utilization in order to prevent very high response time and time-outs." Threshold justification: "Random spikes in CPU consumption might not hamper database performance, but sustained high CPU can hinder upcoming database requests." The 5-of-5 shape is the load-bearing part rather than the 90 — it is what makes this a sustained-saturation rule instead of a spike detector.',
  },
  {
    name: 'RDS instance running out of storage',
    description: 'Free storage has dropped below the floor you set.',
    namespace: NS,
    metricName: 'FreeStorageSpace',
    stat: 'Minimum',
    dimensions: INSTANCE,
    periodS: 60,
    // 10 GiB. A unit, not a recommendation — see the rationale.
    threshold: 10_737_418_240,
    comparisonOperator: 'LessThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'AWS recommended alarm shape, verbatim: Minimum, LESS_THAN_THRESHOLD, period 60, 5 datapoints of 5. AWS gives no fixed threshold — "The threshold value will depend on the currently allocated storage space. Typically, you should calculate the value of 10 percent of the allocated storage space and use that result as the threshold value." The 10 GiB here is that rule applied to a 100 GiB instance, and it is a unit standing in for your own number: read the instance’s allocated storage and replace it. Two further warnings from AWS carry over — do not use this alarm if storage auto scaling is on or if you change storage capacity often, and note that CloudWatch stores bytes while the RDS console renders MB or GB, so a threshold copied from the console is wrong by six orders of magnitude. Missing data is not breaching because Aurora cluster members in the same scope never publish this series.',
  },
  {
    name: 'RDS instance low on memory',
    description: 'Freeable memory has stayed below the floor you set for fifteen minutes.',
    namespace: NS,
    metricName: 'FreeableMemory',
    stat: 'Average',
    dimensions: INSTANCE,
    periodS: 60,
    // 1 GiB. A unit, not a recommendation — see the rationale.
    threshold: 1_073_741_824,
    comparisonOperator: 'LessThanThreshold',
    evaluationPeriods: 15,
    datapointsToAlarm: 15,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS recommended alarm shape, verbatim: Average, LESS_THAN_THRESHOLD, period 60, 15 datapoints of 15. Intent: "This alarm is used to help prevent running out of memory which can result in rejected connections." AWS gives no fixed threshold, but does give the arithmetic: "Ideally, available memory should not go below 25% of total memory for prolonged periods. For Aurora, you can set the threshold close to 5%, because the metric approaching 0 means that the DB instance has scaled up as much as it can." The 1 GiB here is 25% of a 4 GiB instance class and is a unit standing in for your own number. The fifteen-minute window is deliberate and AWS’s: a database that briefly dips is reclaiming page cache, which is what the memory is for.',
  },
  {
    name: 'RDS instance approaching its connection limit',
    description: 'Client connections have stayed above the ceiling you set for five minutes.',
    namespace: NS,
    metricName: 'DatabaseConnections',
    stat: 'Average',
    dimensions: INSTANCE,
    periodS: 60,
    // A unit, not a recommendation — see the rationale.
    threshold: 100,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS recommended alarm shape, verbatim: Average, GREATER_THAN_THRESHOLD, period 60, 5 datapoints of 5. Intent: "This alarm is used to help prevent rejected connections when the maximum number of DB connections is reached." AWS gives no fixed threshold and states the arithmetic instead: "You should calculate a value between 90-95% of the maximum number of connections for your database and use that result as the threshold value." Your maximum is a function of the instance class and the engine’s own parameter, so the 100 here is a unit standing in for 90-95% of it. AWS also warns this alarm is a poor fit if you change instance class often, "because doing so changes the memory and default maximum number of connections".',
  },
  {
    name: 'RDS instance read latency high',
    description: 'Nine reads in ten have taken longer than the budget you set, for five minutes.',
    namespace: NS,
    metricName: 'ReadLatency',
    stat: 'p90',
    dimensions: INSTANCE,
    periodS: 60,
    // 0.02s = 20ms, AWS's own investigation threshold. Seconds, not ms.
    threshold: 0.02,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS recommended alarm, verbatim: p90, GREATER_THAN_THRESHOLD, period 60, 5 datapoints of 5. Intent: "This alarm is used to detect high read latency. Database disks normally have a low read/write latency, but they can have issues that can cause high latency operations." Threshold from AWS’s own justification: "Read latencies higher than 20 milliseconds are likely a cause for investigation." The value is 0.02 rather than 20 because AWS documents this metric’s unit as Seconds — entering 20 here would alarm at twenty seconds per read, which is an outage long past the point of needing an alarm.',
  },
  {
    name: 'RDS instance write latency high',
    description: 'Nine writes in ten have taken longer than the budget you set, for five minutes.',
    namespace: NS,
    metricName: 'WriteLatency',
    stat: 'p90',
    dimensions: INSTANCE,
    periodS: 60,
    threshold: 0.02,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS recommended alarm, verbatim: p90, GREATER_THAN_THRESHOLD, period 60, 5 datapoints of 5. Intent: "This alarm is used to detect high write latency. Although database disks typically have low read/write latency, they may experience problems that cause high latency operations." Threshold from AWS’s justification: "Write latencies higher than 20 milliseconds are likely a cause for investigation." Seconds, so 0.02 — the same unit trap as the read rule.',
  },
  {
    name: 'RDS read replica lagging',
    description: 'A replica has been more than a minute behind its source for ten minutes.',
    namespace: NS,
    metricName: 'ReplicaLag',
    stat: 'Maximum',
    dimensions: INSTANCE,
    periodS: 60,
    threshold: 60,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 10,
    datapointsToAlarm: 10,
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'AWS recommended alarm, verbatim: Maximum, threshold 60.0, GREATER_THAN_THRESHOLD, period 60, 10 datapoints of 10. Intent: "This alarm can detect the replica lag which reflects the data loss that could happen in case of a failure of the primary instance. If the replica gets too far behind the primary and the primary fails, the replica will be missing data that was in the primary instance." Threshold justification: "Typically, the acceptable lag depends on the application. We recommend no more than 60 seconds." Missing data is not breaching because a standalone writer publishes nothing here, and an unpinned rule matches every instance in the scope.',
  },
  {
    name: 'PostgreSQL transaction ID wraparound approaching',
    description: 'The oldest unvacuumed transaction has passed a billion transaction IDs.',
    namespace: NS,
    metricName: 'MaximumUsedTransactionIDs',
    stat: 'Average',
    dimensions: INSTANCE,
    periodS: 60,
    threshold: 1_000_000_000,
    comparisonOperator: 'GreaterThanThreshold',
    // One datapoint, and AWS's own shape. The series moves over hours, so
    // requiring a second confirmation would add a minute of delay to a signal
    // that already has days of lead time and change nothing about the answer.
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'AWS recommended alarm, verbatim: Average, threshold 1.0E9, GREATER_THAN_THRESHOLD, period 60, 1 datapoint of 1. Intent: "This alarm is used to help prevent transaction ID wraparound for PostgreSQL." Threshold justification: "Setting this threshold to 1 billion should give you time to investigate the problem. The default autovacuum_freeze_max_age value is 200 million. If the age of the oldest transaction is 1 billion, autovacuum is having a problem keeping this threshold below the target of 200 million transaction IDs." Critical rather than warning because the failure mode is not degradation: PostgreSQL forces the database read-only at 2,146,483,648 to protect itself, and there is no way to recover from that quickly. Missing data is not breaching because every non-PostgreSQL instance in the scope is silent on this series.',
  },
]);

/** The RDS pack. */
export const RDS_PACK: InfraServicePack = Object.freeze({
  service: 'rds',
  label: 'RDS',
  metrics: RDS_METRICS,
  dimensions: Object.freeze([
    {
      name: 'DBInstanceIdentifier',
      // RDS has no basic-vs-detailed monitoring split, so no dimension here is
      // conditional on one. The flag exists for EC2's sake.
      detailedMonitoringOnly: false,
      description:
        'One DB instance. The only dimension collected: every other one AWS documents is either an aggregation across instances (DatabaseClass, EngineName, SourceRegion) or a slice below one (the DbInstanceIdentifier + VolumeName pair, for per-volume storage metrics on a multi-volume instance), and neither is a row this inventory holds.',
    },
    {
      name: 'DatabaseClass',
      detailedMonitoringOnly: false,
      description:
        'Every instance in a database class, aggregated — AWS’s example is "aggregate metrics for all instances that belong to the database class db.r5.large". Documented rather than collected: this is a fleet roll-up, and a chart of it cannot name the instance that moved.',
    },
    {
      name: 'EngineName',
      detailedMonitoringOnly: false,
      description:
        'Every instance running one engine, aggregated — "for example, you can aggregate metrics for all instances that have the engine name postgres". Documented rather than collected, for the same reason as DatabaseClass.',
    },
    {
      name: 'SourceRegion',
      detailedMonitoringOnly: false,
      description:
        'Every instance in one Region, aggregated. Documented rather than collected: a scope is already pinned to a region, so this dimension would restate the scope and lose the instance.',
    },
    {
      name: 'VolumeName',
      detailedMonitoringOnly: false,
      description:
        'Paired with DBInstanceIdentifier for per-volume storage metrics on an instance that uses more than one volume. AWS: "If you are using additional storage volumes, you can see aggregate storage metrics under the DBInstanceIdentifier dimension. To see per-volume storage metrics, use the DbInstanceIdentifier, VolumeName dimensions." Documented rather than collected — inventory holds instances, not volumes, and the instance-level aggregate is what the collected series already reports.',
    },
  ]),
  // RDS metrics are on by default at 1-minute resolution with no paid opt-in, so
  // there is nothing here for a feature gate to describe. Enhanced Monitoring
  // and Performance Insights are paid, but they are separate products that
  // publish outside this namespace rather than modes of these metrics — see
  // absentMetrics.
  features: Object.freeze([]),
  absentMetrics: Object.freeze([
    {
      label: 'Memory breakdown, per-process CPU, and per-device disk I/O',
      reason:
        'These are OS-level numbers and they do not exist in the AWS/RDS namespace. AWS draws the line itself: "CloudWatch gathers metrics about CPU utilization from the hypervisor for a DB instance. In contrast, Enhanced Monitoring gathers its metrics from an agent on the DB instance." Enhanced Monitoring is also not a CloudWatch metric even once enabled — RDS "delivers the metrics from Enhanced Monitoring into your Amazon CloudWatch Logs account", into an RDSOSMetrics log group, so there is no metric series to chart or alarm on here at all.',
      remedy:
        'Enable Enhanced Monitoring on the instance at a granularity of 1, 5, 10, 15, 30 or 60 seconds. AWS bills it through CloudWatch Logs rather than CloudWatch metrics: "You are charged for Enhanced Monitoring only if you exceed the amount of data transfer and storage provided by Amazon CloudWatch Logs." The data lands in CloudWatch Logs with a 30-day default retention and is read there or in the RDS console, not in this module.',
    },
    {
      label: 'DBLoad and the Performance Insights counters',
      reason:
        'DBLoad measures average active sessions against the vCPU line and comes from Performance Insights, a separate feature with its own dashboard and its own enablement. AWS publishes a recommended alarm for it, and it is genuinely the best single indicator of database saturation, but an instance without Performance Insights turned on publishes nothing.',
      remedy:
        'Turn Performance Insights on for the instance, then read DBLoad in the Performance Insights dashboard or export the counters to a CloudWatch dashboard. AWS’s recommended alarm for it is Average, GREATER_THAN_THRESHOLD, period 60, 15 datapoints of 15, with the threshold set at the instance’s vCPU count — "ideally, DB load should not go above vCPU line". It is not collected here because the metric’s presence depends on a per-instance opt-in that inventory does not currently read.',
    },
    {
      label: 'EBSByteBalance% and EBSIOBalance%',
      reason:
        'Both exist for RDS and AWS publishes a recommended alarm for each (Average below 10%, period 60, 3 datapoints of 3). They are not collected here to keep the per-instance query count — and therefore the GetMetricData bill — to the ten series this pack declares. AWS also scopes them narrowly: the EBSByteBalance% alarm is "not recommended for Aurora PostgreSQL instances" and the EBSIOBalance% one is "not recommended for Aurora instances".',
      remedy:
        'They are already published — nothing needs enabling. Read them in the CloudWatch console, or open a ticket to add them to this pack. Note AWS states "the Sum statistic is not applicable" to both, so chart them on Average, Minimum or Maximum.',
    },
    {
      label: 'ReadIOPS, WriteIOPS, ReadThroughput, WriteThroughput, SwapUsage and the network pair',
      reason:
        'All are published by RDS and all are deliberately not collected. Each additional series is a separately billed GetMetricData entry on every tick for every instance in the scope, and the questions they answer are mostly answered by series this pack already holds: a latency rise with a growing DiskQueueDepth is storage saturation whether or not the IOPS figure is charted beside it.',
      remedy:
        'Read them in the CloudWatch console under the same DBInstanceIdentifier dimension, or open a ticket to add one to this pack if it is load-bearing for your workload. SwapUsage in particular is worth adding by hand on a memory-constrained MySQL or PostgreSQL instance — AWS does not publish it for SQL Server.',
    },
    {
      label: 'Aurora cluster-level storage: VolumeBytesUsed and AuroraVolumeBytesLeftTotal',
      reason:
        'They are keyed on DBClusterIdentifier — a cluster, not an instance — and inventory has no cluster rows to hang that dimension on. This is why FreeStorageSpace reads as empty for an Aurora member rather than being replaced by an Aurora equivalent.',
      remedy:
        'Build it in the CloudWatch console with AWS’s recommended shape for AuroraVolumeBytesLeftTotal: Average, LESS_THAN_THRESHOLD, period 60, 5 datapoints of 5, threshold at 10-20% of the cluster’s size limit. AWS recommends it "only for Aurora MySQL". Collecting it here needs an Aurora cluster resource kind and a DescribeDBClusters inventory pass, which is a change to the inventory model rather than to this pack.',
    },
    {
      label:
        'Aurora FreeLocalStorage, AuroraReplicaLag, ACUUtilization and the rest of the Aurora set',
      reason:
        'Aurora publishes into AWS/RDS but declares its own metric names for several concepts this pack collects under the provisioned-RDS name — AuroraReplicaLag is in milliseconds where ReplicaLag is in seconds, and FreeLocalStorage measures ephemeral instance disk where FreeStorageSpace measures the allocated volume. Charting them as if they were the same series would put two different units on one axis.',
      remedy:
        'None here yet. Aurora needs its own pack keyed on the same DBInstanceIdentifier dimension but declaring the Aurora metric names, so that an Aurora member row gets the Aurora queries and a provisioned instance row gets these. Until then, read the Aurora-specific series in the CloudWatch console.',
    },
    {
      label: 'BurstBalance on a gp3, io1, io2 or Aurora instance',
      reason:
        'AWS defines the metric as "the percent of General Purpose SSD (gp2) burst-bucket I/O credits available". Storage types that do not burst have no bucket to report, so the series simply does not exist for them — and the inventory row records the instance identifier, not its storage type, so the collector cannot prune the query.',
      remedy:
        'Nothing to fix on a gp3 volume: gp3 provisions baseline IOPS and throughput directly instead of borrowing from a bucket, so the absence is the storage type working as designed. Watch EBSIOBalance% and EBSByteBalance% instead for instance-level burst limits, in the CloudWatch console.',
    },
  ]),
  defaultAlertRules: RDS_DEFAULT_ALERT_RULES,
});
