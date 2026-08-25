// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { eventsToBlocks } from './sessionTailBlocks';
import { mapRowsFromMessageEventsApi } from './sessionTailEventsLoad';
import { formatTime, parseDate } from './time';

/**
 * Mobile twin of `client/src/components/SessionTail.scheduleWakeup.test.tsx`.
 * A `ScheduleWakeup` call must route to its own block carrying the wall clock
 * its relative `delaySeconds` is measured from — the timeline used to collapse
 * it into an opaque tool row with no indication of *when*.
 */

const ANCHOR = '2026-08-05T12:00:00Z';

const wakeupUse = (input: any, id = 'w1') => ({
  type: 'tool_use',
  id,
  tool: 'ScheduleWakeup',
  input,
});

describe('eventsToBlocks — ScheduleWakeup routing (mobile)', () => {
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

describe('mapRowsFromMessageEventsApi', () => {
  it('keeps the row timestamp so a replayed wakeup keeps its real anchor', () => {
    const rows = mapRowsFromMessageEventsApi([
      { seq: 0, event: wakeupUse({ delaySeconds: 600 }), timestamp: '2026-08-05 12:00:00' },
    ]);
    expect(rows[0].timestamp).toBe('2026-08-05 12:00:00');
  });

  it('normalizes a missing timestamp to null rather than undefined', () => {
    expect(mapRowsFromMessageEventsApi([{ seq: 0, event: {} }])[0].timestamp).toBeNull();
  });

  it('still parses a stringified event payload', () => {
    const rows = mapRowsFromMessageEventsApi([
      { seq: 0, event: JSON.stringify({ type: 'assistant_text', text: 'hi' }), timestamp: ANCHOR },
    ]);
    expect(rows[0].event).toEqual({ type: 'assistant_text', text: 'hi' });
  });
});

describe('mobile ScheduleWakeupCard renders the tool result', () => {
  // The mobile vitest env is `node` with no React Native renderer, so the card
  // cannot be mounted here. These assert the source wiring instead, guarding the
  // exact regression review caught: the card received `result` and never
  // rendered it, hiding scheduling confirmations and error text behind a badge.
  const src = readFileSync(new URL('../components/SessionTail.tsx', import.meta.url), 'utf8');

  it('derives its result panel from the shared helper', () => {
    expect(src).toContain('wakeupResultPanel');
    expect(src).toMatch(/const resultPanel = wakeupResultPanel\(result\)/);
  });

  it('renders the panel label and body, not just an error badge', () => {
    expect(src).toContain('testID="schedule-wakeup-result"');
    expect(src).toContain('{resultPanel.label}');
    expect(src).toContain('{resultPanel.text}');
  });

  it('does not hand-roll the label/body, which is how web and mobile drifted', () => {
    const card = src.slice(
      src.indexOf('function ScheduleWakeupCard'),
      src.indexOf('const planMarkdownStyles'),
    );
    expect(card).not.toContain("errored ? 'error' : 'result'");
    expect(card).not.toContain('result.output');
  });
});

describe('time.formatTime', () => {
  it('reads a zone-less SQLite stamp as UTC, matching the web helper', () => {
    expect(parseDate('2026-08-05 12:00:00')?.getTime()).toBe(Date.parse(ANCHOR));
  });

  it('is null-safe rather than rendering "Invalid Date"', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime('nonsense')).toBe('');
  });

  it('accepts an epoch-ms fire time', () => {
    expect(formatTime(Date.parse(ANCHOR))).not.toBe('');
  });
});
