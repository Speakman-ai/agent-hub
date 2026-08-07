/**
 * Persistence for service quota limits, and the headroom read model that joins
 * them to collected `AWS/Usage` points.
 *
 * The split this module maintains is the one the whole feature rests on:
 * **limits come from Service Quotas, usage comes from CloudWatch**, and neither
 * source knows about the other. `ListServiceQuotas` reports what the account is
 * allowed and never how much is in use; `AWS/Usage` reports what is in use and
 * never the ceiling. Utilization exists only in the join, which is here.
 *
 * A quota row is written by `quota-sync.ts` on the hourly inventory cadence and
 * read on every metric collector tick, so the read path is a primary-key lookup
 * and the write path is a batch upsert.
 */

import { getInfraDb } from './infra-db.js';
import {
  QUOTA_SERVICE_TOKEN,
  quotaHeadroom,
  quotaHeadroomBand,
  quotaUtilizationPercent,
  type QuotaHeadroomBand,
  type QuotaUsageMetric,
} from './quota-catalog.js';

/** One quota, as stored. */
export interface InfraServiceQuotaRow {
  resourceKey: string;
  projectId: string;
  accountId: string;
  region: string;
  serviceCode: string;
  quotaCode: string;
  quotaName: string;
  /** Applied quota value, or null when AWS returned no applied value. */
  value: number | null;
  unit: string | null;
  adjustable: boolean;
  globalQuota: boolean;
  usageMetric: QuotaUsageMetric;
  syncedAt: number;
}

/** A quota to write. */
export type InfraServiceQuotaInput = Omit<InfraServiceQuotaRow, 'syncedAt'>;

const UPSERT_SQL = `
  INSERT INTO infra_service_quotas (
    resource_key, project_id, account_id, region, service_code, quota_code,
    quota_name, value, unit, adjustable, global_quota, usage_metric_json, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (resource_key) DO UPDATE SET
    project_id        = excluded.project_id,
    account_id        = excluded.account_id,
    region            = excluded.region,
    service_code      = excluded.service_code,
    quota_code        = excluded.quota_code,
    quota_name        = excluded.quota_name,
    value             = excluded.value,
    unit              = excluded.unit,
    adjustable        = excluded.adjustable,
    global_quota      = excluded.global_quota,
    usage_metric_json = excluded.usage_metric_json,
    synced_at         = excluded.synced_at`;

/**
 * Upsert a batch of quotas, stamping every row with the same `syncedAt`.
 *
 * One timestamp for the whole batch rather than per row, because the stamp is
 * what {@link pruneInfraServiceQuotas} compares against to find rows this sweep
 * did not refresh. Per-row stamps taken during the loop would straddle the
 * cutoff and prune rows the sweep had just written.
 */
export function upsertInfraServiceQuotas(
  quotas: readonly InfraServiceQuotaInput[],
  syncedAt: number,
): number {
  if (quotas.length === 0) return 0;
  const db = getInfraDb();
  const stmt = db.prepare(UPSERT_SQL);
  const run = db.transaction((rows: readonly InfraServiceQuotaInput[]) => {
    for (const row of rows) {
      stmt.run(
        row.resourceKey,
        row.projectId,
        row.accountId,
        row.region,
        row.serviceCode,
        row.quotaCode,
        row.quotaName,
        row.value,
        row.unit,
        row.adjustable ? 1 : 0,
        row.globalQuota ? 1 : 0,
        JSON.stringify(row.usageMetric),
        syncedAt,
      );
    }
  });
  run(quotas);
  return quotas.length;
}

/**
 * Drop quotas in one (project, account, region) that the latest sweep did not
 * refresh, i.e. that AWS no longer reports as carrying a usage metric.
 *
 * Scoped to the triple the sweep actually covered rather than to the project,
 * because a sweep of `eu-west-1` says nothing about `us-east-1` and a
 * project-wide prune would delete every other region's quotas on every run.
 *
 * Unlike `infra_resources` — where rows are kept after deletion so a chart
 * keeps its subject — a stale quota row is deleted outright. It holds no time
 * series of its own, and keeping it would leave the headroom panel showing a
 * limit that no longer applies, which is worse than showing nothing.
 */
export function pruneInfraServiceQuotas(
  projectId: string,
  accountId: string,
  region: string,
  syncedBefore: number,
): number {
  const result = getInfraDb()
    .prepare(
      `DELETE FROM infra_service_quotas
        WHERE project_id = ? AND account_id = ? AND region = ? AND synced_at < ?`,
    )
    .run(projectId, accountId, region, syncedBefore);
  return result.changes;
}

interface QuotaDbRow {
  resource_key: string;
  project_id: string;
  account_id: string;
  region: string;
  service_code: string;
  quota_code: string;
  quota_name: string;
  value: number | null;
  unit: string | null;
  adjustable: number;
  global_quota: number;
  usage_metric_json: string;
  synced_at: number;
}

function toRow(row: QuotaDbRow): InfraServiceQuotaRow | null {
  let usageMetric: QuotaUsageMetric;
  try {
    usageMetric = JSON.parse(row.usage_metric_json) as QuotaUsageMetric;
  } catch {
    // A row whose pointer will not parse cannot be collected or charted.
    // Skipping it is strictly better than surfacing a quota whose usage can
    // never arrive, and it cannot be repaired here — the next sync rewrites it.
    return null;
  }
  return {
    resourceKey: row.resource_key,
    projectId: row.project_id,
    accountId: row.account_id,
    region: row.region,
    serviceCode: row.service_code,
    quotaCode: row.quota_code,
    quotaName: row.quota_name,
    value: row.value,
    unit: row.unit,
    adjustable: row.adjustable === 1,
    globalQuota: row.global_quota === 1,
    usageMetric,
    syncedAt: row.synced_at,
  };
}

