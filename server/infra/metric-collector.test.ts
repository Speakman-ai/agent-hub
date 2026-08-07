/**
 * Batched GetMetricData collector.
 *
 * The behaviours pinned here are the ones AWS's own limits make load-bearing
 * and that a refactor would plausibly break: period selection tracking data
 * age, window alignment, batching against *both* per-request ceilings,
 * `NextToken` pagination, throttle backoff landing on the run row, and one
 * failing target not taking the tick down with it.
 *
 * No AWS SDK client is ever constructed — every test injects a
 * `cloudWatchClientFactory`, so nothing here can reach the network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { GetMetricDataCommandOutput } from '@aws-sdk/client-cloudwatch';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import { estimateIntervalSeconds } from '../cron-tick.js';
import type { InfraScopeRow } from './inventory-sync.js';
import type { InfraMetricPointInput } from './infra-metric-store.js';
import {
  isValidCloudWatchPeriod,
  startInfraCollectRun,
  finishInfraCollectRun,
  recordInfraCollectRunProgress,
} from './infra-metric-store.js';
import {
  setInfraCostCeiling,
  getInfraSpendToDate,
  resolveProjectDegradation,
} from './infra-cost-store.js';
import { COLLECTOR_TICK_INTERVAL_S } from './infra-cost.js';
import { getServiceMetricPack } from './service-metric-packs.js';
import {
  runInfraMetricCollection,
  resolvePeriod,
  effectivePeriod,
  alignWindow,
  estimateDatapointsPerQuery,
  batchMetricQueries,
  isThrottlingError,
  backoffDelayMs,
  planQueries,
  groupQueriesByPeriod,
  groupScopesIntoTargets,
  buildMetricDataQueries,
  pointsFromResult,
  estimateGetMetricDataCostUsd,
  INFRA_COLLECT_CRON,
  MAX_QUERIES_PER_REQUEST,
  MAX_DATAPOINTS_PER_REQUEST,
  MAX_PAGES_PER_BATCH,
  MAX_RESOURCE_STALENESS_MS,
  THROTTLE_BACKOFF_BASE_MS,
  THROTTLE_BACKOFF_MAX_MS,
  type CollectableResource,
  type CloudWatchMetricDataClient,
  type PlannedQuery,
} from './metric-collector.js';

let dir: string;

/** 2023-11-14T22:13:20.000Z — deliberately not on a 5-minute boundary. */
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const EC2_PACK_SIZE = getServiceMetricPack('ec2').length;

function insertScope(overrides: Partial<InfraScopeRow> & { id: string }): InfraScopeRow {
  const row: InfraScopeRow = {
    project_id: 'proj',
    profile_name: 'monitor',
    account_id: null,
    region: 'us-east-1',
    service: 'ec2',
    tag_filter_json: null,
    ...overrides,
  };
  getInfraDb()
    .prepare(
      `INSERT INTO infra_scopes
         (id, project_id, profile_name, account_id, region, service, tag_filter_json,
          enabled, created_at, updated_at)
       VALUES (@id, @project_id, @profile_name, @account_id, @region, @service,
               @tag_filter_json, @enabled, @created_at, @updated_at)`,
    )
    .run({
      ...row,
      enabled: (overrides as { enabled?: number }).enabled ?? 1,
      created_at: NOW,
      updated_at: NOW,
    });
  return row;
}

