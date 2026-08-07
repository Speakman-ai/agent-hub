/**
 * NAT Gateway pack — the one networking service with AWS-published alarms.
 *
 * Every entry is traceable to the VPC user guide's *NAT gateway metrics and
 * dimensions* page, the CloudWatch recommended-alarms page's `AWS/NATGateway`
 * section, and the VPC pricing page (verified August 2026).
 *
 * Unlike the two load balancer packs, AWS does publish recommended alarms here,
 * and both of them are encoded below — one as a rule, one as a documented gap.
 *
 * Three things drive the declarations.
 *
 * **1. `PacketsDropCount` has a formula, and the formula names series.** AWS
 * documents the drop ratio as
 * `PacketsDropCount/(PacketsInFromSource+PacketsInFromDestination)*100`, with
 * anything above 0.01 percent suggesting an AWS-side problem. That formula is
 * useless if we only collect the numerator, so both denominator series are
 * collected too. Note the `*100`: the published guidance compares a
 * *percentage* against 0.01, so reading it as a raw ratio is wrong by a factor
 * of a hundred.
 *
 * **2. Data processing is billed per gigabyte in every direction.** The pricing
 * page: "Data processing charges apply for each gigabyte processed through the
 * NAT gateway regardless of the traffic's source or destination." So all four
 * byte counters are collected, not just the egress one — any subset produces a
 * number that understates the bill, and a cost panel that quietly understates is
 * worse than no cost panel. Four extra series per gateway at the 1-minute tier
 * is roughly $0.35 a month against a NAT gateway's own ~$32 hourly charge plus
 * $0.045 per processed GB, which is the trade INFRA-COST asks to be made
 * explicitly rather than by omission.
 *
 * **3. Every metric here is zonal-only at `NatGatewayId`.** AWS: "Zonal NAT
 * gateways use only this dimension. Regional NAT gateways use this dimension
 * together with AvailabilityZone." A regional gateway therefore publishes
 * nothing at the dimension set this pack collects, which is why every metric
 * carries that condition rather than leaving an operator to guess why the tab is
 * empty.
 *
 * VPC Flow Logs are excluded on purpose and the reason is structural, not a
 * deferral: they publish no CloudWatch metrics in any namespace. See
 * `absentMetrics`.
 */

import type { InfraPackAlertRule, InfraPackMetric, InfraServicePack } from './types.js';

const NS = 'AWS/NATGateway';

/** The gateway-keyed series. The only dimension set a zonal NAT gateway publishes. */
const GATEWAY = Object.freeze(['NatGatewayId']);

/** "NAT gateway metrics are sent to CloudWatch at 1-minute intervals." */
const ONE_MINUTE = 60;

/**
 * A regional NAT gateway publishes at `NatGatewayId` + `AvailabilityZone` and
 * not at `NatGatewayId` alone, so none of these series exist for one.
 *
 * Carried per-metric rather than only in `absentMetrics` because this is exactly
 * the case the field exists for: the chart is empty, collection is working, and
 * nothing on screen would otherwise say why.
 */
const ZONAL_ONLY = Object.freeze({
  universal: false,
  condition:
    'Zonal NAT gateways. A regional NAT gateway publishes this metric at NatGatewayId together with AvailabilityZone, which is a different series and is not collected.',
});

/** AWS names exactly one useful statistic for every counter on this page. */
const SUM_ONLY = Object.freeze(['Sum']);

/** One `Sum` counter at the gateway dimension. */
function natCounter(metricName: string, description: string): InfraPackMetric {
  return {
    namespace: NS,
    metricName,
    dimensions: GATEWAY,
    metricType: 'counter',
    stat: 'Sum',
    validStatistics: SUM_ONLY,
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: ZONAL_ONLY,
    requiresFeature: null,
    description,
  };
}

