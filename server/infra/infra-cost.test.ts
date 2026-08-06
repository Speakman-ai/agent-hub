/**
 * Unit coverage for the pure INFRA-COST arithmetic.
 *
 * Everything here is IO-free by construction, so these tests need no database,
 * no clock and no AWS client. What they are actually guarding is the *direction*
 * of each estimate: a projection that under-reports produces the surprise bill
 * the whole module exists to prevent, so the assertions below pin the
 * conservative side of every rounding choice rather than just the arithmetic.
 */

import { describe, it, expect } from 'vitest';
import {
  GET_METRIC_DATA_USD_PER_1000_METRICS,
  GET_METRIC_DATA_USD_PER_1000_BY_REGION,
  GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION,
  isKnownMetricDataRegion,
  PROJECTION_DAYS_PER_MONTH,
  PROJECTION_SECONDS_PER_MONTH,
  COLLECTOR_TICK_INTERVAL_S,
  WIDENED_INTERVAL_MULTIPLIER,
  PAUSE_CEILING_MULTIPLE,
  getMetricDataPricePer1000,
  estimateGetMetricDataCostUsd,
  effectivePollIntervalSeconds,
  isMetricDue,
  ticksPerMonth,
  projectMonthlyApiCost,
  resolveCostDegradation,
  monthStartMs,
  extrapolateMonthlySpendUsd,
} from './infra-cost.js';
import type { InfraMetricSpec } from './service-metric-packs.js';

const spec = (over: Partial<InfraMetricSpec> = {}): InfraMetricSpec => ({
  namespace: 'AWS/EC2',
  metricName: 'CPUUtilization',
  stat: 'Average',
  dimension: 'InstanceId',
  minPeriodSeconds: 300,
  ...over,
});

describe('getMetricDataPricePer1000', () => {
  it('uses the $0.01 list rate for the 33 regions on it', () => {
    expect(getMetricDataPricePer1000('us-east-1')).toBe(0.01);
    expect(getMetricDataPricePer1000('eu-west-1')).toBe(0.01);
    expect(getMetricDataPricePer1000('ap-southeast-2')).toBe(0.01);
  });

  it('prices the regions AWS charges more in', () => {
    // Verified against the AWS Price List feed, August 2026.
    expect(getMetricDataPricePer1000('sa-east-1')).toBe(0.014);
    expect(getMetricDataPricePer1000('us-gov-west-1')).toBe(0.013);
    expect(getMetricDataPricePer1000('us-gov-east-1')).toBe(0.013);
  });

  it('enumerates every region rather than assuming a list rate with exceptions', () => {
    // AWS states pricing varies by Region, so the table is the complete set of
    // regions publishing a GetMetricData SKU — not $0.01 with a couple of
    // exceptions bolted on. If this shrinks, regions silently moved to the
    // conservative fallback and every projection for them jumped 40%.
    expect(Object.keys(GET_METRIC_DATA_USD_PER_1000_BY_REGION).length).toBe(36);
    for (const [region, price] of Object.entries(GET_METRIC_DATA_USD_PER_1000_BY_REGION)) {
      expect(price, `${region} must have a positive price`).toBeGreaterThan(0);
      expect(isKnownMetricDataRegion(region)).toBe(true);
    }
  });

  it('falls back to the most expensive known rate, never the cheapest', () => {
    // Regression: the fallback used to be the $0.01 list rate, which is a
    // guardrail knowingly under-reporting spend for any pricier region. A
    // region absent from the table is one AWS launched after the table was
    // cut, and pricing it optimistically would let a ceiling be breached by up
    // to 40% before the collector noticed.
    expect(getMetricDataPricePer1000('mars-north-1')).toBe(
      GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION,
    );
    expect(getMetricDataPricePer1000(undefined)).toBe(GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION);
    expect(getMetricDataPricePer1000(null)).toBe(GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION);
    expect(isKnownMetricDataRegion('mars-north-1')).toBe(false);
    expect(isKnownMetricDataRegion(undefined)).toBe(false);
  });

  it('derives the fallback from the table, so a pricier new region raises it', () => {
    // Hardcoding 0.014 would go stale the day AWS prices a region above São
    // Paulo, and it would go stale in the under-reporting direction.
    const dearest = Math.max(...Object.values(GET_METRIC_DATA_USD_PER_1000_BY_REGION));
    expect(GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION).toBe(dearest);
    for (const price of Object.values(GET_METRIC_DATA_USD_PER_1000_BY_REGION)) {
      expect(GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION).toBeGreaterThanOrEqual(price);
    }
    // And it is strictly above the list rate, or it would not be conservative.
    expect(GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION).toBeGreaterThan(
      GET_METRIC_DATA_USD_PER_1000_METRICS,
    );
  });

  it('still prices the 33 list-rate regions exactly, without inflating them', () => {
    // The conservative fallback must not leak into regions we do know: an
    // operator in eu-west-1 should see the real number, not a 40% markup.
    for (const region of ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-2']) {
      expect(getMetricDataPricePer1000(region)).toBe(GET_METRIC_DATA_USD_PER_1000_METRICS);
    }
  });
});

