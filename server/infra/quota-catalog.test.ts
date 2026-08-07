import { describe, it, expect } from 'vitest';

import {
  DEFAULT_QUOTA_UTILIZATION_THRESHOLD,
  QUOTA_CRITICAL_UTILIZATION_THRESHOLD,
  QUOTA_INTEGRATED_SERVICE_CODES,
  QUOTA_SERVICE_TOKEN,
  QUOTA_USAGE_DIMENSIONS,
  QUOTA_USAGE_METRIC_NAMES,
  QUOTA_USAGE_NAMESPACE,
  QUOTA_USAGE_PERIOD_SECONDS,
  QUOTA_UTILIZATION_EXPRESSION,
  isCollectableQuotaUsageMetric,
  parseQuotaUsageMetric,
  quotaHeadroom,
  quotaHeadroomBand,
  quotaUtilizationPercent,
} from './quota-catalog.js';

/** A well-formed `UsageMetric` for the EC2 running-instances quota. */
function usageMetric(overrides: Record<string, unknown> = {}) {
  return {
    MetricNamespace: 'AWS/Usage',
    MetricName: 'ResourceCount',
    MetricDimensions: {
      Service: 'EC2',
      Class: 'Standard/OnDemand',
      Type: 'Resource',
      Resource: 'vCPU',
    },
    MetricStatisticRecommendation: 'Maximum',
    ...overrides,
  };
}

describe('documented AWS constants', () => {
  // Quoted verbatim from the CloudWatch "Visualizing your service quotas and
  // setting alarms" walkthrough. If this literal ever changes, the change is a
  // deliberate divergence from AWS and must be argued for, not typo'd in.
  it('reproduces the utilization expression exactly as AWS publishes it', () => {
    expect(QUOTA_UTILIZATION_EXPRESSION).toBe('m1/SERVICE_QUOTA(m1)*100');
  });

  // AWS's console walkthrough: "Whenever Expression1 is Greater ... than 80".
  it('defaults the alert threshold to the 80 percent AWS recommends', () => {
    expect(DEFAULT_QUOTA_UTILIZATION_THRESHOLD).toBe(80);
  });

  it('names the AWS/Usage namespace and its 1-minute resolution', () => {
    expect(QUOTA_USAGE_NAMESPACE).toBe('AWS/Usage');
    expect(QUOTA_USAGE_PERIOD_SECONDS).toBe(60);
  });

  // The whole design rests on this set being fixed for the namespace: a pack
  // metric declares one exact dimension-name set, and AWS/Usage has only one.
  it('declares the four AWS/Usage dimensions, sorted', () => {
    expect([...QUOTA_USAGE_DIMENSIONS]).toEqual(['Class', 'Resource', 'Service', 'Type']);
    expect([...QUOTA_USAGE_DIMENSIONS]).toEqual([...QUOTA_USAGE_DIMENSIONS].sort());
  });

  it('declares exactly the three documented usage metric names', () => {
    expect([...QUOTA_USAGE_METRIC_NAMES]).toEqual(['CallCount', 'ResourceCount', 'ThrottleCount']);
  });

  it('uses a scope token distinct from any AWS service token', () => {
    expect(QUOTA_SERVICE_TOKEN).toBe('quota');
  });
});

describe('QUOTA_INTEGRATED_SERVICE_CODES', () => {
  it('lists the service codes AWS documents as publishing usage metrics', () => {
    // Sorted and deduped so the sync's call order is deterministic and no
    // service is queried twice against a 10 RPS limit.
    expect([...QUOTA_INTEGRATED_SERVICE_CODES]).toEqual([...QUOTA_INTEGRATED_SERVICE_CODES].sort());
    expect(new Set(QUOTA_INTEGRATED_SERVICE_CODES).size).toBe(
      QUOTA_INTEGRATED_SERVICE_CODES.length,
    );
  });

  it('uses Service Quotas ServiceCode values, not the marketing names', () => {
    // The three that are reliably guessed wrong. CloudWatch is `monitoring`
    // (its original API name), CloudWatch Logs is `logs`, and Amazon Location
    // Service is `geo`. Guessing `cloudwatch`/`cloudwatchlogs`/`location`
    // yields NoSuchResourceException and a silently empty quota list.
    expect(QUOTA_INTEGRATED_SERVICE_CODES).toContain('monitoring');
    expect(QUOTA_INTEGRATED_SERVICE_CODES).toContain('logs');
    expect(QUOTA_INTEGRATED_SERVICE_CODES).toContain('geo');
    expect(QUOTA_INTEGRATED_SERVICE_CODES).not.toContain('cloudwatch');
    expect(QUOTA_INTEGRATED_SERVICE_CODES).not.toContain('location');
  });

  it('stays small enough to sweep well inside the 10 RPS ListServiceQuotas limit', () => {
    // The point of the allowlist: ~400 services exist, ~17 publish usage
    // metrics. A sweep of everything would be minutes of paginated calls to
    // discover nothing. If this ever grows past a couple of dozen, the sync
    // needs real rate limiting rather than sequential calls.
    expect(QUOTA_INTEGRATED_SERVICE_CODES.length).toBeLessThanOrEqual(25);
    expect(QUOTA_INTEGRATED_SERVICE_CODES.length).toBeGreaterThan(5);
  });
});

