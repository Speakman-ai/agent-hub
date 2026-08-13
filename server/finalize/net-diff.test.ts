import { describe, expect, it, vi } from 'vitest';
import {
  candidateBaseRefs,
  hasPublishableChanges,
  isPublishableVerdict,
  makeNetDiffProbe,
  type GitRunner,
  type NetDiffProbe,
} from './net-diff.js';
import { fakeHostSharedIo } from '../test/fake-worktree-io.js';

/** Every probe here injects `runGit`, so the seam is only an opaque handle. */
const io = fakeHostSharedIo();

/**
 * A fake `git` runner. `existing` are refs `rev-parse --verify` resolves; for a
 * resolved ref, `diffCode(ref)` decides `git diff --quiet <ref>...HEAD` (0 =
 * identical/empty, 1 = differs).
 */
function fakeGit(existing: Set<string>, diffCode: (ref: string) => number): GitRunner {
  return vi.fn<GitRunner>(async (args) => {
    if (args[0] === 'rev-parse') {
      const ref = args[args.length - 1] as string;
      return existing.has(ref) ? { stdout: 'deadbeef\n', code: 0 } : { stdout: '', code: 1 };
    }
    if (args[0] === 'diff') {
      // args = ['diff','--quiet', `${ref}...HEAD`]
      const ref = (args[2] as string).replace(/\.\.\.HEAD$/, '');
      return { stdout: '', code: diffCode(ref) };
    }
    return { stdout: '', code: 0 };
  });
}