describe('estimateGetMetricDataCostUsd', () => {
  it('prices per 1,000 metrics requested', () => {
    expect(estimateGetMetricDataCostUsd(1000, 'us-east-1')).toBeCloseTo(0.01, 10);
    expect(estimateGetMetricDataCostUsd(500, 'us-east-1')).toBeCloseTo(0.005, 10);
    expect(estimateGetMetricDataCostUsd(1_000_000, 'us-east-1')).toBeCloseTo(10, 10);
  });

  it('prices an unregioned estimate at the conservative rate', () => {
    // Omitting the region is not "assume it is cheap".
    expect(estimateGetMetricDataCostUsd(1000)).toBeCloseTo(
      GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION,
      10,
    );
  });

  it('applies the regional rate', () => {
    // The whole reason the region is threaded through: a São Paulo scope priced
    // at the us-east-1 rate under-reports by 40%, and a ceiling fed by an
    // under-report is a ceiling that does not hold.
    expect(estimateGetMetricDataCostUsd(1000, 'sa-east-1')).toBeCloseTo(0.014, 10);
    expect(estimateGetMetricDataCostUsd(1000, 'us-gov-west-1')).toBeCloseTo(0.013, 10);
  });

  it('treats non-positive and non-finite counts as free', () => {
    expect(estimateGetMetricDataCostUsd(0)).toBe(0);
    expect(estimateGetMetricDataCostUsd(-5)).toBe(0);
    expect(estimateGetMetricDataCostUsd(Number.NaN)).toBe(0);
  });
});

describe('effectivePollIntervalSeconds', () => {
  it('floors a fine service tier at the metric emission rate', () => {
    // EC2's tier is 60s, but base CPU is published every 5 minutes. Requesting
    // it every minute would be billed five times and return the same series.
    expect(
      effectivePollIntervalSeconds('ec2', spec({ minPeriodSeconds: 300 }), {
        tickIntervalSeconds: 60,
      }),
    ).toBe(300);
  });

  it('lets a 1-minute metric run at the tier when the tick allows it', () => {
    expect(
      effectivePollIntervalSeconds('ec2', spec({ minPeriodSeconds: 60 }), {
        tickIntervalSeconds: 60,
      }),
    ).toBe(60);
  });

  it('floors at the collector tick, since nothing can be asked for more often', () => {
    expect(
      effectivePollIntervalSeconds('ec2', spec({ minPeriodSeconds: 60 }), {
        tickIntervalSeconds: 300,
      }),
    ).toBe(300);
  });

  it('never polls a daily metric more often than daily', () => {
    // The S3 BucketSizeBytes case from decision INFRA-COST: AWS publishes these
    // "once per day", so a 5-minute poll bills 288 times for one datapoint.
    const daily = spec({ metricName: 'BucketSizeBytes', minPeriodSeconds: 86_400 });
    expect(effectivePollIntervalSeconds('s3', daily, { tickIntervalSeconds: 300 })).toBe(86_400);
  });

  it('falls back to the default tier for a service with no entry', () => {
    expect(
      effectivePollIntervalSeconds('unknown-service', spec({ minPeriodSeconds: 60 }), {
        tickIntervalSeconds: 60,
      }),
    ).toBe(300);
  });

  it('multiplies the interval when the project is widened, preserving relative cadence', () => {
    const fast = spec({ minPeriodSeconds: 60 });
    const slow = spec({ minPeriodSeconds: 3600 });
    const opts = { tickIntervalSeconds: 60, degradation: 'widened' as const };
    expect(effectivePollIntervalSeconds('ec2', fast, opts)).toBe(60 * WIDENED_INTERVAL_MULTIPLIER);
    expect(effectivePollIntervalSeconds('ec2', slow, opts)).toBe(
      3600 * WIDENED_INTERVAL_MULTIPLIER,
    );
  });
});

