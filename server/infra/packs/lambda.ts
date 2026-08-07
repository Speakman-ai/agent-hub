/**
 * Lambda pack — the service where AWS tells you which statistic to use.
 *
 * Every entry is traceable to the Lambda developer guide's *Monitoring
 * functions with CloudWatch metrics*, *Lambda function metric types* and
 * *Viewing metrics in the console* pages, and to the CloudWatch *recommended
 * alarms* page's Lambda section (verified August 2026).
 *
 * Lambda is the one service in this epic where the statistic question is
 * answered in the documentation rather than inferred from a unit, and the
 * answers come in three groups that this pack follows exactly:
 *
 *   - **Invocation metrics are binary per invocation.** AWS: "Invocation metrics
 *     are binary indicators of the outcome of a Lambda function invocation. View
 *     these metrics with the `Sum` statistic. For example, if the function
 *     returns an error, then Lambda sends the `Errors` metric with a value of 1."
 *     So `Invocations`, `Errors`, `Throttles`, `AsyncEventsReceived` and
 *     `AsyncEventsDropped` are counters stored on `Sum` and nothing else, and
 *     `validStatistics` is `['Sum']` for each. An Average of `Errors` is an
 *     error *rate*, which is a different and mostly less useful number, and a
 *     Maximum of it is always 1.
 *   - **Performance metrics describe one invocation.** AWS: "To get a sense of
 *     how fast your function processes events, view these metrics with the
 *     `Average` or `Max` statistic", and, specifically for `Duration`,
 *     "`Duration` also supports percentile (`p`) statistics. Use percentiles to
 *     exclude outlier values that skew `Average` and `Maximum` statistics."
 *   - **Concurrency metrics are aggregate counts.** AWS: "To see how close you
 *     are to hitting concurrency limits, view these metrics with the `Max`
 *     statistic."
 *
 * `Duration` is therefore declared three times, which is the only place this
 * pack spends more than one series on a metric. Each answers a question the
 * other two cannot: `Average` is the trend and the thing the bill tracks,
 * `Maximum` is the timeout detector — a function whose maximum is walking toward
 * its configured timeout is about to start failing, and a percentile is
 * specifically designed to hide that — and `p90` is the statistic AWS's own
 * recommended alarm evaluates, because it excludes the outlier the Maximum
 * exists to surface. Three billed entries per function per tick is the price of
 * not having to pick one, and it is stated here rather than discovered later.
 *
 * Metrics are free and 1-minute: "there's no additional charge for these
 * metrics" and "Lambda sends metric data to CloudWatch in 1-minute intervals".
 * The cost of monitoring Lambda is entirely our own `GetMetricData` bill, which
 * is why the metric list is twelve series rather than the twenty AWS publishes.
 *
 * Two things are worth reading before trusting a chart here.
 *
 * **`ProvisionedConcurrencyUtilization` is not emitted when the function is
 * idle**, and AWS says so with an explicit warning attached: "If your function
 * is inactive or not receiving requests, Lambda doesn't emit this metric because
 * it is based on `ProvisionedConcurrentExecutions`. Keep this in mind if you use
 * `ProvisionedConcurrencyUtilization` as the basis for CloudWatch alarms." A
 * function with no provisioned concurrency configured never emits it at all. Its
 * default rule therefore treats missing data as **not breaching**, which is what
 * keeps it out of a permanent INSUFFICIENT_DATA state on every function in the
 * scope that does not use the feature.
 *
 * **The async backlog signal is a comparison, not a metric.** AWS: "Mismatches
 * between `AsyncEventsReceived` and `Invocations` can indicate a disparity in
 * processing, events being dropped, or a potential queue backlog." Both sides
 * are collected here so the comparison can be charted, but the difference itself
 * needs a metric-math expression that this rule engine does not evaluate — see
 * `absentMetrics`. `AsyncEventAge` is the alarmable proxy, and it is collected.
 */

