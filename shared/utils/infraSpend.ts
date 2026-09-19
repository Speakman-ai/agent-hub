/**
 * Cost Explorer helpers. Server owns the numbers (cached, at most 3×/day);
 * this module only formats. Never round a real charge to "$0.00".
 */

import { formatAgo } from './relativeTime.js';

/** One day of the trend window. `estimated` is AWS's own flag, not ours. */
export interface InfraSpendDay {
  day: string;
  amountUsd: number;
  estimated: boolean;
}

export interface InfraSpendService {
  service: string;
  amountUsd: number;
}

export interface InfraSpendAccount {
  linkedAccount: string;
  amountUsd: number;
}

/** The last Cost Explorer sync attempt, from the shared collect-run audit trail. */
export interface InfraSpendRun {
  startedAt: number;
  finishedAt: number | null;
  status: string;
  pages: number;
  estimatedCostUsd: number;
  errorMessage: string | null;
}

/** The `GET /api/projects/:projectId/infra/spend` body. */
export interface InfraSpendTrendWire {
  enabled: boolean;
  syncedAt: number | null;
  windowStartDay: string;
  windowEndDay: string;
  days: InfraSpendDay[];
  topServices: InfraSpendService[];
  accounts: InfraSpendAccount[];
  totalUsd: number;
  unit: string | null;
  fetchedAt: number | null;
  lastRun: InfraSpendRun | null;
}

/** Cost Explorer opt-in copy. Keep the quoted price identical on every surface. */
export const COST_EXPLORER_OPT_IN_COPY = {
  price:
    'AWS bills Cost Explorer at $0.01 per paginated request, with no free tier. Nothing here is free.',
  cadence:
    'Agent Hub polls it at most 3 times a day, because AWS refreshes billing data at most three times daily. Polling harder would cost more and show the same numbers.',
  estimates: 'The most recent day is always an AWS estimate and will move as charges settle.',
} as const;

/**
 * Never print a sub-cent charge as "$0.00". Non-finite/absent → dash, not zero.
 * Negative amounts (credits) put the sign first (`-$1.50`, not `$-1.50`).
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (magnitude > 0 && magnitude < 0.01) return `${sign}<$0.01`;
  return `${sign}$${magnitude.toFixed(2)}`;
}

/** {@link formatUsd} when `unit` is not USD. */
export function formatMoney(
  value: number | null | undefined,
  unit: string | null | undefined,
): string {
  if (!unit || unit.toUpperCase() === 'USD') return formatUsd(value);
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (magnitude > 0 && magnitude < 0.01) return `${sign}<0.01 ${unit}`;
  return `${sign}${magnitude.toFixed(2)} ${unit}`;
}

export interface InfraSpendBar {
  /** The first day in this column, so a caller can label or key it. */
  day: string;
  /** Summed spend across the column's days. */
  amountUsd: number;
  /** Column height as a 0..1 fraction of the tallest column. */
  height: number;
  /** True when any day in the column is still an AWS estimate. */
  estimated: boolean;
}

export interface InfraSpendBars {
  bars: InfraSpendBar[];
  /** True when at least one day carries a non-zero charge. */
  hasData: boolean;
  /** The tallest column's amount, which is what `height` is a fraction of. */
  maxUsd: number;
}

/**
 * Bucket days into at most `barCount` columns. Sum days (do not average).
 * Scale from zero, not the series min. Fewer than `barCount` bars is normal.
 */
