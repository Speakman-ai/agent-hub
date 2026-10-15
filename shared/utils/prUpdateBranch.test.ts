import { describe, expect, it } from 'vitest';
import { updateBranchButtonState } from './prUpdateBranch';

const open = { state: 'open', base: 'main', behind_by: 3, mergeable: true };

describe('updateBranchButtonState', () => {
  it('is enabled for an open native PR behind its base', () => {
    expect(updateBranchButtonState(open, { isNative: true })).toMatchObject({
      visible: true,
      enabled: true,
      label: 'Update with main',
    });
  });

  it('is visible but disabled when the PR has conflicts', () => {
    const s = updateBranchButtonState({ ...open, mergeable: false }, { isNative: true });
    expect(s).toMatchObject({ visible: true, enabled: false });
    expect(s.reason).toMatch(/conflicts/);
  });

  it('hides when the head is up to date, unknown, closed, merged, or not native', () => {
    for (const pr of [
      { ...open, behind_by: 0 },
      { ...open, behind_by: null },
      { ...open, state: 'closed' },
      { ...open, merged_at: '2026-01-01T00:00:00Z' },
    ]) {
      expect(updateBranchButtonState(pr, { isNative: true }).visible).toBe(false);
    }
    expect(updateBranchButtonState(open, { isNative: false }).visible).toBe(false);
    expect(updateBranchButtonState(null, { isNative: true }).visible).toBe(false);
  });
});
