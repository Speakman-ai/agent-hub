/**
 * Chart geometry (including the flat-series case that breaks a naive scale),
 * the empty-series states, and the contract that the *server* owns the display
 * period.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import InfraMetricChart, {
  buildChartGeometry,
  formatPeriod,
  formatValue,
  seriesKey,
} from './InfraMetricChart';
import { api } from '../../utils/api';

(vi as any).mock('../../utils/api.js', () => ({
  api: {
    listInfraMetricSeries: vi.fn(),
    getInfraMetricRange: vi.fn(),
  },
}));

const listInfraMetricSeries = vi.mocked(api.listInfraMetricSeries);
const getInfraMetricRange = vi.mocked(api.getInfraMetricRange);

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const SERIES = {
  namespace: 'AWS/EC2',
  metricName: 'CPUUtilization',
  stat: 'Average',
  periodSeconds: 60,
  dimensionsHash: 'none',
  pointCount: 10,
  firstTsMs: NOW - HOUR,
  lastTsMs: NOW,
};

function rangeResponse(over: Record<string, any> = {}) {
  return {
    resource: null,
    series: SERIES,
    fromMs: NOW - HOUR,
    toMs: NOW,
    periodSeconds: 60,
    aggregation: 'avg',
    maxBuckets: 720,
    truncated: false,
    points: [
      { tsMs: NOW - 2 * 60_000, value: 10, count: 1 },
      { tsMs: NOW - 60_000, value: 20, count: 1 },
    ],
    alarmSegments: [],
    alerts: [],
    ...over,
  } as any;
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: `clear` leaves queued `…Once` values in
  // place, which makes the suite order-dependent.
  vi.resetAllMocks();
  listInfraMetricSeries.mockResolvedValue({ resource: null, series: [SERIES] } as any);
  getInfraMetricRange.mockResolvedValue(rangeResponse());
});

describe('buildChartGeometry', () => {
  it('maps points across the plot area in window order', () => {
    const geometry = buildChartGeometry(
      [
        { tsMs: NOW - HOUR, value: 0, count: 1 },
        { tsMs: NOW, value: 100, count: 1 },
      ],
      [],
      NOW - HOUR,
      NOW,
    );
    const coords = geometry.linePoints.split(' ').map((pair) => pair.split(',').map(Number));
    expect(coords).toHaveLength(2);
    expect(coords[0][0]).toBeLessThan(coords[1][0]);
    // Higher value plots higher on screen, which is a smaller y.
    expect(coords[0][1]).toBeGreaterThan(coords[1][1]);
  });

  it('renders a constant series instead of dividing by a zero range', () => {
    // max === min is the case that silently produces NaN coordinates and an
    // invisible line.
    const geometry = buildChartGeometry(
      [
        { tsMs: NOW - HOUR, value: 42, count: 1 },
        { tsMs: NOW, value: 42, count: 1 },
      ],
      [],
      NOW - HOUR,
      NOW,
    );
    const ys = geometry.linePoints.split(' ').map((pair) => Number(pair.split(',')[1]));
    expect(ys.every((y) => Number.isFinite(y))).toBe(true);
    expect(geometry.minValue).toBeLessThan(42);
    expect(geometry.maxValue).toBeGreaterThan(42);
  });

  it('produces no line and finite ticks for an empty series', () => {
    const geometry = buildChartGeometry([], [], NOW - HOUR, NOW);
    expect(geometry.linePoints).toBe('');
    expect(geometry.yTicks.every((t) => Number.isFinite(t.y))).toBe(true);
  });

  it('clips an alarm band to the window and keeps it at least a pixel wide', () => {
    const geometry = buildChartGeometry(
      [{ tsMs: NOW, value: 1, count: 1 }],
      [
        // Starts before the window and ends inside it.
        {
          alertId: 'a',
          ruleId: 'r',
          state: 'ALARM',
          startMs: NOW - 3 * HOUR,
          endMs: NOW - HOUR / 2,
        },
        // Narrower than a pixel at this scale.
        { alertId: 'b', ruleId: 'r', state: 'ALARM', startMs: NOW - 1000, endMs: NOW - 999 },
      ],
      NOW - HOUR,
      NOW,
    );
    expect(geometry.bands).toHaveLength(2);
    expect(geometry.bands[0].x).toBeGreaterThanOrEqual(0);
    expect(geometry.bands.every((b) => b.width >= 1)).toBe(true);
  });

  it('drops a band entirely outside the window', () => {
    const geometry = buildChartGeometry(
      [],
      [
        {
          alertId: 'a',
          ruleId: 'r',
          state: 'ALARM',
          startMs: NOW - 5 * HOUR,
          endMs: NOW - 4 * HOUR,
        },
      ],
      NOW - HOUR,
      NOW,
    );
    expect(geometry.bands).toEqual([]);
  });
});

describe('formatters', () => {
  it('names a resolved period without recomputing it', () => {
    expect(formatPeriod(60)).toBe('1m');
    expect(formatPeriod(300)).toBe('5m');
    expect(formatPeriod(3600)).toBe('1h');
    expect(formatPeriod(0)).toBe('—');
  });

  it('keeps axis labels short', () => {
    expect(formatValue(1_500_000)).toBe('1.5M');
    expect(formatValue(2_500)).toBe('2.5k');
    expect(formatValue(0.125)).toBe('0.13');
  });

  it('keys a series on every field of its identity', () => {
    expect(seriesKey(SERIES)).not.toBe(seriesKey({ ...SERIES, periodSeconds: 300 }));
    expect(seriesKey(SERIES)).not.toBe(seriesKey({ ...SERIES, stat: 'Maximum' }));
  });
});

describe('InfraMetricChart pack annotations', () => {
  const packMetric = {
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimension: 'InstanceId',
    metricType: 'gauge' as const,
    stat: 'Average',
    validStatistics: ['Average', 'Minimum', 'Maximum'],
    minPeriodSeconds: 300,
    availability: 'either' as const,
    appliesTo: { universal: true, condition: '' },
    description: 'Percentage of physical CPU time the instance used.',
  };
  const pack = {
    service: 'ec2',
    label: 'EC2',
    metrics: [packMetric],
    dimensions: [],
    absentMetrics: [],
    defaultAlertRules: [],
  };

  it('describes the selected metric when the pack declares it', async () => {
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" pack={pack} />);

    await waitFor(() =>
      expect(screen.getByTestId('infra-metric-description').textContent).toContain(
        'Percentage of physical CPU time',
      ),
    );
  });

  it('adds the caveat for a metric that not every resource publishes', async () => {
    const conditional = {
      ...pack,
      metrics: [
        {
          ...packMetric,
          availability: 'basic-only' as const,
          appliesTo: { universal: false, condition: 'Instances with an EBS burst bucket.' },
        },
      ],
    };
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" pack={conditional} />);

    await waitFor(() =>
      expect(screen.getByTestId('infra-metric-description').textContent).toContain(
        'Instances with an EBS burst bucket.',
      ),
    );
    expect(screen.getByTestId('infra-metric-description').textContent).toContain(
      'Detailed monitoring removes this metric',
    );
  });

  it('says nothing when the series is not one the pack declares', async () => {
    // Matched on the full identity: the pack's Average series does not describe
    // the same metric stored on Maximum.
    const other = { ...pack, metrics: [{ ...packMetric, stat: 'Maximum' }] };
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" pack={other} />);

    await waitFor(() => expect(screen.getByTestId('infra-metric-line')).toBeTruthy());
    expect(screen.queryByTestId('infra-metric-description')).toBeNull();
  });

  it('draws normally with no pack at all', async () => {
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" />);

    await waitFor(() => expect(screen.getByTestId('infra-metric-line')).toBeTruthy());
    expect(screen.queryByTestId('infra-metric-description')).toBeNull();
  });
});

describe('InfraMetricChart', () => {
  it('draws the line once the range arrives', async () => {
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" />);

    await waitFor(() => expect(screen.getByTestId('infra-metric-line')).toBeTruthy());
    expect(screen.getByTestId('infra-metric-line').getAttribute('points')).not.toBe('');
  });

  it('shows the period the server resolved rather than one it computed', async () => {
    // The client picks a window; the period comes back in the response. A
    // client that derived its own would be a second implementation of the
    // collector's retention-tier rule, and disagreeing with it is silent.
    getInfraMetricRange.mockResolvedValue(rangeResponse({ periodSeconds: 3600 }));
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" />);

    await waitFor(() =>
      expect(screen.getByTestId('infra-metric-period').textContent).toContain('1h'),
    );
  });

  it('renders an empty-series state instead of a blank chart', async () => {
    getInfraMetricRange.mockResolvedValue(rangeResponse({ points: [], series: null }));
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" />);

    await waitFor(() => expect(screen.getByTestId('infra-metric-empty-series')).toBeTruthy());
    expect(screen.queryByTestId('infra-metric-line')).toBeNull();
  });

  it('says nothing has been collected when the resource has no series at all', async () => {
    listInfraMetricSeries.mockResolvedValue({ resource: null, series: [] } as any);
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" resourceLabel="web-1" />);

    await waitFor(() => expect(screen.getByTestId('infra-metric-no-series')).toBeTruthy());
    expect(screen.getByTestId('infra-metric-no-series').textContent).toContain('web-1');
    // No series means no range to ask for; requesting one would be a billed-
    // looking call that can only come back empty.
    expect(getInfraMetricRange).not.toHaveBeenCalled();
  });

  it('shades the alert timeline over the chart', async () => {
    getInfraMetricRange.mockResolvedValue(
      rangeResponse({
        alarmSegments: [
          { alertId: 'a1', ruleId: 'r1', state: 'ALARM', startMs: NOW - 30 * 60_000, endMs: NOW },
        ],
      }),
    );
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" />);

    await waitFor(() => expect(screen.getByTestId('infra-alarm-band-ALARM')).toBeTruthy());
    expect(screen.getByTestId('infra-alarm-legend')).toBeTruthy();
  });

  it('pins the full series identity on the range request', async () => {
    // Leaving the period open is the filter that bites: one metric stored at
    // two tiers interleaves at duplicate timestamps with different meanings.
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" />);

    await waitFor(() => expect(getInfraMetricRange).toHaveBeenCalled());
    const params = getInfraMetricRange.mock.calls[0][1] as Record<string, unknown>;
    expect(params).toMatchObject({
      resource: 'res-1',
      metric: 'CPUUtilization',
      namespace: 'AWS/EC2',
      stat: 'Average',
      dimensionsHash: 'none',
      period: 60,
    });
    expect(typeof params.from).toBe('number');
    expect(typeof params.to).toBe('number');
    expect(params.to as number).toBeGreaterThan(params.from as number);
  });

  it('surfaces a failed range read instead of leaving a stale chart up', async () => {
    getInfraMetricRange.mockRejectedValue(new Error('boom'));
    render(<InfraMetricChart projectId="p1" resourceKey="res-1" />);

    await waitFor(() => expect(screen.getByTestId('infra-metric-error')).toBeTruthy());
    expect(screen.getByTestId('infra-metric-error').textContent).toContain('boom');
  });

  it('does not draw one resource’s data under another’s selection', async () => {
    const { rerender } = render(<InfraMetricChart projectId="p1" resourceKey="res-1" />);
    await waitFor(() => expect(screen.getByTestId('infra-metric-line')).toBeTruthy());

    listInfraMetricSeries.mockResolvedValue({ resource: null, series: [] } as any);
    rerender(<InfraMetricChart projectId="p1" resourceKey="res-2" />);

    await waitFor(() => expect(screen.getByTestId('infra-metric-no-series')).toBeTruthy());
    expect(screen.queryByTestId('infra-metric-line')).toBeNull();
  });
});
