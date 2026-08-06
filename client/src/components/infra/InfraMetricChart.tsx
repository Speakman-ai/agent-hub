/**
 * The metric chart (decision INFRA-UI, Metrics tab).
 *
 * Hand-drawn SVG rather than a charting dependency: one line, one shaded
 * overlay and two axes is less code than the adapter around a library would be,
 * and it keeps the geometry a pure function this file can test.
 *
 * Three things about this screen are deliberate rather than incidental:
 *
 *   - **The server owns the period.** The client picks a *window*; the display
 *     period comes back in the response. A client that computed its own would
 *     be a second implementation of the collector's `resolvePeriod` semantics,
 *     and the failure it exists to prevent (a 90-day view asking for 60s data
 *     that aged out of CloudWatch) is silent — an empty chart, not an error.
 *   - **Alert state is drawn from the same response.** A chart's job is to show
 *     *when* a resource went bad, which the alert's current state cannot say.
 *   - **REST polling, no socket.** Metric points arrive at most once per
 *     collector tick, so a dedicated stream would be complexity with no payoff
 *     (the divergence from the logs module recorded in INFRA-UI).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  RANGE_OPTIONS,
  formatAxisTime,
  formatPeriod,
  formatValue,
  normalizeValueRange,
  seriesKey,
  type InfraAlarmSegment,
  type InfraMetricPoint,
  type InfraSeriesWire,
} from '@shared/utils/infraMetrics';
import { findPackMetric, metricCaveats, type InfraServicePackWire } from '@shared/utils/infraPacks';
import { api } from '../../utils/api';

// Re-exported so this module stays the import site for everything the chart
// needs. The definitions moved to `shared/` when the mobile screen became a
// second consumer (a window offered on one surface and not the other is the
// drift that motivated the move); callers here did not have to care.
export {
  RANGE_OPTIONS,
  formatAxisTime,
  formatPeriod,
  formatValue,
  seriesKey,
  type InfraAlarmSegment,
  type InfraMetricPoint,
  type InfraSeriesWire,
};

const HOUR = 60 * 60 * 1000;

/** Poll interval. The collector ticks every 5 minutes; this is comfortably under. */
const POLL_MS = 60_000;

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 220;
const PAD_LEFT = 48;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

export interface ChartGeometry {
  /** Polyline points attribute, empty when there is nothing to draw. */
  linePoints: string;
  bands: Array<{ key: string; x: number; width: number; state: InfraAlarmSegment['state'] }>;
  yTicks: Array<{ value: number; y: number }>;
  xTicks: Array<{ tsMs: number; x: number }>;
  minValue: number;
  maxValue: number;
}

/**
 * Map a series and its alert overlay onto the SVG viewbox.
 *
 * Pure, so the arithmetic that decides whether a flat series renders at all is
 * unit-testable without a DOM.
 *
 * A constant series is the case that breaks a naive implementation: `max ===
 * min` makes the vertical scale a division by zero, and the line either
 * vanishes or renders at NaN. The range is padded so a flat line draws through
 * the middle of the plot, which is what a constant metric looks like.
 */
export function buildChartGeometry(
  points: readonly InfraMetricPoint[],
  segments: readonly InfraAlarmSegment[],
  fromMs: number,
  toMs: number,
): ChartGeometry {
  const plotWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const spanMs = Math.max(1, toMs - fromMs);

  const xFor = (tsMs: number): number =>
    PAD_LEFT + ((Math.min(Math.max(tsMs, fromMs), toMs) - fromMs) / spanMs) * plotWidth;

  // The scale (including the flat-series padding that keeps the divide finite)
  // is shared with the mobile bar plot — see `normalizeValueRange`.
  const { minValue, maxValue, valueSpan } = normalizeValueRange(points.map((p) => p.value));

  const yFor = (value: number): number =>
    PAD_TOP + (1 - (value - minValue) / valueSpan) * plotHeight;

  const linePoints = points
    .map((p) => `${xFor(p.tsMs).toFixed(2)},${yFor(p.value).toFixed(2)}`)
    .join(' ');

  const bands = segments
    .filter((s) => s.endMs > fromMs && s.startMs < toMs)
    .map((s, index) => {
      const x = xFor(s.startMs);
      // Floored at one pixel: a breach shorter than a pixel is still a breach,
      // and a zero-width rect would render as nothing at all.
      const width = Math.max(1, xFor(s.endMs) - x);
      return { key: `${s.alertId}-${index}`, x, width, state: s.state };
    });

  const yTicks = [0, 0.5, 1].map((fraction) => {
    const value = minValue + fraction * valueSpan;
    return { value, y: yFor(value) };
  });

  const xTicks = [0, 0.5, 1].map((fraction) => {
    const tsMs = fromMs + fraction * spanMs;
    return { tsMs, x: xFor(tsMs) };
  });

  return { linePoints, bands, yTicks, xTicks, minValue, maxValue };
}

