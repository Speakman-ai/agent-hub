/**
 * The Cost Explorer poller: the three guards that must hold before a request is
 * signed, the per-page spend accounting, and the pagination cap.
 *
 * Almost every test here is about **not** spending money. `GetCostAndUsage` is
 * billed $0.01 per paginated request with no free tier at all, so the failure
 * modes worth pinning are the ones where a request goes out that should not
 * have: a project that never opted in, a second sweep inside the cadence floor,
 * a project the ceiling already paused, and an unbounded `NextPageToken` loop.
 *
 * The AWS client is injected rather than mocked at the module boundary, which is
 * the same seam `inventory-sync.ts` uses. No real SDK client is ever
 * constructed, so no credential resolution and no network call can happen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { GetCostAndUsageCommandOutput } from '@aws-sdk/client-cost-explorer';
import { initInfraDb, closeInfraDb } from './infra-db.js';
import {
  getInfraCostConfig,
  setInfraCostCeiling,
  setInfraCostExplorerEnabled,
  recordCostExplorerSyncStart,
  listInfraCollectRuns,
  getInfraSpendToDate,
} from './infra-cost-store.js';
import { queryInfraSpendTrend } from './cost-explorer-store.js';
import {
  runInfraCostExplorerSync,
  parseCostExplorerPage,
  costExplorerWindow,
  isCostExplorerSyncDue,
  utcDayString,
  COST_EXPLORER_LOOKBACK_DAYS,
  COST_EXPLORER_METRIC,
  INFRA_COST_EXPLORER_CRON,
  MAX_COST_EXPLORER_PAGES,
  type CostExplorerClientLike,
} from './cost-explorer-sync.js';
import {
  COST_EXPLORER_USD_PER_REQUEST,
  MIN_COST_EXPLORER_SYNC_INTERVAL_MS,
  COST_EXPLORER_SYNC_INTERVAL_S,
  estimateCostExplorerCostUsd,
} from './infra-cost.js';

vi.mock('./aws-clients.js', () => ({
  // The sync resolves a profile name and, when no client is injected, would
  // build one. Both are stubbed so a test can never reach real credentials.
  requireProjectMonitoringProfile: vi.fn(() => 'monitoring'),
  getProjectCostExplorerClient: vi.fn(() => {
    throw new Error('a test reached the real Cost Explorer client factory');
  }),
}));

let dir: string;
const PROJECT = 'proj-a';
const NOW = Date.UTC(2026, 7, 7, 9, 0, 0);

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-ce-sync-'));
  initInfraDb(dir);
  const clients = await import('./aws-clients.js');
  vi.mocked(clients.requireProjectMonitoringProfile).mockReturnValue('monitoring');
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** One CE page, in the shape the SDK hands back. */
function page(
  groups: Array<{ day: string; service: string; account: string; amount: string }>,
  over: { nextPageToken?: string; estimated?: boolean } = {},
): GetCostAndUsageCommandOutput {
  const byDay = new Map<string, typeof groups>();
  for (const g of groups) {
    const list = byDay.get(g.day) ?? [];
    list.push(g);
    byDay.set(g.day, list);
  }
  return {
    $metadata: {},
    GroupDefinitions: [
      { Type: 'DIMENSION', Key: 'SERVICE' },
      { Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' },
    ],
    ResultsByTime: [...byDay.entries()].map(([day, list]) => ({
      TimePeriod: { Start: day, End: day },
      Estimated: over.estimated ?? false,
      Total: {},
      Groups: list.map((g) => ({
        Keys: [g.service, g.account],
        Metrics: { [COST_EXPLORER_METRIC]: { Amount: g.amount, Unit: 'USD' } },
      })),
    })),
    NextPageToken: over.nextPageToken,
  };
}

/** A client returning the supplied pages in order, recording every input. */
function fakeClient(pages: GetCostAndUsageCommandOutput[]): CostExplorerClientLike & {
  calls: unknown[];
} {
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    send: (command) => {
      calls.push((command as { input: unknown }).input);
      const next = pages[Math.min(i, pages.length - 1)];
      i += 1;
      return Promise.resolve(next);
    },
  };
}

