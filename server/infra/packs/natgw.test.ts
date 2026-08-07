/**
 * NAT Gateway pack-definition tests.
 *
 * The cross-pack invariants live in `ec2.test.ts`'s `describe.each`. What is
 * here is the NAT-specific facts, and two of them are load-bearing in a way the
 * load balancer packs' are not: AWS publishes real recommended alarms for this
 * namespace, and it publishes a drop-ratio formula that names series the pack
 * has to actually collect for the formula to be usable.
 */

import { describe, it, expect } from 'vitest';
import { NATGW_PACK } from './natgw.js';
import { getServiceMetricPack, servicePollTierSeconds } from '../service-metric-packs.js';

function metric(name: string) {
  const found = NATGW_PACK.metrics.find((m) => m.metricName === name);
  expect(found, `${name} is not declared`).toBeDefined();
  return found!;
}

const rule = (name: string) => {
  const found = NATGW_PACK.defaultAlertRules.find((r) => r.name === name);
  expect(found, `no default rule named ${name}`).toBeDefined();
  return found!;
};

describe('natgw pack — the AWS facts it claims to encode', () => {
  it('collects only the NATGateway namespace', () => {
    expect(new Set(NATGW_PACK.metrics.map((m) => m.namespace))).toEqual(
      new Set(['AWS/NATGateway']),
    );
  });

  it('declares every metric the card requires, plus the ones the docs force', () => {
    expect(NATGW_PACK.metrics.map((m) => m.metricName).sort()).toEqual([
      'ActiveConnectionCount',
      'BytesInFromDestination',
      'BytesInFromSource',
      'BytesOutToDestination',
      'BytesOutToSource',
      'ErrorPortAllocation',
      'IdleTimeoutCount',
      'PacketsDropCount',
      'PacketsInFromDestination',
      'PacketsInFromSource',
    ]);
  });

  it('asks for everything at the 1-minute rate NAT gateways publish at', () => {
    // "NAT gateway metrics are sent to CloudWatch at 1-minute intervals."
    for (const m of NATGW_PACK.metrics) expect(m.minPeriodSeconds).toBe(60);
    expect(servicePollTierSeconds('natgw')).toBe(60);
  });

  it('keys every series on NatGatewayId alone', () => {
    for (const m of NATGW_PACK.metrics) expect(m.dimensions).toEqual(['NatGatewayId']);
  });

  describe('zonal versus regional gateways', () => {
    it('marks every metric as zonal-only rather than universal', () => {
      // "Zonal NAT gateways use only this dimension. Regional NAT gateways use
      // this dimension together with AvailabilityZone." CloudWatch treats each
      // combination as a separate metric, so a regional gateway publishes
      // nothing at the set collected here — an empty chart with working
      // collection, which is exactly what appliesTo exists to explain.
      for (const m of NATGW_PACK.metrics) {
        expect(m.appliesTo.universal, `${m.metricName} claims to be universal`).toBe(false);
        expect(m.appliesTo.condition).toMatch(/regional/i);
      }
    });

    it('declares AvailabilityZone as a dimension it knowingly does not collect', () => {
      const az = NATGW_PACK.dimensions.find((d) => d.name === 'AvailabilityZone');
      expect(az, 'the regional dimension must be declared even though it is unused').toBeDefined();
      expect(az!.description).toMatch(/regional/i);
      for (const m of NATGW_PACK.metrics) expect(m.dimensions).not.toContain('AvailabilityZone');
    });

    it('indexes the regional gap in absentMetrics with an honest remedy', () => {
      const absent = NATGW_PACK.absentMetrics.find((a) => /regional/i.test(a.label));
      expect(absent).toBeDefined();
      // Inventory sync already writes these rows with the NatGatewayId +
      // AvailabilityZone pair; the missing half is this pack declaring metrics
      // at that dimension set. The remedy has to say which half is done, or an
      // operator reads "not supported" and stops looking.
      expect(absent!.remedy).toMatch(/inventory sync already records/i);
      expect(absent!.remedy).toMatch(/AvailabilityZone/);
    });
  });

  describe('ErrorPortAllocation', () => {
    it('is a Sum counter, AWS’s only useful statistic for it', () => {
      const m = metric('ErrorPortAllocation');
      expect(m.metricType).toBe('counter');
      expect(m.stat).toBe('Sum');
      expect(m.validStatistics).toEqual(['Sum']);
      expect(m.description).toMatch(/too many concurrent connections/i);
    });

    it('encodes AWS’s recommended alarm verbatim, 15 of 15 included', () => {
      // The CloudWatch recommended-alarms page, AWS/NATGateway section: Sum,
      // threshold 0.0, GREATER_THAN_THRESHOLD, period 60, 15 datapoints of 15.
      const r = rule('NAT gateway cannot allocate source ports');
      expect(r.metricName).toBe('ErrorPortAllocation');
      expect(r.stat).toBe('Sum');
      expect(r.threshold).toBe(0);
      expect(r.comparisonOperator).toBe('GreaterThanThreshold');
      expect(r.periodS).toBe(60);
      expect(r.evaluationPeriods).toBe(15);
      expect(r.datapointsToAlarm).toBe(15);
      expect(r.severity).toBe('critical');
      expect(r.rationale).toMatch(/could not allocate a source port/i);
    });

    it('records that the VPC user guide gives a conflicting shape for the same metric', () => {
      // The VPC user guide's worked example says Maximum, 5-minute period, 3 of
      // 3. Two AWS pages disagree; a reviewer diffing against either needs to
      // know which one was chosen rather than assume a transcription error.
      expect(rule('NAT gateway cannot allocate source ports').rationale).toMatch(/VPC user guide/i);
    });
  });

  describe('PacketsDropCount and its ratio formula', () => {
    it('carries AWS’s formula verbatim, including the *100', () => {
      // "PacketsDropCount/(PacketsInFromSource+PacketsInFromDestination)*100".
      // The *100 matters: the published guidance compares a percentage against
      // 0.01, so reading it as a raw ratio is wrong by a factor of a hundred.
      const description = metric('PacketsDropCount').description;
      expect(description).toContain(
        'PacketsDropCount/(PacketsInFromSource+PacketsInFromDestination)*100',
      );
      expect(description).toMatch(/0\.01 percent/);
      expect(description).toMatch(/percentage/i);
    });

    it('collects both denominators, so the formula is computable', () => {
      // A documented formula that names series we do not collect is a formula
      // an operator cannot evaluate.
      for (const name of ['PacketsInFromSource', 'PacketsInFromDestination']) {
        expect(metric(name).stat).toBe('Sum');
      }
    });

    it('ships no default rule for it, and says why in absentMetrics', () => {
      // AWS's recommended threshold is the literal string "Depends on your
      // situation" — a per-deployment number derived from a ratio this engine
      // cannot evaluate. Inventing a round one is the exact failure INFRA-ALERT
      // exists to avoid.
      expect(NATGW_PACK.defaultAlertRules.some((r) => r.metricName === 'PacketsDropCount')).toBe(
        false,
      );

      const absent = NATGW_PACK.absentMetrics.find((a) => /dropped packets/i.test(a.label));
      expect(absent, 'the missing rule must be documented, not merely omitted').toBeDefined();
      expect(absent!.reason).toMatch(/Depends on your situation/i);
      // AWS's alarm shape survives in the remedy so an operator can finish it.
      expect(absent!.remedy).toMatch(/5 datapoints of 5/);
      expect(absent!.remedy).toMatch(/0\.01 percent/);
    });
  });

  describe('connection and cost metrics', () => {
    it('stores ActiveConnectionCount on Maximum as a gauge', () => {
      // AWS writes "The most useful statistic is Max" — the console's shorthand
      // for the CloudWatch statistic Maximum, which is what the API accepts. A
      // 60-second average hides the peak that caused the port errors.
      const m = metric('ActiveConnectionCount');
      expect(m.metricType).toBe('gauge');
      expect(m.stat).toBe('Maximum');
      expect(m.validStatistics).toEqual(['Maximum']);
    });

    it('sums IdleTimeoutCount and explains the 350-second rule', () => {
      const m = metric('IdleTimeoutCount');
      expect(m.stat).toBe('Sum');
      expect(m.description).toMatch(/350 seconds/);
    });

    it('surfaces BytesOutToDestination as a cost driver without overstating it', () => {
      // AWS bills every gigabyte processed "regardless of the traffic's source
      // or destination", so the egress counter alone understates the bill. Say
      // so rather than let a cost panel quietly undercount.
      const m = metric('BytesOutToDestination');
      expect(m.stat).toBe('Sum');
      expect(m.description).toMatch(/data processing charge/i);
      expect(m.description).toMatch(/understates/i);
    });

    it('collects all four byte counters, since all four are billed', () => {
      for (const name of [
        'BytesInFromSource',
        'BytesInFromDestination',
        'BytesOutToSource',
        'BytesOutToDestination',
      ]) {
        expect(metric(name).stat).toBe('Sum');
      }
    });
  });

  describe('VPC Flow Logs', () => {
    it('excludes them explicitly, on the grounds that they publish no metrics', () => {
      // Not a deferral — structural. There is no flow-logs CloudWatch namespace
      // at all; flow logs emit log *records* to CloudWatch Logs, S3 or Firehose.
      const absent = NATGW_PACK.absentMetrics.find((a) => /flow logs/i.test(a.label));
      expect(absent, 'flow logs must be explicitly excluded').toBeDefined();
      expect(absent!.reason).toMatch(/no CloudWatch metrics/i);
    });

    it('points at the log-derived path instead, with its latency stated', () => {
      const absent = NATGW_PACK.absentMetrics.find((a) => /flow logs/i.test(a.label))!;
      expect(absent.remedy).toMatch(/metric filter/i);
      expect(absent.remedy).toMatch(/Athena/i);
      // The remedy is minutes behind a NAT gateway metric; a reader choosing
      // between the two needs that before they pick it for an alarm.
      expect(absent.reason).toMatch(/10 minutes/);
    });
  });

  it('gates nothing behind a paid feature', () => {
    expect(NATGW_PACK.features).toEqual([]);
    for (const m of NATGW_PACK.metrics) expect(m.requiresFeature).toBeNull();
  });

  it('projects into the collector query list', () => {
    const specs = getServiceMetricPack('natgw');
    expect(specs).toHaveLength(NATGW_PACK.metrics.length);
    expect(specs.every((s) => s.requiresFeature === null)).toBe(true);
  });
});
