/**
 * ALB pack-definition tests.
 *
 * Same contract as `ec2.test.ts` and `ecs.test.ts`: not tests of behaviour — a
 * pack has none — but a machine-read of the AWS documentation the pack claims to
 * encode. The cross-pack invariants (statistics legal for the metric type, valid
 * periods, rules pointing at declared series, every dimension declared) live in
 * `ec2.test.ts`'s `describe.each` and already cover this pack. What is here is
 * the ALB-specific facts, which are mostly facts about *absence*.
 */

import { describe, it, expect } from 'vitest';
import { ALB_PACK } from './alb.js';
import { getServiceMetricPack, servicePollTierSeconds } from '../service-metric-packs.js';

/** A pack metric is identified by name, dimension set *and* statistic. */
function metric(name: string, stat: string, ...dimensions: string[]) {
  const found = ALB_PACK.metrics.find(
    (m) =>
      m.metricName === name &&
      m.stat === stat &&
      m.dimensions.length === dimensions.length &&
      dimensions.every((d) => m.dimensions.includes(d)),
  );
  expect(found, `${name} (${stat}) by ${dimensions.join('+')} is not declared`).toBeDefined();
  return found!;
}

const rule = (name: string) => {
  const found = ALB_PACK.defaultAlertRules.find((r) => r.name === name);
  expect(found, `no default rule named ${name}`).toBeDefined();
  return found!;
};

