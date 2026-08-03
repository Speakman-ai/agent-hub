import { describe, expect, it, vi } from 'vitest';
import { getSessionCommittableChanges } from './worktree-changes.js';

vi.mock('../auto-git.js', () => ({
  checkWorktreeChanges: vi.fn(),
}));

import { checkWorktreeChanges } from '../auto-git.js';

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
    const out = await getSessionCommittableChanges('/tmp/wt', { probe: async () => true });
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
    // Probe reports no net diff → nothing would land → not committable. The
    // session is not empty (it has commits), so the reason names what is wrong
    // rather than claiming there is nothing here.
    const out = await getSessionCommittableChanges('/tmp/wt', { probe: async () => false });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('no_pushable_commits');
  });

  it('fails open (committable) when the net diff cannot be determined', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    // Probe undeterminable (null) → never worse than reachability-only behavior.
    const out = await getSessionCommittableChanges('/tmp/wt', { probe: async () => null });
    expect(out.ok).toBe(true);
  });

  // Regression: the reported "session finalized with no changes but says 7
  // changes". An agent left seven files edited and never committed. The
  // dirty-worktree shortcut lit the Finalize button and passed this gate, so
  // the run rebased, reviewed, and ran the full CI suite before parking at a
  // summary reading "No commits on this branch, so nothing would ship" next to
  // a Changes badge counting the seven files. Refuse at the gate instead.
  it('uncommitted changes with no commits are NOT committable', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const probe = vi.fn(async () => true);
    const out = await getSessionCommittableChanges('/tmp/wt', { probe });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('no_pushable_commits');
      // The refusal has to name the uncommitted work, or it reads as Finalize
      // losing the operator's files.
      expect(out.message).toContain('uncommitted');
      expect(out.message).toContain('commit them');
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports the empty session distinctly from uncommitted-only work', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: false,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('no_committable_changes');
      expect(out.message).not.toContain('uncommitted changes');
    }
  });

  it('is committable when commits exist alongside uncommitted work', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', { probe: async () => true });
    expect(out.ok).toBe(true);
  });

  it('blocks with base_unresolved when the authoritative base cannot be proven', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    // Explicit base + undeterminable probe (null) → fail closed with a distinct,
    // actionable reason (NOT "no changes"). This is the stale/missing feature-
    // base fetch case the guard is meant to catch.
    const out = await getSessionCommittableChanges('/tmp/wt', {
      base: { kind: 'explicit', baseBranch: 'feature/epic' },
      probe: async () => null,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('base_unresolved');
      expect(out.message).toContain('feature/epic');
    }
  });

  it('an unresolved base blocks outright even when a (publishable) probe is injected', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    // Regression: an injected probe must NOT be able to bypass the fail-closed
    // path for an unresolved base. Even a probe that reports a real net diff is
    // ignored — the base short-circuits before any probing.
    const probe = vi.fn(async () => true);
    const out = await getSessionCommittableChanges('/tmp/wt', {
      base: { kind: 'unresolved' },
      probe,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('base_unresolved');
    expect(probe).not.toHaveBeenCalled();
  });

  it('an unresolved base with no injected probe also blocks', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', { base: { kind: 'unresolved' } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('base_unresolved');
  });

  it('an explicit base with a real net diff is committable', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', {
      base: { kind: 'explicit', baseBranch: 'feature/epic' },
      probe: async () => true,
    });
    expect(out.ok).toBe(true);
  });

  it('a dirty worktree with no commits blocks even before the base is consulted', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'feature/x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', { base: { kind: 'unresolved' } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('no_pushable_commits');
  });
});

describe('getSessionCommittableChanges with requirePushableHead (the ship gate)', () => {
  // Regression: surveytracker session-04ebfae9 / PR #470. The agent staged 14
  // files and never committed, so the branch was identical to `master`. The
  // dirty-worktree shortcut passed the push gate, Finalize reviewed and tested
  // an unchanged tree, then pushed and auto-merged a zero-diff PR while the run
  // summary correctly reported "no commits found on the branch".
  it('blocks a staged-but-uncommitted session whose HEAD is empty vs base', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', {
      requirePushableHead: true,
      probe: async () => false,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('no_pushable_commits');
      // The refusal has to name the uncommitted work, or the operator reads it
      // as Finalize losing their staged files.
      expect(out.message).toContain('uncommitted');
      expect(out.message).toContain('commit them');
    }
  });

  it('probes the base even when the worktree is dirty', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const probe = vi.fn(async () => false);
    await getSessionCommittableChanges('/tmp/wt', { requirePushableHead: true, probe });
    expect(probe).toHaveBeenCalledWith('/tmp/wt');
  });

  it('allows a dirty worktree whose HEAD still carries a real diff vs base', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: true,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', {
      requirePushableHead: true,
      probe: async () => true,
    });
    expect(out.ok).toBe(true);
  });

  it('allows an already-pushed branch (hasUnpushed false) that still diffs vs base', async () => {
    // `hasUnpushed` is measured against the branch's upstream, so it goes false
    // as soon as the branch is pushed. A re-push of real work must not be
    // mistaken for an empty branch.
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: false,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', {
      requirePushableHead: true,
      probe: async () => true,
    });
    expect(out.ok).toBe(true);
  });

  // The ship gate must prove a diff. Failing open on an undeterminable probe
  // would let a transient git / base-resolution failure recreate the zero-diff
  // PR this gate exists to prevent.
  it('fails CLOSED when the net diff is undeterminable against a default base', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', {
      requirePushableHead: true,
      probe: async () => null,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('base_unresolved');
  });

  it('fails closed on an undeterminable probe even with a dirty worktree', async () => {
    // The dirty-worktree shortcut is skipped in this mode, so dirtiness must not
    // smuggle an unproven branch past the gate either.
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', {
      requirePushableHead: true,
      probe: async () => null,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('base_unresolved');
  });

  it('leaves the non-push gate failing open on an undeterminable default base', async () => {
    // Regression guard on the split: the Finalize-offer affordance must keep its
    // fail-open behavior so a detection miss never strands real work behind a
    // disabled button. Only the ship gate tightened.
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: false,
      hasUnpushed: true,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', { probe: async () => null });
    expect(out.ok).toBe(true);
  });

  it('fails closed with base_unresolved when an explicit base cannot be proven', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const out = await getSessionCommittableChanges('/tmp/wt', {
      requirePushableHead: true,
      base: { kind: 'explicit', baseBranch: 'feature/epic' },
      probe: async () => null,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('base_unresolved');
  });

  it('an unresolved base blocks before any probing', async () => {
    vi.mocked(checkWorktreeChanges).mockResolvedValue({
      hasUncommitted: true,
      hasUnpushed: false,
      branch: 'agent-hub/dev/session-x',
      headSha: 'abc123',
    });
    const probe = vi.fn(async () => true);
    const out = await getSessionCommittableChanges('/tmp/wt', {
      requirePushableHead: true,
      base: { kind: 'unresolved' },
      probe,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('base_unresolved');
    expect(probe).not.toHaveBeenCalled();
  });

  it('still reports no_worktree with no path', async () => {
    const out = await getSessionCommittableChanges(null, { requirePushableHead: true });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('no_worktree');
  });
});
