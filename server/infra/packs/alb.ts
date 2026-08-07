/**
 * Application Load Balancer pack — the service where an empty chart is the
 * normal, healthy state.
 *
 * Every entry is traceable to the ELB *CloudWatch metrics for your Application
 * Load Balancer* page (verified August 2026). Where habit disagrees with the
 * docs, the docs win.
 *
 * Three facts shape every declaration below.
 *
 * **1. No traffic means no datapoint — not a zero.** AWS states it in the first
 * paragraph of the metrics page: "Elastic Load Balancing reports metrics to
 * CloudWatch only when requests are flowing through the load balancer. If there
 * are requests flowing through the load balancer, Elastic Load Balancing
 * measures and sends its metrics in 60-second intervals. If there are no
 * requests flowing through the load balancer or no data for a metric, the
 * metric is not reported." Most metrics here narrow it further with a per-metric
 * **Reporting criteria** of "There is a nonzero value" — an ALB serving traffic
 * with no errors publishes *nothing at all* for `HTTPCode_ELB_5XX_Count`.
 *
 * That is why every rule in this pack sets `treatMissingData` explicitly, and
 * why every one of them sets it to `notBreaching`. Under the CloudWatch default
 * of `missing` a healthy load balancer would sit in INSUFFICIENT_DATA
 * permanently, which is how operators learn to stop reading the state column.
 * It also makes the error rules *safe to leave unpinned*: a rule with no
 * `resourceKey` matches every ALB resource in the project, including the
 * target-group rows that never publish load-balancer-level series.
 *
 * The cost of that choice, stated plainly because operators will diff our state
 * against the console: a load balancer that has stopped receiving traffic
 * entirely — because DNS moved, or the listener was deleted — reads OK here
 * rather than INSUFFICIENT_DATA. Detecting *that* needs a rule on the absence of
 * `RequestCount`, which is a different alarm shape than this engine evaluates.
 * See the `absentMetrics` entry.
 *
 * **2. Host counts are keyed on the target group, never on the load balancer
 * alone.** AWS publishes `HealthyHostCount` / `UnHealthyHostCount` only at
 * `LoadBalancer` + `TargetGroup` (and the per-AZ variant). This is the same
 * two-level shape ECS has with clusters and services: the pack declares the
 * exact dimension set, and the collector binds a metric to a resource only on an
 * exact match, so a load-balancer row is never billed for a target-group query.
 *
 * **3. `RequestCountPerTarget` is a `Sum` that is not a sum.** See its
 * declaration — it is the single most reliable way to build a wrong dashboard
 * out of correct-looking CloudWatch calls.
 *
 * On statistics: `validStatistics` transcribes what the page prints, which for
 * ALB is usually a single entry. AWS does not merely prefer `Sum` on the HTTP
 * code counters, it warns that "`Minimum`, `Maximum`, and `Average` all return
 * 1" — an average-based alarm on those is not imprecise, it is a constant.
 *
 * One thing this pack deliberately does not claim: there are **no AWS-published
 * recommended alarms for `AWS/ApplicationELB`**. The CloudWatch recommended-
 * alarms page covers EC2, ECS, RDS, NAT Gateway and two dozen others, and has no
 * ELB section of any kind. The only prescriptive ALB alarm guidance AWS
 * publishes anywhere is the `UnHealthyHostCount` paragraph quoted in that rule's
 * rationale, and it lives in the ELB developer guide. Every other rule below
 * says in its own rationale what it is derived from, and none of them attributes
 * a threshold to AWS that AWS did not write.
 */

import type { InfraPackAlertRule, InfraPackMetric, InfraServicePack } from './types.js';
import { PERCENTILE_STATISTIC_TOKEN } from './types.js';

const NS = 'AWS/ApplicationELB';

/** The load-balancer-keyed series: one row per ALB in inventory. */
const LB = Object.freeze(['LoadBalancer']);
/** The target-group-keyed series. AWS publishes no host count without it. */
const TARGET_GROUP = Object.freeze(['LoadBalancer', 'TargetGroup']);

/** "Elastic Load Balancing measures and sends its metrics in 60-second intervals." */
const ONE_MINUTE = 60;

const UNIVERSAL = Object.freeze({ universal: true, condition: '' });