/** A client that must never be called; calling it fails the test loudly. */
function forbiddenClient(): CostExplorerClientLike {
  return {
    send: () => {
      throw new Error('a billed GetCostAndUsage request was issued when it should not have been');
    },
  };
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('utcDayString', () => {
  it('formats in UTC, not the host timezone', () => {
    expect(utcDayString(Date.UTC(2026, 7, 7, 23, 59, 59))).toBe('2026-08-07');
    expect(utcDayString(Date.UTC(2026, 7, 8, 0, 0, 0))).toBe('2026-08-08');
  });
});

describe('costExplorerWindow', () => {
  it('ends tomorrow, so today’s partial spend is inside the exclusive bound', () => {
    // CE's end date is exclusive. An end of today would stop at yesterday and
    // the panel would never show month-to-date spend.
    const window = costExplorerWindow(NOW, 30);
    expect(window.endDay).toBe('2026-08-08');
    expect(window.startDay).toBe('2026-07-09');
  });

  it('defaults to the 30-day lookback the sync fetches', () => {
    expect(costExplorerWindow(NOW)).toEqual(costExplorerWindow(NOW, COST_EXPLORER_LOOKBACK_DAYS));
  });

  it('spans exactly the requested number of days', () => {
    const window = costExplorerWindow(NOW, 7);
    const days = (Date.parse(window.endDay) - Date.parse(window.startDay)) / 86_400_000;
    expect(days).toBe(7);
  });
});

describe('isCostExplorerSyncDue', () => {
  it('allows the first ever sync', () => {
    expect(isCostExplorerSyncDue(null, NOW)).toBe(true);
  });

  it('refuses a second sweep inside the floor', () => {
    expect(isCostExplorerSyncDue(NOW - 1000, NOW)).toBe(false);
    expect(isCostExplorerSyncDue(NOW - MIN_COST_EXPLORER_SYNC_INTERVAL_MS + 1, NOW)).toBe(false);
  });

  it('allows one exactly at the floor', () => {
    expect(isCostExplorerSyncDue(NOW - MIN_COST_EXPLORER_SYNC_INTERVAL_MS, NOW)).toBe(true);
  });

  it('treats a future-dated stamp as just-synced, the direction that cannot overspend', () => {
    expect(isCostExplorerSyncDue(NOW + 60_000, NOW)).toBe(false);
  });

  it('fits at most three syncs into a day at the eight-hour cadence', () => {
    // The property the whole guard exists for: AWS updates billing data at most
    // three times daily, so a fourth charge buys nothing.
    let fires = 0;
    let last: number | null = null;
    for (let t = 0; t < 24 * 60 * 60 * 1000; t += COST_EXPLORER_SYNC_INTERVAL_S * 1000) {
      if (isCostExplorerSyncDue(last, t)) {
        fires += 1;
        last = t;
      }
    }
    expect(fires).toBe(3);
  });
});

describe('parseCostExplorerPage', () => {
  it('maps group keys through the response’s own GroupDefinitions, not the request order', () => {
    // AWS echoes the definitions back precisely so a client does not have to
    // assume. Assuming is how service names and account ids end up swapped.
    const swapped: GetCostAndUsageCommandOutput = {
      $metadata: {},
      GroupDefinitions: [
        { Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' },
        { Type: 'DIMENSION', Key: 'SERVICE' },
      ],
      ResultsByTime: [
        {
          TimePeriod: { Start: '2026-08-01', End: '2026-08-02' },
          Estimated: false,
          Groups: [
            {
              Keys: ['111111111111', 'Amazon EC2'],
              Metrics: { [COST_EXPLORER_METRIC]: { Amount: '2.5', Unit: 'USD' } },
            },
          ],
        },
      ],
    };

    expect(parseCostExplorerPage(swapped)).toEqual([
      {
        day: '2026-08-01',
        service: 'Amazon EC2',
        linkedAccount: '111111111111',
        amountUsd: 2.5,
        unit: 'USD',
        estimated: false,
      },
    ]);
  });

  it('carries the estimated flag from the day, not the group', () => {
    const rows = parseCostExplorerPage(
      page([{ day: '2026-08-07', service: 'Amazon EC2', account: '', amount: '1' }], {
        estimated: true,
      }),
    );
    expect(rows[0].estimated).toBe(true);
  });

  it('drops a bucket whose amount will not parse, rather than poisoning every SUM', () => {
    const broken: GetCostAndUsageCommandOutput = {
      $metadata: {},
      GroupDefinitions: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      ResultsByTime: [
        {
          TimePeriod: { Start: '2026-08-01', End: '2026-08-02' },
          Groups: [
            { Keys: ['Amazon EC2'], Metrics: { [COST_EXPLORER_METRIC]: { Amount: 'n/a' } } },
            { Keys: ['Amazon S3'], Metrics: {} },
            { Keys: ['AWS Lambda'], Metrics: { [COST_EXPLORER_METRIC]: { Amount: '0.5' } } },
          ],
        },
      ],
    };
    const rows = parseCostExplorerPage(broken);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ service: 'AWS Lambda', amountUsd: 0.5 });
  });

  it('keeps a zero-amount bucket, which is real data and not a parse failure', () => {
    const rows = parseCostExplorerPage(
      page([{ day: '2026-08-01', service: 'Amazon S3', account: '', amount: '0' }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amountUsd).toBe(0);
  });

  it('labels rather than discards a group with no service key', () => {
    // Spend silently dropped is a bill that does not add up.
    const noService: GetCostAndUsageCommandOutput = {
      $metadata: {},
      GroupDefinitions: [{ Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' }],
      ResultsByTime: [
        {
          TimePeriod: { Start: '2026-08-01', End: '2026-08-02' },
          Groups: [
            {
              Keys: ['111111111111'],
              Metrics: { [COST_EXPLORER_METRIC]: { Amount: '3' } },
            },
          ],
        },
      ],
    };
    expect(parseCostExplorerPage(noService)[0]).toMatchObject({
      service: 'Unattributed',
      linkedAccount: '111111111111',
      amountUsd: 3,
    });
  });

  it('returns nothing for an empty response rather than throwing', () => {
    expect(parseCostExplorerPage({ $metadata: {} })).toEqual([]);
  });

  it('skips a result with no start date, which cannot be keyed', () => {
    expect(
      parseCostExplorerPage({
        $metadata: {},
        GroupDefinitions: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        ResultsByTime: [
          {
            Groups: [{ Keys: ['x'], Metrics: { [COST_EXPLORER_METRIC]: { Amount: '1' } } }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('defaults a missing unit to USD', () => {
    const rows = parseCostExplorerPage({
      $metadata: {},
      GroupDefinitions: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      ResultsByTime: [
        {
          TimePeriod: { Start: '2026-08-01', End: '2026-08-02' },
          Groups: [{ Keys: ['x'], Metrics: { [COST_EXPLORER_METRIC]: { Amount: '1' } } }],
        },
      ],
    });
    expect(rows[0].unit).toBe('USD');
  });
});

// ─── The guards ─────────────────────────────────────────────────────────────

describe('runInfraCostExplorerSync guards', () => {
  it('issues nothing for a project that never opted in', () => {
    // The whole point of the opt-in: this API charges from the first request.
    const result = { client: forbiddenClient(), nowMs: NOW, projectId: PROJECT };
    return expect(runInfraCostExplorerSync(result)).resolves.toMatchObject({
      synced: 0,
      pages: 0,
      skipped: expect.objectContaining({ not_enabled: 1 }),
    });
  });

  it('sweeps only opted-in projects when none is named', async () => {
    setInfraCostExplorerEnabled('opted-in', true, NOW);
    setInfraCostExplorerEnabled('opted-out', false, NOW);
    const client = fakeClient([page([])]);

    const result = await runInfraCostExplorerSync({ client, nowMs: NOW });
    expect(result.projectsConsidered).toBe(1);
    expect(result.synced).toBe(1);
  });

  it('refuses a second sweep inside the cadence floor', async () => {
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
    recordCostExplorerSyncStart(PROJECT, NOW - 1000);

    const result = await runInfraCostExplorerSync({
      client: forbiddenClient(),
      nowMs: NOW,
      projectId: PROJECT,
    });
    expect(result.skipped.too_soon).toBe(1);
    expect(result.pages).toBe(0);
  });

  it('allows the sweep once the floor has elapsed', async () => {
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
    recordCostExplorerSyncStart(PROJECT, NOW - MIN_COST_EXPLORER_SYNC_INTERVAL_MS);
    const client = fakeClient([page([])]);

    const result = await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });
    expect(result.synced).toBe(1);
    expect(result.pages).toBe(1);
  });

  it('does not spend on a project the ceiling has paused', async () => {
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
    // A zero ceiling means "collect nothing" and pauses immediately.
    setInfraCostCeiling(PROJECT, 0, NOW);

    const result = await runInfraCostExplorerSync({
      client: forbiddenClient(),
      nowMs: NOW,
      projectId: PROJECT,
    });
    expect(result.skipped.paused).toBe(1);
    expect(result.pages).toBe(0);
  });

  it('resolves the pause live rather than trusting the stored degradation level', async () => {
    // The stored level is what the *collector* last acted on. Between two
    // collector ticks a project can cross the ceiling, and spending here on a
    // stale 'normal' is exactly the leak the ceiling exists to stop.
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
    setInfraCostCeiling(PROJECT, 1, NOW);
    expect(getInfraCostConfig(PROJECT).degradationLevel).toBe('normal');

    // Spend well past twice the ceiling without ever running the collector.
    const { startInfraCollectRun, recordInfraCollectRunProgress } =
      await import('./infra-metric-store.js');
    startInfraCollectRun({ id: 'spendy', projectId: PROJECT, startedAt: NOW - 5000 });
    recordInfraCollectRunProgress('spendy', { estimatedCostUsd: 50 });

    const result = await runInfraCostExplorerSync({
      client: forbiddenClient(),
      nowMs: NOW,
      projectId: PROJECT,
    });
    expect(result.skipped.paused).toBe(1);
  });

  it('skips a project with no usable monitoring profile', async () => {
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
    const clients = await import('./aws-clients.js');
    vi.mocked(clients.requireProjectMonitoringProfile).mockImplementation(() => {
      throw new Error('no monitoring profile designated');
    });

    const result = await runInfraCostExplorerSync({
      client: forbiddenClient(),
      nowMs: NOW,
      projectId: PROJECT,
    });
    expect(result.skipped.no_monitoring_profile).toBe(1);
    expect(result.pages).toBe(0);
  });

  it('is a no-op when infra.db was never opened', async () => {
    closeInfraDb();
    const result = await runInfraCostExplorerSync({ client: forbiddenClient(), nowMs: NOW });
    expect(result.projectsConsidered).toBe(0);
    // Re-open so afterEach's close is symmetric.
    initInfraDb(dir);
  });
});

// ─── The request AWS actually receives ──────────────────────────────────────

describe('the GetCostAndUsage request', () => {
  beforeEach(() => {
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
  });

  it('asks for DAILY granularity grouped by service and linked account', async () => {
    const client = fakeClient([page([])]);
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });

    expect(client.calls[0]).toMatchObject({
      Granularity: 'DAILY',
      Metrics: [COST_EXPLORER_METRIC],
      GroupBy: [
        { Type: 'DIMENSION', Key: 'SERVICE' },
        { Type: 'DIMENSION', Key: 'LINKED_ACCOUNT' },
      ],
      TimePeriod: { Start: '2026-07-09', End: '2026-08-08' },
    });
  });

  it('never sends more than the two GroupBy dimensions AWS permits', async () => {
    const client = fakeClient([page([])]);
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });
    const groupBy = (client.calls[0] as { GroupBy: unknown[] }).GroupBy;
    expect(groupBy).toHaveLength(2);
  });

  it('never sends a BillingViewArn, which would multiply the per-request price', async () => {
    // A request against a view combining N sources is billed $0.01 per source.
    const client = fakeClient([page([])]);
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });
    expect(client.calls[0]).not.toHaveProperty('BillingViewArn');
  });
});

// ─── Spend accounting ───────────────────────────────────────────────────────

describe('per-page spend accounting', () => {
  beforeEach(() => {
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
  });

  it('charges a cent per page, including every pagination page', async () => {
    const client = fakeClient([
      page([{ day: '2026-08-01', service: 'Amazon EC2', account: '', amount: '1' }], {
        nextPageToken: 'p2',
      }),
      page([{ day: '2026-08-02', service: 'Amazon EC2', account: '', amount: '2' }], {
        nextPageToken: 'p3',
      }),
      page([{ day: '2026-08-03', service: 'Amazon EC2', account: '', amount: '3' }]),
    ]);

    const result = await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });
    expect(result.pages).toBe(3);
    expect(result.estimatedCostUsd).toBeCloseTo(0.03, 10);
    expect(result.estimatedCostUsd).toBeCloseTo(estimateCostExplorerCostUsd(3), 10);
  });

  it('follows the pagination token from each page', async () => {
    const client = fakeClient([
      page([], { nextPageToken: 'p2' }),
      page([], { nextPageToken: 'p3' }),
      page([]),
    ]);
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });

    expect((client.calls[0] as { NextPageToken?: string }).NextPageToken).toBeUndefined();
    expect((client.calls[1] as { NextPageToken?: string }).NextPageToken).toBe('p2');
    expect((client.calls[2] as { NextPageToken?: string }).NextPageToken).toBe('p3');
  });

  it('records the spend into infra_collect_runs under the cost_explorer kind', async () => {
    const client = fakeClient([page([], { nextPageToken: 'p2' }), page([])]);
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });

    const runs = listInfraCollectRuns(PROJECT);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'cost_explorer',
      queriesIssued: 2,
      status: 'ok',
      // Not metrics_requested: that is a GetMetricData billing quantity and
      // stays zero here, or the ceiling would double-count a unit it never spent.
      metricsRequested: 0,
    });
    expect(runs[0].estimatedCostUsd).toBeCloseTo(2 * COST_EXPLORER_USD_PER_REQUEST, 10);
  });

  it('counts against the same month-to-date figure the ceiling reads', async () => {
    const client = fakeClient([page([])]);
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });

    const spend = getInfraSpendToDate(PROJECT, NOW);
    expect(spend.monthToDateUsd).toBeCloseTo(COST_EXPLORER_USD_PER_REQUEST, 10);
    expect(spend.byKind.cost_explorer).toBeCloseTo(COST_EXPLORER_USD_PER_REQUEST, 10);
    expect(spend.byKind.metrics).toBe(0);
  });

  it('records the pages it already paid for when a later page throws', async () => {
    // A hard failure mid-sweep has still spent money. Spend recorded only on
    // success is how a crash loop defeats the ceiling meant to stop it.
    let sent = 0;
    const client: CostExplorerClientLike = {
      send: () => {
        sent += 1;
        if (sent === 1) return Promise.resolve(page([], { nextPageToken: 'p2' }));
        return Promise.reject(new Error('LimitExceededException'));
      },
    };

    const result = await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });
    expect(result.failed).toBe(1);
    expect(getInfraSpendToDate(PROJECT, NOW).monthToDateUsd).toBeCloseTo(
      COST_EXPLORER_USD_PER_REQUEST,
      10,
    );
  });

  it('stamps the sync time before the first request, so a crash still gates the next tick', async () => {
    const client: CostExplorerClientLike = {
      send: () => Promise.reject(new Error('boom')),
    };
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });

    expect(getInfraCostConfig(PROJECT).costExplorerSyncedAt).toBe(NOW);
    // And the very next tick is refused rather than re-issuing the whole sweep.
    const second = await runInfraCostExplorerSync({
      client: forbiddenClient(),
      nowMs: NOW + 1000,
      projectId: PROJECT,
    });
    expect(second.skipped.too_soon).toBe(1);
  });

  it('closes the run row failed and keeps the reason for the operator', async () => {
    const client: CostExplorerClientLike = {
      send: () => Promise.reject(new Error('DataUnavailableException: no data')),
    };
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });

    const run = listInfraCollectRuns(PROJECT)[0];
    expect(run.status).toBe('failed');
    expect(run.errors).toBe(1);
    expect(run.errorMessage).toContain('DataUnavailableException');
  });
});

