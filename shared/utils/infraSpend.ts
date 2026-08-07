/**
 * Framework-free Cost Explorer helpers shared by the web Infrastructure module
 * and the mobile Infrastructure screen.
 *
 * The peer of `infraMetrics.ts`, and here for the same reason: the parts that
 * decide *what* an operator reads about their AWS bill must be one
 * implementation, because the two surfaces drifting on a money figure is a
 * worse bug than either surface being ugly. A phone that rounds a real charge
 * to "$0.00" while the desktop shows "<$0.01" is the concrete case.
 *
 * What is deliberately NOT here is any pixel mapping beyond a 0..1 fraction.
 * Web hands geometry to an SVG viewbox and mobile stacks plain `View`s, so a
 * shared coordinate space would force one of them to lie about its own
 * dimensions (the same split `infraMetrics.ts` documents).
 *
 * Note on the numbers: the server owns them. `GET /infra/spend` reads a cache
 * that a cron fills at most three times a day, and nothing in this module
 * recomputes, extrapolates, or freshens anything. Staleness is therefore a
 * value to render, not a fault to report.
 */

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

/**
 * The price of the API this feature turns on, in one place.
 *
 * Shared rather than retyped per surface because it is the sentence that has to
 * change an operator's mind before they opt in (the same requirement decision
 * INFRA-COST puts on the scope editor's projection). Two surfaces quoting
 * different prices for the same billed call is how one of them stops being
 * believed.
 */
export const COST_EXPLORER_OPT_IN_COPY = {
  price:
    'AWS bills Cost Explorer at $0.01 per paginated request, with no free tier. Nothing here is free.',
  cadence:
    'Agent Hub polls it at most 3 times a day, because AWS refreshes billing data at most three times daily. Polling harder would cost more and show the same numbers.',
  estimates: 'The most recent day is always an AWS estimate and will move as charges settle.',
} as const;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Money, never rounded down to "free".
 *
 * A sub-cent charge printed as "$0.00" reads as "this costs nothing", which is
 * the one thing a figure about a billed API must never imply. Non-finite and
 * absent values render as a dash rather than a zero for the same reason: an
 * amount that could not be read is unknown, not free.
 *
 * Negative amounts are real (Cost Explorer reports credits and refunds), so the
 * sign leads rather than landing between the symbol and the digits, where
 * "$-1.50" invites a misread.
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (magnitude > 0 && magnitude < 0.01) return `${sign}<$0.01`;
  return `${sign}$${magnitude.toFixed(2)}`;
}

/**
 * {@link formatUsd} for a window whose `unit` is not USD.
 *
 * Cost Explorer answers in the payer account's currency, so a caller that hard
 * codes a dollar sign relabels someone's euro bill. The dollar path is kept
 * verbatim (it is by far the common case and the symbol reads better than a
 * suffix); anything else gets the code after the number, which is how currency
 * codes are normally written when no symbol is known.
 */
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
 * Bucket a day series into at most `barCount` columns for a bar-style plot.
 *
 * Two things differ from `buildMetricBars` in `infraMetrics.ts`, both because
 * this is money rather than a gauge:
 *
 * Days are summed, not averaged. A column covering three days of a long window
 * represents what those three days cost together; a mean would answer a
 * question nobody asked and would not add up to the total shown beside it.
 *
 * The vertical scale is anchored at zero rather than at the series minimum, so
 * `normalizeValueRange` is deliberately not reused here. That helper pads a
 * flat series to sit mid-plot, which is right for a CPU percentage and wrong
 * for a bill: with a $50 floor a $50 day would draw as no bar at all, and the
 * difference between a $95 day and a $100 day would fill the plot. Bar length
 * is read as an amount, so the baseline has to be the amount zero.
 *
 * Fewer than `barCount` columns is normal and intended. A 30 day window on a
 * 40 column plot draws 30 bars rather than padding with 10 empty days that are
 * outside the window and were never billed.
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

  // Floored at zero so a window of pure credits cannot invert the scale and
  // draw the least negative day as the tallest bar.
  const maxUsd = buckets.reduce((max, bucket) => Math.max(max, bucket.amountUsd), 0);
  const bars = buckets.map((bucket) => ({
    ...bucket,
    height: maxUsd > 0 ? Math.min(1, Math.max(0, bucket.amountUsd / maxUsd)) : 0,
  }));

  return {
    bars,
    // "Some days are cached but every one of them is zero" is a real answer
    // (nothing was billed), and it deserves a sentence rather than a plot of
    // flat bars that looks like a rendering failure.
    hasData: source.some((entry) => Number.isFinite(entry.amountUsd) && entry.amountUsd !== 0),
    maxUsd,
  };
}