/**
 * AWS says of several target metrics: "This metric does not apply if the target
 * is a Lambda function."
 */
const NOT_LAMBDA_TARGETS = Object.freeze({
  universal: false,
  condition:
    'Target groups whose targets are instances or IP addresses. AWS does not publish this metric for a target group backed by a Lambda function.',
});

/** AWS names exactly one meaningful statistic for every count metric on this page. */
const SUM_ONLY = Object.freeze(['Sum']);

/** One `Sum` counter at the load-balancer dimension. */
function albCounter(
  metricName: string,
  description: string,
  dimensions: readonly string[] = LB,
  appliesTo: InfraPackMetric['appliesTo'] = UNIVERSAL,
): InfraPackMetric {
  return {
    namespace: NS,
    metricName,
    dimensions,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: SUM_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo,
    requiresFeature: null,
    description,
  };
}

/**
 * One `TargetResponseTime` series at a single statistic.
 *
 * Declared three times rather than once, because a statistic is part of the
 * stored series key and the three answer different questions. Each one is a
 * separately billed `GetMetricData` entry, which is the deliberate cost: at the
 * 1-minute tier three series per load balancer is roughly $0.26 a month, against
 * an ALB's own fixed hourly charge of about $16.
 */
function targetResponseTime(stat: string, description: string): InfraPackMetric {
  return {
    namespace: NS,
    metricName: 'TargetResponseTime',
    dimensions: LB,
    metricType: 'latency',
    stat,
    // Verbatim: "The most useful statistics are Average and pNN.NN
    // (percentiles)." AWS names no specific percentile because all of them are
    // legal, so the token stands for the whole family.
    validStatistics: Object.freeze(['Average', PERCENTILE_STATISTIC_TOKEN]),
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description,
  };
}

