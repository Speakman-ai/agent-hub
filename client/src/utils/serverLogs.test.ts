import { describe, it, expect } from 'vitest';
import { orderServerLogsNewestFirst } from './serverLogs';

describe('orderServerLogsNewestFirst', () => {
  it('returns entries newest-first (reverse of chronological insertion)', () => {
    const chronological = [
      { ts: '1', message: 'oldest' },
      { ts: '2', message: 'middle' },
      { ts: '3', message: 'newest' },
    ];
    expect(orderServerLogsNewestFirst(chronological).map((e) => e.message)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [1, 2, 3];
    const out = orderServerLogsNewestFirst(input);
    expect(input).toEqual([1, 2, 3]);
    expect(out).toEqual([3, 2, 1]);
    expect(out).not.toBe(input);
  });

  it('handles the empty list', () => {
    expect(orderServerLogsNewestFirst([])).toEqual([]);
  });
});
