/**
 * NLB pack-definition tests.
 *
 * The cross-pack invariants live in `ec2.test.ts`'s `describe.each` and already
 * cover this pack. What is here is the NLB-specific facts, and most of them
 * exist to stop the ALB pack being copied across: the two services document
 * different useful statistics for identically-named metrics, and AWS publishes a
 * two-sided host-count recommendation here that it does not publish for ALB.
 */

import { describe, it, expect } from 'vitest';
import { ALB_PACK } from './alb.js';
import { NLB_PACK } from './nlb.js';
import { getServiceMetricPack, servicePollTierSeconds } from '../service-metric-packs.js';

function metric(name: string, ...dimensions: string[]) {
  const found = NLB_PACK.metrics.find(
    (m) =>
      m.metricName === name &&
      m.dimensions.length === dimensions.length &&
      dimensions.every((d) => m.dimensions.includes(d)),
  );
  expect(found, `${name} by ${dimensions.join('+')} is not declared`).toBeDefined();
  return found!;
}

const rule = (name: string) => {
  const found = NLB_PACK.defaultAlertRules.find((r) => r.name === name);
  expect(found, `no default rule named ${name}`).toBeDefined();
  return found!;
};

describe('nlb pack — the AWS facts it claims to encode', () => {
  it('collects only the NetworkELB namespace', () => {
    expect(new Set(NLB_PACK.metrics.map((m) => m.namespace))).toEqual(new Set(['AWS/NetworkELB']));
  });

  it('declares every metric the card is responsible for', () => {
    expect(NLB_PACK.metrics.map((m) => m.metricName).sort()).toEqual([
      'ActiveFlowCount',
      'HealthyHostCount',
      'NewFlowCount',
      'PortAllocationErrorCount',
      'TCP_Client_Reset_Count',
      'TCP_ELB_Reset_Count',
      'TCP_Target_Reset_Count',
      'UnHealthyHostCount',
    ]);
  });

  it('asks for everything at the 60-second rate ELB publishes at', () => {
    for (const m of NLB_PACK.metrics) expect(m.minPeriodSeconds).toBe(60);
    expect(servicePollTierSeconds('nlb')).toBe(60);
  });

  it('is a separate service from ALB, not a second namespace on one pack', () => {
    // The LoadBalancer dimension *name* is identical on both, so a single
    // `elbv2` token would make the collector request every ApplicationELB metric
    // against each NLB and vice versa — each a billed GetMetricData entry
    // returning an empty series. Only the namespace and the `app/` vs `net/`
    // value prefix distinguish them.
    expect(NLB_PACK.service).not.toBe(ALB_PACK.service);
    expect(NLB_PACK.dimensions.find((d) => d.name === 'LoadBalancer')!.description).toMatch(
      /net\//,
    );
    expect(ALB_PACK.dimensions.find((d) => d.name === 'LoadBalancer')!.description).toMatch(
      /app\//,
    );
  });

  describe('flow metrics — a gauge and a counter that look like a pair', () => {
    it('treats ActiveFlowCount as a concurrent level', () => {
      // "The most useful statistics are Average, Maximum, and Minimum" — the
      // vocabulary of a gauge. Maximum because the number is read against the
      // ~55,000-per-target ceiling, and an average hides a ten-second peak that
      // dropped connections.
      const m = metric('ActiveFlowCount', 'LoadBalancer');
      expect(m.metricType).toBe('gauge');
      expect(m.stat).toBe('Maximum');
      expect(m.validStatistics).toEqual(['Average', 'Maximum', 'Minimum']);
    });

    it('treats NewFlowCount as a per-period total', () => {
      // "The most useful statistic is Sum." AWS lists these two adjacently and
      // they read like a pair; they are different kinds of number.
      const m = metric('NewFlowCount', 'LoadBalancer');
      expect(m.metricType).toBe('counter');
      expect(m.stat).toBe('Sum');
      expect(m.validStatistics).toEqual(['Sum']);
    });
  });

  describe('resets', () => {
    it.each(['TCP_Client_Reset_Count', 'TCP_ELB_Reset_Count', 'TCP_Target_Reset_Count'])(
      'sums %s at the load balancer dimension only',
      (name) => {
        // AWS publishes the reset family at LoadBalancer and
        // AvailabilityZone+LoadBalancer, never at TargetGroup.
        const m = metric(name, 'LoadBalancer');
        expect(m.metricType).toBe('counter');
        expect(m.stat).toBe('Sum');
        expect(m.dimensions).not.toContain('TargetGroup');
      },
    );

    it('documents that resets cannot be attributed to a target group', () => {
      const absent = NLB_PACK.absentMetrics.find((a) => /target group/i.test(a.label));
      expect(absent, 'the missing TargetGroup reset series must be documented').toBeDefined();
      expect(absent!.reason).toMatch(/no TargetGroup variant/i);
    });
  });

  describe('PortAllocationErrorCount', () => {
    const m = () => metric('PortAllocationErrorCount', 'LoadBalancer');

    it('is a Sum counter at the load balancer dimension', () => {
      expect(m().metricType).toBe('counter');
      expect(m().stat).toBe('Sum');
      expect(m().validStatistics).toEqual(['Sum']);
    });

    it('says it applies when client IP preservation is DISABLED', () => {
      // The intuition runs the other way, which is why it is spelled out. AWS:
      // "when client IP preservation is disabled, a Network Load Balancer
      // supports 55,000 simultaneous connections […] If you exceed these limits,
      // there is an increased chance of port allocation errors." Source NAT is
      // what forces a port allocation per flow.
      expect(m().description).toMatch(/disabled/i);
      expect(m().description).toMatch(/55,000/);
    });

    it('records AWS’s remedy, which is more targets rather than a bigger LB', () => {
      expect(m().description).toMatch(/more targets/i);
    });

    it('ships the > 0 rule the card requires, firing on one datapoint', () => {
      // "A non-zero value indicates dropped client connections." The connection
      // is already lost by the time the datapoint exists.
      const r = rule('NLB is exhausting ephemeral ports');
      expect(r.metricName).toBe('PortAllocationErrorCount');
      expect(r.stat).toBe('Sum');
      expect(r.threshold).toBe(0);
      expect(r.comparisonOperator).toBe('GreaterThanThreshold');
      expect(r.evaluationPeriods).toBe(1);
      expect(r.datapointsToAlarm).toBe(1);
      expect(r.rationale).toMatch(/dropped client connections/i);
    });
  });

  describe('target group health — where the NLB docs diverge from the ALB docs', () => {
    it('omits Average from the documented statistics, unlike ALB', () => {
      // NLB: "The most useful statistics are Maximum and Minimum."
      // ALB: "The most useful statistics are Average, Minimum, and Maximum."
      // Averaging a count across load balancer nodes is a number no node ever
      // reported, and copying the ALB pack across would import it.
      for (const name of ['HealthyHostCount', 'UnHealthyHostCount']) {
        const nlb = metric(name, 'LoadBalancer', 'TargetGroup');
        expect(nlb.validStatistics).toEqual(['Maximum', 'Minimum']);
        expect(nlb.validStatistics).not.toContain('Average');

        const alb = ALB_PACK.metrics.find((m) => m.metricName === name)!;
        expect(alb.validStatistics).toContain('Average');
      }
    });

    it('stores the healthy count on Maximum and the unhealthy count on Minimum', () => {
      // AWS's own two-sided recommendation on this page, and the reason the
      // statistics are not symmetric: both pick the reading the whole fleet of
      // load balancer nodes agrees on.
      expect(metric('HealthyHostCount', 'LoadBalancer', 'TargetGroup').stat).toBe('Maximum');
      expect(metric('UnHealthyHostCount', 'LoadBalancer', 'TargetGroup').stat).toBe('Minimum');
    });

    it('keys both counts on LoadBalancer + TargetGroup', () => {
      // AWS publishes no load-balancer-only host count on NLB either.
      for (const name of ['HealthyHostCount', 'UnHealthyHostCount']) {
        expect(metric(name, 'LoadBalancer', 'TargetGroup').dimensions).toContain('TargetGroup');
      }
    });

    it('encodes AWS’s maximum-HealthyHostCount recommendation and its 0 fallback', () => {
      // "invoking the alarm when the maximum HealthyHostCount falls below your
      // required minimum, or being 0." The required minimum is deployment
      // specific, so the default takes AWS's own concrete alternative.
      const r = rule('NLB target group has no healthy targets');
      expect(r.stat).toBe('Maximum');
      expect(r.threshold).toBe(0);
      expect(r.comparisonOperator).toBe('LessThanOrEqualToThreshold');
      expect(r.severity).toBe('critical');
      expect(r.rationale).toMatch(/falls below your required minimum/i);
    });

    it('encodes AWS’s minimum-UnHealthyHostCount recommendation', () => {
      // "invoking the alarm when the minimum UnHealthyHostCount rises above 0.
      // This allows you to become aware when there are no longer any registered
      // targets."
      const r = rule('NLB target group has unhealthy targets');
      expect(r.stat).toBe('Minimum');
      expect(r.threshold).toBe(0);
      expect(r.comparisonOperator).toBe('GreaterThanThreshold');
      expect(r.severity).toBe('critical');
      expect(r.rationale).toMatch(/rises above 0/i);
    });

    it('flags that AWS’s own justification for that rule does not hold', () => {
      // AWS says monitoring minimum UnHealthyHostCount makes you "aware when
      // there are no longer any registered targets". It cannot: the metric is
      // reported only "if there are registered targets", so an emptied target
      // group stops publishing rather than raising the count. Quoting AWS is
      // right; repeating a claim its own reporting criteria contradict is not.
      expect(rule('NLB target group has unhealthy targets').rationale).toMatch(
        /if there are registered targets/i,
      );
    });

    it('states that the healthy-host rule cannot catch a deregistered target group', () => {
      const r = rule('NLB target group has no healthy targets');
      expect(r.treatMissingData).toBe('notBreaching');
      expect(r.rationale).toMatch(/if there are registered targets/i);
      expect(r.rationale).toMatch(/not breaching/i);
    });

    it('documents the emptied-target-group gap with a handling that can alarm on it', () => {
      const absent = NLB_PACK.absentMetrics.find((a) => /no registered targets/i.test(a.label));
      expect(absent, 'the empty-target-group gap must be documented').toBeDefined();
      expect(absent!.reason).toMatch(/if there are registered targets/i);
      expect(absent!.remedy).toMatch(/breaching/);
      expect(absent!.remedy).toMatch(/pin/i);
    });
  });

  describe('default alert rules', () => {
    it('sets treatMissingData explicitly on every rule, and never to `missing`', () => {
      // Same reasoning as ALB: ELB publishes nothing when no traffic is
      // flowing, so the CloudWatch default would park every healthy load
      // balancer in INSUFFICIENT_DATA.
      expect(NLB_PACK.defaultAlertRules.length).toBeGreaterThan(0);
      for (const r of NLB_PACK.defaultAlertRules) {
        expect(r.treatMissingData, `${r.name} must not use the CloudWatch default`).toBe(
          'notBreaching',
        );
      }
    });

    it('never claims a CloudWatch recommended alarm that does not exist', () => {
      // The recommended-alarms page has no NetworkELB section. The host-count
      // rules cite the NLB developer guide's prose instead, which is a different
      // AWS source and is quoted as such.
      for (const r of NLB_PACK.defaultAlertRules) {
        expect(
          /AWS (?:best[- ]practice|recommended) alarm/i.test(r.rationale),
          `${r.name} claims an AWS-published alarm that does not exist`,
        ).toBe(false);
      }
    });
  });

  it('gates nothing behind a paid feature', () => {
    expect(NLB_PACK.features).toEqual([]);
    for (const m of NLB_PACK.metrics) expect(m.requiresFeature).toBeNull();
  });

  it('projects into the collector query list', () => {
    const specs = getServiceMetricPack('nlb');
    expect(specs).toHaveLength(NLB_PACK.metrics.length);
    expect(specs.every((s) => s.requiresFeature === null)).toBe(true);
  });
});