const ALB_METRICS: readonly InfraPackMetric[] = Object.freeze([
  // ── Traffic ──────────────────────────────────────────────────────────────
  albCounter(
    'RequestCount',
    'Requests the load balancer routed to a target. Reported only when the target group has registered targets, and it counts only requests for which a target was chosen — a request rejected before target selection never appears here, so this is not a total-arrivals counter.',
  ),
  targetResponseTime(
    'Average',
    'Mean seconds from the request leaving the load balancer until the target began sending response headers. Reported only when there is a nonzero value, so an idle load balancer shows a gap rather than a zero.',
  ),
  targetResponseTime(
    'p50',
    'Median target response time in seconds. Charted beside the Average because the two diverging is the signal: a mean well above the median means a slow tail is dragging it, which is exactly what the average hides.',
  ),
  targetResponseTime(
    'p99',
    'Ninety-ninth percentile target response time in seconds — the slowest 1% of requests. AWS recommends the 99th percentile for alarms precisely because "the average doesn’t indicate the distribution of the data".',
  ),

  // ── Errors the targets produced ──────────────────────────────────────────
  albCounter(
    'HTTPCode_Target_5XX_Count',
    'HTTP 5XX responses generated by the targets, excluding anything the load balancer generated itself. Sum is the only meaningful statistic: AWS states that Minimum, Maximum and Average all return 1 for this metric.',
  ),

  // ── Errors the load balancer produced ────────────────────────────────────
  albCounter(
    'HTTPCode_ELB_5XX_Count',
    'HTTP 5XX responses originating from the load balancer itself, excluding anything the targets returned. The aggregate of the 500/502/503/504 splits below.',
  ),
  albCounter(
    'HTTPCode_ELB_502_Count',
    'Bad Gateway: the target returned a response the load balancer could not parse, or closed the connection before responding. Usually a target-side crash or a protocol mismatch, not a capacity problem.',
  ),
  albCounter(
    'HTTPCode_ELB_503_Count',
    'Service Unavailable: the load balancer had no healthy target to route to. The one 5XX split that means "no capacity" rather than "broken response", and the one that keeps counting while RequestCount reports nothing.',
  ),
  albCounter(
    'HTTPCode_ELB_504_Count',
    'Gateway Timeout: the target did not respond within the idle timeout. Read beside TargetResponseTime p99 — a rising tail usually arrives before the timeouts do.',
  ),

  // ── Connection failures ──────────────────────────────────────────────────
  albCounter(
    'RejectedConnectionCount',
    'Connections rejected because the load balancer had reached its maximum number of connections. Any nonzero value is the load balancer at a hard ceiling, turning clients away.',
  ),
  albCounter(
    'TargetConnectionErrorCount',
    'Connections the load balancer could not establish to a target. Health-check connections are excluded, so this counts only failures on real request paths.',
    LB,
    NOT_LAMBDA_TARGETS,
  ),

  // ── Target group health (TargetGroup dimension is mandatory) ─────────────
  {
    namespace: NS,
    metricName: 'HealthyHostCount',
    dimensions: TARGET_GROUP,
    metricType: 'gauge',
    // Maximum, which is the most *optimistic* load balancer node's view.
    //
    // The Min/Max spread here is across load balancer nodes within one sampling
    // window, not across time: AWS's worked example has one node reporting a
    // Minimum of 2 and another a Minimum of 1, so the load balancer's Minimum is
    // 1. Storing the Minimum would therefore fire whenever any single node
    // briefly lost sight of its targets. Maximum answers the question the alarm
    // actually asks — "is there capacity anywhere" — and it is the statistic AWS
    // recommends for this metric on the sibling Network Load Balancer page,
    // where the node-aggregation semantics are identical.
    stat: 'Maximum',
    validStatistics: Object.freeze(['Average', 'Minimum', 'Maximum']),
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Targets in the target group passing health checks, taken across load balancer nodes at their most optimistic. Reported only when the target group has registered targets, so an empty target group is a gap rather than a zero.',
  },
  {
    namespace: NS,
    metricName: 'UnHealthyHostCount',
    dimensions: TARGET_GROUP,
    metricType: 'gauge',
    // Minimum, and this one AWS states outright: "We recommend you monitor for
    // non-zero UnHealthyHostCount in the Minimum statistic […] Using the Minimum
    // will detect when targets are considered unhealthy by every node and
    // Availability Zone of your load balancer."
    stat: 'Minimum',
    validStatistics: Object.freeze(['Average', 'Minimum', 'Maximum']),
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Targets in the target group failing health checks, counted only where every load balancer node agrees. Deregistering a target lowers HealthyHostCount without raising this, and removing the *last* target stops both series outright — neither count can report anything about an empty target group.',
  },
  {
    namespace: NS,
    metricName: 'RequestCountPerTarget',
    dimensions: TARGET_GROUP,
    // Typed as a counter because `Sum` is the statistic, and the metric type's
    // job is to decide the statistic. What the number *means* is an average —
    // see the description. The two disagree here and nowhere else in any pack.
    metricType: 'counter',
    stat: 'Sum',
    // Verbatim: "The only valid statistic is Sum. This represents the average
    // not the sum." Note "valid", not the "most useful" wording every other
    // metric on the page gets.
    validStatistics: SUM_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: NOT_LAMBDA_TARGETS,
    requiresFeature: null,
    description:
      'Average requests per target in the target group: total target-group requests divided by the number of healthy targets (or by all registered targets when none are healthy). AWS publishes it under the Sum statistic and states plainly that "this represents the average not the sum" — so do not add it up across periods, and do not read a per-target rate as a request total. It is also one of the few ALB metrics reported unconditionally, so unlike RequestCount it keeps producing datapoints on an idle load balancer.',
  },
]);

/**
 * Default rules (decision INFRA-ALERT). Templates only — nothing here is
 * inserted into `infra_alert_rules` on its own.
 *
 * Every one sets `treatMissingData: 'notBreaching'`, which is the pack's single
 * most consequential choice and is explained in the module header. The
 * thresholds split into two kinds and no third:
 *
 *   - **Zero-thresholds on nonzero-only metrics.** `RejectedConnectionCount`,
 *     `HTTPCode_ELB_5XX_Count` and `TargetConnectionErrorCount` are reported
 *     only when nonzero, so "greater than 0" is not a round number somebody
 *     picked — it is the metric's own publication condition restated. The only
 *     judgement is how long it has to persist.
 *   - **AWS's own wording**, for `UnHealthyHostCount`.
 */