import { PERCENTILE_STATISTIC_TOKEN } from './types.js';
import type {
  InfraMetricApplicability,
  InfraPackAlertRule,
  InfraPackMetric,
  InfraServicePack,
} from './types.js';

const NS = 'AWS/Lambda';

/**
 * The function-level series. One row per function in inventory.
 *
 * `FunctionName` aggregates "all versions and aliases of a function", which is
 * the level a resource row exists at. The three finer dimensions AWS documents —
 * `Resource`, `ExecutedVersion` and `EventSourceMappingUUID` — slice below a
 * function, and inventory holds functions.
 */
const FUNCTION = Object.freeze(['FunctionName']);

/** "Lambda sends metric data to CloudWatch in 1-minute intervals." */
const ONE_MINUTE = 60;

const UNIVERSAL: InfraMetricApplicability = Object.freeze({ universal: true, condition: '' });

/**
 * The three statistic lists below are narrow on purpose.
 *
 * Lambda, like RDS and unlike EC2 or S3, publishes no per-metric "Valid
 * statistics" column. What it publishes instead is a recommendation per metric
 * *group*, in prose, and each of the three is quoted verbatim on the list it
 * produces. So these lists say what AWS names and stop there: adding `Minimum`
 * to a group AWS describes as "Average or Max" would be this pack's opinion
 * wearing the documentation's clothes, and `isStatisticDocumented` would then
 * wave through a statistic nobody vouched for.
 */

/**
 * "Invocation metrics are binary indicators... View these metrics with the `Sum`
 * statistic." AWS names exactly one, and so does this.
 */
const COUNT_ONLY = Object.freeze(['Sum']);

/**
 * `Duration`: "view these metrics with the `Average` or `Max` statistic", plus
 * the metric-specific "`Duration` also supports percentile (`p`) statistics".
 */
const DURATION_STATS = Object.freeze(['Average', 'Maximum', PERCENTILE_STATISTIC_TOKEN]);

/**
 * The rest of the performance group, which gets the same sentence as `Duration`
 * but not its percentile note: "To get a sense of how fast your function
 * processes events, view these metrics with the `Average` or `Max` statistic."
 */
const PERFORMANCE_STATS = Object.freeze(['Average', 'Maximum']);

/**
 * "To see how close you are to hitting concurrency limits, view these metrics
 * with the `Max` statistic." One statistic named, one recorded — an average
 * concurrency over a minute answers a question nobody asked, because a quota is
 * breached by a peak.
 */
const CONCURRENCY_STATS = Object.freeze(['Maximum']);

/** Only functions wired to a stream or queue event source publish these. */
const STREAM_SOURCED: InfraMetricApplicability = Object.freeze({
  universal: false,
  condition:
    'Published only for functions with a DynamoDB, Kinesis or Amazon DocumentDB event source mapping. AWS scopes the metric to exactly those: "For DynamoDB, Kinesis, and Amazon DocumentDB event sources, the age of the last record in the event in milliseconds." A function invoked over HTTP, by EventBridge, or synchronously by another service is silent on this series, and so is a Kafka-sourced function — Kafka reports OffsetLag instead.',
});

/** Only asynchronously invoked functions publish these. */
const ASYNC_INVOKED: InfraMetricApplicability = Object.freeze({
  universal: false,
  condition:
    'Published only for asynchronous invocations — the ones Lambda queues internally before running, such as S3 notifications, SNS and EventBridge. A function that is only ever invoked synchronously (an API Gateway or Function URL request, a direct RequestResponse call) never enters that queue and never publishes this series.',
});