// ─── The pagination cap ─────────────────────────────────────────────────────

describe('the pagination cap', () => {
  beforeEach(() => {
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
  });

  it('stops at the cap rather than following an unbounded token loop', async () => {
    // At a cent a page, an unbounded loop is unbounded billing in someone
    // else's account.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = fakeClient([page([], { nextPageToken: 'always-more' })]);

    const result = await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });
    expect(result.pages).toBe(MAX_COST_EXPLORER_PAGES);
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('reports truncation rather than presenting a partial window as complete', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = fakeClient([page([], { nextPageToken: 'always-more' })]);
    await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });

    const run = listInfraCollectRuns(PROJECT)[0];
    expect(run.status).toBe('partial');
    expect(run.errorMessage).toMatch(/incomplete/i);
  });

  it('does not flag truncation when the last page has no token', async () => {
    const client = fakeClient([page([], { nextPageToken: 'p2' }), page([])]);
    const result = await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });
    expect(result.truncated).toBe(false);
    expect(listInfraCollectRuns(PROJECT)[0].status).toBe('ok');
  });
});

// ─── End to end into the cache ──────────────────────────────────────────────

describe('what lands in the cache', () => {
  beforeEach(() => {
    setInfraCostExplorerEnabled(PROJECT, true, NOW);
  });

  it('writes every page’s rows as one window replace', async () => {
    const client = fakeClient([
      page(
        [
          { day: '2026-08-01', service: 'Amazon EC2', account: '111111111111', amount: '4' },
          { day: '2026-08-01', service: 'Amazon S3', account: '111111111111', amount: '1' },
        ],
        { nextPageToken: 'p2' },
      ),
      page([{ day: '2026-08-02', service: 'Amazon EC2', account: '111111111111', amount: '6' }]),
    ]);

    const result = await runInfraCostExplorerSync({ client, nowMs: NOW, projectId: PROJECT });
    expect(result.rowsWritten).toBe(3);

    const trend = queryInfraSpendTrend({
      projectId: PROJECT,
      startDay: '2026-07-09',
      endDay: '2026-08-08',
    });
    expect(trend.totalUsd).toBe(11);
    expect(trend.topServices).toEqual([
      { service: 'Amazon EC2', amountUsd: 10 },
      { service: 'Amazon S3', amountUsd: 1 },
    ]);
    expect(trend.days.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('clears the cached window when a re-sync finds no spend', async () => {
    await runInfraCostExplorerSync({
      client: fakeClient([
        page([{ day: '2026-08-01', service: 'Amazon EC2', account: '', amount: '4' }]),
      ]),
      nowMs: NOW,
      projectId: PROJECT,
    });

    const later = NOW + MIN_COST_EXPLORER_SYNC_INTERVAL_MS;
    await runInfraCostExplorerSync({
      client: fakeClient([page([])]),
      nowMs: later,
      projectId: PROJECT,
    });

    const window = costExplorerWindow(later);
    expect(
      queryInfraSpendTrend({
        projectId: PROJECT,
        startDay: window.startDay,
        endDay: window.endDay,
      }).totalUsd,
    ).toBe(0);
  });

  it('does not let one project’s failure starve another', async () => {
    setInfraCostExplorerEnabled('proj-b', true, NOW);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    const client: CostExplorerClientLike = {
      send: () => {
        call += 1;
        // The first project fails; the second must still be swept.
        if (call === 1) return Promise.reject(new Error('ExpiredToken'));
        return Promise.resolve(
          page([{ day: '2026-08-01', service: 'Amazon EC2', account: '', amount: '2' }]),
        );
      },
    };

    const result = await runInfraCostExplorerSync({ client, nowMs: NOW });
    expect(result.failed).toBe(1);
    expect(result.synced).toBe(1);
  });
});

describe('the schedule', () => {
  it('fires three times a day, matching the module’s own cadence floor', () => {
    // The cron is the schedule; MIN_COST_EXPLORER_SYNC_INTERVAL_MS is the
    // guarantee. If they disagree the cron either wastes ticks or, worse, looks
    // like it permits a fourth charge.
    const [, hours] = INFRA_COST_EXPLORER_CRON.split(' ');
    const fires = hours.split(',');
    expect(fires).toHaveLength(3);
    expect(24 / fires.length).toBe(COST_EXPLORER_SYNC_INTERVAL_S / 3600);
  });

  it('does not collide with the inventory sweep’s minute', async () => {
    const { INFRA_INVENTORY_SYNC_CRON } = await import('./inventory-sync.js');
    expect(INFRA_COST_EXPLORER_CRON.split(' ')[0]).not.toBe(
      INFRA_INVENTORY_SYNC_CRON.split(' ')[0],
    );
  });
});