const ALB_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  {
    name: 'ALB target group has unhealthy targets',
    description: 'Every load balancer node has agreed a target is unhealthy for two minutes.',
    namespace: NS,
    metricName: 'UnHealthyHostCount',
    stat: 'Minimum',
    dimensions: TARGET_GROUP,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    // "alarm on non-zero value for more than one data point" — two is the
    // smallest number that satisfies "more than one", and AWS gives no larger
    // figure to prefer.
    evaluationPeriods: 2,
    datapointsToAlarm: 2,
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'The only prescriptive ALB alarm guidance AWS publishes, quoted from the ELB developer guide: "We recommend you monitor for non-zero UnHealthyHostCount in the Minimum statistic, and alarm on non-zero value for more than one data point. Using the Minimum will detect when targets are considered unhealthy by every node and Availability Zone of your load balancer." AWS supplies the statistic, the threshold and the datapoint count but no period; 60s is the rate ELB publishes at. There is no ApplicationELB section on the CloudWatch recommended-alarms page.',
  },
  {
    name: 'ALB target group has no healthy targets',
    description: 'Targets are registered but none is healthy on any node, for two minutes.',
    namespace: NS,
    metricName: 'HealthyHostCount',
    stat: 'Maximum',
    dimensions: TARGET_GROUP,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'LessThanOrEqualToThreshold',
    evaluationPeriods: 2,
    datapointsToAlarm: 2,
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'Not a duplicate of the UnHealthyHostCount rule but the severe tier of the same signal: that one fires when every node agrees *some* target is unhealthy, this one when no node can see *any* healthy target — zero routable capacity rather than partial degradation. Its limit, which the threshold cannot express away: AWS reports both host counts only "if there are registered targets", so deregistering the last target stops the series rather than driving it to zero, and this rule treats missing data as not breaching. An emptied target group therefore reads OK here — see the "target group with no registered targets" absent-metric note for the pinned rule that does catch it. AWS recommends this alarm shape on the Network Load Balancer page ("invoking the alarm when the maximum HealthyHostCount falls below your required minimum, or being 0"); the ALB page publishes no alarm at all.',
  },
  {
    name: 'ALB is rejecting connections',
    description: 'The load balancer turned a client away because it hit its connection limit.',
    namespace: NS,
    metricName: 'RejectedConnectionCount',
    stat: 'Sum',
    dimensions: LB,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    // 1 of 1, unlike the 5-of-5 error rules below. A rejected connection is a
    // client that never got served, and the load balancer only publishes this
    // metric once that has already happened — waiting for it to repeat delays
    // notice of damage that is already done, and does not make it less real.
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'AWS publishes no threshold for this metric. The threshold is derived from its own definition — "the number of connections that were rejected because the load balancer had reached its maximum number of connections", reported only when nonzero — so any datapoint at all is the load balancer at a hard ceiling. Nothing about a rejected connection is transient or self-correcting.',
  },
  {
    name: 'ALB is generating 5XX responses',
    description: 'The load balancer itself has returned server errors for five minutes.',
    namespace: NS,
    metricName: 'HTTPCode_ELB_5XX_Count',
    stat: 'Sum',
    dimensions: LB,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    // Five consecutive minutes, where the rejected-connection rule uses one.
    // 502s and 503s are normal during a rolling deployment as targets drain and
    // register; what is not normal is them still arriving five minutes later.
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'AWS publishes no threshold for this metric. Threshold 0 is its publication condition restated — "Reporting criteria: There is a nonzero value" means a healthy load balancer emits no datapoint, so any datapoint is an error the load balancer generated itself rather than passed through from a target. The five-period requirement is the judgement call: a rolling deployment produces 502s and 503s while targets drain, and five consecutive minutes separates that from an outage.',
  },
  {
    name: 'ALB cannot connect to its targets',
    description: 'The load balancer has failed to open connections to targets for five minutes.',
    namespace: NS,
    metricName: 'TargetConnectionErrorCount',
    stat: 'Sum',
    dimensions: LB,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 5,
    datapointsToAlarm: 5,
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'AWS publishes no threshold for this metric. Same derivation as the 5XX rule: reported only when nonzero, so the threshold is the publication condition. It is a distinct failure from a 5XX — the connection never opened, so the target returned nothing to classify — and AWS notes the metric "is not incremented for unsuccessful health check connections", meaning these are real requests that failed rather than health-check noise.',
  },
]);