describe('hasPublishableChanges', () => {
  const clean = { hasUncommitted: false, hasUnpushed: false };
  const unpushed = { hasUncommitted: false, hasUnpushed: true };
  const dirty = { hasUncommitted: true, hasUnpushed: false };

  it('is false for a clean, fully-pushed worktree (no probe)', async () => {
    const probe = vi.fn<NetDiffProbe>();
    expect(await hasPublishableChanges(io, clean, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('is false for a dirty worktree with no commits, without probing the base', async () => {
    // Regression: uncommitted edits are not shippable work. Counting them lit
    // the Finalize button for a commit-less session, which then ran a full
    // review + CI cycle and reported "no commits on this branch, so nothing
    // would ship" while the Changes badge advertised the edited files.
    const probe = vi.fn<NetDiffProbe>(async () => true);
    expect(await hasPublishableChanges(io, dirty, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('is true when unpushed commits produce a net diff vs base', async () => {
    expect(await hasPublishableChanges(io, unpushed, async () => true)).toBe(true);
  });

  it('is false when unpushed commits net to zero vs base', async () => {
    // The "Finalize kicked off for an empty diff" case: commits exist but add
    // nothing to base (commit+revert / already integrated).
    expect(await hasPublishableChanges(io, unpushed, async () => false)).toBe(false);
  });

  it('fails open (true) when the net diff is undeterminable', async () => {
    expect(await hasPublishableChanges(io, unpushed, async () => null)).toBe(true);
  });

  it('still judges the commits when the worktree is also dirty', async () => {
    const dirtyAndUnpushed = { hasUncommitted: true, hasUnpushed: true };
    expect(await hasPublishableChanges(io, dirtyAndUnpushed, async () => true)).toBe(true);
    expect(await hasPublishableChanges(io, dirtyAndUnpushed, async () => false)).toBe(false);
  });
});

describe('candidateBaseRefs', () => {
  it('targets only the explicit base (origin/<base> then <base>), never the default', () => {
    expect(candidateBaseRefs('feature/epic', 'main')).toEqual([
      'origin/feature/epic',
      'feature/epic',
    ]);
  });

  it('strips a leading origin/ from the explicit base', () => {
    expect(candidateBaseRefs('origin/feature/epic', null)).toEqual([
      'origin/feature/epic',
      'feature/epic',
    ]);
  });

  it('uses the resolved repo default when there is no explicit base', () => {
    expect(candidateBaseRefs(null, 'master')).toEqual(['origin/master', 'master']);
  });

  it('falls back to the legacy ref chain when no base is resolvable', () => {
    expect(candidateBaseRefs(null, null)).toEqual([
      'origin/HEAD',
      'origin/main',
      'origin/master',
      'main',
      'master',
    ]);
  });
});

describe('makeNetDiffProbe — base-aware', () => {
  const FEATURE = 'feature/accountability-role-remap';

  it('measures against the resolved PR base, not the repo default', async () => {
    // Regression for the surveytracker PR #308 zero-diff merge: the branch is
    // EMPTY vs its real feature base but NON-EMPTY vs master. Probing the repo
    // default let it pass the committable gate and ship an empty merge.
    const existing = new Set([`origin/${FEATURE}`, 'origin/main']);
    const diffCode = (ref: string) => (ref === `origin/${FEATURE}` ? 0 : 1);
    const resolveDefault = vi.fn(async () => 'main');

    // Base-aware probe → empty vs feature base → NOT publishable (blocks).
    const baseAware = makeNetDiffProbe(FEATURE, {
      runGit: fakeGit(existing, diffCode),
      resolveDefault,
    });
    expect(await baseAware(io)).toBe(false);
    // It must not consult the repo default at all when an explicit base is given.
    expect(resolveDefault).not.toHaveBeenCalled();

    // Same worktree, default-only probe → non-empty vs master → the old,
    // buggy "looks publishable" verdict. Confirms the two disagree.
    const defaultOnly = makeNetDiffProbe(null, {
      runGit: fakeGit(existing, diffCode),
      resolveDefault,
    });
    expect(await defaultOnly(io)).toBe(true);
  });

  it('returns true when the branch has a real net diff vs its PR base', async () => {
    const existing = new Set([`origin/${FEATURE}`]);
    const probe = makeNetDiffProbe(FEATURE, { runGit: fakeGit(existing, () => 1) });
    expect(await probe(io)).toBe(true);
  });

  it('does NOT silently fall back to the default when the explicit base ref is missing', async () => {
    // origin/main exists and differs, but the explicit feature base does not.
    // We must return null (undeterminable → fail open), never check master.
    const existing = new Set(['origin/main']);
    const resolveDefault = vi.fn(async () => 'main');
    const runGit = fakeGit(existing, () => 1);
    const probe = makeNetDiffProbe(FEATURE, { runGit, resolveDefault });
    expect(await probe(io)).toBeNull();
    expect(resolveDefault).not.toHaveBeenCalled();
  });

  it('propagates an unexpected git error as undeterminable (null)', async () => {
    const runGit: GitRunner = async (args) =>
      args[0] === 'rev-parse' ? { stdout: 'x\n', code: 0 } : { stdout: '', code: 129 };
    const probe = makeNetDiffProbe(FEATURE, { runGit });
    expect(await probe(io)).toBeNull();
  });
});

describe('isPublishableVerdict — explicit bases fail closed', () => {
  it('true diff / false diff are decided the same regardless of base authority', () => {
    expect(isPublishableVerdict(true, { explicitBase: true })).toBe(true);
    expect(isPublishableVerdict(true, { explicitBase: false })).toBe(true);
    expect(isPublishableVerdict(false, { explicitBase: true })).toBe(false);
    expect(isPublishableVerdict(false, { explicitBase: false })).toBe(false);
  });

  it('an undeterminable EXPLICIT base fails CLOSED (not publishable)', () => {
    // We have not proven a net diff against the real target, so a stale/missing
    // feature-base fetch must not let an empty stacked change through.
    expect(isPublishableVerdict(null, { explicitBase: true })).toBe(false);
  });

  it('an undeterminable repo-DEFAULT base fails OPEN (legacy behavior)', () => {
    expect(isPublishableVerdict(null, { explicitBase: false })).toBe(true);
  });
});
