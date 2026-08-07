/**
 * S3 pack — one namespace, two economies.
 *
 * Every entry is traceable to the S3 user guide's *Monitoring metrics with
 * Amazon CloudWatch*, *Metrics and dimensions* and *CloudWatch metrics
 * configurations* pages, and to the CloudWatch *best practice alarm
 * recommendations* page's `Amazon S3` section (verified August 2026).
 *
 * S3 splits cleanly down the middle, and the split is the pack.
 *
 * **1. Daily storage metrics are free and arrive once a day.** AWS: storage
 * metrics "are reported once per day and are provided to all customers at no
 * additional cost". So they floor at an 86,400-second period, which
 * `effectiveServicePollIntervalSeconds` then turns into one poll per day — the
 * concrete form of decision INFRA-COST's "S3 daily storage metrics are polled at
 * most a few times a day because they only update daily". Asking every five
 * minutes would cost 288 times as much and return the same single datapoint.
 *
 * **2. Request metrics are paid, per-bucket, and opt-in.** They do not exist
 * until an operator creates a *metrics configuration* on the bucket, and AWS is
 * explicit that "these CloudWatch metrics are billed at the same rate as the
 * Amazon CloudWatch custom metrics". They therefore carry
 * `requiresFeature: 'requestMetrics'`: inventory sync detects the configurations
 * rather than assuming them, the collector skips these queries for a bucket that
 * has none, and the UI says "no metrics configuration on this bucket" instead of
 * rendering eleven empty charts.
 *
 * Four doc facts do the rest of the work, and three of them are easy to get
 * wrong.
 *
 *   - **`BucketSizeBytes` and `NumberOfObjects` share a dimension set and share
 *     no dimension values.** Both are keyed on `BucketName` + `StorageType`, but
 *     `NumberOfObjects`' only valid storage-type filter is `AllStorageTypes`,
 *     and `AllStorageTypes` is not among `BucketSizeBytes`' filters. That is
 *     what {@link InfraPackMetric.dimensionValues} exists for. Only the object
 *     count is pinned: pinning the byte total to a transcribed list of storage
 *     classes would make the pack go blind the next time AWS ships a new one,
 *     and the cost of leaving it open is one empty daily series per bucket —
 *     three hundredths of a cent a year — annotated with the reason.
 *   - **`4xxErrors` / `5xxErrors` are 0-or-1 per request, so the statistic
 *     changes what the number means.** AWS: "The Average statistic shows the
 *     error rate, and the Sum statistic shows the count of that type of error,
 *     during each period." Both are collected, because a rate answers "is this
 *     bucket healthy" and a count answers "how many users did this hit", and
 *     neither is derivable from the other without the request total.
 *   - **Request metrics are keyed on a `FilterId`, never on the bucket alone.**
 *     The metrics-configuration id is the dimension value, and AWS's own
 *     recommended alarms for S3 list the dimensions as "BucketName, FilterId".
 *     A bucket with three configurations publishes three sets of these series.
 *   - **Storage metrics cannot be filtered.** "Currently, it's not possible to
 *     get daily storage metrics for a filtered subset of objects", so a
 *     `FilterId` narrows requests and never bytes.
 *
 * On cost, concretely: eleven request-metric series polled at the 5-minute
 * collector tick is roughly $0.95 a month per metrics configuration, against the
 * roughly $4.80 a month AWS itself charges for the sixteen custom metrics a
 * configuration publishes. The free storage metrics are two series polled once a
 * day: about a hundredth of a cent. The asymmetry is the point — the expensive
 * half is the half an operator has already chosen to pay for.
 *
 * `projectMonthlyApiCost` prices a scope as (resources × every metric in the
 * pack), and one bucket becomes several rows here of which each carries only
 * part of the pack. The projection therefore reads high for S3, as it already
 * does for ECS, and `infra-cost.ts` states that is the direction it rounds in:
 * against the operator's wallet, so the number shown before saving is never an
 * underestimate. Making it exact needs the resource *composition* rather than a
 * count, which is a change to the projection's inputs and not to this pack.
 */

import { PERCENTILE_STATISTIC_TOKEN } from './types.js';
import type {
  InfraMetricApplicability,
  InfraPackAlertRule,
  InfraPackFeature,
  InfraPackMetric,
  InfraServicePack,
} from './types.js';