describe('isMetricDue', () => {
  const TICK = 300_000;

  it('is due on every tick when the interval is at or below the tick cadence', () => {
    expect(isMetricDue(60_000, 1_000_000_000_000, TICK)).toBe(true);
    expect(isMetricDue(TICK, 1_000_000_000_000, TICK)).toBe(true);
  });

  it('fires exactly once per interval across a long run of ticks', () => {
    const hourly = 3_600_000;
    // A day of 5-minute ticks starting on an hour boundary.
    const start = Date.UTC(2026, 7, 6, 0, 0, 0);
    let due = 0;
    for (let i = 1; i <= 288; i += 1) {
      if (isMetricDue(hourly, start + i * TICK, TICK)) due += 1;
    }
    expect(due).toBe(24);
  });

  it('fires once per day for a daily metric', () => {
    const daily = 86_400_000;
    const start = Date.UTC(2026, 7, 6, 0, 0, 0);
    let due = 0;
    for (let i = 1; i <= 288 * 3; i += 1) {
      if (isMetricDue(daily, start + i * TICK, TICK)) due += 1;
    }
    expect(due).toBe(3);
  });

  it('stays correct when ticks are not aligned to the interval', () => {
    const hourly = 3_600_000;
    const start = Date.UTC(2026, 7, 6, 0, 2, 30);
    let due = 0;
    for (let i = 1; i <= 288; i += 1) {
      if (isMetricDue(hourly, start + i * TICK, TICK)) due += 1;
    }
    expect(due).toBe(24);
  });

  it('treats a nonsense interval as always due rather than never', () => {
    // Failing open here means a pack typo over-collects, which is visible in
    // the cost audit. Failing closed would silently stop collecting a metric.
    expect(isMetricDue(0, 1_000, 300_000)).toBe(true);
    expect(isMetricDue(Number.NaN, 1_000, 300_000)).toBe(true);
  });
});

describe('ticksPerMonth', () => {
  it('divides the projection month by the interval, rounding up', () => {
    expect(ticksPerMonth(PROJECTION_SECONDS_PER_MONTH)).toBe(1);
    expect(ticksPerMonth(300)).toBe(PROJECTION_SECONDS_PER_MONTH / 300);
    expect(ticksPerMonth(86_400)).toBe(PROJECTION_DAYS_PER_MONTH);
  });

  it('uses a 31-day month so the projection never under-reports', () => {
    expect(PROJECTION_DAYS_PER_MONTH).toBe(31);
    expect(ticksPerMonth(86_400)).toBeGreaterThan(30);
  });

  it('returns zero for a nonsense interval instead of Infinity', () => {
    expect(ticksPerMonth(0)).toBe(0);
    expect(ticksPerMonth(-1)).toBe(0);
  });
});

