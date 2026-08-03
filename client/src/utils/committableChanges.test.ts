import { describe, expect, it } from 'vitest';
import { hasCommittableChangesFromReady, noCommittableChangesTooltip } from './committableChanges';

describe('hasCommittableChangesFromReady', () => {
  it('returns false for null/empty input', () => {
    expect(hasCommittableChangesFromReady(null)).toBe(false);
    expect(hasCommittableChangesFromReady({})).toBe(false);
  });

  it('returns true when the branch carries commits', () => {
    expect(
      hasCommittableChangesFromReady({ branch: 'x', hasUncommitted: false, hasUnpushed: true }),
    ).toBe(true);
  });

  // Regression: uncommitted edits are not shippable work. Counting them lit the
  // Finalize button for a commit-less session, which then ran a full review + CI
  // cycle only to report that nothing would ship.
  it('returns false for uncommitted-only work', () => {
    expect(
      hasCommittableChangesFromReady({ branch: 'x', hasUncommitted: true, hasUnpushed: false }),
    ).toBe(false);
  });
});

describe('noCommittableChangesTooltip', () => {
  it('mentions session worktree vs project checkout', () => {
    const tip = noCommittableChangesTooltip('agent-hub/foo/session-1');
    expect(tip!).toMatch(/session's worktree/i);
    expect(tip!).toMatch(/project checkout/i);
    expect(tip!).toContain('agent-hub/foo/session-1');
  });

  it('names the uncommitted work when that is why the button is disabled', () => {
    const tip = noCommittableChangesTooltip('agent-hub/foo/session-1', { hasUncommitted: true });
    expect(tip!).toMatch(/uncommitted changes but no commits/i);
    expect(tip!).toMatch(/commit the work/i);
    expect(tip!).toContain('agent-hub/foo/session-1');
  });
});