describe('parseQuotaUsageMetric — null is the common case', () => {
  // AC: UsageMetric is a pointer with no value, and null is ordinary.
  it('returns null for a quota with no UsageMetric at all', () => {
    expect(parseQuotaUsageMetric(undefined)).toBeNull();
    expect(parseQuotaUsageMetric(null)).toBeNull();
  });

  it('returns a pointer carrying no usage value', () => {
    const parsed = parseQuotaUsageMetric(usageMetric());
    expect(parsed).not.toBeNull();
    // The shape is exhaustively pinned: any future `value`/`usage` field would
    // invite callers to read a usage number that Service Quotas never sent.
    expect(Object.keys(parsed!).sort()).toEqual([
      'dimensions',
      'metricName',
      'namespace',
      'statisticRecommendation',
    ]);
  });

  it('keeps the dimensions Service Quotas reported, sorted by name', () => {
    const parsed = parseQuotaUsageMetric(usageMetric())!;
    expect(Object.keys(parsed.dimensions)).toEqual(['Class', 'Resource', 'Service', 'Type']);
    expect(parsed.dimensions).toEqual({
      Class: 'Standard/OnDemand',
      Resource: 'vCPU',
      Service: 'EC2',
      Type: 'Resource',
    });
  });

  it('reports a missing statistic recommendation as null rather than guessing', () => {
    // AWS recommends the statistic per quota and it is not inferable from the
    // metric name. A guess here would be collected and charted as fact.
    const parsed = parseQuotaUsageMetric(
      usageMetric({ MetricStatisticRecommendation: undefined }),
    )!;
    expect(parsed.statisticRecommendation).toBeNull();

    const blank = parseQuotaUsageMetric(usageMetric({ MetricStatisticRecommendation: '  ' }))!;
    expect(blank.statisticRecommendation).toBeNull();
  });

  it('rejects a partially-populated pointer that could never be queried', () => {
    // Each of these would produce an inventoried quota row that shows no usage
    // forever, with nothing to explain why.
    expect(parseQuotaUsageMetric(usageMetric({ MetricNamespace: undefined }))).toBeNull();
    expect(parseQuotaUsageMetric(usageMetric({ MetricNamespace: '   ' }))).toBeNull();
    expect(parseQuotaUsageMetric(usageMetric({ MetricName: null }))).toBeNull();
    expect(parseQuotaUsageMetric(usageMetric({ MetricDimensions: {} }))).toBeNull();
    expect(parseQuotaUsageMetric(usageMetric({ MetricDimensions: null }))).toBeNull();
  });

  it('drops individual dimensions with blank values instead of keeping unmatchable ones', () => {
    // CloudWatch matches on exact dimension values; an empty value matches
    // nothing, so keeping it would guarantee an empty series.
    const parsed = parseQuotaUsageMetric(
      usageMetric({
        MetricDimensions: { Service: 'EC2', Class: '', Type: 'Resource', Resource: null },
      }),
    )!;
    expect(parsed.dimensions).toEqual({ Service: 'EC2', Type: 'Resource' });
  });

  it('returns null when dropping blank dimensions leaves nothing', () => {
    expect(
      parseQuotaUsageMetric(usageMetric({ MetricDimensions: { Service: '', Class: null } })),
    ).toBeNull();
  });
});

describe('isCollectableQuotaUsageMetric', () => {
  it('accepts a well-formed AWS/Usage pointer on the exact dimension set', () => {
    expect(isCollectableQuotaUsageMetric(parseQuotaUsageMetric(usageMetric())!)).toBe(true);
  });

  it('accepts each documented usage metric name', () => {
    for (const metricName of QUOTA_USAGE_METRIC_NAMES) {
      const parsed = parseQuotaUsageMetric(usageMetric({ MetricName: metricName }))!;
      expect(isCollectableQuotaUsageMetric(parsed)).toBe(true);
    }
  });

  it('rejects a namespace the quota pack does not declare', () => {
    const parsed = parseQuotaUsageMetric(usageMetric({ MetricNamespace: 'AWS/EC2' }))!;
    expect(isCollectableQuotaUsageMetric(parsed)).toBe(false);
  });

  it('rejects an undeclared metric name', () => {
    const parsed = parseQuotaUsageMetric(usageMetric({ MetricName: 'SomeFutureCount' }))!;
    expect(isCollectableQuotaUsageMetric(parsed)).toBe(false);
  });

  it('rejects a subset of the four dimensions', () => {
    // bindMetricDimensions compares dimension sets by exact length, so a
    // three-dimension pointer binds to nothing. Catching it here is what makes
    // the omission countable rather than invisible.
    const parsed = parseQuotaUsageMetric(
      usageMetric({ MetricDimensions: { Service: 'EC2', Class: 'None', Type: 'API' } }),
    )!;
    expect(isCollectableQuotaUsageMetric(parsed)).toBe(false);
  });

  it('rejects a superset carrying an extra dimension', () => {
    const parsed = parseQuotaUsageMetric(
      usageMetric({
        MetricDimensions: {
          Service: 'EC2',
          Class: 'None',
          Type: 'API',
          Resource: 'RunInstances',
          Region: 'us-east-1',
        },
      }),
    )!;
    expect(isCollectableQuotaUsageMetric(parsed)).toBe(false);
  });
});

