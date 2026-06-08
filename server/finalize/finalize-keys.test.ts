import { describe, it, expect } from 'vitest';
import { computeIdempotencyKey, normalizeJobFilter } from './finalize-keys.js';

describe('normalizeJobFilter', () => {
  it('returns null for nullish / empty input', () => {
    expect(normalizeJobFilter(null)).toBeNull();
    expect(normalizeJobFilter(undefined)).toBeNull();
    expect(normalizeJobFilter([])).toBeNull();
    expect(normalizeJobFilter(['', '  '])).toBeNull();
  });

  it('trims, drops blanks, dedups, and sorts', () => {
    expect(normalizeJobFilter([' b ', 'a', 'b', ''])).toEqual(['a', 'b']);
  });
});

describe('computeIdempotencyKey', () => {
  const base = { projectId: 'p', branch: 'feature/x', headSha: 'abc123' };

  it('omitting mode resolves to full (historical key preserved)', () => {
    expect(computeIdempotencyKey(base)).toBe(computeIdempotencyKey({ ...base, mode: 'full' }));
  });

  it('an empty / absent job filter does not change the key', () => {
    const noFilter = computeIdempotencyKey({ ...base, mode: 'checks' });
    expect(computeIdempotencyKey({ ...base, mode: 'checks', jobFilter: null })).toBe(noFilter);
    expect(computeIdempotencyKey({ ...base, mode: 'checks', jobFilter: [] })).toBe(noFilter);
  });

  it('a job filter produces a distinct key from the full checks run', () => {
    const full = computeIdempotencyKey({ ...base, mode: 'checks' });
    const partial = computeIdempotencyKey({ ...base, mode: 'checks', jobFilter: ['test'] });
    expect(partial).not.toBe(full);
  });

  it('two different single-job runs get different keys (no cross-dedup)', () => {
    const a = computeIdempotencyKey({ ...base, mode: 'checks', jobFilter: ['test'] });
    const b = computeIdempotencyKey({ ...base, mode: 'checks', jobFilter: ['lint'] });
    expect(a).not.toBe(b);
  });

  it('is insensitive to job-filter order and duplicates', () => {
    const ab = computeIdempotencyKey({ ...base, mode: 'checks', jobFilter: ['a', 'b'] });
    const ba = computeIdempotencyKey({ ...base, mode: 'checks', jobFilter: ['b', 'a', 'a'] });
    expect(ab).toBe(ba);
  });

  it('attempt 1 (and absent attempt) keeps the historical key byte-identical', () => {
    const noAttempt = computeIdempotencyKey({ ...base, mode: 'checks' });
    expect(computeIdempotencyKey({ ...base, mode: 'checks', attempt: 1 })).toBe(noAttempt);
  });

  it('a re-run attempt produces a distinct key so it gets its own row/bubble', () => {
    const first = computeIdempotencyKey({ ...base, mode: 'checks' });
    const second = computeIdempotencyKey({ ...base, mode: 'checks', attempt: 2 });
    const third = computeIdempotencyKey({ ...base, mode: 'checks', attempt: 3 });
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });

  it('attempt composes with mode and job filter independently', () => {
    const checksA2 = computeIdempotencyKey({ ...base, mode: 'checks', attempt: 2 });
    const reviewA2 = computeIdempotencyKey({ ...base, mode: 'review', attempt: 2 });
    const checksJobA2 = computeIdempotencyKey({
      ...base,
      mode: 'checks',
      jobFilter: ['test'],
      attempt: 2,
    });
    expect(checksA2).not.toBe(reviewA2);
    expect(checksA2).not.toBe(checksJobA2);
  });
});
