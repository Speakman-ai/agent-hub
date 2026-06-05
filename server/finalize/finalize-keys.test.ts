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
});
