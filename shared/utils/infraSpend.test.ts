import { describe, expect, it } from 'vitest';
import {
  buildSpendBars,
  formatMoney,
  formatUsd,
  spendFailureHint,
  spendStalenessLabel,
  spendTrendSummary,
  type InfraSpendDay,
} from './infraSpend';

const day = (label: string, amountUsd: number, estimated = false): InfraSpendDay => ({
  day: label,
  amountUsd,
  estimated,
});

describe('formatUsd', () => {
  it('never rounds a real charge down to free', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0.0000001)).toBe('<$0.01');
    // The boundary itself is a printable cent, so it prints as one.
    expect(formatUsd(0.01)).toBe('$0.01');
  });

  it('prints an exact zero as zero, because that is a real answer', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('formats ordinary amounts to the cent', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(1234.567)).toBe('$1234.57');
  });

  it('renders an unknown amount as a dash rather than a zero', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(Number.NaN)).toBe('—');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('leads with the sign on a credit', () => {
    expect(formatUsd(-1.5)).toBe('-$1.50');
    expect(formatUsd(-0.004)).toBe('-<$0.01');
  });
});

describe('formatMoney', () => {
  it('uses the dollar path for USD and for an unknown unit', () => {
    expect(formatMoney(3, 'USD')).toBe('$3.00');
    expect(formatMoney(3, 'usd')).toBe('$3.00');
    expect(formatMoney(3, null)).toBe('$3.00');
  });

  it('suffixes the currency code when the payer account is not billed in USD', () => {
    expect(formatMoney(3, 'EUR')).toBe('3.00 EUR');
    expect(formatMoney(0.004, 'EUR')).toBe('<0.01 EUR');
    expect(formatMoney(-2, 'EUR')).toBe('-2.00 EUR');
    expect(formatMoney(null, 'EUR')).toBe('—');
  });
});