/**
 * Residual below which the top-N remainder is treated as rounding noise.
 *
 * Summing a handful of doubles leaves errors around 1e-13, and an "Other" row
 * reading "<$0.01" on a list that is actually complete teaches operators to
 * ignore the row. Set far below any charge AWS would ever report, so a genuine
 * sub-cent tail still surfaces.
 */
const SPEND_RESIDUAL_EPSILON = 1e-6;

export interface InfraSpendSummary {
  totalUsd: number;
  /** The largest single service in the window, or null when none are cached. */
  topService: InfraSpendService | null;
  dayCount: number;
  /** The newest cached day is an AWS estimate, so the total will still move. */
  latestEstimated: boolean;
  /**
   * Window total minus the listed services, floored at zero. Non-zero means the
   * ranked list is truncated and the sum of its rows is less than the bill.
   */
  otherUsd: number;
  unit: string | null;
}

/**
 * The derived figures both panels need, computed once.
 *
 * `otherUsd` exists so neither surface has to re-derive it. The server's
 * `totalUsd` covers the whole window including the tail that `topServices`
 * truncates, so a panel that renders the ranked list alone understates the
 * bill by exactly this amount, silently. Floored at zero because the total and
 * the per-service rows come from different aggregations and float drift must
 * never produce a negative "Other".
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
function formatAgo(deltaMs: number): string {
  // A negative delta is clock skew between the server's timestamp and the
  // device's clock, not a cache from the future.
  if (!Number.isFinite(deltaMs) || deltaMs < MINUTE) return 'just now';
  if (deltaMs < HOUR) return `${Math.floor(deltaMs / MINUTE)}m ago`;
  if (deltaMs < 2 * DAY) return `${Math.floor(deltaMs / HOUR)}h ago`;
  return `${Math.floor(deltaMs / DAY)}d ago`;
}

/**
 * How fresh the cached spend is, in words.
 *
 * Phrased as a plain statement rather than a warning on purpose. The sync runs
 * at most three times a day by design (AWS updates billing data no more often
 * than that, and every extra poll is another billed cent), so several hours old
 * is the normal state of this cache and must not be dressed up as a fault.
 *
 * `fetchedAt` leads because it is when numbers were actually written.
 * `syncedAt` only says when an attempt began, and the two diverge exactly when
 * the last attempt failed; reporting that one as "Updated" would claim a
 * freshness the data does not have.
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
 * The extra sentence a failed sync needs, when the error message alone is not
 * actionable.
 *
 * `DataUnavailable` is the case worth special-casing: it means Cost Explorer was
 * never switched on in the payer account, which is a one-time click in the
 * Billing console by the account owner. No IAM policy, role, or credential
 * change fixes it, so an operator who reads the raw message will spend the
 * afternoon widening permissions that were never the problem.
 */
export function spendFailureHint(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) return null;
  if (!/DataUnavailable/i.test(errorMessage)) return null;
  return 'Cost Explorer has never been enabled in this AWS account. The account owner has to turn it on once in the Billing console (it can take up to 24 hours to populate). No IAM permission change will fix this.';
}
