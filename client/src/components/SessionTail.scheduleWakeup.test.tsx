import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import SessionTail, { eventsToBlocks, ScheduleWakeupCard } from './SessionTail';

/**
 * A `ScheduleWakeup` tool call used to collapse into the generic ToolCard as
 * "ScheduleWakeup <prompt…>", hiding the only thing a reader wants: *when*.
 * The input carries a relative `delaySeconds`, so the fire time only exists
 * once paired with the session-event's wall clock — which the client used to
 * throw away on both the live WS and REST-replay paths.
 */

const ANCHOR = '2026-08-05T12:00:00Z';
const ANCHOR_MS = Date.parse(ANCHOR);

const wakeupUse = (input: any, id = 'w1') => ({
  type: 'tool_use',
  id,
  tool: 'ScheduleWakeup',
  input,
});

describe('eventsToBlocks — ScheduleWakeup routing', () => {
  it('routes a ScheduleWakeup call to a wakeup block carrying its timestamp', () => {
    const blocks = eventsToBlocks([
      {
        seq: 0,
        event: wakeupUse({ delaySeconds: 1200, reason: 'watching CI' }),
        timestamp: ANCHOR,
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('wakeup');
    expect(blocks[0].scheduledAt).toBe(ANCHOR);
  });

  it('anchors on the first revision when an engine re-emits the same tool id', () => {
    // A same-id follow-up upgrades the args; it does not mean the call was
    // re-issued, so restarting the countdown from the later timestamp would
    // overstate how long is left.
    const blocks = eventsToBlocks([
      { seq: 0, event: wakeupUse({ delaySeconds: 1200 }), timestamp: ANCHOR },
      {
        seq: 1,
        event: wakeupUse({ delaySeconds: 1200, reason: 'watching CI' }),
        timestamp: '2026-08-05T12:00:30Z',
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].scheduledAt).toBe(ANCHOR);
    expect(blocks[0].use.input.reason).toBe('watching CI');
  });

  it('still produces a wakeup block when no timestamp accompanies the event', () => {
    const blocks = eventsToBlocks([{ seq: 0, event: wakeupUse({ delaySeconds: 600 }) }]);
    expect(blocks[0].kind).toBe('wakeup');
    expect(blocks[0].scheduledAt).toBeNull();
  });

  it('pairs the tool_result with the wakeup block', () => {
    const blocks = eventsToBlocks([
      { seq: 0, event: wakeupUse({ delaySeconds: 600 }), timestamp: ANCHOR },
      { seq: 1, event: { type: 'tool_result', toolUseId: 'w1', output: 'scheduled' } },
    ]);
    expect(blocks[0].result?.output).toBe('scheduled');
  });

  it('leaves other tools on the generic tool block', () => {
    const blocks = eventsToBlocks([
      {
        seq: 0,
        event: { type: 'tool_use', id: 't1', tool: 'Bash', input: { command: 'ls' } },
        timestamp: ANCHOR,
      },
    ]);
    expect(blocks[0].kind).toBe('tool');
  });
});

describe('ScheduleWakeupCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_MS + 18_000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a live countdown to the fire time', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1200, reason: 'watching CI run' })}
        result={{ output: 'ok' }}
        scheduledAt={ANCHOR}
      />,
    );
    expect(screen.getByTestId('schedule-wakeup-card')).toBeTruthy();
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent('in 19m 42s');
  });

  it('ticks down as wall-clock time advances', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 120 })}
        result={{ output: 'ok' }}
        scheduledAt={ANCHOR}
      />,
    );
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent('in 1m 42s');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent('in 42s');
  });

  it('flips to "wakeup time reached" once the clock runs out and stops ticking', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 60 })}
        result={{ output: 'ok' }}
        scheduledAt={ANCHOR}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent(
      'wakeup time reached',
    );
    // No further timers should be pending — a settled wakeup must not hold an
    // interval for the life of the transcript.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders a stop as a stopped loop with no countdown', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ stop: true })}
        result={{ output: 'ok' }}
        scheduledAt={ANCHOR}
      />,
    );
    expect(screen.getByText('Loop stopped')).toBeTruthy();
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent('loop stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to the requested delay when the event carried no timestamp', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1800 })}
        result={{ output: 'ok' }}
        scheduledAt={null}
      />,
    );
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent('after 30m 00s');
  });

  it('treats a replayed wakeup as long past rather than freshly scheduled', () => {
    // Regression: the REST replay path dropped `timestamp`, so reopening an old
    // session re-anchored every wakeup to "now" and showed a full countdown.
    vi.setSystemTime(new Date(ANCHOR_MS + 86_400_000));
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1200 })}
        result={{ output: 'ok' }}
        scheduledAt={ANCHOR}
      />,
    );
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent(
      'wakeup time reached',
    );
  });

  it('parses a SQLite datetime anchor as UTC, not local time', () => {
    // `GET /api/messages/:id/events` returns SQLite `datetime('now')` strings
    // with no zone marker; `new Date(str)` would read them as local time and
    // skew the countdown by the viewer's UTC offset.
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1200 })}
        result={{ output: 'ok' }}
        scheduledAt="2026-08-05 12:00:00"
      />,
    );
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent('in 19m 42s');
  });

  it('shows the error message when the call failed, not just an error badge', () => {
    // Regression: the dedicated card replaced a generic tool row that displayed
    // `result.output`. Dropping it hid the real failure reason.
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1200 })}
        result={{ output: 'ScheduleWakeupInputError: delaySeconds out of range', isError: true }}
        scheduledAt={ANCHOR}
        defaultOpen
      />,
    );
    const panel = screen.getByTestId('schedule-wakeup-result');
    expect(panel).toHaveTextContent('error');
    expect(panel).toHaveTextContent('ScheduleWakeupInputError: delaySeconds out of range');
  });

  it('shows the scheduling confirmation on success', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1200 })}
        result={{ output: 'Wakeup scheduled', isError: false }}
        scheduledAt={ANCHOR}
        defaultOpen
      />,
    );
    const panel = screen.getByTestId('schedule-wakeup-result');
    expect(panel).toHaveTextContent('result');
    expect(panel).toHaveTextContent('Wakeup scheduled');
  });

  it('renders an errored result whose body is empty rather than staying silent', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1200 })}
        result={{ output: '', isError: true }}
        scheduledAt={ANCHOR}
        defaultOpen
      />,
    );
    expect(screen.getByTestId('schedule-wakeup-result')).toHaveTextContent('(empty)');
  });

  it('omits the result panel while the call is still in flight', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1200 })}
        result={undefined}
        scheduledAt={ANCHOR}
        defaultOpen
      />,
    );
    expect(screen.queryByTestId('schedule-wakeup-result')).toBeNull();
  });

  it('shows the reason and both wall-clock times when expanded', () => {
    render(
      <ScheduleWakeupCard
        use={wakeupUse({ delaySeconds: 1200, reason: 'watching CI run', prompt: '/loop check CI' })}
        result={{ output: 'ok' }}
        scheduledAt={ANCHOR}
        defaultOpen
      />,
    );
    expect(screen.getByTestId('schedule-wakeup-times')).toBeTruthy();
    expect(screen.getByText('/loop check CI')).toBeTruthy();
  });
});

describe('SessionTail — end to end', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(ANCHOR_MS + 18_000));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the countdown card in the timeline instead of a generic tool row', () => {
    render(
      <SessionTail
        message={{
          id: 'm1',
          role: 'assistant',
          engine: 'claude-code',
          model: 'opus',
          created_at: ANCHOR,
        }}
        events={[
          {
            seq: 0,
            event: wakeupUse({ delaySeconds: 1200, reason: 'watching CI run' }),
            timestamp: ANCHOR,
          },
          { seq: 1, event: { type: 'tool_result', toolUseId: 'w1', output: 'ok' } },
        ]}
        agentColor="#6366f1"
      />,
    );
    expect(screen.getByTestId('schedule-wakeup-card')).toBeTruthy();
    expect(screen.getByTestId('schedule-wakeup-countdown')).toHaveTextContent('in 19m 42s');
  });
});
