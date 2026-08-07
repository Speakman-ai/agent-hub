/**
 * Network Load Balancer pack.
 *
 * Every entry is traceable to the ELB *CloudWatch metrics for your Network Load
 * Balancer* page and the NLB troubleshooting guide (verified August 2026).
 *
 * It shares the ALB pack's central constraint — "Elastic Load Balancing reports
 * metrics to CloudWatch only when requests are flowing through the load
 * balancer […] If there are no requests flowing through the load balancer or no
 * data for a metric, the metric is not reported" — and the same consequence:
 * every rule sets `treatMissingData` explicitly, and to `notBreaching`. The ALB
 * module header explains that choice in full.
 *
 * What is *not* shared is the statistics guidance, and copying the ALB pack
 * across would get it wrong in two places:
 *
 *   - **NLB drops `Average` from the host counts.** ALB documents
 *     `HealthyHostCount`'s useful statistics as "Average, Minimum, and Maximum";
 *     NLB documents them as "Maximum and Minimum". Averaging a count across
 *     load balancer nodes is a number no node ever reported.
 *   - **NLB publishes an explicit two-sided recommendation the ALB page does
 *     not.** Verbatim: "It's recommended to monitor maximum HealthyHostCount,
 *     invoking the alarm when the maximum HealthyHostCount falls below your
 *     required minimum, or being 0 […] It's also recommended to monitor minimum
 *     UnHealthyHostCount, invoking the alarm when the minimum UnHealthyHostCount
 *     rises above 0. This allows you to become aware when there are no longer any
 *     registered targets." Both rules below are that sentence.
 *
 * Two NLB-specific traps are encoded in the declarations:
 *
 *   - **`ActiveFlowCount` and `NewFlowCount` are not the same kind of number.**
 *     AWS gives the first "the most useful statistics are Average, Maximum, and
 *     Minimum" (a concurrent level) and the second "the most useful statistic is
 *     Sum" (a per-period total). They sit next to each other in the docs and
 *     read like a pair; they are a gauge and a counter.
 *   - **`PortAllocationErrorCount` fires when client IP preservation is
 *     *disabled*.** The intuition runs the other way, so it is spelled out on
 *     the metric and in its rule.
 *
 * On dimensions: the `TCP_*_Reset_Count` family is published at `LoadBalancer`
 * and `AvailabilityZone` + `LoadBalancer` only — never at `TargetGroup`. Resets
 * cannot be attributed to a target group at all, which is a real blind spot
 * rather than a collection gap, and it is recorded in `absentMetrics`.
 */

import type { InfraPackAlertRule, InfraPackMetric, InfraServicePack } from './types.js';

const NS = 'AWS/NetworkELB';

/** The load-balancer-keyed series: one row per NLB in inventory. */
const LB = Object.freeze(['LoadBalancer']);
/** The target-group-keyed series. AWS publishes no host count without it. */
const TARGET_GROUP = Object.freeze(['LoadBalancer', 'TargetGroup']);

/** "Elastic Load Balancing measures and sends its metrics in 60-second intervals." */
const ONE_MINUTE = 60;

const UNIVERSAL = Object.freeze({ universal: true, condition: '' });

/** AWS names exactly one meaningful statistic for every count metric on this page. */
const SUM_ONLY = Object.freeze(['Sum']);

/** The documented statistic list for the host counts — note the absent `Average`. */
const HOST_COUNT_STATS = Object.freeze(['Maximum', 'Minimum']);

/** One `Sum` counter at the load-balancer dimension. */
function nlbCounter(metricName: string, description: string): InfraPackMetric {
  return {
    namespace: NS,
    metricName,
    dimensions: LB,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: SUM_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description,
  };
}

/** One target-group host count. */
function hostCount(metricName: string, stat: string, description: string): InfraPackMetric {
  return {
    namespace: NS,
    metricName,
    dimensions: TARGET_GROUP,
    metricType: 'gauge',
    stat,
    validStatistics: HOST_COUNT_STATS,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description,
  };
}

