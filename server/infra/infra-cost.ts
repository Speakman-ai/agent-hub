/**
 * infra-cost.ts — the pure arithmetic behind decision INFRA-COST.
 *
 * "Treat AWS API spend as a first-class, visible, capped resource — not an
 * emergent property of the poll loop. Monitoring tools that surprise you with a
 * bill get turned off."
 *
 * Everything here is IO-free and deterministic so the three places that must
 * agree on the number cannot drift:
 *
 *   1. the **scope editor**, which shows a projected monthly cost *before* the
 *      operator saves — the number that changes behaviour is the one shown at
 *      decision time, not the one on next month's bill;
 *   2. the **collector**, which decides on each tick which metrics are due and
 *      whether the project has spent past its ceiling;
 *   3. the **cost endpoint**, which reports spend-to-date against that same
 *      projection.
 *
 * The store half (reading `infra_collect_runs`, persisting the ceiling and the
 * degradation level) lives in `infra-cost-store.ts`.
 *
 * ## Rounding direction
 *
 * Every estimate here rounds *against* the operator's wallet: a projection that
 * under-reports produces the surprise bill this module exists to prevent, and a
 * ceiling computed from an under-report is a ceiling that does not hold. Where
 * a choice exists — days in a month, statistics bundled onto one metric — the
 * more expensive reading wins.
 */

import {
  getServiceMetricPack,
  effectiveServicePollIntervalSeconds,
  type InfraMetricSpec,
} from './service-metric-packs.js';

// ─── Published AWS prices ───────────────────────────────────────────────────

/**
 * `GetMetricData` list price per 1,000 metrics requested — the rate 33 of the
 * 36 regions publishing this usage type charge.
 *
 * This is **not** the fallback for an unrecognised region; see
 * {@link GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION} for why the cheapest rate
 * is the wrong default for a spend guardrail.
 *
 * This operation is billed from the first call. The CloudWatch free tier grants
 * "1 Million API requests (not including GetMetricData, GetInsightRuleReport and
 * GetMetricWidgetImage: these 3 operations are always charged)" — verified
 * against the CloudWatch pricing page, August 2026.
 */
export const GET_METRIC_DATA_USD_PER_1000_METRICS = 0.01;

/**
 * `GetMetricData` price per 1,000 metrics requested, per region.
 *
 * AWS states plainly that "Pricing varies by Region", so this is a complete
 * enumeration rather than a list rate with a couple of exceptions bolted on.
 * Every entry is machine-extracted from the **AWS Price List API** — for each
 * region code in `AmazonCloudWatch/current/region_index.json`, the on-demand
 * price dimension of the SKU whose `operation` attribute is `GetMetricData`.
 * Verified against price-list version `20260803161723` (August 2026); three
 * distinct rates exist, $0.01, $0.013 (GovCloud) and $0.014 (São Paulo).
 *
 * `us-west-2-lax-1` is deliberately absent: the Los Angeles Local Zone
 * publishes no `GetMetricData` SKU at all, so there is no price to record and
 * the conservative fallback is the honest answer for it.
 *
 * Regenerate by re-running the extraction against the current price list when
 * AWS launches a region; a missing region is priced conservatively in the
 * meantime, so this table going stale over-charges rather than under-charges.
 */