const NS = 'AWS/S3';

/**
 * The daily-storage series. One row per (bucket, storage class) in inventory,
 * plus one `AllStorageTypes` row per bucket for the object count.
 */
const STORAGE = Object.freeze(['BucketName', 'StorageType']);

/**
 * The request-metric series. `FilterId` is the metrics configuration's own id —
 * `EntireBucket` for a configuration with no filter, which is what the console
 * creates for "all objects in the bucket".
 */
const REQUESTS = Object.freeze(['BucketName', 'FilterId']);

/** The feature key the paid `AWS/S3` request metrics are gated on. */
export const S3_REQUEST_METRICS_FEATURE = 'requestMetrics';

/** "These storage metrics for Amazon S3 are reported once per day." */
const ONE_DAY = 86_400;

/** "The metrics are available at 1-minute intervals after some latency." */
const ONE_MINUTE = 60;

/** The `StorageType` value the object count is published at, and only there. */
export const S3_ALL_STORAGE_TYPES = 'AllStorageTypes';

const UNIVERSAL: InfraMetricApplicability = Object.freeze({ universal: true, condition: '' });

/**
 * AWS reports a request metric only when requests of that kind happened, so an
 * idle bucket produces a gap rather than a zero. Stated per metric because it
 * changes how a chart reads: a flat line at zero would mean "no errors", and
 * what is actually there is "no traffic".
 */
const OPERATION_SPECIFIC: InfraMetricApplicability = Object.freeze({
  universal: false,
  condition:
    'Reported only when requests of this type reach the bucket. AWS: "Operation-specific metrics (such as PostRequests) are reported only if there are requests of that type for your bucket or your filter." An idle bucket produces a gap, not a zero.',
});

/** AWS's documented "Valid statistics" for both daily storage metrics. */
const STORAGE_STATS = Object.freeze(['Average']);

/** The documented list for the plain request counters. */
const COUNT_ONLY = Object.freeze(['Sum']);

/**
 * The documented list for `4xxErrors` / `5xxErrors`, verbatim: "Average
 * (reports per request), Sum (reports per period), Min, Max, Sample Count".
 */
const ERROR_STATS = Object.freeze(['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount']);

/**
 * The documented list for the byte counters: "Average (bytes per request), Sum
 * (bytes per period), Sample Count, Min, Max (same as p100), any percentile
 * between p0.0 and p99.9".
 */
const BYTE_STATS = Object.freeze([
  'Average',
  'Sum',
  'SampleCount',
  'Minimum',
  'Maximum',
  PERCENTILE_STATISTIC_TOKEN,
]);

/**
 * The documented list for the two latency metrics: "Average, Sum, Min, Max
 * (same as p100), Sample Count, any percentile between p0.0 and p100".
 */
const LATENCY_STATS = Object.freeze([
  'Average',
  'Sum',
  'Minimum',
  'Maximum',
  'SampleCount',
  PERCENTILE_STATISTIC_TOKEN,
]);

/** One paid request metric, gated on the bucket having a metrics configuration. */
function requestMetric(
  metricName: string,
  metricType: InfraPackMetric['metricType'],
  stat: string,
  validStatistics: readonly string[],
  description: string,
  appliesTo: InfraMetricApplicability = UNIVERSAL,
): InfraPackMetric {
  return {
    namespace: NS,
    metricName,
    dimensions: REQUESTS,
    metricType,
    stat,
    validStatistics,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo,
    requiresFeature: S3_REQUEST_METRICS_FEATURE,
    description,
  };
}

