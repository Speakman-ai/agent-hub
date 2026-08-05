import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { buildSessionEventBroadcast } from './session-event-broadcast.js';

describe('buildSessionEventBroadcast', () => {
  it('carries the envelope fields the client indexes on', () => {
    const event = { type: 'tool_use', id: 'w1', tool: 'ScheduleWakeup' };
    expect(
      buildSessionEventBroadcast({
        sessionId: 's1',
        messageId: 'm1',
        seq: 7,
        event,
        now: new Date('2026-08-05T12:00:00.000Z'),
      }),
    ).toEqual({
      type: 'session-event',
      sessionId: 's1',
      messageId: 'm1',
      seq: 7,
      event,
      timestamp: '2026-08-05T12:00:00.000Z',
    });
  });

  it('stamps a wall clock so relative tool args can be resolved live', () => {
    // Regression: the live broadcast used to omit `timestamp` entirely, while
    // REST replay returned it off the persisted row. A ScheduleWakeup arriving
    // over the socket therefore had no anchor for its `delaySeconds`.
    const before = Date.now();
    const msg = buildSessionEventBroadcast({
      sessionId: 's1',
      messageId: 'm1',
      seq: 1,
      event: { type: 'assistant_text', text: 'hi' },
    });
    const stamped = Date.parse(msg.timestamp);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('emits ISO-8601 UTC, which the clients parse the same as a SQLite replay stamp', () => {
    const msg = buildSessionEventBroadcast({
      sessionId: 's1',
      messageId: 'm1',
      seq: 1,
      event: {},
      now: new Date('2026-08-05T12:00:00.000Z'),
    });
    expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The clients' `parseDate` treats a zone-less SQLite string as UTC, so both
    // shapes must land on the same instant.
    expect(Date.parse(msg.timestamp)).toBe(Date.parse('2026-08-05 12:00:00Z'));
  });

  it('is the only builder chat.ts uses for session-event broadcasts', () => {
    // Guards against a future hand-rolled `type: 'session-event'` literal
    // slipping back in without a timestamp.
    const src = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/type:\s*'session-event'/);
    expect(src).toContain('buildSessionEventBroadcast');
  });
});