/** The ALB pack. */
export const ALB_PACK: InfraServicePack = Object.freeze({
  service: 'alb',
  label: 'Application Load Balancer',
  metrics: ALB_METRICS,
  dimensions: Object.freeze([
    {
      name: 'LoadBalancer',
      detailedMonitoringOnly: false,
      description:
        'One Application Load Balancer, identified by the tail of its ARN in the form `app/<name>/<id>`. The `app/` prefix is what distinguishes it from a Network Load Balancer’s `net/` — the dimension name is the same on both, so only the value says which namespace the series belongs to.',
    },
    {
      name: 'TargetGroup',
      detailedMonitoringOnly: false,
      description:
        'One target group, in the form `targetgroup/<name>/<id>`. Mandatory for the host counts and RequestCountPerTarget: AWS publishes no load-balancer-only healthy-host series, so those charts need a target-group row in inventory rather than a load-balancer one.',
    },
    {
      name: 'AvailabilityZone',
      detailedMonitoringOnly: false,
      description:
        'Splits any of these metrics per zone. Not collected: it multiplies every series by the zone count for a view that matters only while diagnosing a zonal failure, and CloudWatch bills each combination as its own metric.',
    },
  ]),
  features: Object.freeze([]),
  absentMetrics: Object.freeze([
    {
      label: 'A flat zero line on an idle load balancer',
      reason:
        'AWS reports ALB metrics "only when requests are flowing through the load balancer", and most of them only when the value is nonzero. Zero requests, zero errors and zero rejected connections are all published as nothing at all, so the chart ends rather than flattening.',
      remedy:
        'Read a gap as "no traffic or no errors", not as broken collection. The pack’s default rules all treat missing data as not breaching for this reason, so a quiet load balancer reads OK rather than sitting in INSUFFICIENT_DATA.',
    },
    {
      label: 'An alert for a target group with no registered targets',
      reason:
        'AWS reports HealthyHostCount and UnHealthyHostCount only "if there are registered targets". Deregistering the last target stops both series rather than driving either to zero, and every rule in this pack treats missing data as not breaching, so a scale-in that went too far or a deployment that removed every target reads OK on both host-count rules. The counts describe the targets in a group; they cannot describe a group that has none.',
      remedy:
        'Pin a rule to the specific target-group resource and set its treatMissingData to `breaching`, which turns the absence of datapoints into the alarm. Pinning is not optional here: unpinned it would also match every load-balancer-level row in the project, none of which publish host counts at all, and page for all of them at once.',
    },
    {
      label: 'An alert for "traffic stopped completely"',
      reason:
        'The evidence for a total traffic stop is the *absence* of RequestCount datapoints, and every rule in this pack deliberately treats absence as not breaching so that a healthy idle load balancer does not page. A rule cannot have it both ways on the same series.',
      remedy:
        'Pin a rule to one load balancer resource, set its treatMissingData to `breaching` on RequestCount, and give it enough evaluation periods to survive a genuine quiet spell. Unpinned it would match every ALB and target-group row in the project and page for all of them at once.',
    },
    {
      label: 'Per-request latency, or latency below one second',
      reason:
        'TargetResponseTime is a statistic over a 60-second window, not a per-request trace, and CloudWatch stores it in seconds. A p99 of 0.004 is four milliseconds; there is no finer resolution to request.',
      remedy:
        'Enable ALB access logs, which record target_processing_time per request — TargetResponseTime is documented as equivalent to that field. Query them with Athena for anything per-request.',
    },
    {
      label: 'An error *rate* (5XX as a percentage of requests)',
      reason:
        'A rate needs a metric-math expression over two series, which this rule engine does not evaluate. It would also be wrong in the case that matters: RequestCount is "reported if there are registered targets" and counts only requests where a target was chosen, so the denominator can vanish at exactly the moment HTTPCode_ELB_503_Count spikes.',
      remedy:
        'Use the absolute-count rules shipped here. Both series are charted on the Metrics tab, so the ratio remains readable by eye even though it cannot be alarmed on.',
    },
  ]),
  defaultAlertRules: ALB_DEFAULT_ALERT_RULES,
});