/** Every stored quota for a project, newest sync first. */
export function listInfraServiceQuotas(projectId: string): InfraServiceQuotaRow[] {
  const rows = getInfraDb()
    .prepare(
      `SELECT * FROM infra_service_quotas
        WHERE project_id = ?
        ORDER BY service_code, quota_name`,
    )
    .all(projectId) as QuotaDbRow[];
  return rows.map(toRow).filter((r): r is InfraServiceQuotaRow => r !== null);
}

/** One quota by its resource key, or null. */
export function getInfraServiceQuota(resourceKey: string): InfraServiceQuotaRow | null {
  const row = getInfraDb()
    .prepare('SELECT * FROM infra_service_quotas WHERE resource_key = ?')
    .get(resourceKey) as QuotaDbRow | undefined;
  return row ? toRow(row) : null;
}

/** A quota with its most recent usage reading resolved into headroom. */
export interface InfraQuotaHeadroom {
  resourceKey: string;
  accountId: string;
  region: string;
  serviceCode: string;
  quotaCode: string;
  quotaName: string;
  /** Applied quota, or null when AWS reported no applied value. */
  limit: number | null;
  unit: string | null;
  adjustable: boolean;
  /** Most recent usage reading, or null when nothing has been collected yet. */
  usage: number | null;
  /** Timestamp of that reading, or null. */
  usageAtMs: number | null;
  /** The AWS/Usage metric that measures this quota. */
  metricName: string;
  /** `m1/SERVICE_QUOTA(m1)*100`, or null when undefined. */
  utilizationPercent: number | null;
  /** `limit - usage`, floored at zero, or null when undefined. */
  headroom: number | null;
  band: QuotaHeadroomBand;
}

/**
 * Quotas for a project with the latest usage reading joined in.
 *
 * The usage half is a correlated subquery picking the newest point per quota
 * rather than a join plus `GROUP BY`, because the series is keyed on
 * (resource_key, namespace, metric_name, dimensions_hash, stat, period_s) and a
 * plain join would have to de-duplicate across all six. The `idx_..._chart`
 * index on (project_id, resource_key, metric_name, ts_ms DESC) serves the
 * subquery directly.
 *
 * `staleBeforeMs` bounds how old a reading may be and still count as current. A
 * quota whose newest point predates it reports `usage: null` rather than a
 * stale number, so a collector that stopped running degrades to "unknown"
 * instead of freezing a reassuring figure on the panel forever.
 */
export function listInfraQuotaHeadroom(
  projectId: string,
  opts: { staleBeforeMs?: number } = {},
): InfraQuotaHeadroom[] {
  const staleBeforeMs = opts.staleBeforeMs ?? 0;
  const quotas = listInfraServiceQuotas(projectId);
  if (quotas.length === 0) return [];

  const latest = getInfraDb().prepare(
    `SELECT value, ts_ms
       FROM infra_metric_points
      WHERE project_id = ? AND resource_key = ? AND metric_name = ? AND ts_ms >= ?
      ORDER BY ts_ms DESC
      LIMIT 1`,
  );

  return quotas.map((quota) => {
    const point = latest.get(
      projectId,
      quota.resourceKey,
      quota.usageMetric.metricName,
      staleBeforeMs,
    ) as { value: number; ts_ms: number } | undefined;

    const usage = point ? point.value : null;
    const utilizationPercent = quotaUtilizationPercent(usage, quota.value);
    return {
      resourceKey: quota.resourceKey,
      accountId: quota.accountId,
      region: quota.region,
      serviceCode: quota.serviceCode,
      quotaCode: quota.quotaCode,
      quotaName: quota.quotaName,
      limit: quota.value,
      unit: quota.unit,
      adjustable: quota.adjustable,
      usage,
      usageAtMs: point ? point.ts_ms : null,
      metricName: quota.usageMetric.metricName,
      utilizationPercent,
      headroom: quotaHeadroom(usage, quota.value),
      band: quotaHeadroomBand(utilizationPercent),
    };
  });
}

/** Ordering for the headroom panel: worst first, unknowns last. */
const BAND_ORDER: Record<QuotaHeadroomBand, number> = {
  critical: 0,
  warning: 1,
  ok: 2,
  unknown: 3,
};

/**
 * Sort headroom rows for display: tightest quota first, unknowns after
 * everything measured.
 *
 * Unknowns sort last rather than first despite being "not ok", because they are
 * the steady-state background — a quota nobody has collected yet, or one whose
 * applied value AWS would not report — and floating them to the top would bury
 * the one quota actually near its limit under rows that need no action.
 *
 * Returns a new array; the input is not mutated, so a caller can render more
 * than one ordering from the same read.
 */
export function sortQuotaHeadroom(rows: readonly InfraQuotaHeadroom[]): InfraQuotaHeadroom[] {
  return [...rows].sort((a, b) => {
    const byBand = BAND_ORDER[a.band] - BAND_ORDER[b.band];
    if (byBand !== 0) return byBand;
    // Within a band, higher utilization first. Nulls only occur in `unknown`,
    // where they all tie and fall through to the name for a stable order.
    const au = a.utilizationPercent ?? -1;
    const bu = b.utilizationPercent ?? -1;
    if (au !== bu) return bu - au;
    return a.quotaName.localeCompare(b.quotaName);
  });
}

/** The service token quota resources are inventoried under. */
export { QUOTA_SERVICE_TOKEN };
