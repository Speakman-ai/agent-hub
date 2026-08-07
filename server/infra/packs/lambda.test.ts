/**
 * Lambda pack-definition tests.
 *
 * The shared invariants every pack must satisfy live in `ec2.test.ts`'s
 * `describe.each(ALL_PACKS)` block and cover this pack automatically. What is
 * here is the Lambda-specific half, and it exists mostly to hold three lines
 * that are easy to lose in a refactor: an invocation counter must stay on `Sum`
 * because AWS publishes it as 0-or-1 per invocation, `Duration` must keep all
 * three of its statistics because each answers a question the others hide, and
 * `ProvisionedConcurrencyUtilization`'s rule must keep treating missing data as
 * not breaching, because AWS documents that Lambda stops emitting the metric
 * when the function is idle.
 */

import { describe, it, expect } from 'vitest';
import { LAMBDA_PACK } from './lambda.js';
import { PERCENTILE_STATISTIC_TOKEN, isPercentileStatistic } from './types.js';
import {
  getServiceMetricPack,
  effectiveServicePollIntervalSeconds,
} from '../service-metric-packs.js';

const ruleFor = (metricName: string) =>
  LAMBDA_PACK.defaultAlertRules.find((r) => r.metricName === metricName)!;
const metricFor = (metricName: string, stat: string) =>
  LAMBDA_PACK.metrics.find((m) => m.metricName === metricName && m.stat === stat)!;

/** Every metric AWS classes as a binary per-invocation indicator. */
const INVOCATION_METRICS = [
  'Invocations',
  'Errors',
  'Throttles',
  'AsyncEventsReceived',
  'AsyncEventsDropped',
];