export const GET_METRIC_DATA_USD_PER_1000_BY_REGION: Readonly<Record<string, number>> =
  Object.freeze({
    'af-south-1': 0.01,
    'ap-east-1': 0.01,
    'ap-east-2': 0.01,
    'ap-northeast-1': 0.01,
    'ap-northeast-2': 0.01,
    'ap-northeast-3': 0.01,
    'ap-south-1': 0.01,
    'ap-south-2': 0.01,
    'ap-southeast-1': 0.01,
    'ap-southeast-2': 0.01,
    'ap-southeast-3': 0.01,
    'ap-southeast-4': 0.01,
    'ap-southeast-5': 0.01,
    'ap-southeast-6': 0.01,
    'ap-southeast-7': 0.01,
    'ca-central-1': 0.01,
    'ca-west-1': 0.01,
    'eu-central-1': 0.01,
    'eu-central-2': 0.01,
    'eu-north-1': 0.01,
    'eu-south-1': 0.01,
    'eu-south-2': 0.01,
    'eu-west-1': 0.01,
    'eu-west-2': 0.01,
    'eu-west-3': 0.01,
    'il-central-1': 0.01,
    'me-central-1': 0.01,
    'me-south-1': 0.01,
    'mx-central-1': 0.01,
    'sa-east-1': 0.014,
    'us-east-1': 0.01,
    'us-east-2': 0.01,
    'us-gov-east-1': 0.013,
    'us-gov-west-1': 0.013,
    'us-west-1': 0.01,
    'us-west-2': 0.01,
  });

/**
 * Price used for a region absent from {@link GET_METRIC_DATA_USD_PER_1000_BY_REGION}.
 *
 * The **highest** rate AWS currently charges anywhere, not the list rate, and
 * derived from the table so a future region priced above São Paulo raises it
 * automatically instead of silently sitting below the new maximum.
 *
 * Defaulting an unknown region to the cheapest rate is precisely the error this
 * module warns against everywhere else: it is a guardrail knowingly
 * under-reporting spend. A region we have never heard of is one AWS launched
 * after this table was cut, and pricing it optimistically would let a ceiling
 * be breached by up to 40% before the collector noticed. Over-charging an
 * unknown region costs the operator a projection that reads high — visible, and
 * corrected the moment the table is refreshed. Under-charging costs them a bill
 * they were never shown.
 */
export const GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION = Math.max(
  ...Object.values(GET_METRIC_DATA_USD_PER_1000_BY_REGION),
);

/**
 * `GetMetricData` price per 1,000 metrics requested in a region.
 *
 * An unrecognised or absent region is priced at
 * {@link GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION} — the most expensive rate
 * AWS charges — so an estimate is never knowingly low.
 */
export function getMetricDataPricePer1000(region?: string | null): number {
  if (!region) return GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION;
  return (
    GET_METRIC_DATA_USD_PER_1000_BY_REGION[region] ?? GET_METRIC_DATA_USD_PER_1000_UNKNOWN_REGION
  );
}

/** Whether a region's `GetMetricData` price is known, or conservatively assumed. */
export function isKnownMetricDataRegion(region?: string | null): boolean {
  return !!region && region in GET_METRIC_DATA_USD_PER_1000_BY_REGION;
}

/**
 * Days used to turn a per-second rate into a monthly figure.
 *
 * 31, not 30 and not the 30.44-day average, because this number is compared
 * against a spend ceiling. The average is right on average and wrong in exactly
 * the direction that matters — it would let a scope whose real cost lands at
 * 31/30.44 of the projection slip under a ceiling the operator set from that
 * projection. Over-stating February by 11% is the cheap error.
 */
export const PROJECTION_DAYS_PER_MONTH = 31;

/** Seconds in the projection month. */
export const PROJECTION_SECONDS_PER_MONTH = PROJECTION_DAYS_PER_MONTH * 24 * 60 * 60;

// ─── Cost of a quantity of requests ─────────────────────────────────────────

/**
 * Metrics *requested* — the quantity AWS bills — converted to dollars.
 *
 * Counted per request issued, pagination pages included: each page re-sends the
 * full query set, so each page is charged.
 *
 * AWS bundles statistics on the same metric: *"Each request can include up to
 * five statistics for a single metric. If you need more than five statistics for
 * the same metric, each additional set of up to five statistics counts as a
 * separate metric request."* We do not model that bundling, which over-estimates
 * a pack polling one metric on several stats — and over-estimating is the
 * correct direction for a spend guardrail. It is also nearly inert here: a
 * service pack names one statistic per metric entry (`stat` is part of the
 * stored series key), so the bundle is a bundle of one in every pack shipped so
 * far.
 */