const S3_METRICS: readonly InfraPackMetric[] = Object.freeze([
  // ── Free daily storage ───────────────────────────────────────────────────
  {
    namespace: NS,
    metricName: 'BucketSizeBytes',
    dimensions: STORAGE,
    // A level, not an accrual: this is how much is stored right now, and AWS
    // names Average as the only valid statistic for it.
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: STORAGE_STATS,
    minPeriodSeconds: ONE_DAY,
    availability: 'either',
    appliesTo: Object.freeze({
      universal: false,
      condition:
        'One series per storage class the bucket holds objects in — StandardStorage, GlacierStorage, IntelligentTieringFAStorage and the rest. There is no AllStorageTypes total for bytes: AWS publishes that filter for NumberOfObjects only, so this metric is empty on the bucket’s own object-count row and lives on its storage-class rows instead. Inventory sync discovers which classes a bucket actually reports, so a class the bucket has never used is not charted.',
    }),
    requiresFeature: null,
    description:
      'Bytes stored in this bucket in one storage class, including current and noncurrent objects, metadata, and the parts of every incomplete multipart upload. Free, and published once a day — the daily series is the storage-growth trend.',
  },
  {
    namespace: NS,
    metricName: 'NumberOfObjects',
    dimensions: STORAGE,
    // Not a name-set distinction but a value one: this metric exists at
    // AllStorageTypes and nowhere else, and BucketSizeBytes exists everywhere
    // else and not here.
    dimensionValues: Object.freeze({ StorageType: S3_ALL_STORAGE_TYPES }),
    metricType: 'gauge',
    stat: 'Average',
    validStatistics: STORAGE_STATS,
    minPeriodSeconds: ONE_DAY,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Objects in the bucket across every storage class, counting current and noncurrent objects, delete markers, and the parts of every incomplete multipart upload. A count that climbs while BucketSizeBytes does not is usually abandoned multipart uploads or delete markers rather than data.',
  },

  // ── Paid request metrics: volume ─────────────────────────────────────────
  requestMetric(
    'AllRequests',
    'counter',
    'Sum',
    COUNT_ONLY,
    'Every HTTP request to the bucket regardless of type, narrowed to the metrics configuration’s filter when it has one. This is the denominator the 4xxErrors and 5xxErrors rates are computed against, which is why it is collected even though it is the least specific counter here.',
  ),
  requestMetric(
    'GetRequests',
    'counter',
    'Sum',
    COUNT_ONLY,
    'HTTP GET requests for objects. Excludes list operations, and is incremented for the *source* of every CopyObject. Note the counter includes non-billable requests — AWS states the request metrics count GETs from CopyObject and Replication — so this is a traffic figure, not a billing one.',
    OPERATION_SPECIFIC,
  ),
  requestMetric(
    'PutRequests',
    'counter',
    'Sum',
    COUNT_ONLY,
    'HTTP PUT requests for objects, incremented for the *destination* of every CopyObject. Collected alongside GetRequests because BytesUploaded without a write count is a total with no rate behind it.',
    OPERATION_SPECIFIC,
  ),

  // ── Paid request metrics: errors, both ways ──────────────────────────────
  requestMetric(
    '4xxErrors',
    // A rate in 0..1 at this statistic, which is a level rather than a total.
    'gauge',
    'Average',
    ERROR_STATS,
    'Client-error **rate**: the share of requests in the period that returned a 4xx. AWS publishes the metric as 0 or 1 per request, so "the Average statistic shows the error rate". 403s usually mean an IAM or bucket policy problem, 404s a client asking for something that is not there.',
  ),
  requestMetric(
    '4xxErrors',
    'counter',
    'Sum',
    ERROR_STATS,
    'Client-error **count**: how many 4xx responses the bucket returned in the period. The same underlying metric as the rate above — "the Sum statistic shows the count of that type of error" — and collected separately because a 4% error rate on ten requests and on ten million are different incidents.',
  ),
  requestMetric(
    '5xxErrors',
    'gauge',
    'Average',
    ERROR_STATS,
    'Server-error **rate**: the share of requests in the period S3 could not complete. Sustained non-zero values are worth checking against the AWS service health dashboard for your Region before looking at your own code.',
  ),
  requestMetric(
    '5xxErrors',
    'counter',
    'Sum',
    ERROR_STATS,
    'Server-error **count**: how many 5xx responses S3 returned in the period. Charted beside the rate so a burst on a quiet bucket is distinguishable from a steady leak on a busy one.',
  ),

  // ── Paid request metrics: latency and bytes ──────────────────────────────
  requestMetric(
    'FirstByteLatency',
    'latency',
    'Average',
    LATENCY_STATS,
    'Milliseconds from the complete request arriving to the first byte of the response going out — S3’s own think time, independent of object size. Rising here without a matching rise in TotalRequestLatency points at S3 or at request shape rather than at the network.',
  ),
  requestMetric(
    'TotalRequestLatency',
    'latency',
    'Average',
    LATENCY_STATS,
    'Milliseconds from the first byte received to the last byte sent, so it includes transferring the request and response bodies that FirstByteLatency excludes. Grows with object size by design; compare the two before concluding S3 got slower.',
  ),
  requestMetric(
    'BytesDownloaded',
    'counter',
    'Sum',
    BYTE_STATS,
    'Bytes sent in response bodies during the period. The closest signal to the data-transfer-out line on the bill, though not the same number: transfer to another AWS service in the same Region is metered differently from transfer to the internet, and this counter does not distinguish them.',
  ),
  requestMetric(
    'BytesUploaded',
    'counter',
    'Sum',
    BYTE_STATS,
    'Bytes received in request bodies during the period. Read beside BucketSizeBytes: uploads that do not turn into stored bytes are usually overwrites, or multipart uploads that were never completed and are still being charged for.',
  ),
]);