describe('alb pack — the AWS facts it claims to encode', () => {
  it('collects only the ApplicationELB namespace', () => {
    expect(new Set(ALB_PACK.metrics.map((m) => m.namespace))).toEqual(
      new Set(['AWS/ApplicationELB']),
    );
  });

  it('declares every metric the card is responsible for', () => {
    expect([...new Set(ALB_PACK.metrics.map((m) => m.metricName))].sort()).toEqual([
      'HTTPCode_ELB_502_Count',
      'HTTPCode_ELB_503_Count',
      'HTTPCode_ELB_504_Count',
      'HTTPCode_ELB_5XX_Count',
      'HTTPCode_Target_5XX_Count',
      'HealthyHostCount',
      'RejectedConnectionCount',
      'RequestCount',
      'RequestCountPerTarget',
      'TargetConnectionErrorCount',
      'TargetResponseTime',
      'UnHealthyHostCount',
    ]);
  });

  it('asks for everything at the 60-second rate ELB publishes at', () => {
    // "If there are requests flowing through the load balancer, Elastic Load
    // Balancing measures and sends its metrics in 60-second intervals."
    for (const m of ALB_PACK.metrics) expect(m.minPeriodSeconds).toBe(60);
    expect(servicePollTierSeconds('alb')).toBe(60);
  });

  it('gates nothing behind a paid feature', () => {
    // Unlike ECS, every ALB metric is published with no opt-in and no charge.
    expect(ALB_PACK.features).toEqual([]);
    for (const m of ALB_PACK.metrics) expect(m.requiresFeature).toBeNull();
  });

  describe('TargetResponseTime — a distribution, not a level', () => {
    it('is typed as latency so percentiles are legal on it', () => {
      for (const stat of ['Average', 'p50', 'p99']) {
        expect(metric('TargetResponseTime', stat, 'LoadBalancer').metricType).toBe('latency');
      }
    });

    it('collects the Average and at least two percentiles as separate series', () => {
      // The statistic is part of the stored series key, so these are three
      // series and three billed GetMetricData entries, not one metric read
      // three ways.
      const stats = ALB_PACK.metrics
        .filter((m) => m.metricName === 'TargetResponseTime')
        .map((m) => m.stat);
      expect(stats).toContain('Average');
      expect(stats.filter((s) => s.startsWith('p')).length).toBeGreaterThanOrEqual(2);
      expect(new Set(stats).size).toBe(stats.length);
    });

    it('transcribes AWS’s pNN.NN notation rather than guessing a percentile list', () => {
      // "The most useful statistics are Average and pNN.NN (percentiles)." AWS
      // names no specific percentile because every one of them is legal.
      const m = metric('TargetResponseTime', 'p99', 'LoadBalancer');
      expect(m.validStatistics).toEqual(['Average', 'pNN.NN']);
    });

    it('is the only latency metric in the pack', () => {
      const latency = ALB_PACK.metrics.filter((m) => m.metricType === 'latency');
      expect(new Set(latency.map((m) => m.metricName))).toEqual(new Set(['TargetResponseTime']));
    });
  });

  describe('RequestCountPerTarget — the Sum that is not a sum', () => {
    const m = () => metric('RequestCountPerTarget', 'Sum', 'LoadBalancer', 'TargetGroup');

    it('stores Sum, which AWS calls the only *valid* statistic', () => {
      // "The only valid statistic is Sum. This represents the average not the
      // sum." Note "valid" — stronger than the "most useful" wording every other
      // metric on the page gets.
      expect(m().stat).toBe('Sum');
      expect(m().validStatistics).toEqual(['Sum']);
    });

    it('says in the description that the number is an average', () => {
      // This is the whole point of the metric being in the pack: a dashboard
      // that adds it up across periods is the classic wrong dashboard, and
      // nothing in the CloudWatch API hints at it.
      expect(m().description).toMatch(/average not the sum/i);
      expect(m().description).toMatch(/divided by the number of healthy targets/i);
    });

    it('requires the TargetGroup dimension', () => {
      // "You must specify the target group using the TargetGroup dimension."
      expect(m().dimensions).toContain('TargetGroup');
    });

    it('is scoped away from Lambda target groups', () => {
      expect(m().appliesTo.universal).toBe(false);
      expect(m().appliesTo.condition).toMatch(/Lambda/);
    });
  });

  describe('target group health', () => {
    it('keys both host counts on LoadBalancer + TargetGroup', () => {
      // AWS publishes no load-balancer-only host count. A query without the
      // target group returns nothing at all rather than an aggregate.
      for (const [name, stat] of [
        ['HealthyHostCount', 'Maximum'],
        ['UnHealthyHostCount', 'Minimum'],
      ]) {
        const m = metric(name!, stat!, 'LoadBalancer', 'TargetGroup');
        expect(m.metricType).toBe('gauge');
        expect(m.validStatistics).toEqual(['Average', 'Minimum', 'Maximum']);
      }
    });

    it('stores UnHealthyHostCount on Minimum, as AWS explicitly recommends', () => {
      // "We recommend you monitor for non-zero UnHealthyHostCount in the Minimum
      // statistic […] Using the Minimum will detect when targets are considered
      // unhealthy by every node and Availability Zone of your load balancer."
      expect(metric('UnHealthyHostCount', 'Minimum', 'LoadBalancer', 'TargetGroup').stat).toBe(
        'Minimum',
      );
    });

    it('stores HealthyHostCount on Maximum, the cross-node consensus', () => {
      // Min/Max here span load balancer *nodes* within one sampling window, not
      // time. Maximum answers "is there capacity anywhere"; Minimum would fire
      // whenever a single node briefly lost sight of its targets.
      expect(metric('HealthyHostCount', 'Maximum', 'LoadBalancer', 'TargetGroup').stat).toBe(
        'Maximum',
      );
    });
  });

  describe('the 5XX splits', () => {
    it.each([
      'HTTPCode_ELB_5XX_Count',
      'HTTPCode_ELB_502_Count',
      'HTTPCode_ELB_503_Count',
      'HTTPCode_ELB_504_Count',
      'HTTPCode_Target_5XX_Count',
    ])('sums %s and lists no other meaningful statistic', (name) => {
      // AWS on the aggregate code counters: "Minimum, Maximum, and Average all
      // return 1." An average-based alarm on one of these is not imprecise, it
      // is a constant.
      const m = metric(name, 'Sum', 'LoadBalancer');
      expect(m.metricType).toBe('counter');
      expect(m.validStatistics).toEqual(['Sum']);
    });

    it('separates load-balancer-generated errors from target-generated ones', () => {
      // HTTPCode_ELB_5XX_Count "does not include any response codes generated by
      // the targets", and HTTPCode_Target_5XX_Count "does not include any
      // response codes generated by the load balancer". Charting one as the
      // other attributes an outage to the wrong tier.
      expect(metric('HTTPCode_ELB_5XX_Count', 'Sum', 'LoadBalancer').description).toMatch(
        /originating from the load balancer/i,
      );
      expect(metric('HTTPCode_Target_5XX_Count', 'Sum', 'LoadBalancer').description).toMatch(
        /generated by the targets/i,
      );
    });
  });

  describe('metrics that are absent rather than zero', () => {
    it('records that an idle load balancer publishes nothing at all', () => {
      // "If there are no requests flowing through the load balancer or no data
      // for a metric, the metric is not reported." Every default rule below
      // depends on this being stated somewhere an operator will read it.
      const idle = ALB_PACK.absentMetrics.find((a) => /idle/i.test(a.label));
      expect(idle, 'the gap-not-zero behaviour must be documented').toBeDefined();
      expect(idle!.reason).toMatch(/only when requests are flowing/i);
      expect(idle!.remedy).toMatch(/not breaching/i);
    });

    it('documents that "traffic stopped" cannot be alarmed on by these rules', () => {
      // The evidence for a total stop is the absence of datapoints, and every
      // rule here treats absence as not breaching so a quiet load balancer does
      // not page. A rule cannot have it both ways on one series — say so rather
      // than let an operator assume coverage.
      const stopped = ALB_PACK.absentMetrics.find((a) => /traffic stopped/i.test(a.label));
      expect(stopped).toBeDefined();
      expect(stopped!.remedy).toMatch(/breaching/);
    });

    it('documents that an emptied target group cannot fire the host-count rules', () => {
      // Both host counts are "Reported if there are registered targets", so
      // deregistering the last target produces missing data rather than a zero
      // — and both host-count rules treat missing as notBreaching. The gap is
      // real and the only honest move is to name it.
      const absent = ALB_PACK.absentMetrics.find((a) => /no registered targets/i.test(a.label));
      expect(absent, 'the empty-target-group gap must be documented').toBeDefined();
      expect(absent!.reason).toMatch(/if there are registered targets/i);
      // The remedy has to be the handling that can actually alarm on absence.
      expect(absent!.remedy).toMatch(/breaching/);
      // And it must say the rule has to be pinned, because unpinned it would
      // match load-balancer rows that never publish a host count.
      expect(absent!.remedy).toMatch(/pin/i);
    });

    it('documents why an error *rate* is not expressible', () => {
      const ratio = ALB_PACK.absentMetrics.find((a) => /percentage of requests/i.test(a.label));
      expect(ratio).toBeDefined();
      expect(ratio!.reason).toMatch(/metric[- ]math/i);
      // The denominator vanishing is the part that makes a hand-rolled ratio
      // actively misleading rather than merely unavailable.
      expect(ratio!.reason).toMatch(/registered targets/i);
    });
  });

  describe('default alert rules', () => {
    it('sets treatMissingData explicitly on every rule, and never to `missing`', () => {
      // The pack's single most consequential choice. Under the CloudWatch
      // default of `missing`, a healthy load balancer that published no errors
      // would sit in INSUFFICIENT_DATA permanently.
      expect(ALB_PACK.defaultAlertRules.length).toBeGreaterThan(0);
      for (const r of ALB_PACK.defaultAlertRules) {
        expect(r.treatMissingData, `${r.name} must not use the CloudWatch default`).toBe(
          'notBreaching',
        );
      }
    });

    it('encodes AWS’s UnHealthyHostCount recommendation, datapoint count included', () => {
      // "monitor for non-zero UnHealthyHostCount in the Minimum statistic, and
      // alarm on non-zero value for more than one data point." Two is the
      // smallest number satisfying "more than one".
      const r = rule('ALB target group has unhealthy targets');
      expect(r.stat).toBe('Minimum');
      expect(r.threshold).toBe(0);
      expect(r.comparisonOperator).toBe('GreaterThanThreshold');
      expect(r.datapointsToAlarm).toBeGreaterThan(1);
      expect(r.evaluationPeriods).toBe(r.datapointsToAlarm);
      expect(r.periodS).toBe(60);
      expect(r.severity).toBe('critical');
      expect(r.rationale).toMatch(/every node and Availability Zone/i);
    });

    it('pairs it with a healthy-host rule as the severe tier of the same signal', () => {
      // The unhealthy rule fires when every node agrees *some* target is
      // unhealthy; this one when no node can see *any* healthy target. Zero
      // routable capacity, not partial degradation.
      const r = rule('ALB target group has no healthy targets');
      expect(r.stat).toBe('Maximum');
      expect(r.threshold).toBe(0);
      expect(r.comparisonOperator).toBe('LessThanOrEqualToThreshold');
      expect(r.severity).toBe('critical');
    });

    it('states that the healthy-host rule cannot catch a deregistered target group', () => {
      // Regression guard. An earlier draft justified this rule by AWS's
      // deregistration asymmetry — "a deployment that removed every target is
      // invisible to the unhealthy-count rule and visible here" — which is
      // false: HealthyHostCount is reported only "if there are registered
      // targets", so removing the last one yields missing data, and the rule
      // treats missing as notBreaching. The alarm stays OK. Any rationale for
      // this rule must carry the limitation rather than claim the coverage.
      const r = rule('ALB target group has no healthy targets');
      expect(r.treatMissingData).toBe('notBreaching');
      expect(r.rationale).toMatch(/if there are registered targets/i);
      expect(r.rationale).toMatch(/missing data/i);
      // And it must point at the entry that carries the real remedy.
      expect(r.rationale).toMatch(/no registered targets/i);
    });

    it('fires on a single rejected connection', () => {
      // The metric is only published once connections have already been turned
      // away, so waiting for a repeat delays notice of damage already done.
      const r = rule('ALB is rejecting connections');
      expect(r.metricName).toBe('RejectedConnectionCount');
      expect(r.stat).toBe('Sum');
      expect(r.threshold).toBe(0);
      expect(r.comparisonOperator).toBe('GreaterThanThreshold');
      expect(r.evaluationPeriods).toBe(1);
      expect(r.datapointsToAlarm).toBe(1);
      expect(r.severity).toBe('critical');
    });

    it.each(['ALB is generating 5XX responses', 'ALB cannot connect to its targets'])(
      'requires %s to persist across a deployment window',
      (name) => {
        // 502s and 503s are normal while targets drain and register during a
        // rolling deploy; five consecutive minutes is what separates that from
        // an outage. One datapoint would page on every deployment.
        const r = rule(name);
        expect(r.threshold).toBe(0);
        expect(r.comparisonOperator).toBe('GreaterThanThreshold');
        expect(r.evaluationPeriods).toBe(5);
        expect(r.datapointsToAlarm).toBe(5);
        expect(r.severity).toBe('warning');
      },
    );

    it('never claims a CloudWatch recommended alarm for ApplicationELB', () => {
      // There is no ApplicationELB section on the CloudWatch recommended-alarms
      // page — it covers EC2, ECS, RDS, NAT Gateway and two dozen others and has
      // no ELB entry of any kind. The two host-count rules do cite AWS, but the
      // ELB developer guide's prose, and they name that source.
      // Matched on the affirmative claim form the EC2, ECS and NAT Gateway packs
      // use ("AWS best-practice alarm:", "AWS recommended alarm, verbatim:"),
      // not on any mention of the page — the UnHealthyHostCount rationale names
      // it precisely to say ALB is absent from it.
      for (const r of ALB_PACK.defaultAlertRules) {
        expect(
          /AWS (?:best[- ]practice|recommended) alarm/i.test(r.rationale),
          `${r.name} claims an AWS-published alarm that does not exist`,
        ).toBe(false);
      }
    });

    it('makes every rule declare whether its threshold is AWS’s or ours', () => {
      // The rule that matters most for a reviewer: a threshold is either quoted
      // from AWS with the quote present, or it is ours and says so. A rationale
      // that does neither is a round number wearing a citation.
      for (const r of ALB_PACK.defaultAlertRules) {
        const quotesAws = /AWS (?:documents|recommends|, verbatim)|We recommend you monitor/i.test(
          r.rationale,
        );
        const ownsIt = /AWS publishes no threshold/i.test(r.rationale);
        expect(
          quotesAws || ownsIt,
          `${r.name} neither quotes AWS nor admits the threshold is ours`,
        ).toBe(true);
      }
    });
  });

  it('projects into the collector query list, percentiles and all', () => {
    const specs = getServiceMetricPack('alb');
    expect(specs).toHaveLength(ALB_PACK.metrics.length);
    expect(specs.filter((s) => s.stat === 'p99')).toHaveLength(1);
    // Nothing in this pack is feature-gated, so nothing can be silently skipped.
    expect(specs.every((s) => s.requiresFeature === null)).toBe(true);
  });
});