export function estimateGetMetricDataCostUsd(
  metricsRequested: number,
  region?: string | null,
): number {
  if (!Number.isFinite(metricsRequested) || metricsRequested <= 0) return 0;
  return (metricsRequested / 1000) * getMetricDataPricePer1000(region);
}

// ─── Cost Explorer ──────────────────────────────────────────────────────────

/**
 * `GetCostAndUsage` list price, per **paginated request**.
 *
 * Not per call, not per day, not per 1,000 of anything: AWS charges "$0.01 per
 * paginated request", and every page of a paginated response is its own billed
 * request. A loop that follows `NextPageToken` five times has spent five cents,
 * not one — verified against the Cost Explorer pricing page, August 2026. This
 * is why {@link estimateCostExplorerCostUsd} takes a page count and why the
 * poller flushes a cent onto its run row as each page returns rather than once
 * at the end.
 *
 * There is **no free tier**. Unlike the CloudWatch API, where a million calls a
 * month are free and only three operations are carved out of it, Cost Explorer
 * bills from the first request. That asymmetry is the whole reason this feature
 * is behind an explicit per-project opt-in while metric collection is not.
 *
 * Region does not apply — Cost Explorer is a single global endpoint
 * (`ce.us-east-1.amazonaws.com`), so unlike `GetMetricData` there is no
 * per-region rate table to consult.
 *
 * Custom billing views are the one documented multiplier: a request against a
 * view combining N sources is billed $0.01 *per source*. We never construct one
 * (no `BillingViewArn` is ever sent, so every request runs against the primary
 * view at exactly one source), which is worth stating because adding that
 * parameter later would silently multiply this constant.
 */
export const COST_EXPLORER_USD_PER_REQUEST = 0.01;

/**
 * Dollars for a number of `GetCostAndUsage` pages.
 *
 * Takes pages rather than logical queries so the caller cannot accidentally
 * under-report a paginated sweep — the mistake this signature exists to make
 * impossible.
 */
export function estimateCostExplorerCostUsd(pages: number): number {
  if (!Number.isFinite(pages) || pages <= 0) return 0;
  return pages * COST_EXPLORER_USD_PER_REQUEST;
}

/**
 * Most often a project's Cost Explorer cache may be refreshed, in seconds.
 *
 * Eight hours, which is three times a day — the exact cadence AWS's own
 * best-practices page describes: *"AWS billing information is updated up to
 * three times daily. Typical workloads and use cases for the Cost Explorer API
 * anticipate a call pattern cadence ranging from daily to several times per
 * day."* Polling faster does not produce fresher numbers, it only produces a
 * bigger bill, which is the exact failure mode decision INFRA-COST exists to
 * prevent.
 */
export const COST_EXPLORER_SYNC_INTERVAL_S = 8 * 60 * 60;

/**
 * Days of history one sync fetches, and the default window the spend endpoint
 * reports.
 *
 * Thirty, matching the default metric retention in decision INFRA-STORE, so the
 * spend chart and the metric charts span the same window and can be read side by
 * side. Cost Explorer can serve 13 months, and a wider window costs no more in
 * *requests* — but it does return more groups, more groups is more pages, and
 * pages are what is billed.
 *
 * It lives in this module rather than in the poller because three places have to
 * agree on it: the poller that fills the cache, the REST schema that defaults
 * the query param, and the handler that computes the window. Declaring it three
 * times is how a read window quietly stops matching the written one, and the
 * symptom is a chart that is simply missing its oldest days.
 */
export const COST_EXPLORER_LOOKBACK_DAYS = 30;

/**
 * Floor the sync enforces between two runs, in milliseconds.
 *
 * Seven hours against an eight-hour cadence. The hour of slack is for cron
 * jitter and for a Hub that restarted a few minutes before its scheduled tick;
 * without it a legitimate run drifting early would be refused and the cache
 * would skip a whole third of the day. The gap is still far too small for a
 * fourth run to fit inside a day, which is the property being defended.
 */
