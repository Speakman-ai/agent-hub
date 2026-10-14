import { describe, it, expect } from 'vitest';
import { cronLogKey, latestCronLogKey } from './cronLog';

describe('latestCronLogKey', () => {
  it('picks the first (newest) log', () => {
    expect(latestCronLogKey(7, [{ id: 42 }, { id: 41 }])).toBe('7:42');
  });

  it('returns null when the cron has never run', () => {
    expect(latestCronLogKey(7, [])).toBeNull();
    expect(latestCronLogKey(7, undefined)).toBeNull();
  });

  it('matches the key used by the run chips', () => {
    expect(latestCronLogKey('3', [{ id: '9' }])).toBe(cronLogKey('3', '9'));
  });
});