function insertResource(
  resourceId: string,
  overrides: {
    projectId?: string;
    accountId?: string;
    region?: string;
    service?: string;
    state?: string | null;
    lastSeen?: number;
    tags?: Record<string, string>;
  } = {},
): string {
  const identity = {
    projectId: overrides.projectId ?? 'proj',
    accountId: overrides.accountId ?? '111122223333',
    region: overrides.region ?? 'us-east-1',
    service: overrides.service ?? 'ec2',
    resourceId,
  };
  const key = infraResourceKey(identity);
  getInfraDb()
    .prepare(
      `INSERT INTO infra_resources
         (resource_key, project_id, account_id, region, service, resource_id,
          name, tags_json, environment, state, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
    )
    .run(
      key,
      identity.projectId,
      identity.accountId,
      identity.region,
      identity.service,
      resourceId,
      overrides.tags
        ? JSON.stringify(Object.entries(overrides.tags).map(([Key, Value]) => ({ Key, Value })))
        : null,
      overrides.state === undefined ? 'running' : overrides.state,
      NOW,
      overrides.lastSeen ?? NOW,
    );
  return key;
}

/** Instance ids named by the dimensions of every query a stub client received. */
function queriedInstanceIds(calls: GetMetricDataCommand[]): Set<string> {
  return new Set(
    calls
      .flatMap((c) => c.input.MetricDataQueries ?? [])
      .flatMap((q) => q.MetricStat?.Metric?.Dimensions ?? [])
      .map((d) => d.Value ?? ''),
  );
}

interface RunRow {
  id: string;
  project_id: string;
  account_id: string | null;
  region: string | null;
  queries_issued: number;
  metrics_requested: number;
  datapoints_returned: number;
  points_written: number;
  throttles: number;
  errors: number;
  estimated_cost_usd: number;
  status: string;
  error_message: string | null;
}

function runRows(): RunRow[] {
  return getInfraDb()
    .prepare('SELECT * FROM infra_collect_runs ORDER BY rowid')
    .all() as unknown as RunRow[];
}

/** A CloudWatch stub that answers each `send` from a scripted page list. */
function stubCloudWatch(
  pages: Array<Partial<GetMetricDataCommandOutput> | Error>,
): CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } {
  const calls: GetMetricDataCommand[] = [];
  let index = 0;
  return {
    calls,
    async send(command: GetMetricDataCommand) {
      calls.push(command);
      const page = pages[index] ?? {};
      index += 1;
      if (page instanceof Error) throw page;
      return page as GetMetricDataCommandOutput;
    },
  };
}

/** Echo every requested query back with a single datapoint. */
function echoAll(command: GetMetricDataCommand, tsMs = NOW): Partial<GetMetricDataCommandOutput> {
  const queries = command.input.MetricDataQueries ?? [];
  return {
    MetricDataResults: queries.map((q) => ({
      Id: q.Id,
      StatusCode: 'Complete',
      Timestamps: [new Date(tsMs)],
      Values: [1],
    })),
  };
}

function throttleError(): Error {
  return Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 400 },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-collector-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('resolvePeriod', () => {
  it('uses 60s inside the 15-day retention tier', () => {
    expect(resolvePeriod(NOW - 60_000, NOW)).toBe(60);
    expect(resolvePeriod(NOW - 14 * DAY_MS, NOW)).toBe(60);
  });

  it('treats the 15-day boundary as still 60s and one ms past it as 300s', () => {
    expect(resolvePeriod(NOW - 15 * DAY_MS, NOW)).toBe(60);
    expect(resolvePeriod(NOW - 15 * DAY_MS - 1, NOW)).toBe(300);
  });

  it('uses 300s inside the 63-day tier and 3600s past it', () => {
    expect(resolvePeriod(NOW - 62 * DAY_MS, NOW)).toBe(300);
    expect(resolvePeriod(NOW - 63 * DAY_MS, NOW)).toBe(300);
    expect(resolvePeriod(NOW - 63 * DAY_MS - 1, NOW)).toBe(3600);
  });

  it('stays at 3600s past the 455-day tier rather than inventing a fourth one', () => {
    expect(resolvePeriod(NOW - 455 * DAY_MS, NOW)).toBe(3600);
    expect(resolvePeriod(NOW - 3000 * DAY_MS, NOW)).toBe(3600);
  });

  it('keys on the window start, so a window straddling a boundary uses the coarser tier', () => {
    // End of the window is recent, but its far end has aged out of the 60s tier.
    expect(resolvePeriod(NOW - 20 * DAY_MS, NOW)).toBe(300);
  });

  it('only ever returns periods CloudWatch accepts', () => {
    for (const days of [0, 1, 15, 16, 63, 64, 500]) {
      expect(isValidCloudWatchPeriod(resolvePeriod(NOW - days * DAY_MS, NOW))).toBe(true);
    }
  });
});

describe('effectivePeriod', () => {
  const spec = {
    namespace: 'AWS/EC2',
    metricName: 'X',
    stat: 'Average',
    dimensions: ['InstanceId'],
    requiresFeature: null,
  };

  it('raises the retention tier to the metric emission floor', () => {
    expect(effectivePeriod({ ...spec, minPeriodSeconds: 300 }, NOW - 60_000, NOW)).toBe(300);
  });

  it('leaves the tier alone when it is already coarser than the floor', () => {
    expect(effectivePeriod({ ...spec, minPeriodSeconds: 60 }, NOW - 70 * DAY_MS, NOW)).toBe(3600);
  });

  it('refuses a pack entry whose floor is not a valid CloudWatch period', () => {
    // 45 is currently masked by the 60s tier winning the max; 90 would reach
    // the store. Both are typos and both are rejected where they are written.
    for (const bad of [45, 90, 0, 2.5]) {
      expect(() => effectivePeriod({ ...spec, minPeriodSeconds: bad }, NOW - 60_000, NOW)).toThrow(
        /invalid minPeriodSeconds/,
      );
    }
  });

  it('every shipped pack entry resolves to a storable period', () => {
    for (const entry of getServiceMetricPack('ec2')) {
      expect(isValidCloudWatchPeriod(effectivePeriod(entry, NOW - 60_000, NOW))).toBe(true);
    }
  });
});

describe('alignWindow', () => {
  it('floors both ends to the period, which also syncs them to the hour', () => {
    const { startMs, endMs } = alignWindow(NOW - 15 * 60_000, NOW, 300);
    expect(startMs % 300_000).toBe(0);
    expect(endMs % 300_000).toBe(0);
    // 300 divides 3600, so a period-aligned instant is on a 5-minute mark of
    // the hour — the second half of AWS's guidance comes free.
    expect(new Date(endMs).getUTCSeconds()).toBe(0);
    expect(new Date(endMs).getUTCMinutes() % 5).toBe(0);
  });

  it('never widens the window past the requested end', () => {
    const { endMs } = alignWindow(NOW - 60_000, NOW, 3600);
    expect(endMs).toBeLessThanOrEqual(NOW);
  });

  it('widens a window that would round to zero width back to one period', () => {
    // 15 minutes of lookback collapses to nothing at an hourly period.
    const { startMs, endMs } = alignWindow(NOW - 15 * 60_000, NOW, 3600);
    expect(endMs - startMs).toBe(3_600_000);
  });

  it('is a no-op on a window already flush with the period', () => {
    const end = Math.floor(NOW / 300_000) * 300_000;
    const start = end - 900_000;
    expect(alignWindow(start, end, 300)).toEqual({ startMs: start, endMs: end });
  });
});

describe('estimateDatapointsPerQuery', () => {
  it('counts periods in the window', () => {
    expect(estimateDatapointsPerQuery(0, 900_000, 60)).toBe(15);
    expect(estimateDatapointsPerQuery(0, 900_000, 300)).toBe(3);
  });

  it('never returns zero, so a batch size is never a division by zero', () => {
    expect(estimateDatapointsPerQuery(NOW, NOW, 60)).toBe(1);
  });
});

describe('batchMetricQueries', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('caps at the 500-query per-request ceiling', () => {
    const batches = batchMetricQueries(items(1201), 1);
    expect(batches.map((b) => b.length)).toEqual([
      MAX_QUERIES_PER_REQUEST,
      MAX_QUERIES_PER_REQUEST,
      201,
    ]);
  });

  it('caps at the 100,800-datapoint ceiling when it binds before the query ceiling', () => {
    // A 15-day 60s window is 21,600 datapoints per query, so only 4 fit.
    const perQuery = 21_600;
    const batches = batchMetricQueries(items(10), perQuery);
    expect(Math.floor(MAX_DATAPOINTS_PER_REQUEST / perQuery)).toBe(4);
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
  });

  it('still issues a single-query batch when one query alone exceeds the datapoint ceiling', () => {
    // Dropping it would lose the series; the request paginates instead.
    expect(batchMetricQueries(items(3), MAX_DATAPOINTS_PER_REQUEST * 2)).toEqual([[0], [1], [2]]);
  });

  it('returns nothing for no queries', () => {
    expect(batchMetricQueries([], 1)).toEqual([]);
  });

  it('loses no queries and preserves order', () => {
    const batches = batchMetricQueries(items(1000), 500);
    expect(batches.flat()).toEqual(items(1000));
  });
});

describe('isThrottlingError', () => {
  it('recognises ThrottlingException, which arrives as an HTTP 400', () => {
    expect(isThrottlingError(throttleError())).toBe(true);
  });

  it('trusts the SDK retry classification', () => {
    expect(isThrottlingError({ name: 'Whatever', $retryable: { throttling: true } })).toBe(true);
  });

  it('recognises HTTP 429', () => {
    expect(isThrottlingError({ name: 'Nameless', $metadata: { httpStatusCode: 429 } })).toBe(true);
  });

  it('does not treat an auth or validation failure as retryable', () => {
    expect(
      isThrottlingError(
        Object.assign(new Error('nope'), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 403 },
        }),
      ),
    ).toBe(false);
    expect(isThrottlingError(new Error('boom'))).toBe(false);
    expect(isThrottlingError(null)).toBe(false);
    expect(isThrottlingError('ThrottlingException')).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially and caps', () => {
    const full = { random: () => 1 };
    expect(backoffDelayMs(0, full)).toBe(THROTTLE_BACKOFF_BASE_MS);
    expect(backoffDelayMs(1, full)).toBe(THROTTLE_BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(2, full)).toBe(THROTTLE_BACKOFF_BASE_MS * 4);
    expect(backoffDelayMs(50, full)).toBe(THROTTLE_BACKOFF_MAX_MS);
  });

  it('jitters below the cap', () => {
    expect(backoffDelayMs(6, { random: () => 0.5 })).toBe(THROTTLE_BACKOFF_MAX_MS / 2);
  });

  it('never sleeps less than one base interval, even on a zero jitter draw', () => {
    expect(backoffDelayMs(0, { random: () => 0 })).toBe(THROTTLE_BACKOFF_BASE_MS);
    expect(backoffDelayMs(9, { random: () => 0 })).toBe(THROTTLE_BACKOFF_BASE_MS);
  });
});

describe('estimateGetMetricDataCostUsd', () => {
  it('bills per 1,000 metrics requested at the region rate', () => {
    expect(estimateGetMetricDataCostUsd(1000, 'us-east-1')).toBeCloseTo(0.01, 10);
    expect(estimateGetMetricDataCostUsd(500, 'us-east-1')).toBeCloseTo(0.005, 10);
    expect(estimateGetMetricDataCostUsd(0, 'us-east-1')).toBe(0);
  });

  it('prices a region it does not recognise conservatively', () => {
    // A guardrail must not knowingly under-report: an unknown region is priced
    // at the dearest rate AWS charges, not the $0.01 list rate.
    expect(estimateGetMetricDataCostUsd(1000, 'mars-north-1')).toBeGreaterThan(
      estimateGetMetricDataCostUsd(1000, 'us-east-1'),
    );
  });
});

describe('planQueries', () => {
  const resource = (id: string, service = 'ec2'): CollectableResource => ({
    resource_key: `k-${id}`,
    account_id: '111122223333',
    resource_id: id,
    service,
  });

  it('crosses resources with their service pack', () => {
    const planned = planQueries([resource('i-1'), resource('i-2')], NOW - 900_000, NOW);
    expect(planned).toHaveLength(2 * EC2_PACK_SIZE);
    expect(planned[0].dimensions).toEqual({ InstanceId: 'i-1' });
  });

  it('skips a service with no metric pack rather than guessing at one', () => {
    expect(planQueries([resource('t-1', 'dynamodb')], NOW - 900_000, NOW)).toEqual([]);
  });

  it('applies each metric emission floor, so status checks and CPU land on different tiers', () => {
    const planned = planQueries([resource('i-1')], NOW - 900_000, NOW);
    const byMetric = new Map(planned.map((p) => [p.metricName, p.periodSeconds]));
    expect(byMetric.get('StatusCheckFailed')).toBe(60);
    expect(byMetric.get('CPUUtilization')).toBe(300);
  });

  describe('dimension binding and paid-feature gating', () => {
    /** An ECS row as inventory sync writes it. */
    const ecs = (
      resourceId: string,
      metricDimensions: Record<string, string>,
      features: Record<string, boolean> | null = null,
    ): CollectableResource => ({
      resource_key: `k-${resourceId}`,
      account_id: '111122223333',
      resource_id: resourceId,
      service: 'ecs',
      metric_dimensions_json: JSON.stringify(metricDimensions),
      features_json: features ? JSON.stringify(features) : null,
    });

    const namesOf = (planned: ReturnType<typeof planQueries>) =>
      new Set(planned.map((p) => p.metricName));

    it('gives a cluster row the cluster-keyed metrics and a service row the service-keyed ones', () => {
      // The whole point of exact dimension-set matching: `AWS/ECS`
      // CPUUtilization exists at both levels and they are different numbers.
      const cluster = planQueries([ecs('prod', { ClusterName: 'prod' })], NOW - 900_000, NOW);
      for (const p of cluster) expect(p.dimensions).toEqual({ ClusterName: 'prod' });
      expect(namesOf(cluster)).toContain('CPUReservation');
      // Service-only metrics must not be requested for a cluster row.
      expect(namesOf(cluster)).not.toContain('LiveTaskCount');

      const service = planQueries(
        [ecs('prod/api', { ClusterName: 'prod', ServiceName: 'api' })],
        NOW - 900_000,
        NOW,
      );
      for (const p of service) {
        expect(p.dimensions).toEqual({ ClusterName: 'prod', ServiceName: 'api' });
      }
      expect(namesOf(service)).toContain('LiveTaskCount');
      // Cluster-only metrics must not be requested for a service row.
      expect(namesOf(service)).not.toContain('CPUReservation');
    });

    it('never requests a gated metric for a resource without the feature', () => {
      // Skipped, not merely empty: `GetMetricData` bills per metric requested,
      // so asking for a namespace the account does not publish is spend with no
      // possible return.
      const off = planQueries(
        [
          ecs(
            'prod/api',
            { ClusterName: 'prod', ServiceName: 'api' },
            { containerInsights: false },
          ),
        ],
        NOW - 900_000,
        NOW,
      );
      expect(off.every((p) => p.namespace === 'AWS/ECS')).toBe(true);
      expect(namesOf(off)).not.toContain('RunningTaskCount');
    });

    it('treats an unrecorded feature as off', () => {
      // Fail closed. Guessing towards "on" costs a billed request every tick,
      // forever, for a series that does not exist.
      const unknown = planQueries(
        [ecs('prod/api', { ClusterName: 'prod', ServiceName: 'api' })],
        NOW - 900_000,
        NOW,
      );
      expect(unknown.every((p) => p.namespace === 'AWS/ECS')).toBe(true);
    });

    it('requests the gated metrics once the feature is recorded as on', () => {
      const on = planQueries(
        [ecs('prod/api', { ClusterName: 'prod', ServiceName: 'api' }, { containerInsights: true })],
        NOW - 900_000,
        NOW,
      );
      expect(namesOf(on)).toContain('RunningTaskCount');
      expect(namesOf(on)).toContain('RestartCount');
      // The free metrics are still there — the gate adds, it does not replace.
      expect(namesOf(on)).toContain('CPUUtilization');
    });

    it('falls back to the resource id for a row written before the dimension column', () => {
      // Every EC2 row on an install that predates the column has a NULL here,
      // and it must keep collecting exactly what it collected yesterday until
      // the next hourly sweep fills it in.
      const legacy: CollectableResource = {
        resource_key: 'k-i-1',
        account_id: '111122223333',
        resource_id: 'i-1',
        service: 'ec2',
      };
      const planned = planQueries([legacy], NOW - 900_000, NOW);
      expect(planned).toHaveLength(EC2_PACK_SIZE);
      expect(planned[0].dimensions).toEqual({ InstanceId: 'i-1' });
    });

    it('collects nothing for a multi-dimension service with no recorded dimensions', () => {
      // The fallback is only safe where a service's whole pack agrees on one
      // dimension. ECS does not: binding `prod/api` to `ClusterName` because it
      // happens to be a single-dimension metric would query a cluster that does
      // not exist and be billed for it. Better to collect nothing until the
      // next sweep records the real map.
      const legacy: CollectableResource = {
        resource_key: 'k-api',
        account_id: '111122223333',
        resource_id: 'prod/api',
        service: 'ecs',
      };
      expect(planQueries([legacy], NOW - 900_000, NOW)).toEqual([]);
    });

    it('refuses a metric whose pinned dimension value does not match the resource', () => {
      // The S3 case the pin exists for: `NumberOfObjects` is published at
      // `StorageType=AllStorageTypes` and nowhere else, while `BucketSizeBytes`
      // is published at every real storage class. Both are keyed on the same
      // dimension *names*, so without the value check every storage-class row
      // would carry a permanently empty, permanently billed object count.
      const bucketRow = (storageType: string): CollectableResource => ({
        resource_key: `k-logs-${storageType}`,
        account_id: '111122223333',
        resource_id: `logs@${storageType}`,
        service: 's3',
        metric_dimensions_json: JSON.stringify({ BucketName: 'logs', StorageType: storageType }),
      });
      // A day boundary, because the free storage metrics are due once a day.
      const dayStart = Math.ceil(NOW / 86_400_000) * 86_400_000;

      const storageClass = planQueries([bucketRow('StandardStorage')], dayStart - 1, dayStart);
      expect(namesOf(storageClass)).toEqual(new Set(['BucketSizeBytes']));

      const allTypes = planQueries([bucketRow('AllStorageTypes')], dayStart - 1, dayStart);
      expect(namesOf(allTypes)).toContain('NumberOfObjects');
    });

    it('ignores an unparseable dimension column rather than failing the tick', () => {
      const broken: CollectableResource = {
        resource_key: 'k-i-1',
        account_id: '111122223333',
        resource_id: 'i-1',
        service: 'ec2',
        metric_dimensions_json: '{not json',
      };
      const planned = planQueries([broken], NOW - 900_000, NOW);
      expect(planned).toHaveLength(EC2_PACK_SIZE);
      expect(planned[0].dimensions).toEqual({ InstanceId: 'i-1' });
    });
  });
});

describe('groupQueriesByPeriod', () => {
  it('buckets by period so each request can be aligned to the period it carries', () => {
    const planned = planQueries(
      [{ resource_key: 'k', account_id: 'a', resource_id: 'i-1', service: 'ec2' }],
      NOW - 900_000,
      NOW,
    );
    const groups = groupQueriesByPeriod(planned);
    expect([...groups.keys()].sort((a, b) => a - b)).toEqual([60, 300]);
    expect([...groups.values()].flat()).toHaveLength(EC2_PACK_SIZE);
  });
});

describe('buildMetricDataQueries', () => {
  const plan: PlannedQuery = {
    resourceKey: 'k',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-1' },
    stat: 'Average',
    periodSeconds: 300,
  };

  it('emits ids CloudWatch accepts, unique within the request', () => {
    const { queries, byId } = buildMetricDataQueries([plan, { ...plan, metricName: 'NetworkIn' }]);
    const ids = queries.map((q) => q.Id ?? '');
    expect(ids).toEqual(['m0', 'm1']);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-zA-Z0-9_]*$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(byId.get('m1')?.metricName).toBe('NetworkIn');
  });

  it('carries namespace, dimensions, stat and period onto the wire structure', () => {
    const { queries } = buildMetricDataQueries([plan]);
    expect(queries[0].MetricStat).toEqual({
      Metric: {
        Namespace: 'AWS/EC2',
        MetricName: 'CPUUtilization',
        Dimensions: [{ Name: 'InstanceId', Value: 'i-1' }],
      },
      Period: 300,
      Stat: 'Average',
    });
  });
});

describe('pointsFromResult', () => {
  const plan: PlannedQuery = {
    resourceKey: 'k',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: { InstanceId: 'i-1' },
    stat: 'Average',
    periodSeconds: 300,
  };

  it('zips the parallel timestamp and value arrays', () => {
    const points = pointsFromResult(
      { Timestamps: [new Date(NOW), new Date(NOW + 300_000)], Values: [1, 2] },
      plan,
      'proj',
    );
    expect(points.map((p) => [p.tsMs, p.value])).toEqual([
      [NOW, 1],
      [NOW + 300_000, 2],
    ]);
    expect(points[0].periodSeconds).toBe(300);
    expect(points[0].dimensions).toEqual({ InstanceId: 'i-1' });
  });

  it('truncates to the shorter array rather than pairing a value with the wrong stamp', () => {
    const points = pointsFromResult(
      { Timestamps: [new Date(NOW), new Date(NOW + 300_000)], Values: [1] },
      plan,
      'proj',
    );
    expect(points).toHaveLength(1);
  });

  it('handles an empty result', () => {
    expect(pointsFromResult({ Timestamps: [], Values: [] }, plan, 'proj')).toEqual([]);
  });
});

describe('groupScopesIntoTargets', () => {
  it('shares one target across services on the same account and region', () => {
    const base = { account_id: null, tag_filter_json: null } as const;
    const targets = groupScopesIntoTargets([
      { id: '1', project_id: 'p', profile_name: 'm', region: 'us-east-1', service: 'ec2', ...base },
      { id: '2', project_id: 'p', profile_name: 'm', region: 'us-east-1', service: 'rds', ...base },
      { id: '3', project_id: 'p', profile_name: 'm', region: 'eu-west-1', service: 'ec2', ...base },
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[0].scopes).toHaveLength(2);
    expect(targets[1].region).toBe('eu-west-1');
  });

  it('keeps profiles separate when a delimiter join would have merged them', () => {
    // "a" + "b c" and "a b" + "c" collapse under any single-character join.
    // Merging them would poll one profile's scopes with the other's credentials.
    const base = { account_id: null, tag_filter_json: null, region: 'us-east-1', service: 'ec2' };
    const targets = groupScopesIntoTargets([
      { id: '1', project_id: 'a', profile_name: 'b c', ...base },
      { id: '2', project_id: 'a b', profile_name: 'c', ...base },
    ]);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.profileName)).toEqual(['b c', 'c']);
  });
});

describe('INFRA_COLLECT_CRON', () => {
  it('is a 5-minute schedule', () => {
    expect(estimateIntervalSeconds(INFRA_COLLECT_CRON)).toBe(300);
  });
});

// ─── Collection ─────────────────────────────────────────────────────────────

describe('runInfraMetricCollection', () => {
  function collect(
    client: CloudWatchMetricDataClient,
    extra: Partial<Parameters<typeof runInfraMetricCollection>[0]> = {},
  ) {
    const enqueued: InfraMetricPointInput[] = [];
    return {
      enqueued,
      result: runInfraMetricCollection({
        nowMs: NOW,
        cloudWatchClientFactory: () => client,
        enqueue: (points) => {
          enqueued.push(...points);
          return { enqueued: points.length, dropped: 0 };
        },
        sleep: async () => {},
        random: () => 0,
        ...extra,
      }),
    };
  }

  it('is a no-op with no scope rows and writes no audit row', async () => {
    const client = stubCloudWatch([]);
    const { result } = collect(client);
    const r = await result;
    expect(r).toMatchObject({ targets: 0, queriesIssued: 0, estimatedCostUsd: 0 });
    expect(client.calls).toHaveLength(0);
    expect(runRows()).toHaveLength(0);
  });

  it('opens no run row for a scope whose inventory is empty', async () => {
    insertScope({ id: 's1' });
    const client = stubCloudWatch([]);
    const r = await collect(client).result;
    expect(r.targets).toBe(1);
    expect(client.calls).toHaveLength(0);
    expect(runRows()).toHaveLength(0);
  });

  it('queries the pack for each in-scope resource and records the run', async () => {
    insertScope({ id: 's1' });
    const key = insertResource('i-1');
    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        return echoAll(command) as GetMetricDataCommandOutput;
      },
    };

    const { result, enqueued } = collect(client);
    const r = await result;

    // One request per period group (60s status checks, 300s CPU/network).
    expect(client.calls).toHaveLength(2);
    expect(r.metricsRequested).toBe(EC2_PACK_SIZE);
    expect(r.datapointsReturned).toBe(EC2_PACK_SIZE);
    expect(r.pointsEnqueued).toBe(EC2_PACK_SIZE);
    expect(enqueued.every((p) => p.resourceKey === key && p.projectId === 'proj')).toBe(true);

    const [run] = runRows();
    expect(run).toMatchObject({
      project_id: 'proj',
      account_id: '111122223333',
      region: 'us-east-1',
      status: 'ok',
      queries_issued: 2,
      metrics_requested: EC2_PACK_SIZE,
      throttles: 0,
      errors: 0,
    });
    expect(run.estimated_cost_usd).toBeCloseTo((EC2_PACK_SIZE / 1000) * 0.01, 10);
  });

  it('aligns StartTime and EndTime to the period each request carries', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        return echoAll(command) as GetMetricDataCommandOutput;
      },
    };
    await collect(client).result;

    for (const call of client.calls) {
      const period = call.input.MetricDataQueries?.[0]?.MetricStat?.Period ?? 0;
      const step = period * 1000;
      expect(call.input.StartTime?.getTime() ?? 0).toBe(
        Math.floor((call.input.StartTime?.getTime() ?? 0) / step) * step,
      );
      expect((call.input.EndTime?.getTime() ?? 0) % step).toBe(0);
      // Aligned to the period is also aligned to the hour for 60/300/3600.
      expect(3600 % period).toBe(0);
      // Every query in a request shares the period the window was aligned to.
      for (const q of call.input.MetricDataQueries ?? []) {
        expect(q.MetricStat?.Period).toBe(period);
      }
    }
  });

  it('batches to the 500-query ceiling across many resources', async () => {
    insertScope({ id: 's1' });
    // Queries are grouped by resolved period, and each group is split at the
    // 500-query ceiling. 200 instances puts every group well past it, which is
    // the point — the expected call count is derived from the pack so adding a
    // metric changes the arithmetic rather than the assertion.
    for (let i = 0; i < 200; i += 1) insertResource(`i-${String(i).padStart(4, '0')}`);
    const perPeriod = new Map<number, number>();
    for (const spec of getServiceMetricPack('ec2')) {
      perPeriod.set(spec.minPeriodSeconds, (perPeriod.get(spec.minPeriodSeconds) ?? 0) + 1);
    }
    const expectedCalls = [...perPeriod.values()].reduce(
      (n, count) => n + Math.ceil((count * 200) / MAX_QUERIES_PER_REQUEST),
      0,
    );

    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        return { $metadata: {}, MetricDataResults: [] };
      },
    };
    const r = await collect(client).result;

    for (const call of client.calls) {
      expect((call.input.MetricDataQueries ?? []).length).toBeLessThanOrEqual(
        MAX_QUERIES_PER_REQUEST,
      );
    }
    expect(client.calls).toHaveLength(expectedCalls);
    expect(r.metricsRequested).toBe(200 * EC2_PACK_SIZE);
  });

  it('follows NextToken, re-sending the same query set for each page', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        const page = echoAll(command) as GetMetricDataCommandOutput;
        // Paginate the first request only.
        if (this.calls.length === 1) return { ...page, NextToken: 'page-2' };
        return page;
      },
    };
    const { result, enqueued } = collect(client);
    const r = await result;

    expect(client.calls).toHaveLength(3);
    expect(client.calls[1].input.NextToken).toBe('page-2');
    expect(client.calls[1].input.MetricDataQueries).toEqual(
      client.calls[0].input.MetricDataQueries,
    );
    // The follow-up page is not a continuation token itself.
    expect(client.calls[2].input.NextToken).toBeUndefined();
    // Each page is billed for the full query set it re-sends, so the paginated
    // batch is counted twice on top of the one pass over the whole pack.
    expect(r.queriesIssued).toBe(3);
    const resentBatchSize = (client.calls[0].input.MetricDataQueries ?? []).length;
    expect(r.metricsRequested).toBe(EC2_PACK_SIZE + resentBatchSize);
    expect(enqueued.length).toBe(r.datapointsReturned);
  });

  it('stops at the pagination cap and flags the window as incomplete', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        return { ...echoAll(command), NextToken: 'forever' } as GetMetricDataCommandOutput;
      },
    };
    const r = await collect(client).result;

    // Two period groups, each capped.
    expect(r.queriesIssued).toBe(2 * MAX_PAGES_PER_BATCH);
    expect(r.errors).toBe(2);
    expect(runRows()[0].status).toBe('partial');
  });

  it('retries a throttle with backoff and records the throttle count on the run row', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    const sleeps: number[] = [];
    let thrown = 0;
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        if (thrown < 2) {
          thrown += 1;
          throw throttleError();
        }
        return echoAll(command) as GetMetricDataCommandOutput;
      },
    };

    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (points) => ({ enqueued: points.length, dropped: 0 }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 1,
    });

    expect(r.throttles).toBe(2);
    expect(r.failed).toBe(0);
    // Exponential: one base interval, then two.
    expect(sleeps).toEqual([THROTTLE_BACKOFF_BASE_MS, THROTTLE_BACKOFF_BASE_MS * 2]);
    expect(runRows()[0].throttles).toBe(2);
  });

  it('gives up after the retry budget and still records what the attempt cost', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client: CloudWatchMetricDataClient = {
      async send() {
        throw throttleError();
      },
    };
    const r = await collect(client, { maxThrottleRetries: 2 }).result;

    expect(r.failed).toBe(1);
    expect(r.throttles).toBe(2);
    const [run] = runRows();
    expect(run.status).toBe('failed');
    expect(run.throttles).toBe(2);
    expect(run.error_message).toMatch(/Rate exceeded/);
  });

  it('does not retry a non-throttle error', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const client: CloudWatchMetricDataClient = {
      async send() {
        calls += 1;
        throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
      },
    };
    const r = await collect(client).result;

    expect(calls).toBe(1);
    expect(r.throttles).toBe(0);
    expect(r.failed).toBe(1);
  });

  it('steps over a failing target so another region still collects', async () => {
    insertScope({ id: 'bad', region: 'eu-west-1' });
    insertScope({ id: 'good', region: 'us-east-1' });
    insertResource('i-eu', { region: 'eu-west-1' });
    insertResource('i-us', { region: 'us-east-1' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result, enqueued } = collect({} as CloudWatchMetricDataClient, {
      cloudWatchClientFactory: (target) =>
        target.region === 'eu-west-1'
          ? {
              async send() {
                throw new Error('expired role');
              },
            }
          : {
              async send(command) {
                return echoAll(command) as GetMetricDataCommandOutput;
              },
            },
    });
    const r = await result;

    expect(r.targets).toBe(2);
    expect(r.collected).toBe(1);
    expect(r.failed).toBe(1);
    expect(enqueued).toHaveLength(EC2_PACK_SIZE);
    expect(
      runRows()
        .map((row) => row.status)
        .sort(),
    ).toEqual(['failed', 'ok']);
  });

  it('skips terminated and long-unseen resources so a gone instance stops costing money', async () => {
    insertScope({ id: 's1' });
    insertResource('i-live');
    insertResource('i-dead', { state: 'terminated' });
    insertResource('i-stale', { lastSeen: NOW - MAX_RESOURCE_STALENESS_MS - 1 });

    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        return { $metadata: {}, MetricDataResults: [] };
      },
    };
    const r = await collect(client).result;

    expect(r.metricsRequested).toBe(EC2_PACK_SIZE);
    expect(queriedInstanceIds(client.calls)).toEqual(new Set(['i-live']));
  });

  it("honours the scope's tag filter instead of collecting the whole region", async () => {
    // Regression: inventory rows are never deleted, so a narrowed filter leaves
    // out-of-scope rows behind. Without a client-side re-check the collector
    // keeps polling and billing for them until they age out a day later.
    insertScope({ id: 's1', tag_filter_json: '{"Env":["prod"]}' });
    insertResource('i-prod', { tags: { Env: 'prod', Team: 'platform' } });
    insertResource('i-dev', { tags: { Env: 'dev' } });
    insertResource('i-untagged');

    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        return { $metadata: {}, MetricDataResults: [] };
      },
    };
    const r = await collect(client).result;

    expect(queriedInstanceIds(client.calls)).toEqual(new Set(['i-prod']));
    expect(r.metricsRequested).toBe(EC2_PACK_SIZE);
    expect(r.errors).toBe(0);
  });

  it('applies the same wildcard semantics the describe call used', async () => {
    insertScope({ id: 's1', tag_filter_json: '{"Name":"web-*"}' });
    insertResource('i-web', { tags: { Name: 'web-01' } });
    insertResource('i-db', { tags: { Name: 'db-01' } });

    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        return { $metadata: {}, MetricDataResults: [] };
      },
    };
    await collect(client).result;

    expect(queriedInstanceIds(client.calls)).toEqual(new Set(['i-web']));
  });

  it('keeps two profiles on one region from collecting each other resources', async () => {
    // Same project/region/service, different profiles and filters. Each target
    // must see only its own slice, not the union.
    insertScope({ id: 'a', profile_name: 'prod-role', tag_filter_json: '{"Env":"prod"}' });
    insertScope({ id: 'b', profile_name: 'dev-role', tag_filter_json: '{"Env":"dev"}' });
    insertResource('i-prod', { tags: { Env: 'prod' } });
    insertResource('i-dev', { tags: { Env: 'dev' } });

    const seen = new Map<string, GetMetricDataCommand[]>();
    const r = await collect({} as CloudWatchMetricDataClient, {
      cloudWatchClientFactory: (target) => {
        const calls: GetMetricDataCommand[] = [];
        seen.set(target.profileName, calls);
        return {
          async send(command) {
            calls.push(command);
            return { $metadata: {}, MetricDataResults: [] };
          },
        };
      },
    }).result;

    expect(r.targets).toBe(2);
    expect(queriedInstanceIds(seen.get('prod-role') ?? [])).toEqual(new Set(['i-prod']));
    expect(queriedInstanceIds(seen.get('dev-role') ?? [])).toEqual(new Set(['i-dev']));
  });

  it('skips a scope with an unreadable tag filter rather than widening it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    insertScope({ id: 's1', tag_filter_json: '{not json' });
    insertResource('i-1');

    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        return { $metadata: {}, MetricDataResults: [] };
      },
    };
    const r = await collect(client).result;

    // Nothing collected, and the failure is counted even though no run row
    // opened (there was nothing left to plan).
    expect(client.calls).toHaveLength(0);
    expect(r.errors).toBe(1);
    expect(runRows()).toHaveLength(0);
  });

  it('lets other regions collect while a broken-filter scope is skipped', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    insertScope({ id: 'ok', region: 'us-east-1' });
    insertScope({ id: 'broken', region: 'eu-west-1', tag_filter_json: '[]' });
    insertResource('i-us', { region: 'us-east-1' });
    insertResource('i-eu', { region: 'eu-west-1' });

    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        return { $metadata: {}, MetricDataResults: [] };
      },
    };
    const r = await collect(client).result;

    expect(queriedInstanceIds(client.calls)).toEqual(new Set(['i-us']));
    // Counted, but the broken scope is not a thrown target — it simply has
    // nothing to plan, so no run row opens for it.
    expect(r.errors).toBe(1);
    expect(r.failed).toBe(0);
    expect(runRows()).toHaveLength(1);
    expect(runRows()[0].region).toBe('us-east-1');
  });

  it('ignores a disabled scope', async () => {
    insertScope({ id: 's1', enabled: 0 } as Partial<InfraScopeRow> & { id: string });
    insertResource('i-1');
    const client = stubCloudWatch([]);
    const r = await collect(client).result;
    expect(r.targets).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it('counts a per-metric Forbidden as an error rather than storing a phantom series', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        const queries = command.input.MetricDataQueries ?? [];
        return {
          MetricDataResults: queries.map((q, i) => ({
            Id: q.Id,
            StatusCode: i === 0 ? 'Forbidden' : 'Complete',
            Timestamps: i === 0 ? [] : [new Date(NOW)],
            Values: i === 0 ? [] : [7],
          })),
        } as GetMetricDataCommandOutput;
      },
    };
    const { result, enqueued } = collect(client);
    const r = await result;

    expect(r.errors).toBe(2); // one per period group
    expect(enqueued).toHaveLength(EC2_PACK_SIZE - 2);
    expect(runRows()[0].status).toBe('partial');
  });

  it('treats PartialData mid-pagination as normal, not as an error', async () => {
    // AWS: "PartialData means that an incomplete set of data points were
    // returned. You can use the NextToken value that was returned and repeat
    // your request to get more data points." Flagging it on sight would mark
    // every multi-page tick partial.
    insertScope({ id: 's1' });
    insertResource('i-1');
    const client: CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } = {
      calls: [],
      async send(command) {
        this.calls.push(command);
        const queries = command.input.MetricDataQueries ?? [];
        const firstPage = command.input.NextToken === undefined;
        return {
          $metadata: {},
          MetricDataResults: queries.map((q) => ({
            Id: q.Id,
            StatusCode: firstPage ? 'PartialData' : 'Complete',
            Timestamps: [new Date(NOW)],
            Values: [1],
          })),
          ...(firstPage ? { NextToken: 'more' } : {}),
        };
      },
    };
    const r = await collect(client).result;

    expect(r.errors).toBe(0);
    expect(runRows()[0].status).toBe('ok');
    // Both pages of both period groups were stored.
    expect(r.datapointsReturned).toBe(EC2_PACK_SIZE * 2);
  });

  it('counts PartialData still unresolved when pagination runs out', async () => {
    // No NextToken left to follow, so the stored window really has holes.
    insertScope({ id: 's1' });
    insertResource('i-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        const queries = command.input.MetricDataQueries ?? [];
        return {
          $metadata: {},
          MetricDataResults: queries.map((q, i) => ({
            Id: q.Id,
            StatusCode: i === 0 ? 'PartialData' : 'Complete',
            Timestamps: [new Date(NOW)],
            Values: [1],
          })),
        };
      },
    };
    const { result, enqueued } = collect(client);
    const r = await result;

    // One unresolved series per period group.
    expect(r.errors).toBe(2);
    expect(runRows()[0].status).toBe('partial');
    // The partial datapoints are still real and are still stored.
    expect(enqueued).toHaveLength(EC2_PACK_SIZE);
  });

  it('does not double-count PartialData that the page cap already explains', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        const queries = command.input.MetricDataQueries ?? [];
        return {
          $metadata: {},
          MetricDataResults: queries.map((q) => ({
            Id: q.Id,
            StatusCode: 'PartialData',
            Timestamps: [new Date(NOW)],
            Values: [1],
          })),
          NextToken: 'forever',
        };
      },
    };
    const r = await collect(client).result;

    // One error per capped batch, not one per partial series on top.
    expect(r.errors).toBe(2);
  });

  it('reports points the write queue refused for backpressure', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        return echoAll(command) as GetMetricDataCommandOutput;
      },
    };
    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (points) => ({ enqueued: 0, dropped: points.length }),
      sleep: async () => {},
    });

    expect(r.pointsEnqueued).toBe(0);
    expect(r.pointsDropped).toBe(EC2_PACK_SIZE);
    expect(runRows()[0].status).toBe('partial');
  });
});

// ─── Cost guardrails (decision INFRA-COST) ──────────────────────────────────

describe('cost ceiling degradation', () => {
  function echoClient(): CloudWatchMetricDataClient & { calls: GetMetricDataCommand[] } {
    const calls: GetMetricDataCommand[] = [];
    return {
      calls,
      async send(command) {
        calls.push(command);
        return echoAll(command) as GetMetricDataCommandOutput;
      },
    };
  }

  function setCeiling(projectId: string, ceiling: number | null): void {
    setInfraCostCeiling(projectId, ceiling, NOW);
  }

  /** A finished run row that spends `costUsd` this month. */
  function spend(projectId: string, costUsd: number, id = `r-${costUsd}`): void {
    startInfraCollectRun({ id, projectId, region: 'us-east-1', startedAt: NOW - 60_000 });
    recordInfraCollectRunProgress(id, { metricsRequested: 1000, estimatedCostUsd: costUsd });
    finishInfraCollectRun(id, { finishedAt: NOW - 59_000, status: 'ok' });
  }

  it('collects normally below the ceiling', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    setCeiling('proj', 10);
    spend('proj', 1);

    const client = echoClient();
    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    expect(r.skipped).toBe(0);
    expect(r.degraded).toEqual({ widened: 0, paused: 0 });
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it('pauses without issuing a single billed request once spend hits twice the ceiling', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    setCeiling('proj', 10);
    spend('proj', 25);

    const runsBefore = runRows().length;
    const client = echoClient();
    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    // The whole point of the pause: no request, therefore no spend.
    expect(client.calls).toHaveLength(0);
    expect(r.skipped).toBe(1);
    expect(r.collected).toBe(0);
    expect(r.metricsRequested).toBe(0);
    expect(r.estimatedCostUsd).toBe(0);
    expect(r.degraded.paused).toBe(1);
    // And no audit row either — a zero-spend row every five minutes would bury
    // the ticks that did spend.
    expect(runRows()).toHaveLength(runsBefore);
  });

  it('keeps collecting but on stretched intervals when merely over the ceiling', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    setCeiling('proj', 10);
    spend('proj', 12);

    const client = echoClient();
    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    expect(r.degraded).toEqual({ widened: 1, paused: 0 });
    expect(r.skipped).toBe(0);
    // Widened multiplies every interval to 20 minutes, so this off-boundary
    // tick is not one of the ticks the metrics are due on.
    expect(client.calls).toHaveLength(0);
    expect(r.metricsRequested).toBe(0);
  });

  it('still collects on a widened tick that lands on the stretched boundary', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    setCeiling('proj', 10);
    spend('proj', 12);

    // 20-minute boundary: 300s tick x the 4x widening multiplier.
    const boundary = Math.ceil(NOW / 1_200_000) * 1_200_000;
    const client = echoClient();
    const r = await runInfraMetricCollection({
      nowMs: boundary,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    expect(r.degraded.widened).toBe(1);
    expect(client.calls.length).toBeGreaterThan(0);
    expect(r.metricsRequested).toBe(EC2_PACK_SIZE);
  });

  it('is uncapped by default, however much has already been spent', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    spend('proj', 5_000);

    const client = echoClient();
    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    expect(r.degraded).toEqual({ widened: 0, paused: 0 });
    expect(client.calls.length).toBeGreaterThan(0);
  });

  it('pauses immediately on a zero ceiling', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    setCeiling('proj', 0);

    const client = echoClient();
    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    expect(client.calls).toHaveLength(0);
    expect(r.degraded.paused).toBe(1);
  });

  it('raises the in-app notice on the transition and not on every tick', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    setCeiling('proj', 10);
    spend('proj', 25);

    const broadcast = vi.fn();
    const opts = {
      nowMs: NOW,
      cloudWatchClientFactory: () => echoClient(),
      enqueue: (p: InfraMetricPointInput[]) => ({ enqueued: p.length, dropped: 0 }),
      broadcast,
    };

    await runInfraMetricCollection(opts);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'infra_cost_degradation',
      projectId: 'proj',
      level: 'paused',
      previousLevel: 'normal',
      monthlyCeilingUsd: 10,
    });
    // Never carries a profile name, account id or anything else Admin-gated
    // — a broadcast fans out to every connected client of the project.
    expect(Object.keys(broadcast.mock.calls[0][0])).not.toContain('profileName');

    // The level has not changed, so the second and third ticks stay quiet.
    await runInfraMetricCollection(opts);
    await runInfraMetricCollection(opts);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('announces the escalation from widened to paused', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');
    setCeiling('proj', 10);
    spend('proj', 12, 'r-first');

    const broadcast = vi.fn();
    const base = {
      cloudWatchClientFactory: () => echoClient(),
      enqueue: (p: InfraMetricPointInput[]) => ({ enqueued: p.length, dropped: 0 }),
      broadcast,
    };
    await runInfraMetricCollection({ ...base, nowMs: NOW });
    expect(broadcast.mock.calls[0][0]).toMatchObject({ level: 'widened' });

    spend('proj', 20, 'r-second');
    await runInfraMetricCollection({ ...base, nowMs: NOW + 300_000 });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0]).toMatchObject({
      level: 'paused',
      previousLevel: 'widened',
    });
  });

  it('collects normally when the ceiling bookkeeping itself throws', async () => {
    // A guardrail must not become a new way for the collector to stop working.
    insertScope({ id: 's1' });
    insertResource('i-1');
    const client = echoClient();
    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
      resolveDegradation: () => {
        throw new Error('boom');
      },
    });
    expect(r.failed).toBe(0);
  });

  it('resolves one level per project, not one per region', async () => {
    insertScope({ id: 's1', region: 'us-east-1' });
    insertScope({ id: 's2', region: 'eu-west-1' });
    insertResource('i-1', { region: 'us-east-1' });
    insertResource('i-2', { region: 'eu-west-1' });
    setCeiling('proj', 10);
    spend('proj', 25);

    const resolveDegradation = vi.fn(() => 'paused' as const);
    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => echoClient(),
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
      resolveDegradation,
    });

    expect(r.targets).toBe(2);
    expect(r.skipped).toBe(2);
    // Two targets, one project, one spend lookup.
    expect(resolveDegradation).toHaveBeenCalledTimes(1);
    // And the *project* is counted once, not once per region it happens to span.
    expect(r.degraded.paused).toBe(1);
  });

  it('prices the run row at the target region', async () => {
    insertScope({ id: 's1', region: 'sa-east-1' });
    insertResource('i-1', { region: 'sa-east-1' });

    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => echoClient(),
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    // São Paulo is $0.014 per 1,000, not the $0.01 list rate. A ceiling fed by
    // a us-east-1 estimate would under-report this by 40%.
    const expected = (EC2_PACK_SIZE / 1000) * 0.014;
    expect(r.estimatedCostUsd).toBeCloseTo(expected, 12);
    expect(runRows()[0].estimated_cost_usd).toBeCloseTo(expected, 12);
  });
});

describe('per-service poll interval flooring', () => {
  it('never asks for a metric more often than the collector ticks', () => {
    // EC2's service tier is 60s, but a 300s tick is the real floor.
    const planned = planQueries(
      [{ resource_key: 'k', account_id: 'a', resource_id: 'i-1', service: 'ec2' }],
      NOW - 900_000,
      NOW,
      { tickIntervalMs: 300_000 },
    );
    expect(planned).toHaveLength(EC2_PACK_SIZE);
  });

  it('drops metrics that are not due when the tick is finer than their emission rate', () => {
    // A 60-second tick: only the metrics EC2 publishes every minute are due.
    // Everything on the 5-minute basic-monitoring rate waits for the 5-minute
    // boundary, whatever the tick cadence asks for.
    const offBoundary = Math.floor(NOW / 60_000) * 60_000 + 60_000;
    const planned = planQueries(
      [{ resource_key: 'k', account_id: 'a', resource_id: 'i-1', service: 'ec2' }],
      offBoundary - 900_000,
      offBoundary,
      { tickIntervalMs: 60_000 },
    );
    const names = planned.map((p) => p.metricName).sort();
    const minutely = getServiceMetricPack('ec2')
      .filter((s) => s.minPeriodSeconds === 60)
      .map((s) => s.metricName)
      .sort();
    expect(minutely.length).toBeGreaterThan(0);
    expect(names).toEqual(minutely);
  });

  it('includes the 5-minute metrics again on a 5-minute boundary', () => {
    const boundary = Math.ceil(NOW / 300_000) * 300_000;
    const planned = planQueries(
      [{ resource_key: 'k', account_id: 'a', resource_id: 'i-1', service: 'ec2' }],
      boundary - 900_000,
      boundary,
      { tickIntervalMs: 60_000 },
    );
    expect(planned).toHaveLength(EC2_PACK_SIZE);
  });

  it('agrees with the tick cadence the cost projection assumes', () => {
    // The projection declares its own copy of this number so the REST layer
    // need not import the collector. They must not drift.
    expect(COLLECTOR_TICK_INTERVAL_S).toBe(estimateIntervalSeconds(INFRA_COLLECT_CRON));
  });
});

describe('incremental spend accounting', () => {
  /**
   * Metrics per request for one in-scope EC2 instance.
   *
   * The pack does not go out as one request: `groupQueriesByPeriod` splits it
   * by effective period, so the 300s metrics (CPU + the two Network sums) and
   * the 60s status checks are separate requests. Billing is per metric
   * requested *per request*, so the group size — not the pack size — is what a
   * single request costs.
   */
  const PERIOD_GROUPS = (() => {
    const sizes = new Map<number, number>();
    for (const s of getServiceMetricPack('ec2')) {
      const period = Math.max(60, s.minPeriodSeconds);
      sizes.set(period, (sizes.get(period) ?? 0) + 1);
    }
    return [...sizes.values()];
  })();
  const FIRST_GROUP = PERIOD_GROUPS[0];
  const USD_PER_METRIC = 0.01 / 1000;

  /** The open run row's cost as it stands right now, mid-tick. */
  function liveCost(): number {
    const row = getInfraDb()
      .prepare('SELECT estimated_cost_usd AS c FROM infra_collect_runs ORDER BY rowid DESC LIMIT 1')
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  it('persists each billed request before issuing the next one', async () => {
    // Regression: spend used to be written only by finishInfraCollectRun, so a
    // hard kill mid-tick (SIGKILL / OOM / host reboot) skipped the `finally`
    // entirely and left the row claiming zero cost for requests AWS had already
    // charged for. Month-to-date spend then read as zero, the ceiling never
    // tripped, and every restart of a crash loop issued another billed round.
    insertScope({ id: 's1' });
    insertResource('i-1');

    const costAtRequest: number[] = [];
    let page = 0;
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        // What the audit trail durably knows at the instant this request is
        // about to be billed.
        costAtRequest.push(liveCost());
        page += 1;
        return {
          ...echoAll(command),
          // One NextToken, so the first group spans two billed requests.
          ...(page === 1 ? { NextToken: 'page-2' } : {}),
        } as GetMetricDataCommandOutput;
      },
    };

    await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    // Nothing billed yet when the first request goes out.
    expect(costAtRequest[0]).toBe(0);
    // Every later request already sees the cost of everything before it — this
    // is the assertion that fails against finishing-time-only accounting.
    expect(costAtRequest.length).toBeGreaterThan(1);
    for (let i = 1; i < costAtRequest.length; i += 1) {
      expect(costAtRequest[i]).toBeGreaterThan(costAtRequest[i - 1]);
    }
    // Two pages of the first period group are billed before the second group.
    expect(costAtRequest[1]).toBeCloseTo(FIRST_GROUP * USD_PER_METRIC, 12);
    expect(costAtRequest[2]).toBeCloseTo(2 * FIRST_GROUP * USD_PER_METRIC, 12);
  });

  it('has the ceiling already seeing an unfinished tick mid-flight', async () => {
    // The kill cannot be simulated by editing the row afterwards — that would
    // just assert on whatever the finish wrote. The honest question is what a
    // concurrent reader sees while the tick is still open, because that is
    // precisely the state a SIGKILL freezes forever.
    insertScope({ id: 's1' });
    insertResource('i-1');
    setInfraCostCeiling('proj', 0.00001, NOW);

    let midFlight: { spendUsd: number; metrics: number; level: string } | undefined;
    let page = 0;
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        page += 1;
        if (page === 2) {
          const spend = getInfraSpendToDate('proj', NOW);
          midFlight = {
            spendUsd: spend.monthToDateUsd,
            metrics: spend.metricsRequested,
            level: resolveProjectDegradation('proj', NOW).level,
          };
        }
        return echoAll(command) as GetMetricDataCommandOutput;
      },
    };

    await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    expect(midFlight).toBeDefined();
    // The row is still open (no finished_at) and its spend is already durable.
    expect(midFlight?.spendUsd).toBeCloseTo(FIRST_GROUP * USD_PER_METRIC, 12);
    expect(midFlight?.metrics).toBe(FIRST_GROUP);
    // So the ceiling can act on money spent by a tick still in progress —
    // which is what stops a crash loop from re-billing forever.
    expect(midFlight?.level).toBe('paused');
  });

  it('does not double-count when the tick also closes normally', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');

    const r = await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => ({
        async send(command) {
          return echoAll(command) as GetMetricDataCommandOutput;
        },
      }),
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    const row = runRows()[0];
    // One request per period group, and the pack billed exactly once overall.
    expect(row.queries_issued).toBe(PERIOD_GROUPS.length);
    expect(row.metrics_requested).toBe(EC2_PACK_SIZE);
    expect(row.estimated_cost_usd).toBeCloseTo(r.estimatedCostUsd, 12);
    expect(row.estimated_cost_usd).toBeCloseTo(EC2_PACK_SIZE * USD_PER_METRIC, 12);
    expect(row.status).toBe('ok');
  });

  it('keeps the spend of a target that threw partway through', async () => {
    insertScope({ id: 's1' });
    insertResource('i-1');

    let call = 0;
    const client: CloudWatchMetricDataClient = {
      async send(command) {
        call += 1;
        if (call === 2) throw new Error('AccessDenied');
        return { ...echoAll(command), NextToken: 'page-2' } as GetMetricDataCommandOutput;
      },
    };

    await runInfraMetricCollection({
      nowMs: NOW,
      cloudWatchClientFactory: () => client,
      enqueue: (p) => ({ enqueued: p.length, dropped: 0 }),
    });

    const row = runRows()[0];
    // The first page was billed and must still be accounted for, even though
    // the target ultimately failed.
    expect(row.metrics_requested).toBe(FIRST_GROUP);
    expect(row.estimated_cost_usd).toBeCloseTo(FIRST_GROUP * USD_PER_METRIC, 12);
    expect(row.status).toBe('failed');
    expect(row.errors).toBe(1);
  });
});