export const MIN_COST_EXPLORER_SYNC_INTERVAL_MS = 7 * 60 * 60 * 1000;

// ─── Poll interval resolution ───────────────────────────────────────────────

/**
 * The collector's own tick cadence in seconds, mirroring `INFRA_COLLECT_CRON`.
 *
 * Declared here rather than imported from the collector because the projection
 * runs in the REST layer, and importing the collector for one number would drag
 * the AWS SDK and the database handle into a request path that needs neither.
 * `metric-collector.test.ts` asserts the two stay equal.
 */
export const COLLECTOR_TICK_INTERVAL_S = 300;

/** How much the interval is stretched once spend passes the ceiling. */
export const WIDENED_INTERVAL_MULTIPLIER = 4;

/** Levels the collector can be in for a project, cheapest response first. */
export type InfraCostDegradation = 'normal' | 'widened' | 'paused';

/**
 * Multiple of the ceiling at which widening stops being enough and the
 * collector stops entirely.
 *
 * Widening buys time — it does not stop the meter — so there has to be a second
 * threshold or "degrades gracefully" would just be "overspends more slowly".
 */
export const PAUSE_CEILING_MULTIPLE = 2;

export interface PollIntervalOptions {
  /** Collector cadence; nothing can be requested more often than this. */
  tickIntervalSeconds?: number;
  /** Current degradation level. `paused` is handled by the caller, not here. */
  degradation?: InfraCostDegradation;
}

/**
 * How often one metric on one service is actually requested, all three
 * constraints applied.
 *
 * The three, in the order they bind:
 *
 *   - the **service tier** — how fresh this signal needs to be;
 *   - the **metric's emission floor** — `minPeriodSeconds`, below which extra
 *     requests are billed for data CloudWatch has not published yet;
 *   - the **collector tick** — nothing can be asked for more often than the
 *     loop that asks.
 *
 * `widened` multiplies the result rather than replacing it, so degradation
 * preserves the relative cadence between a 1-minute signal and a daily one
 * instead of flattening every service onto one slow interval.
 */
export function effectivePollIntervalSeconds(
  service: string,
  spec: InfraMetricSpec,
  opts: PollIntervalOptions = {},
): number {
  const tick = opts.tickIntervalSeconds ?? COLLECTOR_TICK_INTERVAL_S;
  const base = Math.max(effectiveServicePollIntervalSeconds(service, spec), tick);
  return opts.degradation === 'widened' ? base * WIDENED_INTERVAL_MULTIPLIER : base;
}

/**
 * Whether an interval boundary fell inside the tick window that just closed.
 *
 * Stateless on purpose. The alternative — a per-metric `last_collected_at`
 * column — would add a write per metric per tick to save an arithmetic
 * comparison, and would drift the moment a tick was skipped or a row was
 * missing. Bucketing the wall clock instead means a metric on a 24-hour
 * interval fires on exactly one tick per day whether or not the process
 * restarted in between, and needs no state to do it.
 *
 * An interval at or below the tick cadence is due on every tick, which is the
 * only honest answer: the loop cannot fire more often than it fires.
 */
export function isMetricDue(intervalMs: number, nowMs: number, tickIntervalMs: number): boolean {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return true;
  if (intervalMs <= tickIntervalMs) return true;
  return Math.floor(nowMs / intervalMs) !== Math.floor((nowMs - tickIntervalMs) / intervalMs);
}

/** Requests per projection month at a given interval, rounded up. */
export function ticksPerMonth(intervalSeconds: number): number {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return 0;
  return Math.ceil(PROJECTION_SECONDS_PER_MONTH / intervalSeconds);
}

// ─── Monthly projection ─────────────────────────────────────────────────────

