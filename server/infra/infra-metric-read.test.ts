/**
 * The pure half of the chart read path: which period a window is drawn at, how
 * a bucket is collapsed to one value, and how an alert timeline is
 * reconstructed across a window.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregationForStat,
  buildInfraAlertOverlay,
  resolveDisplayPeriod,
  selectBucketValue,
  MAX_CHART_BUCKETS,
  MAX_METRIC_WINDOW_MS,
} from './infra-metric-read.js';
import { isValidCloudWatchPeriod } from './infra-metric-store.js';
import type { InfraAlertRow, InfraAlertTransitionRow } from './alert-store.js';
import type { InfraAlarmState } from './alert-evaluator.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

describe('resolveDisplayPeriod', () => {
  it('draws a recent window at the 60s tier', () => {
    expect(resolveDisplayPeriod(NOW - HOUR, NOW, NOW)).toBe(60);
  });

  it('coarsens past the tier boundaries the collector uses', () => {
    // The whole point of reusing resolvePeriod: a 90-day view must not request
    // 60s data that aged out of CloudWatch 75 days ago and render empty.
    expect(resolveDisplayPeriod(NOW - 30 * DAY, NOW, NOW, { maxBuckets: 1e9 })).toBe(300);
    expect(resolveDisplayPeriod(NOW - 90 * DAY, NOW, NOW, { maxBuckets: 1e9 })).toBe(3600);
  });

  it('never draws finer than the series is stored at', () => {
    // A 5-minute-class metric charted at 60s would render as a comb of
    // one-point buckets separated by gaps that look like outages.
    expect(resolveDisplayPeriod(NOW - HOUR, NOW, NOW, { storedPeriodSeconds: 300 })).toBe(300);
  });

  it('ignores a stored period that is not a period CloudWatch would accept', () => {
    expect(resolveDisplayPeriod(NOW - HOUR, NOW, NOW, { storedPeriodSeconds: 45 })).toBe(60);
    expect(resolveDisplayPeriod(NOW - HOUR, NOW, NOW, { storedPeriodSeconds: 0 })).toBe(60);
  });

  it('widens until the window fits the bucket cap', () => {
    // 14 days is inside the 60s retention tier, so the tier alone would say 60
    // — 20,160 points for one chart. The bucket cap is what actually binds.
    const period = resolveDisplayPeriod(NOW - 14 * DAY, NOW, NOW);
    expect(period).toBeGreaterThan(60);
    expect(Math.ceil((14 * DAY) / 1000 / period)).toBeLessThanOrEqual(MAX_CHART_BUCKETS);
  });

  it('keeps every resolved period legal for CloudWatch', () => {
    // The resolved period is handed back to callers as a query filter, so an
    // illegal value would be a period no stored row can ever carry.
    for (const spanMs of [MINUTE, HOUR, DAY, 7 * DAY, 30 * DAY, 90 * DAY, MAX_METRIC_WINDOW_MS]) {
      const period = resolveDisplayPeriod(NOW - spanMs, NOW, NOW);
      expect(isValidCloudWatchPeriod(period)).toBe(true);
    }
  });

  it('bounds the widest allowed window inside the bucket cap', () => {
    const span = MAX_METRIC_WINDOW_MS;
    const period = resolveDisplayPeriod(NOW - span, NOW, NOW);
    expect(Math.ceil(span / 1000 / period)).toBeLessThanOrEqual(MAX_CHART_BUCKETS);
  });
});

describe('aggregationForStat', () => {
  it('preserves what the statistic means', () => {
    expect(aggregationForStat('Maximum')).toBe('max');
    expect(aggregationForStat('Minimum')).toBe('min');
    expect(aggregationForStat('Sum')).toBe('sum');
    expect(aggregationForStat('SampleCount')).toBe('sum');
    expect(aggregationForStat('Average')).toBe('avg');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(aggregationForStat('  maximum ')).toBe('max');
  });

  it('approximates a percentile with the mean rather than the max', () => {
    // A true percentile-of-percentiles needs the underlying distribution we do
    // not store; taking the max instead would systematically overstate.
    expect(aggregationForStat('p99')).toBe('avg');
    expect(aggregationForStat('TM(10%:90%)')).toBe('avg');
  });
});

describe('selectBucketValue', () => {
  const bucket = { minValue: 1, maxValue: 9, sumValue: 20, count: 4 };

  it('picks the aggregate the statistic asked for', () => {
    expect(selectBucketValue('min', bucket)).toBe(1);
    expect(selectBucketValue('max', bucket)).toBe(9);
    expect(selectBucketValue('sum', bucket)).toBe(20);
    expect(selectBucketValue('avg', bucket)).toBe(5);
  });

  it('does not divide by zero on an empty bucket', () => {
    expect(selectBucketValue('avg', { minValue: 0, maxValue: 0, sumValue: 0, count: 0 })).toBe(0);
  });
});

// ── Alert overlay ──────────────────────────────────────────────────────────

function alert(over: Partial<InfraAlertRow> = {}): InfraAlertRow {
  return {
    id: 'alert-1',
    project_id: 'proj-a',
    rule_id: 'rule-1',
    resource_key: 'res-1',
    state: 'ALARM',
    reason: 'datapoints_breached',
    state_updated_at: NOW - 2 * HOUR,
    status: 'open',
    status_updated_at: null,
    status_updated_by: null,
    first_seen: NOW - 2 * HOUR,
    last_seen: NOW,
    occurrence_count: 1,
    last_value: 5,
    breaching_datapoints: 3,
    created_at: NOW - 2 * HOUR,
    updated_at: NOW,
    ...over,
  };
}

let transitionSeq = 0;
function transition(
  fromState: InfraAlarmState,
  toState: InfraAlarmState,
  atMs: number,
): InfraAlertTransitionRow {
  transitionSeq += 1;
  return {
    id: transitionSeq,
    alert_id: 'alert-1',
    project_id: 'proj-a',
    from_state: fromState,
    to_state: toState,
    from_status: 'open',
    to_status: 'open',
    reason: 'datapoints_breached',
    actor: 'system:evaluator',
    at_ms: atMs,
    notification_delivered_at_ms: null,
  };
}

describe('buildInfraAlertOverlay', () => {
  const from = NOW - 6 * HOUR;
  const to = NOW;

  it('shades the stretch between a breach and its recovery', () => {
    const segments = buildInfraAlertOverlay(
      [
        {
          alert: alert(),
          transitions: [
            transition('OK', 'ALARM', NOW - 4 * HOUR),
            transition('ALARM', 'OK', NOW - 3 * HOUR),
          ],
        },
      ],
      from,
      to,
    );

    expect(segments).toEqual([
      {
        alertId: 'alert-1',
        ruleId: 'rule-1',
        state: 'ALARM',
        startMs: NOW - 4 * HOUR,
        endMs: NOW - 3 * HOUR,
      },
    ]);
  });

  it('reads the history oldest-first regardless of the order it arrives in', () => {
    // The store hands transitions back newest-first, so an implementation that
    // walked them as given would build the timeline backwards.
    const segments = buildInfraAlertOverlay(
      [
        {
          alert: alert(),
          transitions: [
            transition('ALARM', 'OK', NOW - 3 * HOUR),
            transition('OK', 'ALARM', NOW - 4 * HOUR),
          ],
        },
      ],
      from,
      to,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startMs: NOW - 4 * HOUR, endMs: NOW - 3 * HOUR });
  });

  it('shades from the window edge when the window opens mid-alarm', () => {
    // The earliest known transition's fromState is the state entering the
    // window. Starting the shading at the next transition instead would leave
    // the breach that is already on screen unshaded.
    const segments = buildInfraAlertOverlay(
      [{ alert: alert(), transitions: [transition('ALARM', 'OK', NOW - 2 * HOUR)] }],
      from,
      to,
    );
    expect(segments).toEqual([
      {
        alertId: 'alert-1',
        ruleId: 'rule-1',
        state: 'ALARM',
        startMs: from,
        endMs: NOW - 2 * HOUR,
      },
    ]);
  });

  it('runs an unrecovered alarm to the window edge, not past it', () => {
    const segments = buildInfraAlertOverlay(
      [{ alert: alert(), transitions: [transition('OK', 'ALARM', NOW - HOUR)] }],
      from,
      to,
    );
    expect(segments).toEqual([
      { alertId: 'alert-1', ruleId: 'rule-1', state: 'ALARM', startMs: NOW - HOUR, endMs: to },
    ]);
  });

  it('omits OK stretches', () => {
    const segments = buildInfraAlertOverlay(
      [
        {
          alert: alert({ state: 'OK' }),
          transitions: [transition('ALARM', 'OK', NOW - 5 * HOUR)],
        },
      ],
      from,
      to,
    );
    expect(segments.map((s) => s.state)).toEqual(['ALARM']);
    expect(segments[0].endMs).toBe(NOW - 5 * HOUR);
  });

  it('shades INSUFFICIENT_DATA as well as ALARM', () => {
    const segments = buildInfraAlertOverlay(
      [
        {
          alert: alert({ state: 'INSUFFICIENT_DATA' }),
          transitions: [
            transition('OK', 'INSUFFICIENT_DATA', NOW - 4 * HOUR),
            transition('INSUFFICIENT_DATA', 'ALARM', NOW - 2 * HOUR),
          ],
        },
      ],
      from,
      to,
    );
    expect(segments.map((s) => s.state)).toEqual(['INSUFFICIENT_DATA', 'ALARM']);
  });

  it('drops a breach that ended before the window opened', () => {
    const segments = buildInfraAlertOverlay(
      [
        {
          alert: alert(),
          transitions: [
            transition('OK', 'ALARM', from - 3 * HOUR),
            transition('ALARM', 'OK', from - 2 * HOUR),
          ],
        },
      ],
      from,
      to,
    );
    expect(segments).toEqual([]);
  });

  it('drops a breach that starts after the window closes', () => {
    const segments = buildInfraAlertOverlay(
      [{ alert: alert(), transitions: [transition('OK', 'ALARM', to + HOUR)] }],
      from,
      to,
    );
    expect(segments).toEqual([]);
  });

  it('does not paint history red for an alert with no transitions', () => {
    // A rule that first fired an hour ago must not shade the preceding month.
    const segments = buildInfraAlertOverlay(
      [{ alert: alert({ state: 'ALARM', state_updated_at: NOW - HOUR }), transitions: [] }],
      from,
      to,
    );
    expect(segments).toEqual([
      { alertId: 'alert-1', ruleId: 'rule-1', state: 'ALARM', startMs: NOW - HOUR, endMs: to },
    ]);
  });

  it('returns nothing for a resource that has never breached', () => {
    const segments = buildInfraAlertOverlay(
      [{ alert: alert({ state: 'OK' }), transitions: [] }],
      from,
      to,
    );
    expect(segments).toEqual([]);
  });

  it('sorts segments from several alerts by start time', () => {
    const segments = buildInfraAlertOverlay(
      [
        { alert: alert({ id: 'b' }), transitions: [transition('OK', 'ALARM', NOW - HOUR)] },
        { alert: alert({ id: 'a' }), transitions: [transition('OK', 'ALARM', NOW - 3 * HOUR)] },
      ],
      from,
      to,
    );
    expect(segments.map((s) => s.alertId)).toEqual(['a', 'b']);
  });
});
