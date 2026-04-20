/**
 * Pool-alerts heartbeat (W4 observability).
 *
 * Reads recent rows from `pool_metrics` and fires/clears alerts when the
 * documented thresholds are crossed. Intended to run on a 1-minute cadence
 * alongside the dispatcher's 60-second metric write — that way the
 * "5-minute sustained" rule for `pool_util_high` only needs to inspect the
 * last 5 samples.
 *
 * Threshold rules (see card W4 description):
 *
 *   pool_util_high   — pool_util > 0.90 in EVERY one of the last 5 samples
 *                      (i.e. ≥5 minutes sustained at the default cadence).
 *                      Fewer than 5 samples → cannot fire.
 *
 *   queue_depth_high — queue_depth > 5 in the most recent sample.
 *
 *   cert_expiring    — cert_days_remaining is non-null and < 14 in the
 *                      most recent sample.
 *
 * Dedup: at most one un-resolved row per `alert_type` exists in
 * `pool_alerts` at a time. A new firing while an alert is already active
 * is a no-op. When the breach clears, the active row's `resolved_at` is
 * set so the next firing of the same type opens a fresh row.
 *
 * Side-effects are SQLite writes only — no network, no process spawn.
 * Safe to call from a node-cron tick without a runner timeout.
 */

import type Database from 'better-sqlite3';

export type PoolAlertType = 'pool_util_high' | 'queue_depth_high' | 'cert_expiring';
export type PoolAlertSeverity = 'info' | 'warn' | 'critical';

export interface PoolAlertThresholds {
  /** Util fraction (0..1) above which we consider the pool saturated. */
  poolUtilHigh: number;
  /** Number of consecutive samples that must exceed `poolUtilHigh`. */
  poolUtilSustainedSamples: number;
  /** Total queue depth above which we fire `queue_depth_high`. */
  queueDepthHigh: number;
  /** Days remaining below which we fire `cert_expiring`. */
  certDaysRemainingLow: number;
}

export const DEFAULT_THRESHOLDS: PoolAlertThresholds = {
  poolUtilHigh: 0.9,
  poolUtilSustainedSamples: 5,
  queueDepthHigh: 5,
  certDaysRemainingLow: 14,
};

export interface PoolAlertsHeartbeatDeps {
  db: Database.Database;
  /** Optional override for the breach thresholds (tests). */
  thresholds?: Partial<PoolAlertThresholds>;
  /** Optional ISO timestamp source so tests can pin the clock. */
  nowIso?: () => string;
  logger?: { log: (m: string) => void; error: (m: string) => void };
}

interface MetricRow {
  pool_util: number;
  queue_depth: number;
  cert_days_remaining: number | null;
}

export interface PoolAlertsTickResult {
  fired: PoolAlertType[];
  resolved: PoolAlertType[];
  /** Non-null when the evaluator itself failed (schema error, etc.). */
  error: string | null;
  /** Snapshot of the rules evaluated this tick (for tests / log lines). */
  evaluated: {
    poolUtilSustained: boolean;
    poolUtilLatest: number | null;
    queueDepthLatest: number | null;
    certDaysLatest: number | null;
  };
}

/**
 * Run one alert-evaluation tick. Returns a structured summary of which
 * alerts fired / resolved this pass. Never throws — scheduler callers
 * want a best-effort tick with a logged failure, not an unhandled error.
 */
export function runPoolAlertsHeartbeat(deps: PoolAlertsHeartbeatDeps): PoolAlertsTickResult {
  const logger = deps.logger ?? {
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  };
  const thresholds: PoolAlertThresholds = { ...DEFAULT_THRESHOLDS, ...(deps.thresholds ?? {}) };
  const nowIso = deps.nowIso ?? (() => new Date().toISOString().slice(0, 19).replace('T', ' '));

  try {
    return evaluate(deps.db, thresholds, nowIso, logger);
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`[pool-alerts] evaluation failed: ${message}`);
    return {
      fired: [],
      resolved: [],
      error: message,
      evaluated: {
        poolUtilSustained: false,
        poolUtilLatest: null,
        queueDepthLatest: null,
        certDaysLatest: null,
      },
    };
  }
}

