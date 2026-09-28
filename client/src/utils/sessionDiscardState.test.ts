import { describe, expect, it } from 'vitest';
import { markSessionDiscarded, withoutChangesReady } from './sessionDiscardState';

describe('withoutChangesReady', () => {
  it('drops only the discarded session', () => {
    const prev = { a: { branch: 'x' }, b: { branch: 'y' } };
    expect(withoutChangesReady(prev, 'a')).toEqual({ b: { branch: 'y' } });
  });

  it('returns the same object when nothing is pinned', () => {
    const prev = { b: { branch: 'y' } };
    expect(withoutChangesReady(prev, 'a')).toBe(prev);
  });
});

describe('markSessionDiscarded', () => {
  it('clears changes_ready and stamps discarded_at', () => {
    const sessions = [
      { id: 'a', changes_ready: '{"branch":"x"}' },
      { id: 'b', changes_ready: '{"branch":"y"}' },
    ];
    const next = markSessionDiscarded(sessions, 'a', '2026-09-28 17:00:00');
    expect(next[0]).toEqual({ id: 'a', changes_ready: null, discarded_at: '2026-09-28 17:00:00' });
    expect(next[1]).toBe(sessions[1]);
  });

  it('is a no-op for an unknown session', () => {
    const sessions = [{ id: 'b' }];
    expect(markSessionDiscarded(sessions, 'a', null)).toBe(sessions);
  });
});