/**
 * The request-metrics opt-in, stated as what it is: an AWS-side paid feature we
 * detect but cannot enable.
 */
const S3_FEATURES: readonly InfraPackFeature[] = Object.freeze([
  {
    key: S3_REQUEST_METRICS_FEATURE,
    label: 'S3 request metrics',
    whenOff:
      'This bucket has no CloudWatch metrics configuration, so S3 publishes no request metrics for it — request counts, 4xx and 5xx errors, latency and transferred bytes do not exist and are not collected. Daily storage metrics are unaffected: they are always on and always free. Turn request metrics on per bucket with `aws s3api put-bucket-metrics-configuration --bucket <name> --id EntireBucket --metrics-configuration Id=EntireBucket`, or from the bucket’s Metrics tab in the console. A bucket may hold up to 1,000 configurations, each one filtered by prefix, object tag or access point.',
    costNote:
      'AWS bills these on your account, not on Agent Hub: "These CloudWatch metrics are billed at the same rate as the Amazon CloudWatch custom metrics." A configuration publishes about sixteen metrics, so expect roughly $4.80 a month per configuration at the standard custom-metric rate, and multiply by the number of filters you create on the bucket. Agent Hub then polls eleven of those series at the 5-minute collector tick, which is about $0.95 a month per configuration in GetMetricData.',
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-configurations.html',
  },
]);

/**
 * Default rules (decision INFRA-ALERT).
 *
 * AWS publishes two recommended alarms for the `AWS/S3` namespace and both ship
 * verbatim, right down to their 15-of-15 shape. The third rule has no AWS
 * counterpart and says so in its own rationale: there is no published threshold
 * for how large a bucket should be, because there cannot be one.
 *
 * Every rule treats missing data as not breaching, which diverges from the
 * CloudWatch default AWS's recommendations assume. The reason is the same one
 * the NAT gateway pack gives: a rule with no `resourceKey` matches every S3 row
 * in the project, and this service has three kinds of row — storage classes,
 * object counts and request filters — of which only one publishes any given
 * series. Under `missing` the other two would sit in INSUFFICIENT_DATA forever,
 * which teaches operators that the state column is noise. Pin a rule to one
 * resource to get the console's exact behaviour.
 */