describe('lambda pack — the AWS facts it claims to encode', () => {
  it('declares every series the card is responsible for', () => {
    // Keyed on metric + statistic, because Duration is three series here and a
    // list of bare metric names would hide two of them.
    expect(LAMBDA_PACK.metrics.map((m) => `${m.metricName}/${m.stat}`).sort()).toEqual(
      [
        'AsyncEventAge/Maximum',
        'AsyncEventsDropped/Sum',
        'AsyncEventsReceived/Sum',
        'ConcurrentExecutions/Maximum',
        'Duration/Average',
        'Duration/Maximum',
        'Duration/p90',
        'Errors/Sum',
        'Invocations/Sum',
        'IteratorAge/Maximum',
        'ProvisionedConcurrencyUtilization/Maximum',
        'Throttles/Sum',
      ].sort(),
    );
  });

  it('floors every metric at the free 1-minute publication rate', () => {
    // "Lambda sends metric data to CloudWatch in 1-minute intervals", and
    // "there's no additional charge for these metrics".
    for (const metric of LAMBDA_PACK.metrics) {
      expect(metric.minPeriodSeconds, `${metric.metricName} floors elsewhere`).toBe(60);
      expect(metric.availability).toBe('either');
      expect(metric.requiresFeature).toBeNull();
    }
    expect(LAMBDA_PACK.features).toEqual([]);
    for (const spec of getServiceMetricPack('lambda')) {
      expect(effectiveServicePollIntervalSeconds('lambda', spec)).toBe(60);
    }
  });

  it.each(INVOCATION_METRICS)('stores %s on Sum and documents no other statistic', (name) => {
    // "Invocation metrics are binary indicators of the outcome of a Lambda
    // function invocation. View these metrics with the Sum statistic." An
    // Average of Errors is an error rate and a Maximum of it is always 1, so
    // widening this list is how a count silently becomes a ratio.
    const metric = LAMBDA_PACK.metrics.find((m) => m.metricName === name)!;
    expect(metric.metricType).toBe('counter');
    expect(metric.stat).toBe('Sum');
    expect(metric.validStatistics).toEqual(['Sum']);
  });

  it('keeps Duration on all three statistics, each for a different question', () => {
    const average = metricFor('Duration', 'Average');
    const maximum = metricFor('Duration', 'Maximum');
    const p90 = metricFor('Duration', 'p90');
    for (const metric of [average, maximum, p90]) {
      expect(metric.metricType).toBe('latency');
      expect(metric.validStatistics).toContain(PERCENTILE_STATISTIC_TOKEN);
    }
    expect(isPercentileStatistic(p90.stat)).toBe(true);
    // The Maximum is the timeout detector and the percentile is designed to
    // hide it — which is exactly why dropping either one loses information.
    expect(maximum.description).toMatch(/timeout/i);
    expect(p90.description).toMatch(/outlier/i);
    // AWS's own recommended Duration alarm is the p90 one, so the rule must
    // resolve to that series rather than to the Average declared first.
    expect(ruleFor('Duration').stat).toBe('p90');
  });

  it('reads concurrency at the peak, as AWS recommends', () => {
    // "To see how close you are to hitting concurrency limits, view these
    // metrics with the Max statistic." An average hides the peak that actually
    // breaches the quota.
    expect(metricFor('ConcurrentExecutions', 'Maximum').stat).toBe('Maximum');
    const rule = ruleFor('ConcurrentExecutions');
    expect(rule.stat).toBe('Maximum');
    // 90% of the default 1,000 regional quota, which is AWS's arithmetic on
    // AWS's own default rather than a round number someone liked.
    expect(rule.threshold).toBe(900);
    expect(rule.evaluationPeriods).toBe(10);
    expect(rule.datapointsToAlarm).toBe(10);
  });

  it('documents ProvisionedConcurrencyUtilization as not emitted when idle', () => {
    const metric = metricFor('ProvisionedConcurrencyUtilization', 'Maximum');
    expect(metric.appliesTo.universal).toBe(false);
    // AWS's own warning, which is the reason the rule below is shaped the way
    // it is: "If your function is inactive or not receiving requests, Lambda
    // doesn't emit this metric... Keep this in mind if you use
    // ProvisionedConcurrencyUtilization as the basis for CloudWatch alarms."
    expect(metric.appliesTo.condition).toMatch(/doesn’t emit this metric|doesn't emit this metric/);
    expect(metric.appliesTo.condition).toMatch(/inactive|idle/i);
  });

  it('keeps the provisioned-concurrency rule out of a permanent INSUFFICIENT_DATA state', () => {
    // This is the acceptance criterion in code. Under CloudWatch's default of
    // `missing`, an unpinned rule on a metric that most functions never emit
    // sits in INSUFFICIENT_DATA on every one of them, forever.
    const rule = ruleFor('ProvisionedConcurrencyUtilization');
    expect(rule.treatMissingData).toBe('notBreaching');
    expect(rule.stat).toBe('Maximum');
    // The metric is a fraction of configured capacity, so 0.9 is 90% of what
    // you are already paying for and 1.0 is where invocations start spilling
    // onto on-demand concurrency and paying a cold start.
    expect(rule.threshold).toBe(0.9);
    expect(rule.threshold).toBeLessThan(1);
    expect(rule.rationale).toMatch(/INSUFFICIENT_DATA/);
  });

  it('collects both sides of AWS’s async backlog comparison and explains why it cannot alarm on it', () => {
    // "Mismatches between AsyncEventsReceived and Invocations can indicate a
    // disparity in processing, events being dropped, or a potential queue
    // backlog." Both series have to be collected for the chart to be possible.
    expect(LAMBDA_PACK.metrics.some((m) => m.metricName === 'AsyncEventsReceived')).toBe(true);
    expect(LAMBDA_PACK.metrics.some((m) => m.metricName === 'Invocations')).toBe(true);

    const absent = LAMBDA_PACK.absentMetrics.find((a) => /AsyncEventsReceived/.test(a.label))!;
    expect(absent.reason).toMatch(/metric-math|metric math/i);
    // The remedy has to point at the alarm that does work, or the entry is a
    // shrug rather than an answer.
    expect(absent.remedy).toMatch(/AsyncEventAge/);
    expect(ruleFor('AsyncEventAge')).toBeDefined();
  });

  it('alarms dropped async events above zero, because a dropped event is lost work', () => {
    const rule = ruleFor('AsyncEventsDropped');
    expect(rule.threshold).toBe(0);
    expect(rule.comparisonOperator).toBe('GreaterThanThreshold');
    expect(rule.evaluationPeriods).toBe(1);
    expect(rule.severity).toBe('critical');
  });

  it('ships AWS’s Errors and Throttles alarms with their operators unchanged', () => {
    const errors = ruleFor('Errors');
    expect(errors.stat).toBe('Sum');
    expect(errors.threshold).toBe(0);
    expect(errors.comparisonOperator).toBe('GreaterThanThreshold');
    expect(errors.evaluationPeriods).toBe(3);

    const throttles = ruleFor('Throttles');
    expect(throttles.stat).toBe('Sum');
    // AWS specifies the inclusive operator here and the exclusive one for
    // Errors. With >= the threshold is 1, not 0 — swapping the pair silently
    // turns "any throttle" into "any throttle plus one".
    expect(throttles.comparisonOperator).toBe('GreaterThanOrEqualToThreshold');
    expect(throttles.threshold).toBe(1);
    expect(throttles.evaluationPeriods).toBe(5);
  });

  it('treats missing data as not breaching exactly for the series not every function publishes', () => {
    for (const rule of LAMBDA_PACK.defaultAlertRules) {
      const metric = metricFor(rule.metricName, rule.stat);
      expect(
        rule.treatMissingData,
        `${rule.name} treats missing data as ${rule.treatMissingData} for a ${
          metric.appliesTo.universal ? 'universal' : 'non-universal'
        } metric`,
      ).toBe(metric.appliesTo.universal ? 'missing' : 'notBreaching');
    }
  });

  it('labels every invented threshold as a unit rather than a recommendation', () => {
    for (const name of ['Duration', 'AsyncEventAge', 'IteratorAge']) {
      const rule = ruleFor(name);
      expect(rule.rationale, `${rule.name} does not label its stand-in`).toMatch(
        /unit standing in/i,
      );
    }
    // AWS's one hard constraint on the Duration threshold, which the rationale
    // has to carry because a threshold above the timeout can never fire.
    expect(ruleFor('Duration').rationale).toMatch(/lower than the configured function timeout/);
  });

  it('explains that the account-wide concurrency metric cannot be bound to a resource', () => {
    const absent = LAMBDA_PACK.absentMetrics.find((a) =>
      /ClaimedAccountConcurrency/.test(a.label),
    )!;
    expect(absent.reason).toMatch(/dimensionless/i);
    // AWS prefers it to the ConcurrentExecutions alarm we do ship, so the rule
    // that stands in for it has to say so.
    expect(ruleFor('ConcurrentExecutions').rationale).toMatch(/ClaimedAccountConcurrency/);
  });

  it('collects only the function dimension while documenting the three it does not', () => {
    expect(LAMBDA_PACK.dimensions.map((d) => d.name)).toEqual([
      'FunctionName',
      'Resource',
      'ExecutedVersion',
      'EventSourceMappingUUID',
    ]);
    for (const metric of LAMBDA_PACK.metrics) {
      expect(metric.dimensions).toEqual(['FunctionName']);
    }
  });

  it('states that cold starts are absent from Duration entirely', () => {
    const absent = LAMBDA_PACK.absentMetrics.find((a) => /[Cc]old start/.test(a.label))!;
    expect(absent.reason).toMatch(/Duration does not include cold start time/);
  });
});
