/**
 * Integration tests for /api/pool/metrics and /api/pool/alerts (W4).
 *
 * Seeds rows directly into the live test DB via getDb() so we don't have
 * to spin up a dispatcher. The endpoints are read-only — these tests
 * verify the response shape, the windowHours filter, and the active /
 * all status filter for the alerts log.
 */

import type supertest from 'supertest';
import { tmpdir } from 'os';
import { getRequest } from './helpers.js';
import { getDb } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

interface MetricsBody {
  windowHours: number;
  samples: Array<{
    pool_util: number;
    queue_depth: number;
    queue_depth_pr_env: number;
    queue_depth_scaffold: number;
    evictions: number;
    reaps: number;
    cert_days_remaining: number | null;
  }>;
}

interface AlertsBody {
  status: string;
  alerts: Array<{
    alert_type: string;
    severity: string;
    message: string;
    fired_at: string;
    resolved_at: string | null;
    value: number | null;
  }>;
}

function clearPoolTables(): void {
  const db = getDb();
  // Safety net — see PR feature/designs-wipe-guard. Refuse to issue bulk
  // DELETEs against anything outside the tmp test data dir.
  if (!db.name.startsWith(tmpdir())) {
    throw new Error(
      `Refusing to wipe pool tables in non-tmp DB at ${db.name} — expected path under ${tmpdir()}`,
    );
  }
  db.exec('DELETE FROM pool_metrics');
  db.exec('DELETE FROM pool_alerts');
}

describe('GET /api/pool/metrics', () => {
  beforeEach(() => {
    clearPoolTables();
  });

  it('returns the seeded samples ordered ascending', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO pool_metrics (timestamp, pool_util, queue_depth, queue_depth_pr_env,
        queue_depth_scaffold, evictions, reaps, cert_days_remaining)
       VALUES (datetime('now', '-30 minutes'), 0.5, 2, 1, 1, 0, 0, 30),
              (datetime('now', '-10 minutes'), 0.7, 4, 3, 1, 1, 0, 29.5)`,
    ).run();

    const res = await request.get('/api/pool/metrics?windowHours=1').expect(200);
    const body = res.body as MetricsBody;

    expect(body.windowHours).toBe(1);
    expect(body.samples).toHaveLength(2);
    expect(body.samples[0].pool_util).toBe(0.5);
    expect(body.samples[1].pool_util).toBe(0.7);
    expect(body.samples[1].cert_days_remaining).toBeCloseTo(29.5, 1);
    expect(body.samples[1].queue_depth_pr_env).toBe(3);
  });

  it('clamps absurd windowHours into the legal range', async () => {
    const tooBig = await request.get('/api/pool/metrics?windowHours=999999').expect(200);
    expect((tooBig.body as MetricsBody).windowHours).toBe(168);

    const tooSmall = await request.get('/api/pool/metrics?windowHours=0').expect(200);
    expect((tooSmall.body as MetricsBody).windowHours).toBe(24);

    const negative = await request.get('/api/pool/metrics?windowHours=-5').expect(200);
    expect((negative.body as MetricsBody).windowHours).toBe(24);
  });

  it('excludes samples older than the requested window', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO pool_metrics (timestamp, pool_util, queue_depth, queue_depth_pr_env,
        queue_depth_scaffold, evictions, reaps, cert_days_remaining)
       VALUES (datetime('now', '-3 hours'), 0.3, 0, 0, 0, 0, 0, NULL),
              (datetime('now', '-30 minutes'), 0.7, 2, 1, 1, 0, 0, 25)`,
    ).run();

    const res = await request.get('/api/pool/metrics?windowHours=1').expect(200);
    const body = res.body as MetricsBody;
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].pool_util).toBe(0.7);
  });
});

describe('GET /api/pool/alerts', () => {
  beforeEach(() => {
    clearPoolTables();
  });

  it('returns only active (unresolved) alerts by default', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO pool_alerts (alert_type, severity, message, fired_at, resolved_at, value)
       VALUES ('pool_util_high', 'critical', 'Sustained util breach', datetime('now', '-10 minutes'), NULL, 0.95),
              ('queue_depth_high', 'warn', 'Queue overflow', datetime('now', '-30 minutes'), datetime('now', '-25 minutes'), 12)`,
    ).run();

    const res = await request.get('/api/pool/alerts').expect(200);
    const body = res.body as AlertsBody;

    expect(body.status).toBe('active');
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].alert_type).toBe('pool_util_high');
    expect(body.alerts[0].resolved_at).toBeNull();
  });

  it('returns the full history when status=all', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO pool_alerts (alert_type, severity, message, fired_at, resolved_at, value)
       VALUES ('cert_expiring', 'critical', 'Cert in 7d', datetime('now', '-1 day'), datetime('now', '-12 hours'), 7),
              ('queue_depth_high', 'warn', 'Queue overflow', datetime('now', '-1 hour'), NULL, 8)`,
    ).run();

    const res = await request.get('/api/pool/alerts?status=all').expect(200);
    const body = res.body as AlertsBody;
    expect(body.status).toBe('all');
    expect(body.alerts).toHaveLength(2);
  });

  it('returns an empty list when no alerts exist', async () => {
    const res = await request.get('/api/pool/alerts').expect(200);
    expect((res.body as AlertsBody).alerts).toEqual([]);
  });
});
