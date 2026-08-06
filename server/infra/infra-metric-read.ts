/**
 * infra-metric-read.ts — the pure half of the chart read path (decision
 * INFRA-UI).
 *
 * Three problems live here, all of them IO-free so they can be tested without
 * a database or a clock:
 *
 *   - **Which period a chart is drawn at.** The collector already answers "what
 *     period can CloudWatch still serve this window at" in
 *     {@link resolvePeriod}; a chart asks the same question and must not answer
 *     it differently, or a 90-day view requests 60s data that aged out of
 *     CloudWatch 75 days ago and renders empty. That function is reused rather
 *     than restated — see {@link resolveDisplayPeriod}.
 *
 *   - **Keeping the response bounded.** Reusing the retention tier alone is not
 *     enough locally. The collector polls a 15-minute lookback every tick, so
 *     `resolvePeriod` is *always* evaluated on a fresh window and every stored
 *     point lands at the finest tier — 60s. Reading a 30-day chart back at 60s
 *     is 43,200 rows for one series, well past
 *     {@link MAX_METRIC_POINTS_PER_QUERY}, and the row limit would silently
 *     truncate the far end of the range. The display period is therefore
 *     widened until the window fits in a bounded number of buckets, and the
 *     points are aggregated into those buckets on read.
 *
 *   - **What the alert timeline looked like across that window.** Reconstructed
 *     from the transition history rather than from the alert's current state,
 *     because "this resource is in ALARM now" says nothing about where on the
 *     chart it went bad.
 *
 * Aggregating on read rather than storing rollups is the deliberate side of
 * decision INFRA-STORE: CloudWatch owns the 60s/300s/3600s tiers and we mirror
 * them, so a downsample table here would be a second source of truth for data
 * we do not own. A bucket computed per request is derived, throwaway, and can
 * never drift.
 */

import { resolvePeriod } from './metric-collector.js';
import { isValidCloudWatchPeriod } from './infra-metric-store.js';
import type { InfraAlertRow, InfraAlertTransitionRow } from './alert-store.js';
import type { InfraAlarmState } from './alert-evaluator.js';

/**
 * Longest window a single chart read may ask for.
 *
 * CloudWatch's own longest retention tier is 455 days, so a wider window can
 * only ever be empty on its old end — there is no data behind it to draw.
 * Bounding here is what makes "the server rejects unbounded windows" true of
 * the range as well as of its presence.
 */
export const MAX_METRIC_WINDOW_MS = 455 * 24 * 60 * 60 * 1000;

/**
 * Buckets one chart response may contain.
 *
 * A chart is drawn a few hundred pixels wide, so more points than this cannot
 * be seen — they are only paid for. Held well under
 * {@link MAX_METRIC_POINTS_PER_QUERY} so the bucketed result is bounded by this
 * constant rather than by the store's row cap, which would truncate instead of
 * coarsening.
 */
export const MAX_CHART_BUCKETS = 720;

export interface DisplayPeriodOptions {
  /**
   * The period the series is actually stored at. A series collected at 300s
   * cannot be drawn at 60s, so the display period is never finer than this.
   */
  storedPeriodSeconds?: number | null;
  maxBuckets?: number;
}

/**
 * The period a chart over `[fromMs, toMs]` should be drawn at.
 *
 * Three floors, in order, and the widest wins:
 *
 *   1. {@link resolvePeriod} — CloudWatch's retention tier for a window
 *      reaching back to `fromMs`. Asking finer than the tier the data has aged
 *      into returns nothing at all rather than coarser data, which is the
 *      silent-empty-chart failure this exists to prevent.
 *   2. The series' own stored period. Buckets narrower than the source points
 *      would render as a comb of one-point buckets separated by gaps that look
 *      like outages.
 *   3. Whatever it takes to fit the window in `maxBuckets`.
 *
 * The result is always a multiple of 60 and therefore a period CloudWatch would
 * accept, so a caller can hand it straight back as a `period` filter.
 */
export function resolveDisplayPeriod(
  fromMs: number,
  toMs: number,
  nowMs: number,
  opts: DisplayPeriodOptions = {},
): number {
  const maxBuckets = Math.max(1, Math.floor(opts.maxBuckets ?? MAX_CHART_BUCKETS));
  const retentionTier = resolvePeriod(fromMs, nowMs);
  const stored =
    typeof opts.storedPeriodSeconds === 'number' &&
    isValidCloudWatchPeriod(opts.storedPeriodSeconds)
      ? opts.storedPeriodSeconds
      : 0;

  let period = Math.max(retentionTier, stored);

  // Widen until the window fits. Rounded up to a whole minute so the result
  // stays a period CloudWatch accepts, which is what lets the caller reuse it
  // as a query filter instead of having to re-derive a legal one.
  const spanSeconds = Math.max(0, toMs - fromMs) / 1000;
  const neededSeconds = Math.ceil(spanSeconds / maxBuckets);
  if (neededSeconds > period) period = Math.ceil(neededSeconds / 60) * 60;

  return period;
}

