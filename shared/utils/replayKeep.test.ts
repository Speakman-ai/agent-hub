import { describe, it, expect } from 'vitest';
import { keepStateAt, keepRefreshDelayMs, isPlaylistKept, MAX_TIMER_DELAY_MS } from './replayKeep';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);

describe('keepStateAt', () => {
  it('is off when unset, lapsed, exactly expiring, or unparseable', () => {
    expect(keepStateAt(null, false, NOW)).toBe('off');
    expect(keepStateAt('2026-10-02 11:59:59', false, NOW)).toBe('off');
    expect(keepStateAt('2026-10-02 12:00:00', false, NOW)).toBe('off');
    expect(keepStateAt('garbage', false, NOW)).toBe('off');
  });
  it('is kept or pending while the Keep is in the future', () => {
    expect(keepStateAt('2026-10-02 12:00:01', false, NOW)).toBe('kept');
    expect(keepStateAt('2026-10-02 12:00:01', true, NOW)).toBe('pending');
  });
});

describe('keepRefreshDelayMs', () => {
  it('waits until just past the expiry instant', () => {
    expect(keepRefreshDelayMs('2026-10-02 12:01:00', NOW)).toBe(60_001);
  });
  it('caps long waits to a safe timer delay', () => {
    expect(keepRefreshDelayMs('2027-10-02 12:00:00', NOW)).toBe(MAX_TIMER_DELAY_MS);
  });
  it('has nothing to wait for when unset or lapsed', () => {
    expect(keepRefreshDelayMs(null, NOW)).toBeNull();
    expect(keepRefreshDelayMs('2026-10-01 00:00:00', NOW)).toBeNull();
  });
});

describe('isPlaylistKept', () => {
  it('needs the flag and a future timestamp', () => {
    expect(
      isPlaylistKept({ extendedRetention: true, retainedUntil: '2027-01-01 00:00:00' }, NOW),
    ).toBe(true);
    expect(
      isPlaylistKept({ extendedRetention: true, retainedUntil: '2026-01-01 00:00:00' }, NOW),
    ).toBe(false);
    expect(
      isPlaylistKept({ extendedRetention: false, retainedUntil: '2027-01-01 00:00:00' }, NOW),
    ).toBe(false);
  });
});