const NATGW_METRICS: readonly InfraPackMetric[] = Object.freeze([
  // ── Failures ─────────────────────────────────────────────────────────────
  natCounter(
    'ErrorPortAllocation',
    'Times the NAT gateway could not allocate a source port. AWS: "A value greater than zero indicates that too many concurrent connections are open through the NAT gateway." A single NAT gateway supports about 55,000 simultaneous connections to each unique destination address and port, so this is usually many clients talking to one popular endpoint rather than overall volume.',
  ),
  natCounter(
    'PacketsDropCount',
    'Packets the NAT gateway dropped. Read as a share of total traffic using AWS’s own formula — PacketsDropCount/(PacketsInFromSource+PacketsInFromDestination)*100 — and note it yields a percentage: AWS’s guidance is that a result above 0.01 percent "may indicate an issue with Amazon VPC service", to be checked against the AWS service health dashboard. Both denominator series are collected so the formula is computable here.',
  ),
  natCounter(
    'IdleTimeoutCount',
    'Connections that went from active to idle, which happens when a connection was not closed gracefully and saw no activity for 350 seconds. A rising count usually means clients behind the gateway are re-using stale connections rather than that the gateway is failing.',
  ),

  // ── Traffic, and the drop-ratio denominators ─────────────────────────────
  natCounter(
    'PacketsInFromSource',
    'Packets the gateway received from clients in your VPC. Collected as the first half of the PacketsDropCount ratio denominator, and readable on its own as outbound request volume.',
  ),
  natCounter(
    'PacketsInFromDestination',
    'Packets the gateway received from the destination. The second half of the PacketsDropCount ratio denominator, and the return path of the same conversations.',
  ),
  {
    namespace: NS,
    metricName: 'ActiveConnectionCount',
    dimensions: GATEWAY,
    // A concurrent level rather than a per-period total.
    metricType: 'gauge',
    // AWS writes "The most useful statistic is Max" — `Max` is the console's
    // shorthand for the CloudWatch statistic `Maximum`, which is what the API
    // accepts. Maximum is also the right answer on its own terms: this is the
    // number read against the connection ceiling that ErrorPortAllocation
    // reports breaching, and a 60-second average hides a peak that dropped
    // connections.
    stat: 'Maximum',
    validStatistics: Object.freeze(['Maximum']),
    minPeriodSeconds: ONE_MINUTE,
    availability: 'either',
    appliesTo: ZONAL_ONLY,
    requiresFeature: null,
    description:
      'Concurrent active TCP connections through the gateway. AWS notes that "a value of zero indicates that there are no active connections", so unlike the ELB metrics a zero here is a real datapoint rather than a gap. Chart it beside ErrorPortAllocation: the errors start when this approaches the per-destination connection limit.',
  },

  // ── Bytes, which are what AWS bills ──────────────────────────────────────
  natCounter(
    'BytesOutToDestination',
    'Bytes sent out through the gateway to the internet — the egress path, and usually the largest share of the per-GB data processing charge. It is not the whole billed figure: AWS bills every gigabyte processed "regardless of the traffic’s source or destination", so this counter alone understates the bill and the other three byte series are collected for that reason.',
  ),
  natCounter(
    'BytesInFromSource',
    'Bytes the gateway received from clients in your VPC. Billed at the same per-GB data processing rate as every other direction.',
  ),
  natCounter(
    'BytesInFromDestination',
    'Bytes the gateway received from the destination — the download side of egress traffic, and typically the largest byte counter for a workload that pulls container images or packages. Billed per GB like the rest.',
  ),
  natCounter(
    'BytesOutToSource',
    'Bytes the gateway sent back to clients in your VPC. AWS notes that a value below BytesInFromDestination "might" mean data loss during processing or traffic actively blocked.',
  ),
]);

/**
 * Default rules (decision INFRA-ALERT).
 *
 * AWS publishes two recommended alarms for `AWS/NATGateway`. Only one of them
 * can ship as a default: `PacketsDropCount`'s recommended threshold is the
 * literal string "Depends on your situation", with the justification "You should
 * calculate the value of 0.01 percent of the total traffic on the NAT Gateway
 * and use that result as the threshold value." That is a per-deployment number
 * derived from a ratio this engine cannot evaluate, and inventing a round one
 * would be the exact failure INFRA-ALERT exists to avoid. It is recorded in
 * `absentMetrics` with AWS's shape intact so an operator can finish it.
 */
const NATGW_DEFAULT_ALERT_RULES: readonly InfraPackAlertRule[] = Object.freeze([
  {
    name: 'NAT gateway cannot allocate source ports',
    description: 'The gateway has failed to allocate a source port for fifteen minutes.',
    namespace: NS,
    metricName: 'ErrorPortAllocation',
    stat: 'Sum',
    dimensions: GATEWAY,
    periodS: 60,
    threshold: 0,
    comparisonOperator: 'GreaterThanThreshold',
    // 15 of 15 is AWS's own figure, not a guess, and it is unusually patient
    // next to every other rule in these packs. It is also self-consistent: port
    // exhaustion under a burst recovers by itself as connections close, and the
    // documented remedy — spread traffic across destinations, or add gateways —
    // is only worth paging for once it has proven sustained.
    evaluationPeriods: 15,
    datapointsToAlarm: 15,
    // Diverges from the CloudWatch default of `missing`, which AWS's
    // recommendation implicitly uses, and operators diffing our state against
    // the console will see it. The reason is that a rule with no `resourceKey`
    // matches every NAT gateway resource in the project, and a regional gateway
    // publishes nothing at this dimension set — under `missing` every one of
    // them would sit in INSUFFICIENT_DATA forever, which teaches operators the
    // state column is noise. Pin the rule to one zonal gateway to get the
    // console's exact behaviour.
    treatMissingData: 'notBreaching',
    severity: 'critical',
    rationale:
      'AWS recommended alarm, verbatim: Sum, threshold 0.0, GREATER_THAN_THRESHOLD, period 60, 15 datapoints of 15. Intent: "This alarm is used to detect if the NAT gateway could not allocate a source port." Threshold justification: "If the value of ErrorPortAllocation is greater than zero, that means too many concurrent connections to a single popular destination are open through NATGateway." Note the VPC user guide’s worked example gives a different shape for the same metric (Maximum, 5-minute period, 3 datapoints); the CloudWatch recommended-alarms figures are used here because that is the page AWS maintains as its alarm guidance.',
  },
]);