export interface InfraMetricChartProps {
  projectId: string;
  resourceKey: string;
  resourceLabel?: string;
  /**
   * The service's declarations, when the page has them. Supplies the selected
   * metric's one-line description and its caveats; the chart draws the same
   * without it.
   */
  pack?: InfraServicePackWire | null;
}

export default function InfraMetricChart({
  projectId,
  resourceKey,
  resourceLabel,
  pack = null,
}: InfraMetricChartProps): React.ReactElement {
  const [series, setSeries] = useState<InfraSeriesWire[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [spanMs, setSpanMs] = useState<number>(HOUR);
  const [range, setRange] = useState<{
    points: InfraMetricPoint[];
    alarmSegments: InfraAlarmSegment[];
    fromMs: number;
    toMs: number;
    periodSeconds: number;
    aggregation: string;
    truncated: boolean;
  } | null>(null);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [loadingRange, setLoadingRange] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards every settle against a resource or project switch: a slow response
  // must never draw the previous resource's data under this one's title.
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    setSeries([]);
    setSelectedKey('');
    setRange(null);
    setError(null);
    if (!projectId || !resourceKey) return;
    setLoadingSeries(true);
    api
      .listInfraMetricSeries(projectId, resourceKey)
      .then((response: any) => {
        if (generation.current !== gen) return;
        const list: InfraSeriesWire[] = Array.isArray(response?.series) ? response.series : [];
        setSeries(list);
        setSelectedKey(list.length > 0 ? seriesKey(list[0]) : '');
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        setError(err?.message || 'The metric list could not be loaded.');
      })
      .finally(() => {
        if (generation.current === gen) setLoadingSeries(false);
      });
  }, [projectId, resourceKey]);

  const selected = useMemo(
    () => series.find((s) => seriesKey(s) === selectedKey) ?? null,
    [series, selectedKey],
  );

  const loadRange = useCallback(() => {
    if (!projectId || !resourceKey || !selected) return;
    const gen = generation.current;
    setLoadingRange(true);
    const toMs = Date.now();
    api
      .getInfraMetricRange(projectId, {
        resource: resourceKey,
        metric: selected.metricName,
        namespace: selected.namespace,
        stat: selected.stat,
        dimensionsHash: selected.dimensionsHash,
        period: selected.periodSeconds,
        from: toMs - spanMs,
        to: toMs,
      })
      .then((response: any) => {
        if (generation.current !== gen) return;
        setRange({
          points: Array.isArray(response?.points) ? response.points : [],
          alarmSegments: Array.isArray(response?.alarmSegments) ? response.alarmSegments : [],
          fromMs: response?.fromMs ?? toMs - spanMs,
          toMs: response?.toMs ?? toMs,
          periodSeconds: response?.periodSeconds ?? 0,
          aggregation: response?.aggregation ?? 'avg',
          truncated: !!response?.truncated,
        });
        setError(null);
      })
      .catch((err: any) => {
        if (generation.current !== gen) return;
        setError(err?.message || 'The metric range could not be loaded.');
      })
      .finally(() => {
        if (generation.current === gen) setLoadingRange(false);
      });
  }, [projectId, resourceKey, selected, spanMs]);

  useEffect(() => {
    loadRange();
  }, [loadRange]);

  useEffect(() => {
    if (!selected) return;
    const timer = setInterval(loadRange, POLL_MS);
    return () => clearInterval(timer);
  }, [selected, loadRange]);

  const geometry = useMemo(
    () =>
      range
        ? buildChartGeometry(range.points, range.alarmSegments, range.fromMs, range.toMs)
        : null,
    [range],
  );

  const selectedSeries = series.find((s) => seriesKey(s) === selectedKey) ?? null;
  const packMetric = findPackMetric(pack, selectedSeries);
  const caveats = metricCaveats(packMetric);

  const selectClass =
    'rounded border border-gray-800 bg-gray-900 px-2 py-1 text-xs text-gray-200 focus:border-sky-600 focus:outline-none';

  return (
    <div className="space-y-3" data-testid="infra-metric-chart">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Metric"
          value={selectedKey}
          onChange={(e) => setSelectedKey(e.target.value)}
          className={selectClass}
          disabled={series.length === 0}
        >
          {series.length === 0 && <option value="">No metrics collected</option>}
          {series.map((s) => (
            <option key={seriesKey(s)} value={seriesKey(s)}>
              {s.metricName} · {s.stat} · {formatPeriod(s.periodSeconds)}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1" role="group" aria-label="Time range">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => setSpanMs(option.spanMs)}
              aria-pressed={spanMs === option.spanMs}
              className={`rounded border px-2 py-1 text-xs ${
                spanMs === option.spanMs
                  ? 'border-sky-600 bg-sky-950/40 text-sky-200'
                  : 'border-gray-800 text-gray-400 hover:bg-gray-800'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {(loadingSeries || loadingRange) && (
          <Loader2 size={13} className="animate-spin text-gray-500" aria-label="Loading" />
        )}

        {range && (
          <span className="ml-auto text-[11px] text-gray-500" data-testid="infra-metric-period">
            {formatPeriod(range.periodSeconds)} buckets · {range.aggregation}
          </span>
        )}
      </div>

      {packMetric && (
        <p className="text-[11px] leading-5 text-gray-500" data-testid="infra-metric-description">
          {packMetric.description}
          {caveats.length > 0 && <span className="text-amber-400"> {caveats.join(' ')}</span>}
        </p>
      )}

      {error && (
        <div
          className="rounded border border-red-900/60 bg-red-950/20 p-3 text-xs text-red-300"
          data-testid="infra-metric-error"
        >
          {error}
        </div>
      )}

      {range?.truncated && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
          <AlertTriangle size={12} />
          This range holds more buckets than one response carries; the newest are not shown.
        </div>
      )}

      {!error && series.length === 0 && !loadingSeries ? (
        <div
          className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-400"
          data-testid="infra-metric-no-series"
        >
          Nothing has been collected for {resourceLabel || 'this resource'} yet. Metrics appear
          after the next collection run.
        </div>
      ) : !error && range && range.points.length === 0 && !loadingRange ? (
        <div
          className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-400"
          data-testid="infra-metric-empty-series"
        >
          No datapoints in this window. Widen the range, or wait for the next collection run.
        </div>
      ) : geometry && range ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            className="h-56 w-full"
            role="img"
            aria-label={`${selected?.metricName ?? 'metric'} over time`}
            data-testid="infra-metric-svg"
          >
            {geometry.bands.map((band) => (
              <rect
                key={band.key}
                x={band.x}
                y={PAD_TOP}
                width={band.width}
                height={VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM}
                fill={band.state === 'ALARM' ? 'rgba(239,68,68,0.18)' : 'rgba(234,179,8,0.14)'}
                data-testid={`infra-alarm-band-${band.state}`}
              />
            ))}

            {geometry.yTicks.map((tick) => (
              <g key={tick.y}>
                <line
                  x1={PAD_LEFT}
                  x2={VIEW_WIDTH - PAD_RIGHT}
                  y1={tick.y}
                  y2={tick.y}
                  stroke="rgba(75,85,99,0.4)"
                  strokeWidth={1}
                />
                <text x={4} y={tick.y + 4} fill="#9ca3af" fontSize={10}>
                  {formatValue(tick.value)}
                </text>
              </g>
            ))}

            {geometry.xTicks.map((tick) => (
              <text
                key={tick.tsMs}
                x={tick.x}
                y={VIEW_HEIGHT - 6}
                fill="#9ca3af"
                fontSize={10}
                textAnchor="middle"
              >
                {formatAxisTime(tick.tsMs, range.toMs - range.fromMs)}
              </text>
            ))}

            <polyline
              points={geometry.linePoints}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={1.5}
              data-testid="infra-metric-line"
            />
          </svg>

          {range.alarmSegments.length > 0 && (
            <p className="mt-1 text-[11px] text-gray-500" data-testid="infra-alarm-legend">
              Shaded stretches are alert state on this resource over the same window.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