const LAMBDA_METRICS: readonly InfraPackMetric[] = Object.freeze([
  // ── Invocation metrics: binary per invocation, Sum and only Sum ───────────
  {
    namespace: NS,
    metricName: 'Invocations',
    dimensions: FUNCTION,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: COUNT_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Times the function code ran, successful or not. AWS: "The value of Invocations equals the number of requests billed", so this is the closest series to the invocation line on the bill. It deliberately excludes throttled and otherwise-rejected requests — those never reached your code — which is why Throttles is charted separately rather than being a subset of this.',
  },
  {
    namespace: NS,
    metricName: 'Errors',
    dimensions: FUNCTION,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: COUNT_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Invocations that ended in a function error — an exception your code threw, or one the runtime threw for a timeout or a configuration problem. Divide by Invocations for the error rate. One trap worth knowing: AWS notes "the timestamp on an error metric reflects when the function was invoked, not when the error occurred", so a fifteen-minute function’s errors land fifteen minutes earlier on the chart than they happened.',
  },
  {
    namespace: NS,
    metricName: 'Throttles',
    dimensions: FUNCTION,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: COUNT_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Invocation requests Lambda rejected because no concurrency was available — the account’s regional quota or the function’s own reserved concurrency was already fully used. These are counted here and nowhere else: AWS is explicit that "throttled requests and other invocation errors don’t count as either Invocations or Errors", so a function can be dropping traffic with a flat error chart.',
  },

  // ── Performance metrics: one invocation each, Average / Max / percentiles ──
  {
    namespace: NS,
    metricName: 'Duration',
    dimensions: FUNCTION,
    metricType: 'latency',
    stat: 'Average',
    validStatistics: DURATION_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Average milliseconds the function spent processing an event. The trend line, and the one that tracks cost most closely — AWS bills the duration of each invocation rounded up to the nearest millisecond. It excludes cold start time, so a function whose users complain about latency the chart does not show is usually paying for initialisation rather than execution.',
  },
  {
    namespace: NS,
    metricName: 'Duration',
    dimensions: FUNCTION,
    metricType: 'latency',
    stat: 'Maximum',
    validStatistics: DURATION_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Slowest single invocation in the period. The timeout detector: a function’s configured timeout defaults to 3 seconds and can be raised to 900, and a Maximum walking toward whichever value you set is the warning that invocations are about to start failing outright. Percentile statistics are specifically designed to hide this datapoint, which is why it is collected beside them rather than instead of them.',
  },
  {
    namespace: NS,
    metricName: 'Duration',
    dimensions: FUNCTION,
    metricType: 'latency',
    stat: 'p90',
    validStatistics: DURATION_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Milliseconds that nine invocations in ten came in under. The statistic AWS’s own recommended Duration alarm evaluates, and the one to alarm on rather than the Maximum: AWS frames percentiles as a way to "exclude outlier values that skew Average and Maximum statistics", so a single pathological request does not page anyone while a genuine regression still does.',
  },
  {
    namespace: NS,
    metricName: 'IteratorAge',
    dimensions: FUNCTION,
    metricType: 'latency',
    // Maximum: the worst-lagging shard is the one that decides whether records
    // fall off the end of the stream, and an average across shards hides it.
    stat: 'Maximum',
    validStatistics: PERFORMANCE_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: STREAM_SOURCED,
    requiresFeature: null,
    description:
      'Milliseconds between a stream receiving the last record in a batch and the event source mapping handing it to your function. This is stream backlog: a value that climbs steadily means the function is consuming slower than producers are writing, and the record at the head of the stream will eventually age past the stream’s retention and be lost unread. Collected on Maximum because one lagging shard is enough to lose data.',
  },

  // ── Concurrency: aggregate counts, Max ───────────────────────────────────
  {
    namespace: NS,
    metricName: 'ConcurrentExecutions',
    dimensions: FUNCTION,
    metricType: 'gauge',
    stat: 'Maximum',
    validStatistics: CONCURRENCY_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Function instances processing events at once, at the period’s peak. AWS: "If this number reaches your concurrent executions quota for the Region, or the reserved concurrency limit on the function, then Lambda throttles additional invocation requests" — so this is the leading indicator for the Throttles series, and the one that gives you time to act. Maximum rather than Average because a quota is breached by a peak, not by a mean.',
  },
  {
    namespace: NS,
    metricName: 'ProvisionedConcurrencyUtilization',
    dimensions: FUNCTION,
    metricType: 'gauge',
    stat: 'Maximum',
    validStatistics: CONCURRENCY_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: Object.freeze({
      universal: false,
      condition:
        'Published only while a function that has provisioned concurrency configured is actively receiving requests. AWS states both halves and attaches a warning to the second: "If your function is inactive or not receiving requests, Lambda doesn’t emit this metric because it is based on ProvisionedConcurrentExecutions. Keep this in mind if you use ProvisionedConcurrencyUtilization as the basis for CloudWatch alarms." A function with no provisioned concurrency at all is therefore permanently silent here, and an idle one goes silent between bursts — which is why the shipped rule treats missing data as not breaching rather than leaving it in INSUFFICIENT_DATA. The query is still issued for every function in the scope, because whether a function has provisioned concurrency configured is not recorded on the inventory row; making it free for the functions that do not use it needs a per-function ListProvisionedConcurrencyConfigs read at inventory time and a feature flag, the same shape S3 request metrics already use.',
    }),
    requiresFeature: null,
    description:
      'How much of the provisioned concurrency you are paying for is in use, as a fraction from 0 to 1. AWS defines it as "the value of ProvisionedConcurrentExecutions divided by the total amount of provisioned concurrency configured". Saturation is the thing to watch: once this reaches 1 the next invocation spills onto standard on-demand concurrency and pays a cold start, which is the exact latency you bought provisioned concurrency to avoid.',
  },

  // ── Asynchronous invocation queue ────────────────────────────────────────
  {
    namespace: NS,
    metricName: 'AsyncEventsReceived',
    dimensions: FUNCTION,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: COUNT_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: ASYNC_INVOKED,
    requiresFeature: null,
    description:
      'Events Lambda successfully queued for asynchronous processing. Collected specifically so it can be read against Invocations, which is AWS’s own recommended backlog check: "Mismatches between AsyncEventsReceived and Invocations can indicate a disparity in processing, events being dropped, or a potential queue backlog." Received climbing while Invocations stays flat is the shape of a queue filling up.',
  },
  {
    namespace: NS,
    metricName: 'AsyncEventAge',
    dimensions: FUNCTION,
    metricType: 'latency',
    stat: 'Maximum',
    validStatistics: PERFORMANCE_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: ASYNC_INVOKED,
    requiresFeature: null,
    description:
      'Milliseconds an event waited in Lambda’s internal queue before the function was invoked. The alarmable form of the received-versus-invoked comparison, and the one that needs no metric math. AWS: "The value of this metric increases when events are being retried due to invocation failures or throttling" — so when this climbs, read Errors and Throttles next, in that order.',
  },
  {
    namespace: NS,
    metricName: 'AsyncEventsDropped',
    dimensions: FUNCTION,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: COUNT_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: ASYNC_INVOKED,
    requiresFeature: null,
    description:
      'Events discarded without the function ever running successfully. This is data loss, and the only series in the pack where any non-zero value is unambiguously bad. Events are dropped for exceeding the maximum event age, exhausting the retry attempts, or reserved concurrency being set to 0. A dead-letter queue or an OnFailure destination catches them before the drop, so a non-zero count here with a DLQ configured means the DLQ delivery failed too.',
  },
]);

