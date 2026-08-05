import { describe, it, expect } from 'vitest';
import {
  SCHEDULE_WAKEUP_TOOL,
  isScheduleWakeupTool,
  parseScheduledWakeup,
  formatWakeupDuration,
  wakeupCountdown,
  wakeupTickIntervalMs,
  wakeupResultPanel,
  WAKEUP_RESULT_MAX_CHARS,
} from './scheduledWakeup';

const T0 = Date.UTC(2026, 7, 5, 12, 0, 0); // anchor for every case below

describe('isScheduleWakeupTool', () => {
  it('matches only the exact tool name', () => {
    expect(isScheduleWakeupTool(SCHEDULE_WAKEUP_TOOL)).toBe(true);
    expect(isScheduleWakeupTool('Bash')).toBe(false);
    expect(isScheduleWakeupTool('scheduleWakeup')).toBe(false);
    expect(isScheduleWakeupTool(undefined)).toBe(false);
  });
});

describe('parseScheduledWakeup', () => {
  it('resolves delaySeconds against the anchor into an absolute fire time', () => {
    const w = parseScheduledWakeup(
      { delaySeconds: 1200, prompt: '/loop check CI', reason: 'watching CI run' },
      T0,
    );
    expect(w.stop).toBe(false);
    expect(w.delaySeconds).toBe(1200);
    expect(w.reason).toBe('watching CI run');
    expect(w.prompt).toBe('/loop check CI');
    expect(w.scheduledAtMs).toBe(T0);
    expect(w.firesAtMs).toBe(T0 + 1_200_000);
  });

  it('accepts a stringified delay (engines that stringify numeric tool args)', () => {
    expect(parseScheduledWakeup({ delaySeconds: '600' }, T0).firesAtMs).toBe(T0 + 600_000);
  });

  it('treats stop:true as a loop end with no fire time, even with a stray delay', () => {
    const w = parseScheduledWakeup({ stop: true, delaySeconds: 900 }, T0);
    expect(w.stop).toBe(true);
    expect(w.delaySeconds).toBeNull();
    expect(w.firesAtMs).toBeNull();
  });

  it('never invents an anchor when the timestamp is missing', () => {
    // Falling back to "now" would restart the countdown on every page load and
    // render a long-finished wakeup as freshly scheduled.
    const w = parseScheduledWakeup({ delaySeconds: 300 }, null);
    expect(w.scheduledAtMs).toBeNull();
    expect(w.firesAtMs).toBeNull();
    expect(w.delaySeconds).toBe(300);
  });

  it('rejects unusable delays instead of producing a bogus fire time', () => {
    for (const bad of [undefined, null, 'soon', NaN, Infinity, -30, {}]) {
      const w = parseScheduledWakeup({ delaySeconds: bad }, T0);
      expect(w.delaySeconds).toBeNull();
      expect(w.firesAtMs).toBeNull();
    }
  });

  it('tolerates a non-object input', () => {
    const w = parseScheduledWakeup(null, T0);
    expect(w.stop).toBe(false);
    expect(w.reason).toBe('');
    expect(w.prompt).toBe('');
    expect(w.firesAtMs).toBeNull();
  });
});

describe('formatWakeupDuration', () => {
  it('formats across the ranges the tool clamps to', () => {
    expect(formatWakeupDuration(9_000)).toBe('9s');
    expect(formatWakeupDuration(60_000)).toBe('1m 00s');
    expect(formatWakeupDuration(90_000)).toBe('1m 30s');
    expect(formatWakeupDuration(1_182_000)).toBe('19m 42s');
    expect(formatWakeupDuration(3_600_000)).toBe('1h 00m');
    expect(formatWakeupDuration(3_900_000)).toBe('1h 05m');
    expect(formatWakeupDuration(90_000_000)).toBe('1d 1h');
  });

  it('clamps negatives to zero rather than rendering "-1s"', () => {
    expect(formatWakeupDuration(-5_000)).toBe('0s');
  });

  it('rounds up so a countdown never shows 0s while still pending', () => {
    expect(formatWakeupDuration(1)).toBe('1s');
    expect(formatWakeupDuration(1_500)).toBe('2s');
  });
});

