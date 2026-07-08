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

  it('returns changes when unpushed commits carry a real net diff vs base', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    // Probe reports a net diff → publishable.
    const out = await getSessionCommittableChanges('/tmp/wt', async () => true);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.changes.hasUnpushed).toBe(true);
  });

  it('is NOT committable when unpushed commits net to zero vs base (empty diff)', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    // Probe reports no net diff → nothing would land → not committable.
    const out = await getSessionCommittableChanges('/tmp/wt', async () => false);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('no_committable_changes');
  });

  it('fails open (committable) when the net diff cannot be determined', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    // Probe undeterminable (null) → never worse than reachability-only behavior.
    const out = await getSessionCommittableChanges('/tmp/wt', async () => null);
    expect(out.ok).toBe(true);
  });

  it('uncommitted changes are committable without probing the base', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const probe = vi.fn(async () => false);
    const out = await getSessionCommittableChanges('/tmp/wt', probe);
    expect(out.ok).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
