/**
 * Framework-free metric helpers shared by the web Infrastructure module and the
 * mobile Infrastructure screen.
 *
 * The two surfaces draw the same series with different primitives — web hands
 * the geometry to an SVG viewbox, mobile stacks plain `View`s — but the parts
 * that decide *what* the operator reads are identical, and duplicating them is
 * how the two drift: a window the web offers and mobile does not, or an axis
 * label that rounds differently on a phone. Those live here.
 *
 * What is deliberately NOT here is the pixel mapping. Web's `buildChartGeometry`
 * emits viewbox coordinates and mobile's `buildMetricBars` emits 0..1 fractions,
 * because a phone's plot is a different shape than a desktop's and one of them
 * would have to lie about its own dimensions to share the other's output. They
 * share the scale arithmetic (`normalizeValueRange`) instead, which is where the
 * only genuinely subtle case lives.
 *
 * Note on the period: the server owns it. The client picks a *window*; the
 * display period comes back on the response. Nothing here computes one.
 */

export interface InfraMetricPoint {
  tsMs: number;
  value: number;
  count: number;
}

export type InfraAlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';

export interface InfraAlarmSegment {
  alertId: string;
  ruleId: string;
  state: InfraAlarmState;
  startMs: number;
  endMs: number;
}

export interface InfraSeriesWire {
  namespace: string;
  metricName: string;
  stat: string;
  periodSeconds: number;
  dimensionsHash: string;
  pointCount: number;
  firstTsMs: number;
  lastTsMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Windows the range picker offers. Server-side coarsening handles the width. */
export const RANGE_OPTIONS: ReadonlyArray<{ label: string; spanMs: number }> = [
  { label: '1h', spanMs: HOUR },
  { label: '6h', spanMs: 6 * HOUR },
  { label: '24h', spanMs: DAY },
  { label: '7d', spanMs: 7 * DAY },
  { label: '30d', spanMs: 30 * DAY },
  { label: '90d', spanMs: 90 * DAY },
];

/** Axis labels. Short numbers, because the axis is only a few characters wide. */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (abs >= 10) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

/** Time-axis label. Drops the date on windows short enough not to need it. */
export function formatAxisTime(tsMs: number, spanMs: number): string {
  const date = new Date(tsMs);
  if (spanMs <= DAY) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Human label for a resolved period. The server chose it; this only names it. */
export function formatPeriod(periodSeconds: number): string {
  if (!Number.isFinite(periodSeconds) || periodSeconds <= 0) return '—';
  if (periodSeconds < 60) return `${periodSeconds}s`;
  if (periodSeconds < 3600) return `${Math.round(periodSeconds / 60)}m`;
  return `${Math.round(periodSeconds / 3600)}h`;
}

/**
 * Series identity as one string, for the picker's option values.
 *
 * Joined on a separator that cannot occur in any field, so two different series
 * can never collide into one key: AWS metric names and namespaces may contain
 * spaces, and a printable separator would make (`namespace: 'A B'`,
 * `metric: 'C'`) and (`namespace: 'A'`, `metric: 'B C'`) the same series.
 *
 * Written as an escape rather than a literal control character. The original
 * carried a raw NUL byte in the source, which made git classify the whole file
 * as binary and refuse to diff it.
 */
const SERIES_KEY_SEP = '\u0000';

export function seriesKey(series: InfraSeriesWire): string {
  return [
    series.namespace,
    series.metricName,
    series.stat,
    series.periodSeconds,
    series.dimensionsHash,
  ].join(SERIES_KEY_SEP);
}

export interface InfraValueRange {
  minValue: number;
  maxValue: number;
  /** `maxValue - minValue`, floored so it is always a usable divisor. */
  valueSpan: number;
}

/**
 * The vertical scale for a set of values.
 *
 * A constant series is the case that breaks a naive implementation: `max ===
 * min` makes the scale a division by zero, and the plot either vanishes or
 * renders at NaN. The range is padded so a flat series draws through the middle
 * of the plot, which is what a constant metric looks like.
 *
 * Shared rather than reimplemented per surface because it is the one piece of
 * this arithmetic where the obvious version is wrong, and a phone hitting the
 * divide-by-zero that the desktop already fixed is exactly the parity bug this
 * module exists to prevent.
 */
export function normalizeValueRange(values: readonly number[]): InfraValueRange {
  const finite = values.filter((v) => Number.isFinite(v));
  const rawMin = finite.length > 0 ? Math.min(...finite) : 0;
  const rawMax = finite.length > 0 ? Math.max(...finite) : 1;
  // Padded by 1, or by a tenth of the magnitude for large constants, so the
  // divide stays finite and a flat series sits mid-plot rather than on an edge.
  const pad = rawMax === rawMin ? Math.max(1, Math.abs(rawMax) * 0.1) : 0;
  const minValue = rawMin - pad;
  const maxValue = rawMax + pad;
  return { minValue, maxValue, valueSpan: Math.max(Number.EPSILON, maxValue - minValue) };
}

export interface InfraMetricBar {
  /** Bucket start, so a caller can label or key the column. */
  tsMs: number;
  /** Mean of the points that landed in this bucket; null when none did. */
  value: number | null;
  /** Column height as a 0..1 fraction of the plot. 0 for an empty bucket. */
  height: number;
  /** Worst alarm state overlapping this bucket, or null. */
  state: InfraAlarmState | null;
}

export interface InfraMetricBars {
  bars: InfraMetricBar[];
  minValue: number;
  maxValue: number;
  /** True when at least one bucket carries a datapoint. */
  hasData: boolean;
}

/**
 * Bucket a series into a fixed number of columns for a bar-style plot.
 *
 * Fixed-column rather than one-bar-per-point because the point count is set by
 * the server's period and the window width, not by the display: a 90-day window
 * at a 5-minute period is ~26,000 points, and a phone plot is ~40 columns wide.
 * Rendering a `View` per point would allocate thousands of native views to draw
 * something narrower than a hairline. Bucketing bounds the cost at `barCount`
 * regardless of window.
 *
 * Empty buckets are kept as zero-height entries rather than dropped, so a gap in
 * collection reads as a gap instead of silently closing up and implying the
 * metric was continuous.
 */
export function buildMetricBars(
  points: readonly InfraMetricPoint[],
  segments: readonly InfraAlarmSegment[],
  fromMs: number,
  toMs: number,
  barCount: number,
): InfraMetricBars {
  const columns = Math.max(1, Math.floor(barCount));
  const spanMs = Math.max(1, toMs - fromMs);
  const bucketMs = spanMs / columns;

  const sums = new Array<number>(columns).fill(0);
  const counts = new Array<number>(columns).fill(0);

  for (const point of points) {
    if (!Number.isFinite(point?.value)) continue;
    if (point.tsMs < fromMs || point.tsMs > toMs) continue;
    // The right edge lands one past the last bucket; clamp it back in rather
    // than dropping the newest datapoint, which is the one being watched.
    const index = Math.min(columns - 1, Math.floor((point.tsMs - fromMs) / bucketMs));
    sums[index] += point.value;
    counts[index] += 1;
  }

  const means: Array<number | null> = sums.map((sum, i) =>
    counts[i] > 0 ? sum / counts[i] : null,
  );
  const present = means.filter((v): v is number => v !== null);
  const { minValue, maxValue, valueSpan } = normalizeValueRange(present);

  const bars = means.map((value, i) => {
    const bucketStart = fromMs + i * bucketMs;
    return {
      tsMs: Math.round(bucketStart),
      value,
      height: value === null ? 0 : Math.min(1, Math.max(0, (value - minValue) / valueSpan)),
      state: worstStateAt(segments, bucketStart, bucketStart + bucketMs),
    };
  });

  return { bars, minValue, maxValue, hasData: present.length > 0 };
}

/**
 * The most severe alarm state overlapping a bucket.
 *
 * "Most severe" rather than "first match" because a bucket wide enough to span
 * a recovery would otherwise report whichever segment happened to be listed
 * first. A breach inside the window has to survive the bucketing — that is the
 * whole reason the overlay is drawn.
 */
function worstStateAt(
  segments: readonly InfraAlarmSegment[],
  startMs: number,
  endMs: number,
): InfraAlarmState | null {
  let worst: InfraAlarmState | null = null;
  for (const segment of segments) {
    if (segment.endMs <= startMs || segment.startMs >= endMs) continue;
    if (segment.state === 'ALARM') return 'ALARM';
    if (segment.state === 'INSUFFICIENT_DATA') worst = 'INSUFFICIENT_DATA';
    else if (worst === null) worst = segment.state;
  }
  return worst;
}