const NLB_METRICS: readonly InfraPackMetric[] = Object.freeze([
  // ── Flows ────────────────────────────────────────────────────────────────
  {
    namespace: NS,
    metricName: 'ActiveFlowCount',
    dimensions: LB,
    // A concurrent level, not a total: AWS's useful statistics here are
    // "Average, Maximum, and Minimum", which is the vocabulary of a gauge.
    metricType: 'gauge',
    // Maximum, because the number this metric is read against is a ceiling.
    // AWS's own troubleshooting page pairs it with PortAllocationErrorCount:
    // "You can track active connections using the ActiveFlowCount metric",
    // against a documented limit of about 55,000 per unique target. A 60-second
    // average that peaked over the limit for ten seconds has still dropped
    // connections, and the average is where that disappears.
    stat: 'Maximum',
    validStatistics: Object.freeze(['Average', 'Maximum', 'Minimum']),
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: UNIVERSAL,
    requiresFeature: null,
    description:
      'Concurrent flows from clients to targets, counting connections in the SYN_SENT and ESTABLISHED states. A Network Load Balancer does not terminate TCP, so one client connection to a target is one flow rather than two. Read it against the ~55,000-per-target ceiling that PortAllocationErrorCount reports breaching.',
  },
  nlbCounter(
    'NewFlowCount',
    'Flows established from clients to targets during the period. A per-period total, unlike ActiveFlowCount immediately above it in the AWS docs, which is a concurrent level — the two look like a pair and are a counter and a gauge.',
  ),

  // ── Resets ───────────────────────────────────────────────────────────────
  nlbCounter(
    'TCP_ELB_Reset_Count',
    'RST packets the load balancer itself generated. AWS documents two causes: a connection idle past the timeout, and a target being marked unhealthy while client connections are open. A spike here just before UnHealthyHostCount rises is a target that was failing before health checks caught it.',
  ),
  nlbCounter(
    'TCP_Target_Reset_Count',
    'RST packets a target sent to a client, forwarded by the load balancer. The target refused or tore down the connection — the load balancer is reporting, not causing.',
  ),
  nlbCounter(
    'TCP_Client_Reset_Count',
    'RST packets a client sent to a target, forwarded by the load balancer. Ordinary in bulk (clients abandon connections constantly); useful as the baseline the other two reset counters are read against.',
  ),

  // ── Port exhaustion ──────────────────────────────────────────────────────
  nlbCounter(
    'PortAllocationErrorCount',
    'Ephemeral port allocation failures during client IP translation. AWS: "A non-zero value indicates dropped client connections." It applies when client IP preservation is *disabled* (or for PrivateLink traffic), because that is when the load balancer must source-NAT and therefore allocate a port per flow — the limit is about 55,000 simultaneous connections per unique target. The fix is more targets in the target group, not a bigger load balancer.',
  ),

  // ── Target group health (TargetGroup dimension is mandatory) ─────────────
  hostCount(
    'HealthyHostCount',
    // Maximum: the most optimistic node's view, and AWS's explicit
    // recommendation on this page. Min and Max here span load balancer nodes
    // within one sampling window, not time, so a Minimum fires whenever any one
    // node briefly lost sight of its targets.
    'Maximum',
    'Targets passing health checks, taken across load balancer nodes at their most optimistic. Excludes any Application Load Balancer registered as a target. Reported only when the target group has registered targets.',
  ),
  hostCount(
    'UnHealthyHostCount',
    // Minimum: the cross-node consensus, matching AWS's recommendation and the
    // identical reasoning on the ALB page.
    'Minimum',
    'Targets failing health checks, counted only where every load balancer node agrees. Excludes any Application Load Balancer registered as a target.',
  ),
]);

/**
 * Default rules (decision INFRA-ALERT). Templates only.
 *
 * There is **no NetworkELB section on the CloudWatch recommended-alarms page** —
 * it covers EC2, ECS, RDS, NAT Gateway and two dozen others and has no ELB
 * entry of any kind. The two host-count rules below are AWS's guidance
 * nonetheless, taken from the prose in the NLB developer guide, which is more
 * specific for this service than the ALB equivalent. The port-allocation rule
 * derives its threshold from the metric's own definition.
 */
const NLB_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  {
    name: 'NLB target group has no healthy targets',
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
      'AWS, verbatim: "It\'s recommended to monitor maximum HealthyHostCount, invoking the alarm when the maximum HealthyHostCount falls below your required minimum, or being 0. This can help in identifying when your targets have become unhealthy." The required minimum is deployment-specific and cannot ship as a default, so this rule takes AWS\'s own concrete alternative of 0 — raise the threshold to your real target count once you know it. AWS supplies no period or datapoint count; 60s is ELB\'s publication rate and two datapoints keeps a single-scrape blip from paging. Its limit: AWS reports the host counts only "if there are registered targets", so deregistering the last target stops the series rather than driving it to zero, and this rule treats missing data as not breaching — an emptied target group reads OK. See the "target group with no registered targets" absent-metric note.',
  },
  {
    name: 'NLB target group has unhealthy targets',
    description: 'Every load balancer node has agreed a target is unhealthy for two minutes.',
    namespace: NS,
    metricName: 'UnHealthyHostCount',
    stat: 'Minimum',
    dimensions: TARGET_GROUP,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 2,
    datapointsToAlarm: 2,
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'AWS, verbatim: "It\'s also recommended to monitor minimum UnHealthyHostCount, invoking the alarm when the minimum UnHealthyHostCount rises above 0. This allows you to become aware when there are no longer any registered targets." Statistic, threshold and direction are AWS\'s; the period and datapoint count are not published, so they mirror the healthy-host rule above. One caveat on AWS\'s own justification, because operators will trust the sentence: the second half does not survive AWS\'s own reporting criteria. UnHealthyHostCount is reported only "if there are registered targets", so a target group emptied by deregistration stops publishing rather than raising this count, and the rule cannot become aware of it. What it does catch is targets that are registered and failing, which is the first half of the sentence and is the reason to ship it.',
  },
  {
    name: 'NLB is exhausting ephemeral ports',
    description: 'The load balancer failed to allocate a source port, dropping client connections.',
    namespace: NS,
    metricName: 'PortAllocationErrorCount',
    stat: 'Sum',
    dimensions: LB,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    // 1 of 1. AWS states the consequence in the metric's own definition — the
    // client connection was already dropped — so requiring a repeat only delays
    // notice of damage that has happened, and the remedy (add targets) is a
    // capacity change rather than something that self-corrects.
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    treatMissingData: 'notBreaching',
    severity: 'warning',
    rationale:
      'AWS publishes no alarm for this metric, but states its meaning unambiguously: "A non-zero value indicates dropped client connections." Threshold 0 is that sentence, not a round number. Severity is warning rather than critical because a handful of allocation failures under a traffic spike is a capacity signal, not an outage — but it will not clear on its own: "To fix port allocation errors, we recommend that you add targets to the target group."',
  },
]);

