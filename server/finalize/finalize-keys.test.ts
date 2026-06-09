import { describe, it, expect } from 'vitest';
import { computeIdempotencyKey } from './finalize-keys.js';

describe('computeIdempotencyKey', () => {
  const base = { projectId: 'p', branch: 'feature/x', headSha: 'abc123' };

  it('omitting mode resolves to full (historical key preserved)', () => {
    expect(computeIdempotencyKey(base)).toBe(computeIdempotencyKey({ ...base, mode: 'full' }));
  });

  it('distinct modes get distinct keys (back-compat with legacy single-phase rows)', () => {
    const full = computeIdempotencyKey({ ...base, mode: 'full' });
    const checks = computeIdempotencyKey({ ...base, mode: 'checks' });
    const review = computeIdempotencyKey({ ...base, mode: 'review' });
    expect(full).not.toBe(checks);
    expect(full).not.toBe(review);
    expect(checks).not.toBe(review);
  });

  it('the key no longer varies by anything beyond project/branch/head/mode/attempt', () => {
    // Regression guard for the single-Finalize-button collapse: there is no
    // job-filter dimension left, so a given (project, branch, head, mode,
    // attempt) tuple maps to exactly one key.
    const a = computeIdempotencyKey({ ...base, mode: 'full' });
    const b = computeIdempotencyKey({ ...base, mode: 'full' });
    expect(a).toBe(b);
  });

  it('attempt 1 (and absent attempt) keeps the historical key byte-identical', () => {
    const noAttempt = computeIdempotencyKey({ ...base, mode: 'full' });
    expect(computeIdempotencyKey({ ...base, mode: 'full', attempt: 1 })).toBe(noAttempt);
  });

  it('a re-run attempt produces a distinct key so it gets its own row/bubble', () => {
    const first = computeIdempotencyKey({ ...base, mode: 'full' });
    const second = computeIdempotencyKey({ ...base, mode: 'full', attempt: 2 });
    const third = computeIdempotencyKey({ ...base, mode: 'full', attempt: 3 });
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });

  it('attempt composes with mode independently', () => {
    const fullA2 = computeIdempotencyKey({ ...base, mode: 'full', attempt: 2 });
    const checksA2 = computeIdempotencyKey({ ...base, mode: 'checks', attempt: 2 });
    expect(fullA2).not.toBe(checksA2);
  });
});
