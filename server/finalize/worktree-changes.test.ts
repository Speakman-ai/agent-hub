import { describe, expect, it, vi } from 'vitest';
import { getSessionCommittableChanges, isCommittable } from './worktree-changes.js';

vi.mock('../auto-git.js', () => ({
  checkWorktreeChanges: vi.fn(),
}));

import { checkWorktreeChanges } from '../auto-git.js';

describe('isCommittable', () => {
  it('is true when uncommitted or unpushed', () => {
    expect(
      isCommittable({ hasUncommitted: true, hasUnpushed: false, branch: 'x', headSha: 'h' }),
    ).toBe(true);
    expect(
      isCommittable({ hasUncommitted: false, hasUnpushed: true, branch: 'x', headSha: 'h' }),
    ).toBe(true);
    expect(
      isCommittable({ hasUncommitted: false, hasUnpushed: false, branch: 'x', headSha: 'h' }),
    ).toBe(false);
  });
});

describe('getSessionCommittableChanges', () => {
  it('returns no_worktree when path is missing', async () => {
    const out = await getSessionCommittableChanges(null);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('no_worktree');
  });

  it('returns no_committable_changes when worktree is clean', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: false,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('no_committable_changes');
  });

  it('returns changes when worktree has unpushed commits', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.changes.hasUnpushed).toBe(true);
  });
});