describe('projectMonthlyApiCost', () => {
  it('is resources x metrics x ticks per month', () => {
    // ec2 pack: 6 metrics. Under a 300s tick, StatusCheckFailed{,_Instance,
    // _System} floor at 60 -> 300, and CPU/NetworkIn/NetworkOut at 300 -> 300.
    // So all six run at 300s.
    const ticks = ticksPerMonth(300);
    const p = projectMonthlyApiCost([{ service: 'ec2', resourceCount: 10, region: 'us-east-1' }]);
    expect(p.perScope).toHaveLength(1);
    expect(p.perScope[0].metricsPerResource).toBe(6);
    expect(p.metricsRequestedPerMonth).toBe(10 * 6 * ticks);
    expect(p.estimatedMonthlyCostUsd).toBeCloseTo((10 * 6 * ticks * 0.01) / 1000, 8);
  });

  it('prices each scope in its own region and sums the dollars, not the metrics', () => {
    const p = projectMonthlyApiCost([
      { service: 'ec2', resourceCount: 10, region: 'us-east-1' },
      { service: 'ec2', resourceCount: 10, region: 'sa-east-1' },
    ]);
    const [virginia, saopaulo] = p.perScope;
    expect(virginia.metricsRequestedPerMonth).toBe(saopaulo.metricsRequestedPerMonth);
    // Identical metric counts, 40% different bill — which is exactly why the
    // total cannot be the metric total times one price.
    expect(saopaulo.estimatedMonthlyCostUsd).toBeCloseTo(virginia.estimatedMonthlyCostUsd * 1.4, 8);
    expect(p.estimatedMonthlyCostUsd).toBeCloseTo(
      virginia.estimatedMonthlyCostUsd + saopaulo.estimatedMonthlyCostUsd,
      10,
    );
  });

  it('reports the resolved cadence per metric so the editor can show the floor', () => {
    const p = projectMonthlyApiCost([{ service: 'ec2', resourceCount: 1 }]);
    const cpu = p.perScope[0].intervals.find((i) => i.metricName === 'CPUUtilization');
    const status = p.perScope[0].intervals.find((i) => i.metricName === 'StatusCheckFailed');
    expect(cpu?.minPeriodSeconds).toBe(300);
    expect(status?.minPeriodSeconds).toBe(60);
    // Both land on the tick, because the tick is coarser than either floor.
    expect(cpu?.pollIntervalSeconds).toBe(COLLECTOR_TICK_INTERVAL_S);
    expect(status?.pollIntervalSeconds).toBe(COLLECTOR_TICK_INTERVAL_S);
  });

  it('reports the rate each scope was priced at, and whether it was assumed', () => {
    const p = projectMonthlyApiCost([
      { service: 'ec2', resourceCount: 1, region: 'us-east-1' },
      { service: 'ec2', resourceCount: 1, region: 'sa-east-1' },
      { service: 'ec2', resourceCount: 1, region: 'mars-north-1' },
      { service: 'ec2', resourceCount: 1 },
    ]);
    expect(p.perScope[0]).toMatchObject({ usdPer1000Metrics: 0.01, regionPriceKnown: true });
    expect(p.perScope[1]).toMatchObject({ usdPer1000Metrics: 0.014, regionPriceKnown: true });
    // Unknown and absent regions are priced conservatively and say so, rather
    // than quietly inflating the figure by 40%.
    expect(p.perScope[2]).toMatchObject({
      usdPer1000Metrics: GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION,
      regionPriceKnown: false,
    });
    expect(p.perScope[3].regionPriceKnown).toBe(false);
  });

  it('charges nothing for a service with no metric pack', () => {
    // A scope on an uncollectable service is inert; quoting a price for it
    // would imply the collector is going to query it.
    const p = projectMonthlyApiCost([{ service: 'rds', resourceCount: 500 }]);
    expect(p.metricsRequestedPerMonth).toBe(0);
    expect(p.estimatedMonthlyCostUsd).toBe(0);
    expect(p.perScope[0].metricsPerResource).toBe(0);
  });

  it('drops the projection by the widening multiplier', () => {
    const normal = projectMonthlyApiCost([{ service: 'ec2', resourceCount: 10 }]);
    const widened = projectMonthlyApiCost([{ service: 'ec2', resourceCount: 10 }], {
      degradation: 'widened',
    });
    expect(widened.metricsRequestedPerMonth).toBeLessThan(normal.metricsRequestedPerMonth);
    expect(widened.metricsRequestedPerMonth * WIDENED_INTERVAL_MULTIPLIER).toBeCloseTo(
      normal.metricsRequestedPerMonth,
      0,
    );
  });

  it('renders a number for a half-typed resource count instead of throwing', () => {
    // This runs on operator keystrokes in the scope editor.
    const p = projectMonthlyApiCost([
      { service: 'ec2', resourceCount: -3 },
      { service: 'ec2', resourceCount: Number.NaN },
      { service: 'ec2', resourceCount: 2.7 },
    ]);
    expect(p.perScope[0].resourceCount).toBe(0);
    expect(p.perScope[1].resourceCount).toBe(0);
    expect(p.perScope[2].resourceCount).toBe(2);
    expect(Number.isFinite(p.estimatedMonthlyCostUsd)).toBe(true);
  });

  it('is empty, not undefined, for no scopes', () => {
    expect(projectMonthlyApiCost([])).toEqual({
      metricsRequestedPerMonth: 0,
      estimatedMonthlyCostUsd: 0,
      perScope: [],
    });
  });
});

