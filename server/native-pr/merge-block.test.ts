import { describe, it, expect } from 'vitest';
import { isRetryableMergeBlock } from './merge-block.js';

// The native Auto-Merge path classifies a refused merge as retryable (a
// required check is still running → re-attempt when it goes green) vs terminal
// (changes requested / checks failed / conflict → leave it). Getting this wrong
// in either direction is the bug: terminal-as-retryable would loop, and
// retryable-as-terminal is exactly what stranded surveytracker #4/#5 open.

describe('isRetryableMergeBlock', () => {
  it('treats "checks still running" as retryable (raw reason)', () => {
    expect(
      isRetryableMergeBlock('Branch protection: checks are still running for the head commit.'),
    ).toBe(true);
  });

  it('treats "checks still running" as retryable through the autoMergeReadyPr wrapping', () => {
    // This is the exact shape that reaches autoMergeFinalizedPr's catch.
    expect(
      isRetryableMergeBlock(
        'native merge failed for /projects/surveytracker/pulls/4 (status 409): ' +
          'Branch protection: checks are still running for the head commit.',
      ),
    ).toBe(true);
  });

  it('treats "checks have not run yet" as retryable', () => {
    expect(
      isRetryableMergeBlock('Branch protection: checks have not run for the head commit yet.'),
    ).toBe(true);
  });

  it('treats a requested-changes block as terminal', () => {
    expect(
      isRetryableMergeBlock(
        'Branch protection: a reviewer requested changes — resolve the review before merging.',
      ),
    ).toBe(false);
  });

  it('treats a failed-checks block as terminal', () => {
    expect(
      isRetryableMergeBlock(
        'Branch protection: checks failed for the head commit — fix and re-run before merging.',
      ),
    ).toBe(false);
  });

  it('treats a merge conflict as terminal', () => {
    expect(isRetryableMergeBlock('merge conflict: server/index.ts')).toBe(false);
  });

  it('is false for empty / nullish input', () => {
    expect(isRetryableMergeBlock(null)).toBe(false);
    expect(isRetryableMergeBlock(undefined)).toBe(false);
    expect(isRetryableMergeBlock('')).toBe(false);
  });
});