describe('wakeupCountdown', () => {
  const pending = parseScheduledWakeup({ delaySeconds: 1200, reason: 'watching CI' }, T0);

  it('counts down while pending', () => {
    const c = wakeupCountdown(pending, T0 + 18_000);
    expect(c.state).toBe('pending');
    expect(c.label).toBe('in 19m 42s');
    expect(c.remainingMs).toBe(1_182_000);
    expect(c.progress).toBeCloseTo(0.015, 3);
  });

  it('reports the time being reached without claiming the agent woke up', () => {
    const c = wakeupCountdown(pending, T0 + 1_200_000);
    expect(c.state).toBe('due');
    expect(c.label).toBe('wakeup time reached');
    expect(c.remainingMs).toBe(0);
    expect(c.progress).toBe(1);
  });

  it('stays due once the fire time is well past', () => {
    expect(wakeupCountdown(pending, T0 + 99_999_999).state).toBe('due');
  });

  it('labels a stop as a stopped loop with no countdown', () => {
    const c = wakeupCountdown(parseScheduledWakeup({ stop: true }, T0), T0);
    expect(c.state).toBe('stopped');
    expect(c.label).toBe('loop stopped');
    expect(c.remainingMs).toBeNull();
  });

  it('falls back to the requested delay when there is no anchor', () => {
    const c = wakeupCountdown(parseScheduledWakeup({ delaySeconds: 1800 }, null), T0);
    expect(c.state).toBe('unknown');
    expect(c.label).toBe('after 30m 00s');
    expect(c.progress).toBeNull();
  });

  it('renders nothing when neither anchor nor delay is known', () => {
    const c = wakeupCountdown(parseScheduledWakeup({}, null), T0);
    expect(c.state).toBe('unknown');
    expect(c.label).toBe('');
  });

  it('keeps progress inside [0,1] when the clock runs backwards past the anchor', () => {
    const c = wakeupCountdown(pending, T0 - 60_000);
    expect(c.progress).toBe(0);
    expect(c.state).toBe('pending');
  });
});

describe('wakeupResultPanel', () => {
  it('surfaces the error text when the call failed', () => {
    // Regression: the dedicated card replaced a generic tool row that showed
    // `result.output` and initially dropped it, hiding the real failure reason
    // behind a bare "error" badge.
    const panel = wakeupResultPanel({
      output: 'ScheduleWakeupInputError: bad delay',
      isError: true,
    });
    expect(panel).toEqual({
      label: 'error',
      text: 'ScheduleWakeupInputError: bad delay',
      errored: true,
      truncated: false,
    });
  });

  it('surfaces the scheduling confirmation on success', () => {
    const panel = wakeupResultPanel({ output: 'Wakeup scheduled', isError: false });
    expect(panel?.label).toBe('result');
    expect(panel?.text).toBe('Wakeup scheduled');
    expect(panel?.errored).toBe(false);
  });

  it('still renders an errored result whose body is empty', () => {
    // A silent card would read as success.
    const panel = wakeupResultPanel({ output: '', isError: true });
    expect(panel?.label).toBe('error');
    expect(panel?.text).toBe('(empty)');
  });

  it('returns null only while the call is still in flight', () => {
    expect(wakeupResultPanel(null)).toBeNull();
    expect(wakeupResultPanel(undefined)).toBeNull();
  });

  it('truncates very long output and flags it', () => {
    const panel = wakeupResultPanel({ output: 'x'.repeat(5000) });
    expect(panel?.text).toHaveLength(WAKEUP_RESULT_MAX_CHARS);
    expect(panel?.truncated).toBe(true);
  });

  it('does not flag output sitting exactly on the limit', () => {
    const panel = wakeupResultPanel({ output: 'x'.repeat(WAKEUP_RESULT_MAX_CHARS) });
    expect(panel?.truncated).toBe(false);
  });

  it('never emits a non-string body for a text node', () => {
    // React Native throws on a non-string child of <Text>.
    for (const bad of [undefined, null, 42, { a: 1 }]) {
      const panel = wakeupResultPanel({ output: bad as any });
      expect(typeof panel?.text).toBe('string');
      expect(panel?.text).toBe('(empty)');
    }
  });

  it('treats a non-true isError as success', () => {
    expect(wakeupResultPanel({ output: 'ok' })?.errored).toBe(false);
    expect(wakeupResultPanel({ output: 'ok', isError: 'yes' as any })?.errored).toBe(false);
  });
});

describe('wakeupTickIntervalMs', () => {
  it('ticks every second inside the last minute and every 15s before that', () => {
    expect(wakeupTickIntervalMs(5_000)).toBe(1_000);
    expect(wakeupTickIntervalMs(60_000)).toBe(1_000);
    expect(wakeupTickIntervalMs(60_001)).toBe(15_000);
    expect(wakeupTickIntervalMs(1_200_000)).toBe(15_000);
  });

  it('returns 0 when there is nothing to tick', () => {
    expect(wakeupTickIntervalMs(null)).toBe(0);
  });
});