describe('resolveCostDegradation', () => {
  it('is normal with no ceiling, however much has been spent', () => {
    // Uncapped is the default: scoping is an explicit opt-in whose projected
    // cost was shown at decision time, so an implicit ceiling nobody chose
    // would pause monitoring the operator deliberately turned on.
    expect(resolveCostDegradation(9_999, null)).toBe('normal');
    expect(resolveCostDegradation(9_999, undefined)).toBe('normal');
  });

  it('is normal below the ceiling', () => {
    expect(resolveCostDegradation(0, 100)).toBe('normal');
    expect(resolveCostDegradation(99.99, 100)).toBe('normal');
  });

  it('widens at exactly the ceiling, not just past it', () => {
    // At the ceiling the budget is spent; the next request is the one over.
    expect(resolveCostDegradation(100, 100)).toBe('widened');
    expect(resolveCostDegradation(150, 100)).toBe('widened');
    expect(resolveCostDegradation(199.99, 100)).toBe('widened');
  });

  it('pauses at the pause multiple', () => {
    expect(resolveCostDegradation(100 * PAUSE_CEILING_MULTIPLE, 100)).toBe('paused');
    expect(resolveCostDegradation(10_000, 100)).toBe('paused');
  });

  it('treats a zero ceiling as "collect nothing", never as a widened band', () => {
    // 0 * 2 is still 0, so without the special case a zero-budget project would
    // sit in `widened` and keep issuing billed requests.
    expect(resolveCostDegradation(0, 0)).toBe('paused');
    expect(resolveCostDegradation(5, 0)).toBe('paused');
  });

  it('ignores a nonsense ceiling rather than pausing collection on it', () => {
    expect(resolveCostDegradation(50, Number.NaN)).toBe('normal');
    expect(resolveCostDegradation(50, -10)).toBe('normal');
  });

  it('treats nonsense spend as zero', () => {
    expect(resolveCostDegradation(Number.NaN, 100)).toBe('normal');
  });
});

describe('monthStartMs', () => {
  it('returns the first instant of the UTC month', () => {
    expect(monthStartMs(Date.UTC(2026, 7, 6, 13, 45, 12))).toBe(Date.UTC(2026, 7, 1));
    expect(monthStartMs(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(Date.UTC(2026, 0, 1));
  });
});

describe('extrapolateMonthlySpendUsd', () => {
  it('scales the observed spend to the full month', () => {
    const start = Date.UTC(2026, 7, 1);
    // Half of a 31-day August elapsed.
    const now = start + 15.5 * 24 * 60 * 60 * 1000;
    expect(extrapolateMonthlySpendUsd(50, now, start)).toBeCloseTo(100, 6);
  });

  it('returns the observed figure at month end rather than inflating it', () => {
    const start = Date.UTC(2026, 7, 1);
    const now = Date.UTC(2026, 8, 1) - 1;
    expect(extrapolateMonthlySpendUsd(42, now, start)).toBeCloseTo(42, 2);
  });

  it('does not extrapolate an astronomical figure from the first minutes of a month', () => {
    const start = Date.UTC(2026, 7, 1);
    expect(extrapolateMonthlySpendUsd(0.02, start + 30_000, start)).toBe(0.02);
  });

  it('is zero when nothing has been spent', () => {
    const start = Date.UTC(2026, 7, 1);
    expect(extrapolateMonthlySpendUsd(0, start + 86_400_000, start)).toBe(0);
  });
});