export function buildSpendBars(
  days: readonly InfraSpendDay[] | null | undefined,
  barCount: number,
): InfraSpendBars {
  const columns = Math.max(1, Math.floor(barCount) || 1);
  const source = (Array.isArray(days) ? days : []).filter(
    (entry): entry is InfraSpendDay => !!entry && typeof entry.day === 'string',
  );
  if (source.length === 0) return { bars: [], hasData: false, maxUsd: 0 };

  const perColumn = Math.ceil(source.length / columns);
  const buckets: Array<{ day: string; amountUsd: number; estimated: boolean }> = [];
  for (let start = 0; start < source.length; start += perColumn) {
    const bucket = source.slice(start, start + perColumn);
    let amountUsd = 0;
    let estimated = false;
    for (const entry of bucket) {
      if (Number.isFinite(entry.amountUsd)) amountUsd += entry.amountUsd;
      if (entry.estimated) estimated = true;
    }
    buckets.push({ day: bucket[0].day, amountUsd, estimated });
  }

  // Floor at zero so a window of credits cannot invert the scale.
  const maxUsd = buckets.reduce((max, bucket) => Math.max(max, bucket.amountUsd), 0);
  const bars = buckets.map((bucket) => ({
    ...bucket,
    height: maxUsd > 0 ? Math.min(1, Math.max(0, bucket.amountUsd / maxUsd)) : 0,
  }));

  return {
    bars,
    // All zeros is a real answer (nothing billed), not a blank plot.
    hasData: source.some((entry) => Number.isFinite(entry.amountUsd) && entry.amountUsd !== 0),
    maxUsd,
  };
}

/** Residual treated as float noise. A genuine sub-cent tail still surfaces. */
const SPEND_RESIDUAL_EPSILON = 1e-6;

export interface InfraSpendSummary {
  totalUsd: number;
  /** The largest single service in the window, or null when none are cached. */
  topService: InfraSpendService | null;
  dayCount: number;
  /** The newest cached day is an AWS estimate, so the total will still move. */
  latestEstimated: boolean;
  /** Window total minus listed services, floored at zero. */
  otherUsd: number;
  unit: string | null;
}

/**
 * Derived panel figures. `otherUsd` is total minus top services, floored at zero
 * so float drift never produces a negative "Other".
 */
export function spendTrendSummary(
  trend:
    | {
        days?: readonly InfraSpendDay[] | null;
        topServices?: readonly InfraSpendService[] | null;
        totalUsd?: number | null;
        unit?: string | null;
      }
    | null
    | undefined,
): InfraSpendSummary {
  const days = (Array.isArray(trend?.days) ? trend?.days : []) as readonly InfraSpendDay[];
  const services = (
    Array.isArray(trend?.topServices) ? trend?.topServices : []
  ) as readonly InfraSpendService[];
  const totalUsd = Number.isFinite(trend?.totalUsd) ? (trend?.totalUsd as number) : 0;

  const listed = services.reduce(
    (sum, service) => sum + (Number.isFinite(service?.amountUsd) ? service.amountUsd : 0),
    0,
  );
  const residual = totalUsd - listed;
  const latest = days.length > 0 ? days[days.length - 1] : null;

  return {
    totalUsd,
    topService: services.length > 0 ? services[0] : null,
    dayCount: days.length,
    latestEstimated: !!latest?.estimated,
    otherUsd: residual > SPEND_RESIDUAL_EPSILON ? residual : 0,
    unit: trend?.unit ?? null,
  };
}

/** How long ago, in the few words a status line has room for. */

/**
 * Cache freshness in words. Hours-old is normal (at most 3 polls/day).
 * Prefer `fetchedAt` (numbers written) over `syncedAt` (attempt started).
 */
export function spendStalenessLabel(
  syncedAt: number | null | undefined,
  fetchedAt: number | null | undefined,
  nowMs: number,
): string {
  if (fetchedAt !== null && fetchedAt !== undefined && Number.isFinite(fetchedAt)) {
    return `Updated ${formatAgo(nowMs - fetchedAt)}`;
  }
  if (syncedAt !== null && syncedAt !== undefined && Number.isFinite(syncedAt)) {
    return `Checked ${formatAgo(nowMs - syncedAt)}, nothing cached yet`;
  }
  return 'Never synced';
}

/**
 * Extra sentence when a failed sync needs more than the raw error.
 * `DataUnavailable` means Cost Explorer was never enabled in the payer account.
 */
export function spendFailureHint(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) return null;
  if (!/DataUnavailable/i.test(errorMessage)) return null;
  return 'Cost Explorer has never been enabled in this AWS account. The account owner has to turn it on once in the Billing console (it can take up to 24 hours to populate). No IAM permission change will fix this.';
}
