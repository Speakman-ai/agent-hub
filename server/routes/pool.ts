/**
 * Container-pool observability endpoints (W4).
 *
 * Surfaces the rolling 24-hour metric series and the active-alert log used
 * by the `/settings/pool` dashboard. Both routes are read-only and do not
 * touch the dispatcher / allocator state — observability only.
 *
 *   GET /api/pool/metrics?windowHours=24
 *     Returns the per-sample series for the requested window. Default 24h,
 *     clamped to [1, 168]. Rows ordered ascending so the client can render
 *     a sparkline left-to-right without reversing.
 *
 *   GET /api/pool/alerts?status=active|all
 *     Returns the alert log. `status=active` (default) returns rows with
 *     `resolved_at IS NULL`; `status=all` returns the recent 200.
 */

import { Router, Request, Response } from 'express';
import { getDb } from '../db.js';
import type { RouteDeps } from '../types.js';

interface PoolMetricRow {
  id: number;
  timestamp: string;
  pool_util: number;
  queue_depth: number;
  queue_depth_pr_env: number;
  queue_depth_scaffold: number;
  evictions: number;
  reaps: number;
  cert_days_remaining: number | null;
}

interface PoolAlertRow {
  id: number;
  alert_type: string;
  severity: string;
  message: string;
  fired_at: string;
  resolved_at: string | null;
  value: number | null;
}

const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 168; // 7 days
const DEFAULT_WINDOW_HOURS = 24;
const ALERT_HISTORY_LIMIT = 200;

/** Clamp to [1, 168]; non-finite / missing → default 24h. */
function parseWindowHours(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseFloat(raw) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_HOURS;
  return Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, n));
}

export default function createPoolRoutes(_deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/pool/metrics', (req: Request, res: Response) => {
    const windowHours = parseWindowHours(req.query.windowHours);
    const db = getDb();

    // Pull rows newer than (now - windowHours). Using SQLite's built-in
    // datetime arithmetic keeps the query timezone-consistent with the
    // dispatcher's writeMetrics() (both use datetime('now')).
    const rows = db
      .prepare(
        `SELECT id, timestamp, pool_util, queue_depth, queue_depth_pr_env,
                queue_depth_scaffold, evictions, reaps, cert_days_remaining
           FROM pool_metrics
          WHERE timestamp >= datetime('now', ?)
          ORDER BY timestamp ASC`,
      )
      .all(`-${windowHours} hours`) as PoolMetricRow[];

    res.json({ windowHours, samples: rows });
  });

  router.get('/api/pool/alerts', (req: Request, res: Response) => {
    const status = req.query.status === 'all' ? 'all' : 'active';
    const db = getDb();

    const rows =
      status === 'active'
        ? (db
            .prepare(
              `SELECT id, alert_type, severity, message, fired_at, resolved_at, value
                 FROM pool_alerts
                WHERE resolved_at IS NULL
                ORDER BY fired_at DESC`,
            )
            .all() as PoolAlertRow[])
        : (db
            .prepare(
              `SELECT id, alert_type, severity, message, fired_at, resolved_at, value
                 FROM pool_alerts
                ORDER BY fired_at DESC
                LIMIT ?`,
            )
            .all(ALERT_HISTORY_LIMIT) as PoolAlertRow[]);

    res.json({ status, alerts: rows });
  });

  return router;
}