describe('buildSpendBars', () => {
  it('draws one column per day when the window fits the plot', () => {
    const { bars } = buildSpendBars([day('2026-08-01', 1), day('2026-08-02', 2)], 40);
    expect(bars.map((b) => b.day)).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('never exceeds the column budget on a long window', () => {
    const days = Array.from({ length: 365 }, (_, i) => day(`d${i}`, 1));
    const { bars } = buildSpendBars(days, 40);
    expect(bars.length).toBeLessThanOrEqual(40);
    // Every day is still represented: the total across columns is the window.
    expect(bars.reduce((sum, b) => sum + b.amountUsd, 0)).toBeCloseTo(365);
  });

  it('sums a bucket rather than averaging it, because this is money', () => {
    const { bars, maxUsd } = buildSpendBars(
      [day('a', 1), day('b', 2), day('c', 3), day('d', 4)],
      2,
    );
    expect(bars.map((b) => b.amountUsd)).toEqual([3, 7]);
    expect(maxUsd).toBe(7);
  });

  it('marks a bucket estimated when any day inside it still is', () => {
    const { bars } = buildSpendBars([day('a', 1), day('b', 2, true)], 1);
    expect(bars[0].estimated).toBe(true);
  });

  it('anchors the scale at zero so bar length reads as an amount', () => {
    // A minimum-anchored scale would draw the $95 day as an empty column.
    const { bars } = buildSpendBars([day('a', 95), day('b', 100)], 10);
    expect(bars[0].height).toBeCloseTo(0.95);
    expect(bars[1].height).toBe(1);
  });

  it('returns nothing to draw for an empty or absent day list', () => {
    expect(buildSpendBars([], 40)).toEqual({ bars: [], hasData: false, maxUsd: 0 });
    expect(buildSpendBars(null, 40).hasData).toBe(false);
    expect(buildSpendBars(undefined, 40).bars).toEqual([]);
  });

  it('reports no data for a window of cached zeroes, so the panel can say so', () => {
    const { bars, hasData, maxUsd } = buildSpendBars([day('a', 0), day('b', 0)], 40);
    expect(hasData).toBe(false);
    expect(maxUsd).toBe(0);
    expect(bars.every((b) => b.height === 0)).toBe(true);
  });

  it('does not invert the scale on a window of pure credits', () => {
    const { bars, maxUsd } = buildSpendBars([day('a', -5), day('b', -1)], 10);
    expect(maxUsd).toBe(0);
    expect(bars.every((b) => b.height === 0)).toBe(true);
  });

  it('ignores a non-finite amount instead of poisoning the column', () => {
    const { bars } = buildSpendBars([day('a', Number.NaN), day('b', 4)], 1);
    expect(bars[0].amountUsd).toBe(4);
  });

  it('survives a degenerate column count', () => {
    expect(buildSpendBars([day('a', 1)], 0).bars).toHaveLength(1);
    expect(buildSpendBars([day('a', 1)], Number.NaN).bars).toHaveLength(1);
  });
});

describe('spendTrendSummary', () => {
  const trend = {
    days: [day('2026-08-01', 4), day('2026-08-02', 6, true)],
    topServices: [
      { service: 'AmazonEC2', amountUsd: 6 },
      { service: 'AmazonRDS', amountUsd: 3 },
    ],
    totalUsd: 10,
    unit: 'USD',
  };

  it('derives the headline figures the panels render', () => {
    const summary = spendTrendSummary(trend);
    expect(summary.totalUsd).toBe(10);
    expect(summary.topService).toEqual({ service: 'AmazonEC2', amountUsd: 6 });
    expect(summary.dayCount).toBe(2);
    expect(summary.latestEstimated).toBe(true);
    expect(summary.unit).toBe('USD');
  });

  it('exposes the truncated tail so a ranked list cannot understate the bill', () => {
    expect(spendTrendSummary(trend).otherUsd).toBeCloseTo(1);
  });

  it('reports no tail when the listed services are the whole bill', () => {
    expect(spendTrendSummary({ ...trend, totalUsd: 9 }).otherUsd).toBe(0);
  });

  it('floors float drift at zero rather than inventing an Other row', () => {
    // 0.1 + 0.2 !== 0.3, and the residual must not surface as "<$0.01".
    const drifting = {
      days: [],
      topServices: [
        { service: 'a', amountUsd: 0.1 },
        { service: 'b', amountUsd: 0.2 },
      ],
      totalUsd: 0.3,
      unit: 'USD',
    };
    expect(spendTrendSummary(drifting).otherUsd).toBe(0);
  });

  it('never returns a negative tail when the total lags the per-service rows', () => {
    expect(spendTrendSummary({ ...trend, totalUsd: 2 }).otherUsd).toBe(0);
  });

  it('still surfaces a genuine sub-cent remainder', () => {
    expect(spendTrendSummary({ ...trend, totalUsd: 9.003 }).otherUsd).toBeCloseTo(0.003);
  });

  it('reads an empty or absent response without throwing', () => {
    expect(spendTrendSummary(null)).toMatchObject({
      totalUsd: 0,
      topService: null,
      dayCount: 0,
      latestEstimated: false,
      otherUsd: 0,
      unit: null,
    });
    expect(spendTrendSummary({}).dayCount).toBe(0);
  });
});

describe('spendStalenessLabel', () => {
  const now = Date.UTC(2026, 7, 7, 12, 0, 0);

  it('says when the cache was last written', () => {
    expect(spendStalenessLabel(now, now - 4 * 60 * 60 * 1000, now)).toBe('Updated 4h ago');
    expect(spendStalenessLabel(now, now - 90 * 1000, now)).toBe('Updated 1m ago');
    expect(spendStalenessLabel(now, now - 5 * 24 * 60 * 60 * 1000, now)).toBe('Updated 5d ago');
  });

  it('reads as fresh rather than as an error when it is seconds old', () => {
    expect(spendStalenessLabel(now, now - 1000, now)).toBe('Updated just now');
  });

  it('does not claim a freshness the data lacks when the last sync wrote nothing', () => {
    expect(spendStalenessLabel(now - 2 * 60 * 60 * 1000, null, now)).toBe(
      'Checked 2h ago, nothing cached yet',
    );
  });

  it('says plainly that nothing has ever run', () => {
    expect(spendStalenessLabel(null, null, now)).toBe('Never synced');
    expect(spendStalenessLabel(undefined, undefined, now)).toBe('Never synced');
  });

  it('treats clock skew as now rather than as a cache from the future', () => {
    expect(spendStalenessLabel(now, now + 60_000, now)).toBe('Updated just now');
  });
});

describe('spendFailureHint', () => {
  it('explains that DataUnavailable is a console action, not a permission', () => {
    const hint = spendFailureHint('DataUnavailable: no data for the requested period');
    expect(hint).toContain('Billing console');
    expect(hint).toContain('No IAM permission change will fix this');
  });

  it('adds nothing to an error it has no specific advice about', () => {
    expect(spendFailureHint('AccessDeniedException: ce:GetCostAndUsage')).toBeNull();
    expect(spendFailureHint(null)).toBeNull();
    expect(spendFailureHint('')).toBeNull();
  });
});
