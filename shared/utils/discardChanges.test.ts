import { describe, expect, it } from 'vitest';
import {
  discardBlockedReason,
  discardConfirmMessage,
  formatDiscardDiffSize,
  summarizeDiscardDiff,
} from './discardChanges';

describe('summarizeDiscardDiff', () => {
  it('sums additions and deletions across files', () => {
    const s = summarizeDiscardDiff({
      files: [
        { path: 'a.ts', additions: 10, deletions: 2 },
        { path: 'b.png', additions: 0, deletions: 0, binary: true },
        { path: 'c.ts', additions: 5, deletions: 1 },
      ],
      truncated: false,
    });
    expect(s).toEqual({ files: 3, additions: 15, deletions: 3, truncated: false });
  });

  it('returns null when the payload has no file list', () => {
    expect(summarizeDiscardDiff(null)).toBeNull();
    expect(summarizeDiscardDiff({ error: 'x' })).toBeNull();
  });

  it('ignores junk counts', () => {
    const s = summarizeDiscardDiff({ files: [{ additions: 'x', deletions: -3 }] });
    expect(s).toMatchObject({ files: 1, additions: 0, deletions: 0 });
  });
});

describe('formatDiscardDiffSize', () => {
  it('singular and truncated forms', () => {
    expect(formatDiscardDiffSize({ files: 1, additions: 3, deletions: 0, truncated: false })).toBe(
      '1 file (+3 -0)',
    );
    expect(formatDiscardDiffSize({ files: 500, additions: 9, deletions: 1, truncated: true })).toBe(
      '500+ files (+9 -1)',
    );
  });
});

describe('discardConfirmMessage', () => {
  it('states the diff size and that it cannot be undone', () => {
    const msg = discardConfirmMessage({ files: 2, additions: 40, deletions: 7, truncated: false });
    expect(msg).toContain('2 files (+40 -7)');
    expect(msg).toContain('cannot be undone');
  });

  it('still warns when the diff could not be loaded', () => {
    const msg = discardConfirmMessage(null);
    expect(msg).toContain('could not be loaded');
    expect(msg).toContain('cannot be undone');
  });

  it('says so when there are no changed files', () => {
    expect(
      discardConfirmMessage({ files: 0, additions: 0, deletions: 0, truncated: false }),
    ).toContain('No changed files');
  });
});

describe('discardBlockedReason', () => {
  it('blocks while Finalize is unfinished', () => {
    expect(discardBlockedReason({ sessionId: 's', finalizeInFlight: true })).toMatch(/Stop/);
    expect(discardBlockedReason({ sessionId: 's', readyToPush: true })).toMatch(/validated/);
    expect(discardBlockedReason({ sessionId: null })).not.toBeNull();
    expect(discardBlockedReason({ sessionId: 's' })).toBeNull();
  });
});
