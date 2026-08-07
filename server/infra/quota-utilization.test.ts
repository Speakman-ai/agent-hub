/**
 * The derived quota utilization series.
 *
 * The reason this is a stored series rather than a read-time division is that
 * it makes the default "above 80%" rule an ordinary alert rule over an ordinary
 * series. So the assertions here are mostly about the series being keyed
 * exactly as the pack declares — that is what the alert runner resolves on.
 */
import { describe, it, expect, vi } from 'vitest';

import type { InfraMetricPointInput } from './infra-metric-store.js';
import {
  QUOTA_DERIVED_NAMESPACE,
  QUOTA_PACK,
  QUOTA_UTILIZATION_METRIC_NAME,
  QUOTA_UTILIZATION_STAT,
} from './packs/quota.js';
import { deriveQuotaUtilizationPoints } from './quota-utilization.js';

const DIMENSIONS = {
  Class: 'Standard/OnDemand',
  Resource: 'vCPU',
  Service: 'EC2',
  Type: 'Resource',
};

function usagePoint(overrides: Partial<InfraMetricPointInput> = {}): InfraMetricPointInput {
  return {
    projectId: 'proj',
    resourceKey: 'quota-key',
    namespace: 'AWS/Usage',
    metricName: 'ResourceCount',
    dimensions: DIMENSIONS,
    stat: 'Maximum',
    periodSeconds: 60,
    tsMs: 1_700_000_000_000,
    value: 512,
    ...overrides,
  };
}

const limit640 = () => 640;

describe('deriveQuotaUtilizationPoints', () => {
  it('computes m1/SERVICE_QUOTA(m1)*100 with the applied quota substituted', () => {
    const [derived] = deriveQuotaUtilizationPoints([usagePoint()], limit640);
    expect(derived!.value).toBe(80); // 512/640*100
  });

  it('emits the series exactly as the pack declares it', () => {
    // This is what makes the default alert rule resolvable: the runner matches
    // a rule to a series on namespace, metric name, stat and dimension set.
    const packMetric = QUOTA_PACK.metrics.find(
      (m) => m.metricName === QUOTA_UTILIZATION_METRIC_NAME,
    )!;
    const [derived] = deriveQuotaUtilizationPoints([usagePoint()], limit640);

    expect(derived!.namespace).toBe(packMetric.namespace);
    expect(derived!.metricName).toBe(packMetric.metricName);
    expect(derived!.stat).toBe(packMetric.stat);
    expect(Object.keys(derived!.dimensions!).sort()).toEqual([...packMetric.dimensions]);
    expect(derived!.namespace).toBe(QUOTA_DERIVED_NAMESPACE);
    expect(derived!.stat).toBe(QUOTA_UTILIZATION_STAT);
  });

  it('carries the source point’s timestamp, period and resource', () => {
    // A derived point at a different timestamp would not line up with the
    // usage it came from, and the evaluator's M-of-N would count slots that
    // never coincided.
    const source = usagePoint({ tsMs: 1_700_000_060_000, periodSeconds: 60 });
    const [derived] = deriveQuotaUtilizationPoints([source], limit640);
    expect(derived!.tsMs).toBe(source.tsMs);
    expect(derived!.periodSeconds).toBe(source.periodSeconds);
    expect(derived!.resourceKey).toBe(source.resourceKey);
    expect(derived!.projectId).toBe(source.projectId);
  });

  it('returns only the derived points, never echoing the input', () => {
    const out = deriveQuotaUtilizationPoints([usagePoint()], limit640);
    expect(out).toHaveLength(1);
    expect(out[0]!.namespace).toBe(QUOTA_DERIVED_NAMESPACE);
  });

  it('emits nothing when the applied quota is unknown', () => {
    // Not a zero and not a placeholder. The default rule uses
    // treatMissingData: 'missing', which relies on a gap being a real gap — an
    // invented value would resolve an alarm that should stay INSUFFICIENT_DATA.
    expect(deriveQuotaUtilizationPoints([usagePoint()], () => null)).toEqual([]);
  });

  it('emits nothing for a zero or negative quota rather than dividing by it', () => {
    expect(deriveQuotaUtilizationPoints([usagePoint()], () => 0)).toEqual([]);
    expect(deriveQuotaUtilizationPoints([usagePoint()], () => -5)).toEqual([]);
  });

  it('excludes ThrottleCount, which is not a utilization of anything', () => {
    // ThrottleCount counts calls AWS *rejected*. Dividing it by the quota would
    // render "0.3% utilized" at the exact moment the quota is being enforced.
    const out = deriveQuotaUtilizationPoints(
      [usagePoint({ metricName: 'ThrottleCount', value: 2 })],
      limit640,
    );
    expect(out).toEqual([]);
  });

  it('derives from CallCount as well as ResourceCount', () => {
    // A rate quota is as much a headroom question as a resource count.
    const [derived] = deriveQuotaUtilizationPoints(
      [usagePoint({ metricName: 'CallCount', stat: 'Sum', value: 320 })],
      limit640,
    );
    expect(derived!.value).toBe(50);
    // One statistic regardless of the underlying usage statistic, so a single
    // default rule covers both kinds of quota.
    expect(derived!.stat).toBe(QUOTA_UTILIZATION_STAT);
  });

  it('ignores every namespace but AWS/Usage', () => {
    const out = deriveQuotaUtilizationPoints(
      [
        usagePoint({ namespace: 'AWS/EC2', metricName: 'CPUUtilization' }),
        usagePoint({ namespace: QUOTA_DERIVED_NAMESPACE }),
      ],
      limit640,
    );
    // The second case matters: re-deriving from an already-derived point would
    // compound on every tick.
    expect(out).toEqual([]);
  });

  it('does not clamp usage above the applied quota', () => {
    const [derived] = deriveQuotaUtilizationPoints([usagePoint({ value: 896 })], limit640);
    expect(derived!.value).toBe(140);
  });

  it('looks a quota’s limit up once per batch, not once per point', () => {
    // A 15-minute window at a 60s period is 15 points for the same quota, and
    // the default lookup is a SQLite read.
    const lookup = vi.fn(() => 640);
    const points = Array.from({ length: 15 }, (_, i) =>
      usagePoint({ tsMs: 1_700_000_000_000 + i * 60_000 }),
    );
    const out = deriveQuotaUtilizationPoints(points, lookup);
    expect(out).toHaveLength(15);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('caches a missing limit too, rather than re-reading it per point', () => {
    const lookup = vi.fn(() => null);
    const points = Array.from({ length: 5 }, () => usagePoint());
    expect(deriveQuotaUtilizationPoints(points, lookup)).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps separate limits for separate quotas', () => {
    const lookup = (key: string) => (key === 'a' ? 100 : 200);
    const out = deriveQuotaUtilizationPoints(
      [usagePoint({ resourceKey: 'a', value: 50 }), usagePoint({ resourceKey: 'b', value: 50 })],
      lookup,
    );
    expect(out.map((p) => p.value)).toEqual([50, 25]);
  });
});