describe('quotaUtilizationPercent — m1/SERVICE_QUOTA(m1)*100', () => {
  it('computes the documented expression', () => {
    expect(quotaUtilizationPercent(40, 50)).toBe(80);
    expect(quotaUtilizationPercent(1, 4)).toBe(25);
    expect(quotaUtilizationPercent(0, 100)).toBe(0);
  });

  it('does not clamp usage above the applied quota', () => {
    // Real and observable: a quota decrease applies immediately while existing
    // resources keep running. Reporting 100% when the truth is 140% hides the
    // single most important reading on the panel.
    expect(quotaUtilizationPercent(140, 100)).toBe(140);
  });

  it('returns null rather than zero when the ratio is undefined', () => {
    // Zero would render as "plenty of headroom" — the exact opposite of the
    // truth, and the most dangerous value this function could return.
    expect(quotaUtilizationPercent(10, 0)).toBeNull();
    expect(quotaUtilizationPercent(10, null)).toBeNull();
    expect(quotaUtilizationPercent(10, undefined)).toBeNull();
    expect(quotaUtilizationPercent(null, 10)).toBeNull();
    expect(quotaUtilizationPercent(undefined, 10)).toBeNull();
  });

  it('returns null for a negative limit instead of a confidently-signed nonsense value', () => {
    expect(quotaUtilizationPercent(10, -5)).toBeNull();
  });

  it('returns null for non-finite inputs rather than propagating NaN or Infinity', () => {
    expect(quotaUtilizationPercent(Number.NaN, 10)).toBeNull();
    expect(quotaUtilizationPercent(10, Number.NaN)).toBeNull();
    expect(quotaUtilizationPercent(Number.POSITIVE_INFINITY, 10)).toBeNull();
    expect(quotaUtilizationPercent(10, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('quotaHeadroom', () => {
  it('reports the absolute remaining count the percentage cannot express', () => {
    // 82% of 40 leaves 7; 82% of 5,000 leaves 900. Same band, different action.
    expect(quotaHeadroom(33, 40)).toBe(7);
    expect(quotaHeadroom(4100, 5000)).toBe(900);
  });

  it('floors at zero, because "you can create -12 more" is noise', () => {
    expect(quotaHeadroom(140, 100)).toBe(0);
  });

  it('returns null on the same undefined-ratio cases as the percentage', () => {
    expect(quotaHeadroom(10, 0)).toBeNull();
    expect(quotaHeadroom(null, 10)).toBeNull();
    expect(quotaHeadroom(10, null)).toBeNull();
    expect(quotaHeadroom(Number.NaN, 10)).toBeNull();
  });
});

describe('quotaHeadroomBand', () => {
  it('bands an unmeasurable quota as unknown, never as ok', () => {
    // Folding unknown into ok would let unmeasured quotas count toward
    // "everything is fine", which is how you end up surprised.
    expect(quotaHeadroomBand(null)).toBe('unknown');
    expect(quotaHeadroomBand(Number.NaN)).toBe('unknown');
  });

  it('puts the warning edge exactly on AWS’s "Greater than 80"', () => {
    // 80.0 is still ok; the alarm fires above it, not at it. This boundary and
    // DEFAULT_QUOTA_UTILIZATION_THRESHOLD are the same number by construction,
    // so the colour and the alert agree.
    expect(quotaHeadroomBand(79.9)).toBe('ok');
    expect(quotaHeadroomBand(DEFAULT_QUOTA_UTILIZATION_THRESHOLD)).toBe('ok');
    expect(quotaHeadroomBand(80.01)).toBe('warning');
  });

  it('escalates to critical only at or above the quota itself', () => {
    expect(quotaHeadroomBand(99.9)).toBe('warning');
    expect(quotaHeadroomBand(QUOTA_CRITICAL_UTILIZATION_THRESHOLD)).toBe('critical');
    expect(quotaHeadroomBand(140)).toBe('critical');
  });

  it('bands zero utilization as ok', () => {
    expect(quotaHeadroomBand(0)).toBe('ok');
  });
});