/** One (service, resource count) pair the projection prices. */
export interface ProjectedScope {
  /** Service token, e.g. `ec2`. A service with no metric pack costs nothing. */
  service: string;
  /** Resources the scope currently matches. */
  resourceCount: number;
  /** Echoed back on the per-scope breakdown so the editor can label rows. */
  id?: string;
  profileName?: string;
  region?: string;
}

/** What one scope contributes to the monthly bill. */
export interface ProjectedScopeCost {
  id?: string;
  service: string;
  profileName?: string;
  region?: string;
  resourceCount: number;
  /** Metrics in the service's pack. Zero means the service is not collected. */
  metricsPerResource: number;
  metricsRequestedPerMonth: number;
  estimatedMonthlyCostUsd: number;
  /** `GetMetricData` rate per 1,000 metrics this scope was priced at. */
  usdPer1000Metrics: number;
  /**
   * False when the region is absent from the published price table and the
   * dearest known rate was assumed instead.
   *
   * Surfaced rather than left implicit: the conservative fallback inflates the
   * figure by up to 40%, and an operator who cannot see *why* their estimate
   * jumped has been given a number they can only distrust. It also tells them
   * the fix — refresh the price table for the region AWS just launched.
   */
  regionPriceKnown: boolean;
  /** Per-metric cadence after tier, emission floor and tick are all applied. */
  intervals: ProjectedMetricInterval[];
}

export interface ProjectedMetricInterval {
  metricName: string;
  namespace: string;
  stat: string;
  /** The metric's own publication rate — the floor the tier cannot beat. */
  minPeriodSeconds: number;
  /** What the collector will actually request it at. */
  pollIntervalSeconds: number;
  requestsPerMonth: number;
}

export interface MonthlyCostProjection {
  metricsRequestedPerMonth: number;
  estimatedMonthlyCostUsd: number;
  perScope: ProjectedScopeCost[];
}

/**
 * Projected monthly AWS API cost for a set of scopes — resources × metrics ×
 * ticks per month.
 *
 * This is the number decision INFRA-COST requires the scope editor to show
 * **before** the operator saves. It is deliberately computed per *metric*
 * rather than per service: a service whose pack mixes a 1-minute signal with a
 * 5-minute one does not have a single cadence, and pricing it at either one is
 * wrong by a factor of five in one direction or the other.
 *
 * A service with no metric pack contributes zero, because the collector will
 * not query it — a scope on an uncollectable service is inert, and showing it a
 * price would imply otherwise.
 */
export function projectMonthlyApiCost(
  scopes: readonly ProjectedScope[],
  opts: PollIntervalOptions = {},
): MonthlyCostProjection {
  const perScope: ProjectedScopeCost[] = [];
  let metricsRequestedPerMonth = 0;
  // Summed from the per-scope dollars rather than from the metric total, because
  // the price is regional: two scopes on the same services in us-east-1 and
  // sa-east-1 have identical metric counts and a 40% different bill.
  let estimatedMonthlyCostUsd = 0;

  for (const scope of scopes) {
    const pack = getServiceMetricPack(scope.service);
    // Negative or non-finite counts are treated as zero rather than rejected:
    // this runs on operator keystrokes in the editor, where a half-typed value
    // must render a number, not an exception.
    const resourceCount =
      Number.isFinite(scope.resourceCount) && scope.resourceCount > 0
        ? Math.floor(scope.resourceCount)
        : 0;

    const intervals: ProjectedMetricInterval[] = [];
    let scopeMetrics = 0;
    for (const spec of pack) {
      const pollIntervalSeconds = effectivePollIntervalSeconds(scope.service, spec, opts);
      const requestsPerMonth = ticksPerMonth(pollIntervalSeconds);
      scopeMetrics += resourceCount * requestsPerMonth;
      intervals.push({
        metricName: spec.metricName,
        namespace: spec.namespace,
        stat: spec.stat,
        minPeriodSeconds: spec.minPeriodSeconds,
        pollIntervalSeconds,
        requestsPerMonth,
      });
    }

    const scopeCostUsd = estimateGetMetricDataCostUsd(scopeMetrics, scope.region);
    metricsRequestedPerMonth += scopeMetrics;
    estimatedMonthlyCostUsd += scopeCostUsd;
    perScope.push({
      id: scope.id,
      service: scope.service,
      profileName: scope.profileName,
      region: scope.region,
      resourceCount,
      metricsPerResource: pack.length,
      metricsRequestedPerMonth: scopeMetrics,
      estimatedMonthlyCostUsd: scopeCostUsd,
      usdPer1000Metrics: getMetricDataPricePer1000(scope.region),
      regionPriceKnown: isKnownMetricDataRegion(scope.region),
      intervals,
    });
  }

  return { metricsRequestedPerMonth, estimatedMonthlyCostUsd, perScope };
}

