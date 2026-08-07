/**
 * Quota limits store and the headroom join.
 *
 * The join is the whole feature: limits come from Service Quotas, usage from
 * CloudWatch, and utilization exists nowhere until the two meet here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import { initInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import { insertInfraMetricPoints } from './infra-metric-store.js';
import { QUOTA_SERVICE_TOKEN, type QuotaUsageMetric } from './quota-catalog.js';
import {
  getInfraServiceQuota,
  listInfraQuotaHeadroom,
  listInfraServiceQuotas,
  pruneInfraServiceQuotas,
  sortQuotaHeadroom,
  upsertInfraServiceQuotas,
  type InfraServiceQuotaInput,
} from './quota-store.js';

let dir: string;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const MINUTE = 60_000;

const USAGE_METRIC: QuotaUsageMetric = {
  namespace: 'AWS/Usage',
  metricName: 'ResourceCount',
  dimensions: { Class: 'Standard/OnDemand', Resource: 'vCPU', Service: 'EC2', Type: 'Resource' },
  statisticRecommendation: 'Maximum',
};

function keyFor(resourceId: string): string {
  return infraResourceKey({
    projectId: 'proj',
    accountId: '123456789012',
    region: 'us-east-1',
    service: QUOTA_SERVICE_TOKEN,
    resourceId,
  });
}

function quotaInput(overrides: Partial<InfraServiceQuotaInput> = {}): InfraServiceQuotaInput {
  const quotaCode = overrides.quotaCode ?? 'L-1216C47A';
  const serviceCode = overrides.serviceCode ?? 'ec2';
  return {
    resourceKey: keyFor(`${serviceCode}/${quotaCode}`),
    projectId: 'proj',
    accountId: '123456789012',
    region: 'us-east-1',
    serviceCode,
    quotaCode,
    quotaName: 'Running On-Demand Standard instances',
    value: 640,
    unit: 'None',
    adjustable: true,
    globalQuota: false,
    usageMetric: USAGE_METRIC,
    ...overrides,
  };
}

/** Record a usage reading for a quota. */
function usagePoint(
  resourceKey: string,
  value: number,
  tsMs: number,
  metricName = 'ResourceCount',
) {
  insertInfraMetricPoints([
    {
      projectId: 'proj',
      resourceKey,
      namespace: 'AWS/Usage',
      metricName,
      dimensions: USAGE_METRIC.dimensions,
      stat: 'Maximum',
      periodSeconds: 60,
      tsMs,
      value,
    },
  ]);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-quota-store-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('storing quotas', () => {
  it('round-trips a quota including its usage-metric pointer', () => {
    upsertInfraServiceQuotas([quotaInput()], NOW);
    const row = getInfraServiceQuota(keyFor('ec2/L-1216C47A'))!;
    expect(row.value).toBe(640);
    expect(row.adjustable).toBe(true);
    expect(row.globalQuota).toBe(false);
    expect(row.usageMetric).toEqual(USAGE_METRIC);
    expect(row.syncedAt).toBe(NOW);
  });

  it('updates an existing quota in place when its applied value changes', () => {
    // The case this exists for: an operator requested an increase and AWS
    // granted it. The row must move, not duplicate.
    upsertInfraServiceQuotas([quotaInput()], NOW);
    upsertInfraServiceQuotas([quotaInput({ value: 1280 })], NOW + 3_600_000);
    const rows = listInfraServiceQuotas('proj');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(1280);
  });

  it('keeps an unknown applied value distinct from zero', () => {
    upsertInfraServiceQuotas([quotaInput({ value: null })], NOW);
    expect(getInfraServiceQuota(keyFor('ec2/L-1216C47A'))!.value).toBeNull();
  });

  it('prunes only the region the sweep covered', () => {
    // A sweep of eu-west-1 says nothing about us-east-1. A project-wide prune
    // would delete every other region's limits on every run.
    upsertInfraServiceQuotas(
      [quotaInput(), quotaInput({ quotaCode: 'L-OTHER', region: 'eu-west-1' })],
      NOW,
    );
    pruneInfraServiceQuotas('proj', '123456789012', 'eu-west-1', NOW + 1);
    const rows = listInfraServiceQuotas('proj');
    expect(rows.map((r) => r.region)).toEqual(['us-east-1']);
  });

  it('does not prune rows the current sweep just wrote', () => {
    upsertInfraServiceQuotas([quotaInput()], NOW);
    // The sweep's own stamp is the cutoff, so its rows are never < it.
    expect(pruneInfraServiceQuotas('proj', '123456789012', 'us-east-1', NOW)).toBe(0);
    expect(listInfraServiceQuotas('proj')).toHaveLength(1);
  });
});

describe('listInfraQuotaHeadroom', () => {
  it('joins the newest usage reading to the applied limit', () => {
    upsertInfraServiceQuotas([quotaInput()], NOW);
    usagePoint(keyFor('ec2/L-1216C47A'), 320, NOW - MINUTE);
    usagePoint(keyFor('ec2/L-1216C47A'), 512, NOW);

    const [row] = listInfraQuotaHeadroom('proj');
    expect(row!.usage).toBe(512);
    expect(row!.usageAtMs).toBe(NOW);
    expect(row!.limit).toBe(640);
    // 512/640*100
    expect(row!.utilizationPercent).toBe(80);
    expect(row!.headroom).toBe(128);
    // Exactly 80 is still ok — AWS alarms on Greater than 80.
    expect(row!.band).toBe('ok');
  });

  it('reports unknown rather than zero when nothing has been collected', () => {
    // Zero usage and no usage are different facts. Rendering the second as the
    // first would claim full headroom we have not measured.
    upsertInfraServiceQuotas([quotaInput()], NOW);
    const [row] = listInfraQuotaHeadroom('proj');
    expect(row!.usage).toBeNull();
    expect(row!.utilizationPercent).toBeNull();
    expect(row!.headroom).toBeNull();
    expect(row!.band).toBe('unknown');
  });

  it('reports unknown when the applied limit is unavailable', () => {
    upsertInfraServiceQuotas([quotaInput({ value: null })], NOW);
    usagePoint(keyFor('ec2/L-1216C47A'), 512, NOW);
    const [row] = listInfraQuotaHeadroom('proj');
    expect(row!.usage).toBe(512);
    expect(row!.utilizationPercent).toBeNull();
    expect(row!.band).toBe('unknown');
  });

  it('drops a reading older than the staleness bound instead of freezing it', () => {
    // A collector that stopped running must degrade to "unknown", not leave a
    // reassuring number pinned on the panel forever.
    upsertInfraServiceQuotas([quotaInput()], NOW);
    usagePoint(keyFor('ec2/L-1216C47A'), 512, NOW - 60 * MINUTE);

    const fresh = listInfraQuotaHeadroom('proj', { staleBeforeMs: NOW - 10 * MINUTE });
    expect(fresh[0]!.usage).toBeNull();
    expect(fresh[0]!.band).toBe('unknown');

    const lenient = listInfraQuotaHeadroom('proj', { staleBeforeMs: NOW - 120 * MINUTE });
    expect(lenient[0]!.usage).toBe(512);
  });

  it('reads each quota’s own usage metric, not a fixed one', () => {
    // A CallCount quota must not pick up a ResourceCount series, and vice
    // versa: they are different questions with different units.
    upsertInfraServiceQuotas(
      [
        quotaInput(),
        quotaInput({
          quotaCode: 'L-CALLS',
          value: 1000,
          usageMetric: { ...USAGE_METRIC, metricName: 'CallCount' },
        }),
      ],
      NOW,
    );
    usagePoint(keyFor('ec2/L-1216C47A'), 512, NOW, 'ResourceCount');
    usagePoint(keyFor('ec2/L-CALLS'), 900, NOW, 'CallCount');

    const byCode = Object.fromEntries(listInfraQuotaHeadroom('proj').map((r) => [r.quotaCode, r]));
    expect(byCode['L-1216C47A']!.usage).toBe(512);
    expect(byCode['L-CALLS']!.usage).toBe(900);
    expect(byCode['L-CALLS']!.utilizationPercent).toBe(90);
  });

  it('surfaces over-quota usage rather than clamping it to full', () => {
    // Real and observable: a quota decrease applies immediately while existing
    // resources keep running.
    upsertInfraServiceQuotas([quotaInput({ value: 100 })], NOW);
    usagePoint(keyFor('ec2/L-1216C47A'), 140, NOW);
    const [row] = listInfraQuotaHeadroom('proj');
    expect(row!.utilizationPercent).toBeCloseTo(140);
    expect(row!.band).toBe('critical');
    // Headroom floors at zero — "you can create -40 more" is noise.
    expect(row!.headroom).toBe(0);
  });

  it('returns nothing for a project with no quotas', () => {
    expect(listInfraQuotaHeadroom('proj')).toEqual([]);
  });
});

describe('sortQuotaHeadroom', () => {
  it('puts the tightest quota first and unknowns last', () => {
    upsertInfraServiceQuotas(
      [
        quotaInput({ quotaCode: 'L-OK', quotaName: 'ok', value: 100 }),
        quotaInput({ quotaCode: 'L-WARN', quotaName: 'warn', value: 100 }),
        quotaInput({ quotaCode: 'L-CRIT', quotaName: 'crit', value: 100 }),
        quotaInput({ quotaCode: 'L-UNK', quotaName: 'unknown', value: null }),
      ],
      NOW,
    );
    usagePoint(keyFor('ec2/L-OK'), 10, NOW);
    usagePoint(keyFor('ec2/L-WARN'), 90, NOW);
    usagePoint(keyFor('ec2/L-CRIT'), 120, NOW);
    usagePoint(keyFor('ec2/L-UNK'), 5, NOW);

    const sorted = sortQuotaHeadroom(listInfraQuotaHeadroom('proj'));
    // Unknowns last despite not being "ok": they are the steady-state
    // background, and floating them up would bury the quota needing action.
    expect(sorted.map((r) => r.quotaCode)).toEqual(['L-CRIT', 'L-WARN', 'L-OK', 'L-UNK']);
  });

  it('orders within a band by utilization, highest first', () => {
    upsertInfraServiceQuotas(
      [
        quotaInput({ quotaCode: 'L-A', quotaName: 'a', value: 100 }),
        quotaInput({ quotaCode: 'L-B', quotaName: 'b', value: 100 }),
      ],
      NOW,
    );
    usagePoint(keyFor('ec2/L-A'), 20, NOW);
    usagePoint(keyFor('ec2/L-B'), 60, NOW);
    expect(sortQuotaHeadroom(listInfraQuotaHeadroom('proj')).map((r) => r.quotaCode)).toEqual([
      'L-B',
      'L-A',
    ]);
  });

  it('does not mutate its input', () => {
    upsertInfraServiceQuotas(
      [
        quotaInput({ quotaCode: 'L-A', quotaName: 'a', value: 100 }),
        quotaInput({ quotaCode: 'L-B', quotaName: 'b', value: 100 }),
      ],
      NOW,
    );
    usagePoint(keyFor('ec2/L-A'), 20, NOW);
    usagePoint(keyFor('ec2/L-B'), 90, NOW);
    const rows = listInfraQuotaHeadroom('proj');
    const before = rows.map((r) => r.quotaCode);
    sortQuotaHeadroom(rows);
    expect(rows.map((r) => r.quotaCode)).toEqual(before);
  });
});