const S3_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  {
    name: 'S3 bucket 5xx error rate',
    description: 'More than 5% of requests have failed server-side for fifteen minutes.',
    namespace: NS,
    metricName: '5xxErrors',
    stat: 'Average',
    dimensions: REQUESTS,
    periodS: 60,
    threshold: 0.05,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 15,
    datapointsToAlarm: 15,
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'AWS recommended alarm, verbatim: Average, threshold 0.05, GREATER_THAN_THRESHOLD, period 60, 15 datapoints of 15. Intent: "This alarm can help to detect if the application is experiencing issues due to 5xx errors." Threshold justification: "We recommend setting the threshold to detect if more than 5% of total requests are getting 5XXError." The Average statistic is load-bearing rather than incidental — AWS publishes the metric as 0 or 1 per request, so 0.05 is five percent only on Average and would be five *errors* on Sum.',
  },
  {
    name: 'S3 bucket 4xx error rate',
    description: 'More than 5% of requests have been rejected client-side for fifteen minutes.',
    namespace: NS,
    metricName: '4xxErrors',
    stat: 'Average',
    dimensions: REQUESTS,
    periodS: 60,
    threshold: 0.05,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 15,
    datapointsToAlarm: 15,
    treatMissingData: 'notBreaching',
    // Warning rather than critical: a 4xx is the bucket correctly refusing a
    // request, so a rise is a caller or policy problem to investigate, not an
    // outage to page on. AWS frames it the same way — the intent is "to create a
    // baseline for typical 4xx error rates".
    severity: 'warning',
    rationale:
      'AWS recommended alarm, verbatim: Average, threshold 0.05, GREATER_THAN_THRESHOLD, period 60, 15 datapoints of 15. Intent: "This alarm is used to create a baseline for typical 4xx error rates so that you can look into any abnormalities that might indicate a setup issue." Threshold justification: "The recommended threshold is to detect if more than 5% of total requests are getting 4XX errors … setting a very low value for the threshold can cause alarm to be too sensitive."',
  },
  {
    name: 'S3 bucket size above a baseline you set',
    description:
      'A storage class in this bucket has grown past the size you told it to stay under.',
    namespace: NS,
    metricName: 'BucketSizeBytes',
    stat: 'Average',
    dimensions: STORAGE,
    // The metric's own publication rate. Anything finer would evaluate mostly
    // empty periods against a series that changes once a day.
    periodS: ONE_DAY,
    // 1 TiB. A unit, not a recommendation — see the rationale. The rule is a
    // form pre-fill in the rule editor, never a row anything creates on its own.
    threshold: 1_099_511_627_776,
    comparisonOperator: 'GreaterThanThreshold',
    // One daily datapoint is the whole evidence available; requiring two would
    // delay the alert by a day and tell you nothing new.
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: 'notBreaching',
    severity: 'info',
    rationale:
      'No AWS-published alarm exists for S3 storage, and no honest default threshold exists either — how large a bucket should be is a property of the workload. The 1 TiB here is a unit standing in for the number you have to supply: read a representative value off the bucket’s own BucketSizeBytes chart and replace it before applying the rule. This is a level rule, not a growth rule: the day-over-day delta needs a metric-math expression this engine does not evaluate, so the trend lives in the daily chart and the alarm watches where the trend ends up.',
  },
]);