/**
 * Default rules (decision INFRA-ALERT).
 *
 * AWS publishes five recommended alarms for `AWS/Lambda`. Four of them are over
 * a metric this pack collects and ship with AWS's statistic, period, comparison
 * operator and M-of-N verbatim; the fifth, `ClaimedAccountConcurrency`, is
 * dimensionless and cannot be bound to a resource row — see `absentMetrics`.
 *
 * Three further rules have no AWS counterpart and say so in their own rationale.
 * Two of the three carry a threshold that is genuinely derivable rather than
 * invented — `AsyncEventsDropped` alarms above zero because any dropped event is
 * lost data, and `ProvisionedConcurrencyUtilization` alarms at 0.9 because AWS
 * defines the metric as a fraction of what you configured. The third,
 * `IteratorAge`, carries a stand-in and labels it.
 *
 * Missing-data treatment splits the same way it does in the RDS pack. It is
 * `missing` — CloudWatch's own default, so our state column matches the console
 * an operator will diff it against — for the metrics every function emits, and
 * `notBreaching` for the four series that only exist on a function with a stream
 * source, an async invoker, or provisioned concurrency. An unpinned rule matches
 * every function in the scope, and under `missing` the majority that structurally
 * cannot publish the series would sit in INSUFFICIENT_DATA forever.
 */
