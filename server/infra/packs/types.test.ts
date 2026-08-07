/**
 * Pack vocabulary tests — the statistic-validity predicates.
 *
 * These back the two cross-pack invariants in `ec2.test.ts` that every pack is
 * checked against, so a hole here is a hole in every pack at once. Percentiles
 * are the reason they are functions rather than table lookups: there are
 * infinitely many legal percentile statistics, and exactly one metric type they
 * are legal on.
 */

import { describe, it, expect } from 'vitest';
import {
  isPercentileStatistic,
  isStatisticDocumented,
  isStatisticValidForMetricType,
  PERCENTILE_STATISTIC_TOKEN,
  STATISTICS_BY_METRIC_TYPE,
  type InfraMetricType,
  type InfraPackMetric,
} from './types.js';

function metric(over: Partial<InfraPackMetric> = {}): InfraPackMetric {
  return {
    namespace: 'AWS/ApplicationELB',
    metricName: 'TargetResponseTime',
    dimensions: ['LoadBalancer'],
    metricType: 'latency',
    stat: 'p99',
    validStatistics: ['Average', PERCENTILE_STATISTIC_TOKEN],
    minPeriodSeconds: 60,
    availability: 'either',
    appliesTo: { universal: true, condition: '' },
    requiresFeature: null,
    description: 'x',
    ...over,
  };
}

describe('isPercentileStatistic', () => {
  it.each(['p0', 'p1', 'p50', 'p90', 'p95', 'p99', 'p100'])('accepts %s', (stat) => {
    expect(isPercentileStatistic(stat)).toBe(true);
  });

  it.each(['p95.45', 'p99.9', 'p99.99', 'p0.01', 'p100.0', 'p100.00'])(
    'accepts %s — AWS allows "up to two decimal places"',
    (stat) => {
      expect(isPercentileStatistic(stat)).toBe(true);
    },
  );

  it.each([
    // Three decimal places is one more than AWS documents.
    'p99.999',
    // Above the range a percentile can occupy at all.
    'p101',
    'p100.01',
    'p999',
    // Named statistics are not percentiles, however much they look like one.
    'Average',
    'Sum',
    'pNN.NN',
    'p',
    '99',
    'P99',
    // A trailing or leading space would silently key a separate stored series.
    ' p99',
    'p99 ',
  ])('rejects %s', (stat) => {
    expect(isPercentileStatistic(stat)).toBe(false);
  });
});

describe('isStatisticValidForMetricType', () => {
  it('accepts the named statistics each type declares', () => {
    for (const [type, stats] of Object.entries(STATISTICS_BY_METRIC_TYPE)) {
      for (const stat of stats) {
        expect(isStatisticValidForMetricType(type as InfraMetricType, stat)).toBe(true);
      }
    }
  });

  it('allows a percentile only on a latency metric', () => {
    // A percentile of a per-period total is a statement about the periods, not
    // about the thing being counted; a percentile of a 0/1 flag is a diluted
    // flag. Latency is the one type whose value is a distribution.
    expect(isStatisticValidForMetricType('latency', 'p99')).toBe(true);
    for (const type of ['gauge', 'counter', 'flag', 'balance'] as const) {
      expect(isStatisticValidForMetricType(type, 'p99'), `${type} must reject p99`).toBe(false);
    }
  });

  it('rejects a statistic the type does not declare', () => {
    // Averaging a 0/1 failure flag across a five-minute period reports 0.2 for a
    // failure that happened, which is the whole reason this check exists.
    expect(isStatisticValidForMetricType('flag', 'Average')).toBe(false);
    expect(isStatisticValidForMetricType('counter', 'Average')).toBe(false);
    expect(isStatisticValidForMetricType('gauge', 'Sum')).toBe(false);
  });
});

describe('isStatisticDocumented', () => {
  it('accepts a statistic listed verbatim', () => {
    expect(isStatisticDocumented(metric({ stat: 'Average' }))).toBe(true);
  });

  it('expands the pNN.NN token to any percentile', () => {
    // AWS prints "The most useful statistics are Average and pNN.NN
    // (percentiles)" and names no specific percentile, so the token has to stand
    // for the family or validStatistics stops being a transcription.
    expect(isStatisticDocumented(metric({ stat: 'p50' }))).toBe(true);
    expect(isStatisticDocumented(metric({ stat: 'p99.99' }))).toBe(true);
  });

  it('does not let the token smuggle in a non-percentile', () => {
    expect(isStatisticDocumented(metric({ stat: 'Sum' }))).toBe(false);
    expect(isStatisticDocumented(metric({ stat: 'Maximum' }))).toBe(false);
  });

  it('rejects a percentile when AWS documented no percentile for the metric', () => {
    expect(
      isStatisticDocumented(
        metric({ stat: 'p99', validStatistics: ['Average', 'Minimum', 'Maximum'] }),
      ),
    ).toBe(false);
  });
});