function evaluate(
  db: Database.Database,
  thresholds: PoolAlertThresholds,
  nowIso: () => string,
  logger: { log: (m: string) => void; error: (m: string) => void },
): PoolAlertsTickResult {
  const recent = db
    .prepare(
      `SELECT pool_util, queue_depth, cert_days_remaining
         FROM pool_metrics
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(Math.max(thresholds.poolUtilSustainedSamples, 1)) as MetricRow[];

  const latest = recent[0] ?? null;

  // pool_util_high: every sample in the window must exceed the threshold,
  // AND we must have at least the required number of samples.
  const sustained =
    recent.length >= thresholds.poolUtilSustainedSamples &&
    recent.every((r) => r.pool_util > thresholds.poolUtilHigh);

  // queue_depth_high: latest sample only.
  const queueHigh = latest != null && latest.queue_depth > thresholds.queueDepthHigh;

  // cert_expiring: latest sample only; null cert_days_remaining is treated
  // as "unknown" and does not fire (the cert renewer hasn't populated it).
  const certLow =
    latest != null &&
    latest.cert_days_remaining != null &&
    latest.cert_days_remaining < thresholds.certDaysRemainingLow;

  const fired: PoolAlertType[] = [];
  const resolved: PoolAlertType[] = [];

  applyRule(
    db,
    'pool_util_high',
    'critical',
    sustained,
    `pool_util > ${(thresholds.poolUtilHigh * 100).toFixed(0)}% sustained for ${thresholds.poolUtilSustainedSamples} samples (latest=${(latest?.pool_util ?? 0).toFixed(2)})`,
    latest?.pool_util ?? null,
    nowIso,
    fired,
    resolved,
  );

  applyRule(
    db,
    'queue_depth_high',
    'warn',
    queueHigh,
    `queue_depth=${latest?.queue_depth ?? 0} exceeds threshold ${thresholds.queueDepthHigh}`,
    latest?.queue_depth ?? null,
    nowIso,
    fired,
    resolved,
  );

  applyRule(
    db,
    'cert_expiring',
    'critical',
    certLow,
    `wildcard cert expires in ${latest?.cert_days_remaining?.toFixed(1) ?? '?'} days (threshold ${thresholds.certDaysRemainingLow})`,
    latest?.cert_days_remaining ?? null,
    nowIso,
    fired,
    resolved,
  );

  if (fired.length || resolved.length) {
    logger.log(
      `[pool-alerts] tick: fired=${fired.join(',') || 'none'} resolved=${resolved.join(',') || 'none'}`,
    );
  }

  return {
    fired,
    resolved,
    error: null,
    evaluated: {
      poolUtilSustained: sustained,
      poolUtilLatest: latest?.pool_util ?? null,
      queueDepthLatest: latest?.queue_depth ?? null,
      certDaysLatest: latest?.cert_days_remaining ?? null,
    },
  };
}

function applyRule(
  db: Database.Database,
  type: PoolAlertType,
  severity: PoolAlertSeverity,
  isBreaching: boolean,
  message: string,
  value: number | null,
  nowIso: () => string,
  fired: PoolAlertType[],
  resolved: PoolAlertType[],
): void {
  const active = db
    .prepare(
      `SELECT id FROM pool_alerts
        WHERE alert_type = ? AND resolved_at IS NULL
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get(type) as { id: number } | undefined;

  if (isBreaching && !active) {
    db.prepare(
      `INSERT INTO pool_alerts (alert_type, severity, message, fired_at, value)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(type, severity, message, nowIso(), value);
    fired.push(type);
  } else if (!isBreaching && active) {
    db.prepare(`UPDATE pool_alerts SET resolved_at = ? WHERE id = ?`).run(nowIso(), active.id);
    resolved.push(type);
  }
}

/** Cron expression — exported for tests. Every minute. */
export const POOL_ALERTS_CRON = '* * * * *';