// ─── Ceiling ────────────────────────────────────────────────────────────────

/**
 * What the collector should do for a project given what it has spent this month.
 *
 * A `null` ceiling is uncapped, and that is the default. Scoping is already an
 * explicit opt-in whose projected monthly cost is shown at decision time, so an
 * implicit ceiling nobody chose would pause monitoring the operator deliberately
 * turned on — trading a silent monitoring outage for a bill they had already
 * been quoted. A ceiling of **0** is a real setting distinct from `null`, and it
 * means "collect nothing".
 *
 * The two thresholds are `>=`, not `>`: at exactly the ceiling the budget is
 * spent, and the next request is the one that exceeds it.
 */
export function resolveCostDegradation(
  monthToDateUsd: number,
  ceilingUsd: number | null | undefined,
): InfraCostDegradation {
  if (ceilingUsd === null || ceilingUsd === undefined || !Number.isFinite(ceilingUsd)) {
    return 'normal';
  }
  if (ceilingUsd < 0) return 'normal';
  const spend = Number.isFinite(monthToDateUsd) ? monthToDateUsd : 0;
  // A zero ceiling has no band to widen into — zero spend is already at it, and
  // every multiple of it is still zero. It means "collect nothing", so it pauses
  // immediately rather than passing through a `widened` state that would keep
  // issuing billed requests against a budget of nothing.
  if (ceilingUsd === 0) return 'paused';
  if (spend >= ceilingUsd * PAUSE_CEILING_MULTIPLE) return 'paused';
  if (spend >= ceilingUsd) return 'widened';
  return 'normal';
}

/** First epoch ms of the UTC calendar month containing `nowMs`. */
export function monthStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * First epoch ms of the UTC month *after* the one containing `nowMs`.
 *
 * The exclusive upper bound of a billing month, so every run row is attributed
 * to exactly one month.
 */
export function nextMonthStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Straight-line extrapolation of this month's spend to the month's end.
 *
 * Deliberately naive: it assumes the rest of the month looks like the part
 * already observed. That is wrong the moment a scope is added mid-month, which
 * is exactly why {@link projectMonthlyApiCost} exists alongside it — the
 * scope-derived projection answers "what will this configuration cost", and this
 * answers "what is the current configuration on track for", and an operator
 * needs both to tell a config change from a traffic change.
 *
 * Guarded against the first seconds of a month, where dividing by a near-zero
 * elapsed fraction would extrapolate a single tick into an astronomical figure.
 */
export function extrapolateMonthlySpendUsd(
  monthToDateUsd: number,
  nowMs: number,
  monthStart: number = monthStartMs(nowMs),
): number {
  const elapsedMs = nowMs - monthStart;
  const oneHourMs = 60 * 60 * 1000;
  if (!Number.isFinite(monthToDateUsd) || monthToDateUsd <= 0) return 0;
  if (elapsedMs < oneHourMs) return monthToDateUsd;
  const monthMs = nextMonthStartMs(monthStart) - monthStart;
  return (monthToDateUsd / elapsedMs) * monthMs;
}