/** How a bucket's member points are combined. Mirrors CloudWatch's own rollup. */
export type BucketAggregation = 'min' | 'max' | 'sum' | 'avg';

/**
 * The aggregation that preserves a statistic's meaning when points are
 * combined into a coarser bucket.
 *
 * A `Maximum` series rolled up by averaging stops being a maximum — the spike
 * the operator is looking for is exactly what the average erases. CloudWatch
 * rolls its own tiers up the same way, so an aggregated bucket here reads as
 * the coarser tier would have.
 *
 * Percentiles (`p99`, `TM(10%:90%)`, …) fall through to the mean: a true
 * percentile-of-percentiles needs the underlying distribution, which we do not
 * store. Averaging is the conventional approximation and is at least
 * order-preserving; taking the max instead would systematically overstate.
 */
export function aggregationForStat(stat: string): BucketAggregation {
  const s = stat.trim().toLowerCase();
  if (s === 'minimum' || s === 'min') return 'min';
  if (s === 'maximum' || s === 'max') return 'max';
  if (s === 'sum' || s === 'samplecount') return 'sum';
  return 'avg';
}

/**
 * The value a bucket draws at, given the statistic its series carries.
 *
 * The bucket arrives from SQL carrying all four aggregates because computing
 * them together costs one scan, and choosing between them is a decision about
 * meaning rather than about storage — so it is made here, next to
 * {@link aggregationForStat}, and unit-tested without a database.
 */
export function selectBucketValue(
  aggregation: BucketAggregation,
  bucket: { minValue: number; maxValue: number; sumValue: number; count: number },
): number {
  if (aggregation === 'min') return bucket.minValue;
  if (aggregation === 'max') return bucket.maxValue;
  if (aggregation === 'sum') return bucket.sumValue;
  return bucket.count > 0 ? bucket.sumValue / bucket.count : 0;
}

/** A stretch of chart time one alert spent in a non-OK state. */
export interface InfraAlarmSegment {
  alertId: string;
  ruleId: string;
  state: InfraAlarmState;
  startMs: number;
  /** Clipped to the window's end while the state is still current. */
  endMs: number;
}

export interface AlertOverlayInput {
  alert: InfraAlertRow;
  /** The alert's transitions in any order; sorted here. */
  transitions: readonly InfraAlertTransitionRow[];
}

/**
 * The non-OK stretches to shade behind the chart, per alert.
 *
 * Reconstructed by walking the transition history forward, not by reading the
 * alert's current state: a chart's job is to show *when* a resource went bad,
 * and the current state answers a different question. The state entering the
 * window is taken from the earliest known transition's `fromState`, so a window
 * that opens mid-ALARM is shaded from its left edge rather than from the moment
 * the next transition happens to land.
 *
 * With no transitions at all the alert's own state is used, but only from
 * `stateUpdatedAt` onward — a rule that first fired an hour ago must not paint
 * the preceding month red.
 *
 * Transition history is trimmed per alert, so the oldest known transition may
 * not be the first one that ever happened. That only costs accuracy before the
 * retained window, which is also before the points the chart can draw.
 *
 * OK stretches are dropped rather than returned: they are the background, and
 * emitting them would double the payload to say nothing.
 */
export function buildInfraAlertOverlay(
  inputs: readonly AlertOverlayInput[],
  fromMs: number,
  toMs: number,
): InfraAlarmSegment[] {
  const segments: InfraAlarmSegment[] = [];

  for (const { alert, transitions } of inputs) {
    const ordered = [...transitions].sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);

    // (state, since) pairs across the whole known timeline, clipped later.
    const spans: Array<{ state: InfraAlarmState; startMs: number }> = [];
    if (ordered.length === 0) {
      spans.push({ state: alert.state, startMs: alert.state_updated_at });
    } else {
      spans.push({ state: ordered[0].from_state, startMs: -Infinity });
      for (const t of ordered) spans.push({ state: t.to_state, startMs: t.at_ms });
    }

    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i];
      if (span.state === 'OK') continue;
      const spanEnd = i + 1 < spans.length ? spans[i + 1].startMs : Infinity;
      const startMs = Math.max(span.startMs, fromMs);
      const endMs = Math.min(spanEnd, toMs);
      // Strictly-empty and inverted overlaps both drop out here. A zero-width
      // segment is a transition that landed exactly on the window edge, which
      // has nothing to shade.
      if (endMs <= startMs) continue;
      segments.push({
        alertId: alert.id,
        ruleId: alert.rule_id,
        state: span.state,
        startMs,
        endMs,
      });
    }
  }

  return segments.sort((a, b) => a.startMs - b.startMs || a.alertId.localeCompare(b.alertId));
}
