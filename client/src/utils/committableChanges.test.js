import { describe, expect, it } from 'vitest';
import {
  hasCommittableChangesFromReady,
  noCommittableChangesTooltip,
} from './committableChanges.js';

describe('hasCommittableChangesFromReady', () => {
  it('returns false for null/empty input', () => {
    expect(hasCommittableChangesFromReady(null)).toBe(false);
    expect(hasCommittableChangesFromReady({})).toBe(false);
  });

  it('returns true when uncommitted or unpushed', () => {
    expect(
      hasCommittableChangesFromReady({ branch: 'x', hasUncommitted: true, hasUnpushed: false }),
    ).toBe(true);
    expect(
      hasCommittableChangesFromReady({ branch: 'x', hasUncommitted: false, hasUnpushed: true }),
    ).toBe(true);
  });
});

describe('noCommittableChangesTooltip', () => {
  it('mentions session worktree vs project checkout', () => {
    const tip = noCommittableChangesTooltip('agent-hub/foo/session-1');
    expect(tip).toMatch(/session's worktree/i);
    expect(tip).toMatch(/project checkout/i);
    expect(tip).toContain('agent-hub/foo/session-1');
  });
});