/** The NLB pack. */
export const NLB_PACK: InfraServicePack = Object.freeze({
  service: 'nlb',
  label: 'Network Load Balancer',
  metrics: NLB_METRICS,
  dimensions: Object.freeze([
    {
      name: 'LoadBalancer',
      detailedMonitoringOnly: false,
      description:
        'One Network Load Balancer, identified by the tail of its ARN in the form `net/<name>/<id>`. The dimension name is identical to the Application Load Balancer’s, so only the `net/` prefix and the namespace distinguish the two — which is why ALB and NLB are separate services here rather than one `elbv2`.',
    },
    {
      name: 'TargetGroup',
      detailedMonitoringOnly: false,
      description:
        'One target group, in the form `targetgroup/<name>/<id>`. Mandatory for the host counts: AWS publishes no load-balancer-only healthy-host series. Note that ActiveFlowCount and NewFlowCount publish a *bare* TargetGroup set with no LoadBalancer, unlike ALB — a query pairing the two returns nothing.',
    },
    {
      name: 'AvailabilityZone',
      detailedMonitoringOnly: false,
      description:
        'Splits most of these metrics per zone. Not collected: it multiplies every series by the zone count, and CloudWatch bills each dimension combination as its own metric.',
    },
  ]),
  features: Object.freeze([]),
  absentMetrics: Object.freeze([
    {
      label: 'Resets attributed to a target group',
      reason:
        'The TCP_Client_Reset_Count, TCP_ELB_Reset_Count and TCP_Target_Reset_Count family is published only at the LoadBalancer and AvailabilityZone dimensions. AWS publishes no TargetGroup variant, so a query for one returns no data rather than zero.',
      remedy:
        'Correlate by time instead: AWS documents that a TCP_ELB_Reset_Count spike just before UnHealthyHostCount rises means a target was failing before health checks marked it down.',
    },
    {
      label: 'An alert for a target group with no registered targets',
      reason:
        'AWS reports HealthyHostCount and UnHealthyHostCount only "if there are registered targets". Deregistering the last target stops both series rather than driving either to zero, and both host-count rules treat missing data as not breaching, so an emptied target group reads OK on both. AWS\'s own guidance says monitoring minimum UnHealthyHostCount makes you "aware when there are no longer any registered targets"; that half of the sentence does not hold, for exactly this reason.',
      remedy:
        'Pin a rule to the specific target-group resource and set its treatMissingData to `breaching`, so the absence of datapoints is itself the alarm. Pinning is required: unpinned it would match every load-balancer-level row too, none of which publish host counts.',
    },
    {
      label: 'A flat zero line on an idle load balancer',
      reason:
        'AWS reports NLB metrics "only when requests are flowing through the load balancer", and every protocol-suffixed variant only when the value is nonzero. Nothing is published as a zero.',
      remedy:
        'Read a gap as "no traffic", not as broken collection. The pack’s default rules treat missing data as not breaching for this reason.',
    },
    {
      label: 'Traffic blocked by a load balancer security group',
      reason:
        'AWS states that "for Network Load Balancers with security groups, traffic rejected by the security groups is not captured in the CloudWatch metrics" — the flow and byte counters do not include it, so a security group silently dropping traffic looks like an absence of traffic.',
      remedy:
        'The SecurityGroupBlockedFlowCount_* family reports it, split by direction and protocol. Not collected here: it is six separate series per load balancer for a diagnosis that is usually a one-off, and each is a billed GetMetricData entry on every tick.',
    },
    {
      label: 'Per-protocol flow and byte breakdowns',
      reason:
        'ActiveFlowCount_TCP / _TLS / _UDP and the matching NewFlowCount and ProcessedBytes variants exist but are not collected. Unlike the base metrics, which AWS reports "Always", every protocol-suffixed variant is reported only when nonzero.',
      remedy:
        'Use the unsuffixed totals shipped here, which cover every protocol. Add the split explicitly in the rule editor if a specific listener needs it.',
    },
  ]),
  defaultAlertRules: NLB_DEFAULT_ALERT_RULES,
});