const LAMBDA_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  {
    name: 'Lambda function erroring',
    description: 'The function has returned errors in three consecutive minutes.',
    namespace: NS,
    metricName: 'Errors',
    stat: 'Sum',
    dimensions: FUNCTION,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    treatMissingData: 'missing',
    severity: 'critical',
    rationale:
      'AWS recommended alarm, verbatim: Sum, GREATER_THAN_THRESHOLD, period 60, 3 datapoints of 3. Intent: "The alarm helps detect high error counts in function invocations." Threshold justification: "Set the threshold to a number greater than zero. The exact value can depend on the tolerance for errors in your application... For some applications, any error might be unacceptable, while other applications might allow for a certain margin of error." Zero with GreaterThanThreshold is the strictest reading of that and the right default, because the 3-of-3 shape already filters a single bad request: it fires on errors in three consecutive minutes, not on three errors.',
  },
  {
    name: 'Lambda function being throttled',
    description: 'Invocation requests have been rejected for lack of concurrency for five minutes.',
    namespace: NS,
    metricName: 'Throttles',
    stat: 'Sum',
    dimensions: FUNCTION,
    periodS: 60,
    threshold: 1,
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'missing',
    severity: 'critical',
    rationale:
      'AWS recommended alarm, verbatim: Sum, GREATER_THAN_OR_EQUAL_TO_THRESHOLD, period 60, 5 datapoints of 5. Intent: "It is important to know if requests are constantly getting rejected due to throttling and if you need to improve Lambda function performance or increase concurrency capacity to avoid constant throttling." Threshold justification: "Set the threshold to a number greater than zero." With the inclusive operator AWS specifies, that is 1 — one throttled request in each of five consecutive minutes. Critical rather than warning because a throttle is traffic the function never saw: it is dropped work, not slow work.',
  },
  {
    name: 'Lambda function running long',
    description:
      'Nine invocations in ten have taken longer than the budget you set, for fifteen minutes.',
    namespace: NS,
    metricName: 'Duration',
    stat: 'p90',
    dimensions: FUNCTION,
    periodS: 60,
    // 3,000 ms — Lambda's own default function timeout. A unit, not a
    // recommendation; see the rationale.
    threshold: 3_000,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 15,
    datapointsToAlarm: 15,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS recommended alarm shape, verbatim: p90, GREATER_THAN_THRESHOLD, period 60, 15 datapoints of 15. Intent: "High runtime duration indicates that a function is taking a longer time for invocation, and can also impact the concurrency capacity of invocation if Lambda is handling a higher number of events." AWS gives no fixed threshold and one hard constraint: "Make sure to set the threshold lower than the configured function timeout." The 3,000 ms here is Lambda’s own default timeout — "the default value for this setting is 3 seconds", raisable to 900 — so it is the ceiling every function starts with and a unit standing in for your own number. Replace it with a value below your configured timeout, read off the function’s own Duration chart.',
  },
  {
    name: 'Lambda function approaching the concurrency quota',
    description:
      'Concurrent executions have been near the account’s regional quota for ten minutes.',
    namespace: NS,
    metricName: 'ConcurrentExecutions',
    stat: 'Maximum',
    dimensions: FUNCTION,
    periodS: 60,
    // 900 = 90% of the default 1,000 regional quota, which is AWS's own
    // arithmetic applied to AWS's own default.
    threshold: 900,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 10,
    datapointsToAlarm: 10,
    treatMissingData: 'missing',
    severity: 'warning',
    rationale:
      'AWS recommended alarm, verbatim: Maximum, GREATER_THAN_THRESHOLD, period 60, 10 datapoints of 10. Intent: "This alarm can proactively detect if the concurrency of the function is approaching the Region-level concurrency quota of your account, so that you can act on it. A function is throttled if it reaches the Region-level concurrency quota of the account." Threshold justification: "Set the threshold to about 90% of the concurrency quota set for the account in the Region. By default, your account has a concurrency quota of 1,000 across all functions in a Region." 900 is that arithmetic on that default; check your own quota in Service Quotas, since it can be raised. AWS also points at a better metric that this pack cannot collect: "To get better visibility on reserved concurrency and provisioned concurrency utilization, set an alarm on the new metric ClaimedAccountConcurrency instead" — which is dimensionless, so see absentMetrics.',
  },
  {
    name: 'Lambda dropping asynchronous events',
    description: 'Queued events were discarded without the function ever running successfully.',
    namespace: NS,
    metricName: 'AsyncEventsDropped',
    stat: 'Sum',
    dimensions: FUNCTION,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    // One datapoint: a dropped event is already lost, so waiting for a second
    // minute of loss to confirm the first buys nothing.
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'No AWS-published alarm exists for this metric, but the threshold is not a judgement call: AWS defines the series as "the number of events that are dropped without successfully executing the function", so any non-zero value is work that was accepted and then lost. Events drop for exceeding the maximum event age, exhausting the retry attempts, or reserved concurrency being set to 0. If a dead-letter queue or OnFailure destination is configured, events reach it before being dropped — so a non-zero count on a function that has one means the DLQ delivery failed as well, and DeadLetterErrors is worth reading in the console beside this. Missing data is not breaching because only asynchronously invoked functions publish the series at all.',
  },
  {
    name: 'Lambda asynchronous queue backing up',
    description: 'Queued events have waited longer than the budget you set before being processed.',
    namespace: NS,
    metricName: 'AsyncEventAge',
    stat: 'Maximum',
    dimensions: FUNCTION,
    periodS: 60,
    // 300,000 ms = 5 minutes. A unit, not a recommendation.
    threshold: 300_000,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'No AWS-published alarm exists for this metric, though AWS does recommend alarming on it: "Monitor this metric and set alarms for thresholds on different statistics for when a queue buildup occurs." It gives no number, because how stale a queued event may get is a property of the workload. The 300,000 ms here is five minutes and a unit standing in for your own freshness budget — replace it with the age at which acting on an event stops being useful. This is the alarmable form of AWS’s AsyncEventsReceived-versus-Invocations backlog check, which needs metric math this engine does not evaluate. When it fires, read Errors and Throttles: AWS notes the age "increases when events are being retried due to invocation failures or throttling".',
  },
  {
    name: 'Lambda stream consumer falling behind',
    description: 'The oldest unprocessed stream record has been older than the budget you set.',
    namespace: NS,
    metricName: 'IteratorAge',
    stat: 'Maximum',
    dimensions: FUNCTION,
    periodS: 60,
    // 60,000 ms = 1 minute. A unit, not a recommendation.
    threshold: 60_000,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'No AWS-published alarm exists for this metric and no honest default threshold does either — acceptable stream lag is a property of the workload, and the number that actually matters is the stream’s retention period, since a record that ages past it is lost unread. The 60,000 ms here is one minute and a unit standing in for your own number: read a representative value off the function’s own IteratorAge chart and set the threshold above the normal peak but far below the retention. Maximum is the statistic because one lagging shard is enough to lose data. Missing data is not breaching because only functions with a DynamoDB, Kinesis or DocumentDB event source publish the series.',
  },
  {
    name: 'Lambda provisioned concurrency saturated',
    description:
      'Provisioned concurrency has been over 90% used, so invocations are about to spill to on-demand.',
    namespace: NS,
    metricName: 'ProvisionedConcurrencyUtilization',
    stat: 'Maximum',
    dimensions: FUNCTION,
    periodS: 60,
    threshold: 0.9,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    // The metric is documented as not emitted when the function is idle, and
    // absent entirely on a function with no provisioned concurrency. This is
    // the field that keeps the rule out of a permanent INSUFFICIENT_DATA state.
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'No AWS-published alarm exists for this metric, but the threshold follows from AWS’s own definition of it: "the value of ProvisionedConcurrentExecutions divided by the total amount of provisioned concurrency configured", a fraction from 0 to 1. So 0.9 is 90% of the capacity you are already paying for, and the reason it matters is what happens at 1 — the next invocation runs on standard on-demand concurrency and pays a cold start, which is the latency provisioned concurrency was bought to eliminate. Missing data is not breaching, and that is load-bearing rather than a preference: AWS warns that "if your function is inactive or not receiving requests, Lambda doesn’t emit this metric... Keep this in mind if you use ProvisionedConcurrencyUtilization as the basis for CloudWatch alarms." Under the CloudWatch default of missing, this rule would sit in INSUFFICIENT_DATA on every idle function and on every function that does not use provisioned concurrency at all.',
  },
]);

