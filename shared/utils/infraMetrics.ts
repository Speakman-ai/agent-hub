/**
 * Metric helpers. Pixel mapping stays per surface; scale arithmetic
 * (`normalizeValueRange`) is shared. The client picks a window; the server owns the period.
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
 * Series identity. Separator cannot occur in any field (AWS names may contain
 * spaces). Written as an escape: a raw NUL made git treat the file as binary.
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
 * Vertical scale. A constant series (`max === min`) is padded so the plot
 * draws through the middle instead of dividing by zero.
 */
export function normalizeValueRange(values: readonly number[]): InfraValueRange {
  const finite = values.filter((v) => Number.isFinite(v));
  const rawMin = finite.length > 0 ? Math.min(...finite) : 0;
  const rawMax = finite.length > 0 ? Math.max(...finite) : 1;
  // Pad so a flat series sits mid-plot and the divisor stays finite.
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
 * Bucket into a fixed column count (a 90d window is ~26k points). Keep empty
 * buckets as zero-height so collection gaps stay visible.
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
    // Clamp the right edge so the newest datapoint is not dropped.
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

/** Worst overlapping alarm state, not first match. */
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
