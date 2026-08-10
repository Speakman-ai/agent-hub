/**
 * The fleet read: the batch sparkline query (period tiers, absent buckets, the
 * aggregate the caller asked for) and the page it assembles on top.
 *
 * The property that matters most here is the scan bound — one query per series
 * regardless of how many resources are on the page. That is the whole reason
 * this path exists rather than a loop over the single-series readers, so it is
 * asserted directly by counting prepared statements.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import {
  insertInfraMetricPoints,
  queryInfraSparklines,
  type InfraMetricPointInput,
} from './infra-metric-store.js';
import {
  buildInfraFleet,
  emptyInfraFleet,
  fleetBucketSeconds,
  DEFAULT_FLEET_WINDOW_MS,
  MIN_FLEET_WINDOW_MS,
} from './infra-fleet.js';
import { INFRA_FLEET_SERVICES } from './headline-metrics.js';
import { ECS_CONTAINER_INSIGHTS_FEATURE } from './packs/index.js';

let dir: string;
const PROJECT = 'proj-fleet';
const ACCOUNT = '111122223333';
const REGION = 'us-east-1';
const NOW = 1_700_000_000_000;

function key(service: string, resourceId: string): string {
  return infraResourceKey({
    projectId: PROJECT,
    accountId: ACCOUNT,
    region: REGION,
    service,
    resourceId,
  });
}

const EC2_A = key('ec2', 'i-0aaa');
const EC2_B = key('ec2', 'i-0bbb');

function point(over: Partial<InfraMetricPointInput> = {}): InfraMetricPointInput {
  return {
    projectId: PROJECT,
    resourceKey: EC2_A,
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    stat: 'Average',
    periodSeconds: 60,
    tsMs: NOW - 60_000,
    value: 10,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-fleet-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('queryInfraSparklines', () => {
  const base = {
    projectId: PROJECT,
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    stat: 'Average',
    startMs: NOW - 3_600_000,
    endMs: NOW,
    bucketSeconds: 300,
    maxPointsPerResource: 48,
    aggregate: 'avg' as const,
  };

  it('returns one series per resource from a single query', () => {
    insertInfraMetricPoints([
      point({ resourceKey: EC2_A, tsMs: NOW - 600_000, value: 10 }),
      point({ resourceKey: EC2_A, tsMs: NOW - 300_000, value: 20 }),
      point({ resourceKey: EC2_B, tsMs: NOW - 300_000, value: 55 }),
    ]);

    const out = queryInfraSparklines({ ...base, resourceKeys: [EC2_A, EC2_B] });

    expect(out.get(EC2_A)?.map((p) => p.value)).toEqual([10, 20]);
    expect(out.get(EC2_B)?.map((p) => p.value)).toEqual([55]);
  });

  it('omits a resource that reported nothing rather than mapping it to []', () => {
    // "Asked and got nothing" and "did not ask" are different answers, and the
    // caller renders them differently.
    insertInfraMetricPoints([point({ resourceKey: EC2_A })]);
    const out = queryInfraSparklines({ ...base, resourceKeys: [EC2_A, EC2_B] });
    expect(out.has(EC2_A)).toBe(true);
    expect(out.has(EC2_B)).toBe(false);
  });

  it('folds several points in one bucket with the requested aggregate', () => {
    insertInfraMetricPoints([
      point({ tsMs: NOW - 610_000, value: 10 }),
      point({ tsMs: NOW - 590_000, value: 30 }),
    ]);

    const avg = queryInfraSparklines({ ...base, resourceKeys: [EC2_A], aggregate: 'avg' });
    const max = queryInfraSparklines({ ...base, resourceKeys: [EC2_A], aggregate: 'max' });
    const sum = queryInfraSparklines({ ...base, resourceKeys: [EC2_A], aggregate: 'sum' });

    // Both points land in the same 300s bucket.
    expect(avg.get(EC2_A)).toHaveLength(1);
    expect(avg.get(EC2_A)?.[0].value).toBe(20);
    expect(max.get(EC2_A)?.[0].value).toBe(30);
    expect(sum.get(EC2_A)?.[0].value).toBe(40);
  });

  it('never blends period tiers — the finest present wins, per resource', () => {
    // A 60s point and a 3600s point in one bucket would double-count a counter
    // and mis-weight a gauge.
    insertInfraMetricPoints([
      point({ resourceKey: EC2_A, periodSeconds: 60, tsMs: NOW - 600_000, value: 10 }),
      point({ resourceKey: EC2_A, periodSeconds: 3600, tsMs: NOW - 600_000, value: 999 }),
      point({ resourceKey: EC2_B, periodSeconds: 3600, tsMs: NOW - 600_000, value: 42 }),
    ]);

    const out = queryInfraSparklines({ ...base, resourceKeys: [EC2_A, EC2_B] });

    expect(out.get(EC2_A)?.map((p) => p.value)).toEqual([10]);
    // B only ever had the coarse tier, so the coarse tier is its finest.
    expect(out.get(EC2_B)?.map((p) => p.value)).toEqual([42]);
  });

  it('leaves gaps absent rather than zero-filling them', () => {
    insertInfraMetricPoints([
      point({ tsMs: NOW - 3_000_000, value: 5 }),
      point({ tsMs: NOW - 300_000, value: 7 }),
    ]);
    const out = queryInfraSparklines({ ...base, resourceKeys: [EC2_A] });
    // Two observations an hour apart, not a chart full of zeroes between them.
    expect(out.get(EC2_A)).toHaveLength(2);
    expect(out.get(EC2_A)?.every((p) => p.value > 0)).toBe(true);
  });

  it('trims from the old end when a resource has more buckets than fit', () => {
    insertInfraMetricPoints(
      Array.from({ length: 6 }, (_, i) => point({ tsMs: NOW - (6 - i) * 300_000, value: i + 1 })),
    );
    const out = queryInfraSparklines({ ...base, resourceKeys: [EC2_A], maxPointsPerResource: 2 });
    // The two nearest now, not the two furthest from it.
    expect(out.get(EC2_A)?.map((p) => p.value)).toEqual([5, 6]);
  });

  it('does not leak another statistic into the series', () => {
    insertInfraMetricPoints([
      point({ stat: 'Average', value: 10 }),
      point({ stat: 'Maximum', value: 90 }),
    ]);
    const out = queryInfraSparklines({ ...base, resourceKeys: [EC2_A], stat: 'Average' });
    expect(out.get(EC2_A)?.map((p) => p.value)).toEqual([10]);
  });

  it('is a no-op on an empty batch', () => {
    expect(queryInfraSparklines({ ...base, resourceKeys: [] }).size).toBe(0);
  });
});

describe('emptyInfraFleet', () => {
  it('describes itself in exactly the terms a populated page would', () => {
    // The envelope must not depend on whether there happened to be rows: a
    // client cannot be told the bucket width is 60s here and 225s there for the
    // same request.
    const empty = emptyInfraFleet({ windowMs: 24 * 60 * 60 * 1000, nowMs: NOW });
    const populated = buildInfraFleet({
      projectId: PROJECT,
      windowMs: 24 * 60 * 60 * 1000,
      nowMs: NOW,
    });

    expect(empty.fromMs).toBe(populated.fromMs);
    expect(empty.toMs).toBe(populated.toMs);
    expect(empty.bucketSeconds).toBe(populated.bucketSeconds);
    expect(empty.services).toEqual(populated.services);
    expect(empty.resources).toEqual([]);
    expect(empty.truncated).toBe(false);
  });

  it('honours the requested window rather than assuming the default', () => {
    const asked = emptyInfraFleet({ windowMs: 24 * 60 * 60 * 1000, nowMs: NOW });
    expect(asked.toMs - asked.fromMs).toBe(24 * 60 * 60 * 1000);
    expect(asked.bucketSeconds).toBe(fleetBucketSeconds(24 * 60 * 60 * 1000));
    expect(asked.bucketSeconds).not.toBe(60);
  });

  it('clamps and filters the same way the populated path does', () => {
    const clamped = emptyInfraFleet({ windowMs: 1_000, nowMs: NOW });
    expect(clamped.toMs - clamped.fromMs).toBe(MIN_FLEET_WINDOW_MS);

    expect(emptyInfraFleet({ services: ['rds', 'nonsense'], nowMs: NOW }).services).toEqual([
      'rds',
    ]);
    expect(emptyInfraFleet({ nowMs: NOW }).services).toEqual(INFRA_FLEET_SERVICES);
  });
});

describe('fleetBucketSeconds', () => {
  it('never buckets narrower than the collector’s finest tier', () => {
    // A bucket under 60s holds at most one point and only makes the line jagged.
    expect(fleetBucketSeconds(15 * 60 * 1000)).toBe(60);
  });

  it('widens with the window so a tile holds a similar number of points', () => {
    expect(fleetBucketSeconds(24 * 60 * 60 * 1000)).toBeGreaterThan(
      fleetBucketSeconds(3 * 60 * 60 * 1000),
    );
  });
});

function seedResource(over: {
  service: string;
  resourceId: string;
  dimensions?: Record<string, string>;
  features?: Record<string, boolean>;
  lastSeen?: number;
}): string {
  const resourceKey = key(over.service, over.resourceId);
  getInfraDb()
    .prepare(
      `INSERT INTO infra_resources (
         resource_key, project_id, account_id, region, service, resource_id,
         name, tags_json, environment, state, metric_dimensions_json, features_json,
         first_seen, last_seen
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      resourceKey,
      PROJECT,
      ACCOUNT,
      REGION,
      over.service,
      over.resourceId,
      over.resourceId,
      null,
      null,
      'running',
      over.dimensions ? JSON.stringify(over.dimensions) : null,
      over.features ? JSON.stringify(over.features) : null,
      NOW - 10 * 60 * 60 * 1000,
      over.lastSeen ?? NOW - 60_000,
    );
  return resourceKey;
}

describe('buildInfraFleet', () => {
  it('returns resources with their headline metrics already resolved', () => {
    seedResource({ service: 'ec2', resourceId: 'i-0aaa', dimensions: { InstanceId: 'i-0aaa' } });
    insertInfraMetricPoints([
      point({ resourceKey: EC2_A, tsMs: NOW - 600_000, value: 10 }),
      point({ resourceKey: EC2_A, tsMs: NOW - 120_000, value: 44 }),
    ]);

    const page = buildInfraFleet({ projectId: PROJECT, nowMs: NOW });

    expect(page.resources).toHaveLength(1);
    const cpu = page.resources[0].metrics.find((m) => m.metricName === 'CPUUtilization');
    expect(cpu?.label).toBe('CPU');
    expect(cpu?.unit).toBe('percent');
    expect(cpu?.latest).toBe(44);
    expect(cpu?.min).toBe(10);
    expect(cpu?.max).toBe(44);
    expect(cpu?.points.length).toBeGreaterThan(0);
  });

  it('reports a headline that reported nothing as null, not zero', () => {
    // Zero CPU and "the instance stopped reporting" are different situations
    // and a dashboard that draws both as 0 hides the second.
    seedResource({ service: 'ec2', resourceId: 'i-0aaa', dimensions: { InstanceId: 'i-0aaa' } });

    const page = buildInfraFleet({ projectId: PROJECT, nowMs: NOW });
    const cpu = page.resources[0].metrics.find((m) => m.metricName === 'CPUUtilization');

    expect(cpu?.latest).toBeNull();
    expect(cpu?.latestTsMs).toBeNull();
    expect(cpu?.points).toEqual([]);
  });

  it('issues one query per series, not one per resource per series', () => {
    for (let i = 0; i < 12; i += 1) {
      seedResource({
        service: 'ec2',
        resourceId: `i-0${i}`,
        dimensions: { InstanceId: `i-0${i}` },
      });
    }

    const db = getInfraDb();
    const original = db.prepare.bind(db);
    const sqls: string[] = [];
    // Test seam over better-sqlite3's prepare, to count scans.
    db.prepare = ((sql: string) => {
      sqls.push(sql);
      return original(sql);
    }) as typeof db.prepare;
    try {
      buildInfraFleet({ projectId: PROJECT, nowMs: NOW });
    } finally {
      db.prepare = original;
    }

    const sparklineQueries = sqls.filter((s) => s.includes('GROUP BY resource_key, period_s'));
    // Three EC2 headlines, twelve instances. One scan each, not thirty-six.
    expect(sparklineQueries).toHaveLength(3);
  });

  it('skips a Container Insights headline for a service without the feature', () => {
    seedResource({
      service: 'ecs',
      resourceId: 'prod/api',
      dimensions: { ClusterName: 'prod', ServiceName: 'api' },
    });
    seedResource({
      service: 'ecs',
      resourceId: 'prod/web',
      dimensions: { ClusterName: 'prod', ServiceName: 'web' },
      features: { [ECS_CONTAINER_INSIGHTS_FEATURE]: true },
    });

    const page = buildInfraFleet({ projectId: PROJECT, nowMs: NOW });
    const api = page.resources.find((r) => r.resourceId === 'prod/api');
    const web = page.resources.find((r) => r.resourceId === 'prod/web');

    expect(api?.metrics.map((m) => m.metricName)).not.toContain('RunningTaskCount');
    expect(web?.metrics.map((m) => m.metricName)).toContain('RunningTaskCount');
  });

  it('covers the three dashboard services and ignores tokens outside them', () => {
    seedResource({ service: 'ec2', resourceId: 'i-0aaa', dimensions: { InstanceId: 'i-0aaa' } });
    seedResource({
      service: 'rds',
      resourceId: 'db-1',
      dimensions: { DBInstanceIdentifier: 'db-1' },
    });
    seedResource({ service: 's3', resourceId: 'bucket-1', dimensions: { BucketName: 'bucket-1' } });

    const all = buildInfraFleet({ projectId: PROJECT, nowMs: NOW });
    expect(all.resources.map((r) => r.service).sort()).toEqual(['ec2', 'rds']);

    const narrowed = buildInfraFleet({ projectId: PROJECT, services: ['rds'], nowMs: NOW });
    expect(narrowed.resources.map((r) => r.resourceId)).toEqual(['db-1']);

    const bogus = buildInfraFleet({ projectId: PROJECT, services: ['s3', 'nonsense'], nowMs: NOW });
    expect(bogus.resources).toEqual([]);
  });

  it('never lists Service Quotas rows', () => {
    // The rows an operator reads as "kms keys and cloudwatch streams". They
    // describe a limit, they have their own panel, and they are not a fleet.
    seedResource({ service: 'quota', resourceId: 'kms/L-0123' });
    seedResource({ service: 'ec2', resourceId: 'i-0aaa', dimensions: { InstanceId: 'i-0aaa' } });

    const page = buildInfraFleet({ projectId: PROJECT, nowMs: NOW });
    expect(page.resources.map((r) => r.service)).toEqual(['ec2']);
  });

  it('flags truncation instead of silently dropping resources', () => {
    for (let i = 0; i < 5; i += 1) {
      seedResource({
        service: 'ec2',
        resourceId: `i-0${i}`,
        dimensions: { InstanceId: `i-0${i}` },
        lastSeen: NOW - i * 1000,
      });
    }

    const page = buildInfraFleet({ projectId: PROJECT, limit: 2, nowMs: NOW });
    expect(page.resources).toHaveLength(2);
    expect(page.truncated).toBe(true);
    // Most-recently-described first, matching the Resources browser.
    expect(page.resources.map((r) => r.resourceId)).toEqual(['i-00', 'i-01']);
  });

  it('drops rows the collector has stopped describing', () => {
    seedResource({
      service: 'ec2',
      resourceId: 'i-gone',
      dimensions: { InstanceId: 'i-gone' },
      lastSeen: NOW - 30 * 24 * 60 * 60 * 1000,
    });
    seedResource({ service: 'ec2', resourceId: 'i-0aaa', dimensions: { InstanceId: 'i-0aaa' } });

    const page = buildInfraFleet({
      projectId: PROJECT,
      seenSinceMs: NOW - 60 * 60 * 1000,
      nowMs: NOW,
    });
    expect(page.resources.map((r) => r.resourceId)).toEqual(['i-0aaa']);
  });

  it('defaults to a window ending now and reports the bucket width it used', () => {
    const page = buildInfraFleet({ projectId: PROJECT, nowMs: NOW });
    expect(page.toMs).toBe(NOW);
    expect(page.fromMs).toBe(NOW - DEFAULT_FLEET_WINDOW_MS);
    expect(page.bucketSeconds).toBe(fleetBucketSeconds(DEFAULT_FLEET_WINDOW_MS));
  });
});
