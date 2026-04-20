/**
 * Pool-alerts heartbeat tests (W4).
 *
 * Exercise the threshold rules with seeded `pool_metrics` rows and assert
 * the firing / dedup / resolve behaviour. All tests run against an
 * in-memory SQLite DB with the production POOL_SCHEMA — no mocking.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { POOL_SCHEMA } from './schema.js';
import {
  runPoolAlertsHeartbeat,
  DEFAULT_THRESHOLDS,
  type PoolAlertType,
} from './pool-alerts-heartbeat.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(POOL_SCHEMA);
  return db;
}

function seedSample(
  db: Database.Database,
  i: number,
  partial: {
    pool_util?: number;
    queue_depth?: number;
    cert_days_remaining?: number | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO pool_metrics (
       timestamp, pool_util, queue_depth, queue_depth_pr_env,
       queue_depth_scaffold, evictions, reaps, cert_days_remaining
     ) VALUES (?, ?, ?, 0, 0, 0, 0, ?)`,
  ).run(
    `2026-04-20 12:00:${String(i).padStart(2, '0')}`,
    partial.pool_util ?? 0,
    partial.queue_depth ?? 0,
    partial.cert_days_remaining ?? null,
  );
}

function activeAlerts(db: Database.Database): Array<{ alert_type: string; value: number | null }> {
  return db
    .prepare(
      `SELECT alert_type, value FROM pool_alerts
        WHERE resolved_at IS NULL ORDER BY id`,
    )
    .all() as Array<{ alert_type: string; value: number | null }>;
}

describe('pool-alerts heartbeat — pool_util_high (sustained)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('fires after 5 sustained samples > 90%', () => {
    for (let i = 0; i < 5; i++) seedSample(db, i, { pool_util: 0.95 });

    const result = runPoolAlertsHeartbeat({ db });

    expect(result.fired).toContain<PoolAlertType>('pool_util_high');
    expect(result.evaluated.poolUtilSustained).toBe(true);
    expect(activeAlerts(db).map((a) => a.alert_type)).toContain('pool_util_high');
  });

  it('does not fire with only 4 samples (insufficient window)', () => {
    for (let i = 0; i < 4; i++) seedSample(db, i, { pool_util: 0.99 });

    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).not.toContain<PoolAlertType>('pool_util_high');
    expect(activeAlerts(db)).toEqual([]);
  });

  it('does not fire if any sample in the window is below threshold', () => {
    seedSample(db, 0, { pool_util: 0.95 });
    seedSample(db, 1, { pool_util: 0.95 });
    seedSample(db, 2, { pool_util: 0.5 }); // dip below
    seedSample(db, 3, { pool_util: 0.95 });
    seedSample(db, 4, { pool_util: 0.95 });

    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).not.toContain<PoolAlertType>('pool_util_high');
  });

  it('dedupes: a second tick while still breaching does not insert another row', () => {
    for (let i = 0; i < 5; i++) seedSample(db, i, { pool_util: 0.95 });
    runPoolAlertsHeartbeat({ db });
    runPoolAlertsHeartbeat({ db });

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM pool_alerts WHERE alert_type = 'pool_util_high'`)
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('resolves the active row when util drops back below threshold', () => {
    for (let i = 0; i < 5; i++) seedSample(db, i, { pool_util: 0.95 });
    runPoolAlertsHeartbeat({ db });

    // Add 5 fresh samples below threshold (the query reads the LAST 5).
    for (let i = 5; i < 10; i++) seedSample(db, i, { pool_util: 0.5 });

    const result = runPoolAlertsHeartbeat({ db });
    expect(result.resolved).toContain<PoolAlertType>('pool_util_high');
    expect(activeAlerts(db).map((a) => a.alert_type)).not.toContain('pool_util_high');
  });
});

describe('pool-alerts heartbeat — queue_depth_high', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('fires when latest queue_depth exceeds threshold', () => {
    seedSample(db, 0, { queue_depth: 10 });
    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).toContain<PoolAlertType>('queue_depth_high');
  });

  it('does not fire at exactly the threshold (strict >)', () => {
    seedSample(db, 0, { queue_depth: DEFAULT_THRESHOLDS.queueDepthHigh });
    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).not.toContain<PoolAlertType>('queue_depth_high');
  });

  it('resolves when latest sample drops back at/below threshold', () => {
    seedSample(db, 0, { queue_depth: 10 });
    runPoolAlertsHeartbeat({ db });
    seedSample(db, 1, { queue_depth: 0 });
    const result = runPoolAlertsHeartbeat({ db });
    expect(result.resolved).toContain<PoolAlertType>('queue_depth_high');
  });
});

describe('pool-alerts heartbeat — cert_expiring', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('fires when cert_days_remaining < 14', () => {
    seedSample(db, 0, { cert_days_remaining: 7 });
    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).toContain<PoolAlertType>('cert_expiring');
  });

  it('does not fire when cert_days_remaining is null (renewer not yet populated)', () => {
    seedSample(db, 0, { cert_days_remaining: null });
    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).not.toContain<PoolAlertType>('cert_expiring');
  });

  it('does not fire at exactly the threshold (strict <)', () => {
    seedSample(db, 0, {
      cert_days_remaining: DEFAULT_THRESHOLDS.certDaysRemainingLow,
    });
    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).not.toContain<PoolAlertType>('cert_expiring');
  });

  it('respects custom thresholds', () => {
    seedSample(db, 0, { cert_days_remaining: 20 });
    const result = runPoolAlertsHeartbeat({
      db,
      thresholds: { certDaysRemainingLow: 30 },
    });
    expect(result.fired).toContain<PoolAlertType>('cert_expiring');
  });
});

describe('pool-alerts heartbeat — independence between rule types', () => {
  it('one type firing does not block another type from firing in the same tick', () => {
    const db = freshDb();
    // Seed 5 samples, all hot AND with shallow cert.
    for (let i = 0; i < 5; i++)
      seedSample(db, i, { pool_util: 0.95, queue_depth: 12, cert_days_remaining: 3 });

    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).toEqual(
      expect.arrayContaining<PoolAlertType>([
        'pool_util_high',
        'queue_depth_high',
        'cert_expiring',
      ]),
    );
    expect(activeAlerts(db)).toHaveLength(3);
  });

  it('returns a structured eval snapshot even on an empty pool_metrics table', () => {
    const db = freshDb();
    const result = runPoolAlertsHeartbeat({ db });
    expect(result.fired).toEqual([]);
    expect(result.evaluated).toEqual({
      poolUtilSustained: false,
      poolUtilLatest: null,
      queueDepthLatest: null,
      certDaysLatest: null,
    });
  });
});