/** The NAT Gateway pack. */
export const NATGW_PACK: InfraServicePack = Object.freeze({
  service: 'natgw',
  label: 'NAT Gateway',
  metrics: NATGW_METRICS,
  dimensions: Object.freeze([
    {
      name: 'NatGatewayId',
      detailedMonitoringOnly: false,
      description:
        'One NAT gateway. AWS: "Zonal NAT gateways use only this dimension. Regional NAT gateways use this dimension together with AvailabilityZone." Every series collected here is keyed on it alone, so it covers zonal gateways only.',
    },
    {
      name: 'AvailabilityZone',
      detailedMonitoringOnly: false,
      description:
        'Used by regional NAT gateways, always paired with NatGatewayId; a zonal gateway does not use it at all. Not collected — see the "Regional NAT gateway metrics" note.',
    },
  ]),
  features: Object.freeze([]),
  absentMetrics: Object.freeze([
    {
      label: 'Regional NAT gateway metrics',
      reason:
        'A regional NAT gateway publishes every one of these metrics at NatGatewayId together with AvailabilityZone. CloudWatch treats each dimension combination as a separate metric, so the NatGatewayId-only series this pack declares does not exist for one — the charts are empty and collection is working correctly.',
      remedy:
        'Inventory sync already records regional gateways, one row per Availability Zone, carrying the NatGatewayId + AvailabilityZone dimension pair. What is missing is the other half: this pack declares every metric on NatGatewayId alone, and the collector binds only on an exact dimension-set match, so those rows are deliberately inert rather than billed for a series AWS does not publish. Declaring the metrics a second time at the regional dimension set is all that is needed, and the inventory rows are already the right shape for it.',
    },
    {
      label: 'A default alarm on dropped packets',
      reason:
        'AWS recommends one but publishes no threshold for it: "Depends on your situation. You should calculate the value of 0.01 percent of the total traffic on the NAT Gateway and use that result as the threshold value." The threshold is a ratio over three series, and this engine evaluates no metric-math expressions, so it cannot be derived at evaluation time either.',
      remedy:
        'Build it in the rule editor with AWS’s shape: PacketsDropCount, Sum, GreaterThanThreshold, period 60, 5 datapoints of 5. For the threshold, chart PacketsDropCount against PacketsInFromSource + PacketsInFromDestination — all three are collected — take 0.01 percent of a representative total, and use that packet count.',
    },
    {
      label: 'VPC Flow Logs',
      reason:
        'Flow logs publish no CloudWatch metrics in any namespace — there is no AWS/FlowLogs to query. They emit flow log *records* to CloudWatch Logs, S3 or Firehose, and AWS states outright that "flow logs do not capture real-time log streams for your network interfaces": the default aggregation interval is 10 minutes and delivery adds about 5 more.',
      remedy:
        'Take the log-derived path. Send flow logs to CloudWatch Logs and create a metric filter, which produces a custom metric you can then alarm on, or query them in S3 with Athena for ad-hoc analysis. Either way the signal arrives minutes later than a NAT gateway metric, so use the metrics above for anything time-sensitive.',
    },
    {
      label: 'Which client is consuming the NAT gateway',
      reason:
        'Every AWS/NATGateway metric is an aggregate for the whole gateway. CloudWatch publishes no per-instance or per-destination breakdown, so a bill driven by one runaway workload looks identical to one spread evenly.',
      remedy:
        'VPC Flow Logs again: the records carry source and destination addresses and byte counts, so an Athena query over them attributes the traffic. AWS also notes that routing S3 or DynamoDB traffic through a gateway VPC endpoint removes it from the NAT gateway’s billed bytes entirely.',
    },
  ]),
  defaultAlertRules: NATGW_DEFAULT_ALERT_RULES,
});