/** The S3 pack. */
export const S3_PACK: InfraServicePack = Object.freeze({
  service: 's3',
  label: 'S3',
  metrics: S3_METRICS,
  dimensions: Object.freeze([
    {
      name: 'BucketName',
      detailedMonitoringOnly: false,
      description:
        'One bucket. Present on every S3 metric collected here, and never sufficient on its own — both halves of the namespace pair it with a second dimension.',
    },
    {
      name: 'StorageType',
      detailedMonitoringOnly: false,
      description:
        'Which storage class the daily figure is for. BucketSizeBytes is published per class (StandardStorage, GlacierStorage, IntelligentTieringFAStorage, the two Glacier overhead types, and the rest); NumberOfObjects is published at AllStorageTypes and nowhere else. Storage metrics cannot be filtered any further — AWS: "it\'s not possible to get daily storage metrics for a filtered subset of objects".',
    },
    {
      name: 'FilterId',
      detailedMonitoringOnly: false,
      description:
        'The id of the metrics configuration a request metric belongs to — `EntireBucket` for a configuration with no filter, or whatever id you gave a prefix, object-tag or access-point filter. A bucket with several configurations publishes a full set of request metrics under each of them, and each set is a separate row in inventory.',
    },
  ]),
  features: S3_FEATURES,
  absentMetrics: Object.freeze([
    {
      label: 'Request metrics on a bucket with no metrics configuration',
      reason:
        'Request counts, 4xx and 5xx errors, latency and transferred bytes exist only while a CloudWatch metrics configuration is present on the bucket. AWS: "Metrics configurations are necessary only to enable request metrics. Bucket-level daily storage metrics are always turned on, and are provided at no additional cost." Inventory sync reads the configurations on every hourly sweep, so this is detected rather than assumed, and a bucket with none is never billed a GetMetricData entry for a series that does not exist.',
      remedy:
        'Create one — `aws s3api put-bucket-metrics-configuration --bucket <name> --id EntireBucket --metrics-configuration Id=EntireBucket` covers the whole bucket. AWS bills the resulting metrics at the custom-metric rate; see the request-metrics feature note for the figures. The series start appearing within about fifteen minutes and Agent Hub picks the configuration up on the next hourly inventory sweep.',
    },
    {
      label: 'A storage-growth alarm (day over day)',
      reason:
        'Growth is a derivative, and CloudWatch publishes only the level. Alarming on the change between two daily datapoints needs a metric-math expression, which this rule engine does not evaluate.',
      remedy:
        'The daily BucketSizeBytes series *is* the growth trend — chart it and the slope is the answer. For an alarm, use the shipped "S3 bucket size above a baseline you set" rule with a threshold read off that chart, which catches the same runaway a percentage-growth alarm would, one day later and with no false positives from a quiet week.',
    },
    {
      label: 'BucketSizeBytes for a storage class the bucket has only just started using',
      reason:
        'Which storage classes to chart is discovered from CloudWatch ListMetrics, which "doesn\'t return information about metrics if those metrics haven\'t reported data in the past two weeks" — and S3 reports storage metrics once a day. A class used for the first time today therefore has no series to discover until its first daily report lands.',
      remedy:
        'Wait. Inventory sync re-discovers storage classes hourly, so the class appears within an hour of its first daily datapoint and back-collects with the next daily poll. Nothing needs configuring; the same mechanism drops a class again once it has been empty for two weeks.',
    },
    {
      label: 'Per-prefix, per-tag or per-object storage size',
      reason:
        'AWS states it outright: "Currently, it\'s not possible to get daily storage metrics for a filtered subset of objects." A metrics configuration\'s prefix, tag and access-point filters narrow request metrics only; the StorageType dimension is the finest cut CloudWatch offers on bytes.',
      remedy:
        'Use S3 Storage Lens for prefix-level and account-wide storage analytics, or an S3 Inventory report queried with Athena when you need the object list itself. Neither is a CloudWatch metric, so neither can be alarmed on here.',
    },
    {
      label: 'Replication metrics (ReplicationLatency, OperationsFailedReplication and friends)',
      reason:
        'They are keyed on SourceBucket + DestinationBucket + RuleId — a replication *rule*, not a bucket — and are published only for rules that have S3 Replication Time Control or replication metrics enabled. Inventory has no replication-rule rows to hang that dimension set on, so the series are not collected.',
      remedy:
        "Build it in the CloudWatch console with AWS's recommended shape: OperationsFailedReplication, Maximum, GreaterThanThreshold, threshold 0.0, period 60, 5 datapoints of 5. Set missing-data treatment to *ignore* — the S3 docs call for it specifically, because the metric emits nothing at all during a minute with no replication activity.",
    },
    {
      label: 'S3 Storage Lens metrics',
      reason:
        'Storage Lens publishes to its own AWS/S3/Storage-Lens namespace, only for dashboards upgraded to advanced metrics and recommendations, and only when the CloudWatch publishing option is switched on. It is a separate paid product rather than a mode of the metrics above.',
      remedy:
        'Enable advanced metrics and CloudWatch publishing on a Storage Lens dashboard and read them in the CloudWatch console. Agent Hub does not collect them: the namespace is organisation-scoped where every scope here is (account, region, service), so it does not fit the inventory model without its own resource kind.',
    },
    {
      label:
        'The remaining request counters (DeleteRequests, HeadRequests, PostRequests, ListRequests, Select*)',
      reason:
        'A metrics configuration publishes all of them and Agent Hub deliberately collects eleven of the sixteen. Each additional series is a separately billed GetMetricData entry on every tick, and AWS reports operation-specific metrics "only if there are requests of that type", so on most buckets the extras would be permanently empty charts at a permanent cost.',
      remedy:
        'They are already being published — nothing needs enabling. Read them in the CloudWatch console under the same metrics configuration, or open a ticket to add one to this pack if it is load-bearing for your workload.',
    },
    {
      label: 'Directory buckets (S3 Express One Zone)',
      reason:
        'Inventory comes from ListBuckets, which AWS documents as "not supported for directory buckets". A directory bucket is therefore never discovered, so nothing is collected for it even though it does publish an ExpressOneZoneStorage figure.',
      remedy:
        'None here. Directory buckets are enumerated by a different API (ListDirectoryBuckets) and would need their own inventory path and resource kind.',
    },
  ]),
  defaultAlertRules: S3_DEFAULT_ALERT_RULES,
});
