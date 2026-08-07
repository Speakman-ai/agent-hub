/**
 * The `infra_cost_daily` cache: window-replace write semantics and the three
 * aggregations the spend panel reads back.
 *
 * The load-bearing case here is restatement. Cost Explorer revises days after
 * the fact, and a (day, service, account) bucket that had spend yesterday can
 * legitimately have none today. An upsert-only writer leaves that vanished row
 * behind forever as a phantom charge no re-sync can clear, so several tests
 * below exist purely to pin the delete half of the replace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb } from './infra-db.js';
import {
  replaceInfraCostDailyWindow,
  queryInfraSpendTrend,
  DEFAULT_TOP_SERVICES,
  MAX_TOP_SERVICES,
  type InfraCostDailyRow,
} from './cost-explorer-store.js';

let dir: string;
const PROJECT = 'proj';
const PROFILE = 'monitoring';
const FETCHED = Date.UTC(2026, 7, 7, 9, 0, 0);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-ce-store-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

function row(
  day: string,
  service: string,
  amountUsd: number,
  over: Partial<InfraCostDailyRow> = {},
): InfraCostDailyRow {
  return {
    day,
    service,
    linkedAccount: '',
    amountUsd,
    unit: 'USD',
    estimated: false,
    ...over,
  };
}

function write(
  rows: InfraCostDailyRow[],
  window = { startDay: '2026-08-01', endDay: '2026-08-08' },
) {
  replaceInfraCostDailyWindow({
    projectId: PROJECT,
    profileName: PROFILE,
    startDay: window.startDay,
    endDay: window.endDay,
    rows,
    fetchedAt: FETCHED,
  });
}

function read(over: Partial<Parameters<typeof queryInfraSpendTrend>[0]> = {}) {
  return queryInfraSpendTrend({
    projectId: PROJECT,
    startDay: '2026-08-01',
    endDay: '2026-08-08',
    ...over,
  });
}

describe('replaceInfraCostDailyWindow', () => {
  it('stores one row per (day, service, linked account)', () => {
    write([
      row('2026-08-01', 'Amazon EC2', 1.5),
      row('2026-08-01', 'Amazon S3', 0.25),
      row('2026-08-02', 'Amazon EC2', 2),
    ]);

    const count = getInfraDb().prepare('SELECT COUNT(*) AS n FROM infra_cost_daily').get() as {
      n: number;
    };
    expect(count.n).toBe(3);
  });

  it('keeps the same (day, service) under different linked accounts apart', () => {
    write([
      row('2026-08-01', 'Amazon EC2', 1, { linkedAccount: '111111111111' }),
      row('2026-08-01', 'Amazon EC2', 3, { linkedAccount: '222222222222' }),
    ]);

    const trend = read();
    expect(trend.totalUsd).toBe(4);
    expect(trend.accounts).toEqual([
      { linkedAccount: '222222222222', amountUsd: 3 },
      { linkedAccount: '111111111111', amountUsd: 1 },
    ]);
  });

  it('drops a bucket AWS stopped reporting, rather than leaving a phantom charge', () => {
    write([row('2026-08-01', 'Amazon EC2', 5), row('2026-08-01', 'AWS Lambda', 2)]);
    expect(read().totalUsd).toBe(7);

    // A restated window in which Lambda's spend was re-attributed away.
    write([row('2026-08-01', 'Amazon EC2', 5)]);

    const trend = read();
    expect(trend.totalUsd).toBe(5);
    expect(trend.topServices.map((s) => s.service)).toEqual(['Amazon EC2']);
  });

  it('clears the whole window when a re-sync returns no rows at all', () => {
    // The bounds come from what we asked AWS, not from the rows it answered
    // with. A delete bounded by min(rows.day) would delete nothing here and
    // leave the entire stale window standing.
    write([row('2026-08-01', 'Amazon EC2', 5), row('2026-08-03', 'Amazon S3', 1)]);
    write([]);

    expect(read().totalUsd).toBe(0);
    expect(read().days).toEqual([]);
  });

  it('updates an amount in place when a day is restated upward', () => {
    write([row('2026-08-06', 'Amazon EC2', 1, { estimated: true })]);
    write([row('2026-08-06', 'Amazon EC2', 4.2, { estimated: false })]);

    const trend = read();
    expect(trend.totalUsd).toBeCloseTo(4.2, 10);
    expect(trend.days).toEqual([{ day: '2026-08-06', amountUsd: 4.2, estimated: false }]);
  });

  it('leaves rows outside the replaced window alone', () => {
    write([row('2026-07-20', 'Amazon EC2', 9)], {
      startDay: '2026-07-15',
      endDay: '2026-07-22',
    });
    write([row('2026-08-01', 'Amazon EC2', 1)]);

    const july = read({ startDay: '2026-07-15', endDay: '2026-07-22' });
    expect(july.totalUsd).toBe(9);
  });

  it('does not mix two profiles in the same project', () => {
    write([row('2026-08-01', 'Amazon EC2', 1)]);
    replaceInfraCostDailyWindow({
      projectId: PROJECT,
      profileName: 'other',
      startDay: '2026-08-01',
      endDay: '2026-08-08',
      rows: [row('2026-08-01', 'Amazon EC2', 7)],
      fetchedAt: FETCHED,
    });

    // Replacing 'other' must not have touched 'monitoring'.
    expect(read({ profileName: PROFILE }).totalUsd).toBe(1);
    expect(read({ profileName: 'other' }).totalUsd).toBe(7);
    // With no profile filter the caller asked for everything cached.
    expect(read().totalUsd).toBe(8);
  });
});

describe('queryInfraSpendTrend', () => {
  it('returns days oldest-first, already in plot order', () => {
    write([
      row('2026-08-03', 'Amazon EC2', 3),
      row('2026-08-01', 'Amazon EC2', 1),
      row('2026-08-02', 'Amazon EC2', 2),
    ]);

    expect(read().days.map((d) => d.day)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('marks a day estimated when any bucket in it is', () => {
    write([
      row('2026-08-01', 'Amazon EC2', 1, { estimated: false }),
      row('2026-08-01', 'Amazon S3', 1, { estimated: true }),
      row('2026-08-02', 'Amazon EC2', 1, { estimated: false }),
    ]);

    expect(read().days).toEqual([
      { day: '2026-08-01', amountUsd: 2, estimated: true },
      { day: '2026-08-02', amountUsd: 1, estimated: false },
    ]);
  });

  it('ranks services by spend and truncates to the requested top-N', () => {
    write([
      row('2026-08-01', 'A', 1),
      row('2026-08-01', 'B', 5),
      row('2026-08-01', 'C', 3),
      row('2026-08-01', 'D', 4),
    ]);

    const trend = read({ topServices: 2 });
    expect(trend.topServices).toEqual([
      { service: 'B', amountUsd: 5 },
      { service: 'D', amountUsd: 4 },
    ]);
  });

  it('sums totalUsd over the tail the top-N omits', () => {
    // The regression this pins: deriving the summary figure from a truncated
    // list is how a panel claims a $9 month on a $13 bill.
    write([
      row('2026-08-01', 'A', 1),
      row('2026-08-01', 'B', 5),
      row('2026-08-01', 'C', 3),
      row('2026-08-01', 'D', 4),
    ]);

    const trend = read({ topServices: 2 });
    expect(trend.totalUsd).toBe(13);
    expect(trend.topServices.reduce((n, s) => n + s.amountUsd, 0)).toBe(9);
  });

  it('clamps the top-N to at least one and at most MAX_TOP_SERVICES', () => {
    write(
      Array.from({ length: MAX_TOP_SERVICES + 5 }, (_, i) =>
        row('2026-08-01', `svc-${String(i).padStart(2, '0')}`, i + 1),
      ),
    );

    expect(read({ topServices: 0 }).topServices).toHaveLength(1);
    expect(read({ topServices: -3 }).topServices).toHaveLength(1);
    expect(read({ topServices: 999 }).topServices).toHaveLength(MAX_TOP_SERVICES);
    expect(read({ topServices: undefined }).topServices).toHaveLength(DEFAULT_TOP_SERVICES);
  });

  it('breaks a spend tie on service name so the order is stable across reads', () => {
    write([row('2026-08-01', 'zeta', 2), row('2026-08-01', 'alpha', 2)]);
    expect(read().topServices.map((s) => s.service)).toEqual(['alpha', 'zeta']);
  });

  it('omits the empty linked account, which is a standalone account not an org member', () => {
    write([
      row('2026-08-01', 'Amazon EC2', 4, { linkedAccount: '' }),
      row('2026-08-01', 'Amazon S3', 1, { linkedAccount: '333333333333' }),
    ]);

    expect(read().accounts).toEqual([{ linkedAccount: '333333333333', amountUsd: 1 }]);
    expect(read().totalUsd).toBe(5);
  });

  it('excludes a day on the exclusive upper bound', () => {
    write([row('2026-08-07', 'Amazon EC2', 1), row('2026-08-08', 'Amazon EC2', 99)], {
      startDay: '2026-08-01',
      endDay: '2026-08-09',
    });

    const trend = read({ startDay: '2026-08-01', endDay: '2026-08-08' });
    expect(trend.totalUsd).toBe(1);
    expect(trend.days.map((d) => d.day)).toEqual(['2026-08-07']);
  });

  it('carries the reported unit rather than assuming dollars', () => {
    write([row('2026-08-01', 'Amazon EC2', 3, { unit: 'EUR' })]);
    expect(read().unit).toBe('EUR');
  });

  it('reports the newest fetched_at in the window', () => {
    write([row('2026-08-01', 'Amazon EC2', 1)]);
    expect(read().fetchedAt).toBe(FETCHED);
  });

  it('returns a fully empty shape rather than nulls when nothing is cached', () => {
    expect(read()).toEqual({
      days: [],
      topServices: [],
      accounts: [],
      totalUsd: 0,
      unit: null,
      fetchedAt: null,
    });
  });
});