/** The Lambda pack. */
export const LAMBDA_PACK: InfraServicePack = Object.freeze({
  service: 'lambda',
  label: 'Lambda',
  metrics: LAMBDA_METRICS,
  dimensions: Object.freeze([
    {
      name: 'FunctionName',
      // Lambda has no basic-vs-detailed monitoring split; the flag exists for
      // EC2's sake.
      detailedMonitoringOnly: false,
      description:
        'One function, aggregated across every version and alias of it — AWS: "View aggregate metrics for all versions and aliases of a function." The only dimension collected, because it is the level a resource row exists at.',
    },
    {
      name: 'Resource',
      detailedMonitoringOnly: false,
      description:
        'A single version or alias of a function. Documented rather than collected: inventory holds functions, and a per-alias breakdown would multiply both the row count and the GetMetricData bill by however many aliases a deployment happens to keep.',
    },
    {
      name: 'ExecutedVersion',
      detailedMonitoringOnly: false,
      description:
        'A version reached through an alias, which is what makes a weighted-alias comparison possible — AWS: "Use the ExecutedVersion dimension to compare error rates for two versions of a function that are both targets of a weighted alias." Documented rather than collected: it exists to answer a question about one deploy in progress, not to be charted continuously.',
    },
    {
      name: 'EventSourceMappingUUID',
      detailedMonitoringOnly: false,
      description:
        'One event source mapping, for a function consuming from more than one stream or queue. Documented rather than collected — inventory has no event-source-mapping rows, so IteratorAge is collected at the function level, where it already reports the worst-lagging source.',
    },
  ]),
  // Lambda metrics are free and unconditional: "there's no additional charge for
  // these metrics", with no per-function opt-in to detect. Lambda Insights is
  // paid but publishes into its own LambdaInsights namespace rather than gating
  // anything here — see absentMetrics.
  features: Object.freeze([]),
  absentMetrics: Object.freeze([
    {
      label: 'ClaimedAccountConcurrency, and account-wide concurrency headroom generally',
      reason:
        'AWS publishes a recommended alarm for it and explicitly prefers it to the ConcurrentExecutions alarm this pack ships — but the metric is dimensionless. It is one number for a whole Region, defined as UnreservedConcurrentExecutions plus all allocated concurrency, and every metric here has to bind to a resource row through a dimension set. There is no Lambda function it belongs to. UnreservedConcurrentExecutions is absent for the same reason.',
      remedy:
        'Build it in the CloudWatch console with AWS’s recommended shape: ClaimedAccountConcurrency, Maximum, GREATER_THAN_THRESHOLD, period 60, 10 datapoints of 10, threshold at about 90% of your account’s regional concurrency quota. Collecting it here needs a region-scoped resource kind — a row that stands for "this account in this region" rather than for a resource — which is a change to the inventory model rather than to this pack.',
    },
    {
      label: 'The AsyncEventsReceived versus Invocations backlog comparison, as an alarm',
      reason:
        'It is AWS’s own recommended check — "mismatches between AsyncEventsReceived and Invocations can indicate a disparity in processing, events being dropped, or a potential queue backlog" — but the signal is the difference between two series, and expressing that needs a metric-math expression this rule engine does not evaluate. It compares stored datapoints against a threshold, one series at a time.',
      remedy:
        'Both series are collected, so chart them together and the divergence is visible directly. For an alarm, use the shipped "Lambda asynchronous queue backing up" rule on AsyncEventAge, which catches the same backlog from the other side and needs no arithmetic: if received events are not being invoked, the ones waiting get older.',
    },
    {
      label: 'Memory used, and whether the function is over-provisioned',
      reason:
        'Lambda publishes no memory metric to the AWS/Lambda namespace at all. Actual memory used is written to the function’s CloudWatch Logs REPORT line at the end of every invocation, and turned into a metric only by Lambda Insights, which is a separate paid feature publishing into its own LambdaInsights namespace under a function_name dimension.',
      remedy:
        'Enable Lambda Insights on the function if you want it as a metric; AWS bills it as custom metrics on your account. AWS’s recommended alarm for it is memory_utilization, Average, GREATER_THAN_THRESHOLD, threshold 90, period 60, 10 datapoints of 10. Without it, the REPORT lines are already in CloudWatch Logs and can be read there — the max-memory-used figure against the configured size is the over-provisioning answer.',
    },
    {
      label: 'Cold starts, and init duration',
      reason:
        'There is no cold-start metric. AWS documents Duration as excluding initialisation outright — "Duration does not include cold start time" — so a function with slow initialisation looks fast on every series in this pack while its callers wait.',
      remedy:
        'Init duration is reported per invocation in the CloudWatch Logs REPORT line and as a segment in an AWS X-Ray trace. For the concurrency side of the same question, ProvisionedConcurrencySpilloverInvocations counts invocations that ran on standard concurrency because provisioned concurrency was exhausted — every one of those paid a cold start. It is published and readable in the console; it is not collected here.',
    },
    {
      label: 'DeadLetterErrors and DestinationDeliveryFailures',
      reason:
        'Both are published and neither is collected. They are the second-order failures of the async path — Lambda tried to hand a failed event to a dead-letter queue or an OnFailure destination and could not — and each additional series is a separately billed GetMetricData entry on every tick for every function in the scope, on most of which the value is permanently zero because no DLQ is configured.',
      remedy:
        'Read them in the CloudWatch console under the same FunctionName dimension. The shipped AsyncEventsDropped rule is the backstop: an event that Lambda could not deliver to a DLQ is an event that then gets dropped, so the drop count fires even when the delivery failure is not charted.',
    },
    {
      label: 'OffsetLag, for Kafka-sourced functions',
      reason:
        'Kafka and Amazon MSK event sources report backlog as OffsetLag — the offset difference between the last record written to a topic and the last one the consumer group processed — rather than as IteratorAge, which AWS scopes to DynamoDB, Kinesis and DocumentDB. A Kafka-sourced function is therefore silent on the IteratorAge series this pack collects.',
      remedy:
        'Read OffsetLag in the CloudWatch console under FunctionName, or open a ticket to add it to this pack. Note it is a record count rather than a duration, so it cannot share an axis or a threshold with IteratorAge — it needs its own rule.',
    },
    {
      label: 'Per-version and per-alias breakdowns',
      reason:
        'Every series here is keyed on FunctionName, which AWS defines as aggregating "all versions and aliases of a function". A canary alias serving 5% of traffic and erroring on all of it is a 5% error rate at this level, not a 100% one.',
      remedy:
        'Use the Resource and ExecutedVersion dimensions in the CloudWatch console during a weighted-alias rollout — that is exactly what AWS documents ExecutedVersion for. Collecting them here would need alias rows in inventory and would multiply the per-function query cost by the alias count.',
    },
  ]),
  defaultAlertRules: LAMBDA_DEFAULT_ALERT_RULES,
});
