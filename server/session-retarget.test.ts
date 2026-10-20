import { execFileSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { HostWorktreeIo } from './session-env/worktree-io.js';
import {
  retargetSessionWorktree,
  buildRetargetAgentPrompt,
  buildSessionTargetPromptNote,
  isRetargetComplete,
  settleSessionRetarget,
  sessionTargetNoteFor,
} from './session-retarget.js';
import { git, makeRetargetRepo, type RetargetRepo } from './test/retarget-repo-fixture.js';

let repo: RetargetRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

function log(cwd: string): string[] {
  return git(cwd, 'log', '--format=%s', 'HEAD').split('\n');
}

describe('retargetSessionWorktree', () => {
  it('moves only the session commits onto the new target', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'rebased', commits: 2 });
    // The main-only commit must not be dragged onto release.
    expect(log(repo.clone)).toEqual(['S2', 'S1', 'R release-only', 'A']);
    expect(git(repo.clone, 'merge-base', 'HEAD', 'origin/release')).toBe(repo.releaseTip);
    expect(git(repo.clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent-hub/dev/session-1');
  });

  it('aborts on conflict and leaves HEAD where it was', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true });
    const io = new HostWorktreeIo(repo.clone);
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'conflict', commits: 2, files: ['shared.txt'] });
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(repo.clone, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(repo.clone, '.git', 'rebase-apply'))).toBe(false);
    expect(git(repo.clone, 'status', '--porcelain')).toBe('');
  });

  it('refuses to touch a dirty worktree', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    writeFileSync(join(repo.clone, 'wip.txt'), 'unsaved\n');
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'dirty', targetSha: repo.releaseTip });
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('reports a missing target without rewriting history', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'nope' });

    expect(outcome.kind).toBe('error');
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('is a no-op for the same branch and rejects unsafe names', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    expect((await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'main' })).kind).toBe(
      'noop',
    );
    expect(
      (await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'x;rm -rf' })).kind,
    ).toBe('error');
  });
});

describe('retargetSessionWorktree content preservation', () => {
  it('flattens a merge history with an identical tree instead of dropping the merge-only change', async () => {
    repo = makeRetargetRepo({ mergeOnlyChange: true });
    const io = new HostWorktreeIo(repo.clone);
    const before = git(repo.clone, 'rev-parse', 'HEAD');
    const beforeTree = git(repo.clone, 'rev-parse', 'HEAD^{tree}');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'rebased', commits: 1 });
    if (outcome.kind !== 'rebased') return;
    expect(outcome.flattened).toMatchObject({ originalHead: before, mergeCount: 1 });
    expect(git(repo.clone, 'show', 'HEAD:merge-only.txt')).toBe('only in the merge');
    expect(git(repo.clone, 'rev-list', '--merges', `${repo.releaseTip}..HEAD`)).toBe('');
    // The original history is kept, and its content is exactly what moved.
    expect(git(repo.clone, 'rev-parse', outcome.flattened!.backupRef)).toBe(before);
    expect(git(repo.clone, 'rev-parse', `${outcome.flattened!.backupRef}^{tree}`)).toBe(beforeTree);
    expect(git(repo.clone, 'status', '--porcelain')).toBe('');
  });

  it('accepts a rebase that drops a commit the target already has', async () => {
    repo = makeRetargetRepo({ releaseHasS2: true });
    const io = new HostWorktreeIo(repo.clone);

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    // S2 is already on release: the tree matches target + session change.
    expect(outcome).toMatchObject({ kind: 'rebased' });
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S1',
      'S2 upstream',
      'R release-only',
      'A',
    ]);
    expect(git(repo.clone, 'show', 'HEAD:shared.txt')).toBe('session edit');
  });
});

function advanceMain(r: RetargetRepo, file: string, subject: string): void {
  git(r.seed, 'checkout', '-q', 'main');
  git(r.seed, 'pull', '-q', 'origin', 'main');
  writeFileSync(join(r.seed, file), `${subject}\n`);
  git(r.seed, 'add', file);
  git(r.seed, 'commit', '-qm', subject);
  git(r.seed, 'push', '-q', 'origin', 'main');
}

describe('retargetSessionWorktree session fork', () => {
  it('moves the session commits even after main absorbed them before the first change', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    // Upstream merges the session's work (S1, S2) into main, then moves on.
    git(repo.clone, 'push', '-q', 'origin', 'HEAD:main');
    advanceMain(repo, 'later-main.txt', 'C main after merge');
    git(repo.clone, 'fetch', '-q', 'origin');
    expect(git(repo.clone, 'merge-base', 'HEAD', 'origin/main')).toBe(
      git(repo.clone, 'rev-parse', 'HEAD'),
    );

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    // release lacks S1 and S2, so both move; nothing from main comes along.
    expect(outcome).toMatchObject({ kind: 'rebased', commits: 2 });
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S2',
      'S1',
      'R release-only',
      'A',
    ]);
  });

  it('moves only the session commits after a forward rebase onto newer main', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    advanceMain(repo, 'newer-main.txt', 'C newer main');
    git(repo.clone, 'fetch', '-q', 'origin');
    git(repo.clone, 'rebase', '-q', 'origin/main');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'rebased', commits: 2 });
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S2',
      'S1',
      'R release-only',
      'A',
    ]);
  });

  it('moves only the session change after the session merged newer main in', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    advanceMain(repo, 'newer-main.txt', 'C newer main');
    git(repo.clone, 'fetch', '-q', 'origin');
    git(repo.clone, 'merge', '-q', '--no-ff', '-m', 'merge main', 'origin/main');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'rebased' });
    // Session files moved; main's own files did not.
    expect(git(repo.clone, 'show', 'HEAD:session.txt')).toBe('session');
    expect(git(repo.clone, 'show', 'HEAD:shared.txt')).toBe('session edit');
    expect(() => git(repo!.clone, 'show', 'HEAD:main-only.txt')).toThrow();
    expect(() => git(repo!.clone, 'show', 'HEAD:newer-main.txt')).toThrow();
    expect(git(repo.clone, 'merge-base', '--is-ancestor', repo.releaseTip, 'HEAD')).toBe('');
  });
});

describe('retargetSessionWorktree upstream baseline', () => {
  it('keeps main-only changes out after the session merged main and main absorbed that merge', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    advanceMain(repo, 'newer-main.txt', 'C newer main');
    git(repo.clone, 'fetch', '-q', 'origin');
    git(repo.clone, 'merge', '-q', '--no-ff', '-m', 'M merge main', 'origin/main');
    // Upstream then absorbs the session, merge commit included.
    git(repo.clone, 'push', '-q', 'origin', 'HEAD:main');
    git(repo.clone, 'fetch', '-q', 'origin');
    expect(git(repo.clone, 'merge-base', 'HEAD', 'origin/main')).toBe(
      git(repo.clone, 'rev-parse', 'HEAD'),
    );

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'rebased' });
    expect(git(repo.clone, 'show', 'HEAD:session.txt')).toBe('session');
    expect(git(repo.clone, 'show', 'HEAD:shared.txt')).toBe('session edit');
    expect(git(repo.clone, 'show', 'HEAD:release-only.txt')).toBe('release');
    // Neither main-only commit (B before the fork, C merged in) comes along.
    expect(() => git(repo!.clone, 'show', 'HEAD:main-only.txt')).toThrow();
    expect(() => git(repo!.clone, 'show', 'HEAD:newer-main.txt')).toThrow();
  });

  it('records the baseline, not a session commit, as the fork of a conflicted hand-off', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true });
    const io = new HostWorktreeIo(repo.clone);
    advanceMain(repo, 'newer-main.txt', 'C newer main');
    git(repo.clone, 'fetch', '-q', 'origin');
    const newerMain = git(repo.clone, 'rev-parse', 'origin/main');
    git(repo.clone, 'merge', '-q', '--no-ff', '-m', 'M merge main', 'origin/main');
    git(repo.clone, 'push', '-q', 'origin', 'HEAD:main');
    git(repo.clone, 'fetch', '-q', 'origin');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'conflict', forkSha: newerMain });
  });
});

describe('retargetSessionWorktree absorbed-then-merged session work', () => {
  function absorbS1ThenMergeMain(r: RetargetRepo): { s1: string; s2: string } {
    const s2 = git(r.clone, 'rev-parse', 'HEAD');
    const s1 = git(r.clone, 'rev-parse', 'HEAD^');
    // Upstream takes only S1, then moves on with C; the session merges main.
    git(r.clone, 'push', '-q', 'origin', `${s1}:main`);
    advanceMain(r, 'newer-main.txt', 'C newer main');
    git(r.clone, 'fetch', '-q', 'origin');
    git(r.clone, 'merge', '-q', '--no-ff', '-m', 'M merge main', 'origin/main');
    return { s1, s2 };
  }

  it('refuses instead of subtracting S1 out with the upstream baseline', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    const { s1, s2 } = absorbS1ThenMergeMain(repo);
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'busy' });
    expect(outcome.kind === 'busy' && outcome.reason).toContain('already contains session work');
    expect(outcome.kind === 'busy' && outcome.reason).toContain(s1.slice(0, 7));
    // Nothing was rewritten: both session commits are still on the branch.
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo.clone, 'merge-base', '--is-ancestor', s1, 'HEAD')).toBe('');
    expect(git(repo.clone, 'merge-base', '--is-ancestor', s2, 'HEAD')).toBe('');
    expect(git(repo.clone, 'show', 'HEAD:shared.txt')).toBe('session edit');
    expect(git(repo.clone, 'show', 'HEAD:session.txt')).toBe('session');
  });
});

describe('retargetSessionWorktree absorbed-then-rebased session work', () => {
  it('refuses when a forward rebase onto an absorbing upstream hid S1 from HEAD', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    const s1 = git(repo.clone, 'rev-parse', 'HEAD^');
    // Upstream takes S1 and adds C; the session then rebases onto it, which
    // drops S1 from the branch (already upstream): HEAD is C -> S2'.
    git(repo.clone, 'push', '-q', 'origin', `${s1}:main`);
    advanceMain(repo, 'newer-main.txt', 'C newer main');
    git(repo.clone, 'fetch', '-q', 'origin');
    git(repo.clone, 'rebase', '-q', 'origin/main');
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD', '-2').split('\n')).toEqual([
      'S2',
      'C newer main',
    ]);
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    // Replaying only S2' onto release would silently drop S1.
    expect(outcome).toMatchObject({ kind: 'busy' });
    expect(outcome.kind === 'busy' && outcome.reason).toContain(s1.slice(0, 7));
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
  });
});

describe('retargetSessionWorktree fetch freshness', () => {
  it('refuses a target deleted on origin even when its tracking ref is cached', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    git(repo.seed, 'push', '-q', 'origin', '--delete', 'release');
    // The clone still has the stale tracking ref from its initial fetch.
    expect(git(repo.clone, 'rev-parse', 'origin/release')).toBe(repo.releaseTip);
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome.kind).toBe('error');
    expect(outcome.kind === 'error' && outcome.message).toContain('Could not fetch release');
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
  });
});

function pauseInteractiveRebase(cwd: string): void {
  // Mark the last commit `edit` so the rebase stops with a clean worktree.
  execFileSync('git', ['rebase', '-i', 'HEAD~1'], {
    cwd,
    env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i '1s/^pick/edit/'" },
    stdio: 'ignore',
  });
}

describe('retargetSessionWorktree with an operation already open', () => {
  it('leaves a paused rebase it did not start alone', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    pauseInteractiveRebase(repo.clone);
    expect(git(repo.clone, 'status', '--porcelain')).toBe('');
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'busy' });
    expect(existsSync(join(repo.clone, '.git', 'rebase-merge'))).toBe(true);
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(before);
    // The user's rebase can still be finished.
    git(repo.clone, 'rebase', '--continue');
    expect(git(repo.clone, 'log', '-1', '--format=%s')).toBe('S2');
  });

  it('does not report a mid-rebase HEAD as a finished retarget', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });
    expect(
      await isRetargetComplete(io, { targetSha: repo.releaseTip, forkSha: repo.mainOnlySha }),
    ).toBe(true);
    pauseInteractiveRebase(repo.clone);
    expect(
      await isRetargetComplete(io, { targetSha: repo.releaseTip, forkSha: repo.mainOnlySha }),
    ).toBe(false);
  });
});

describe('settleSessionRetarget', () => {
  const session = (r: RetargetRepo) => ({
    id: 's1',
    pr_base_pending_from: 'main',
    pr_base_pending_to_sha: r.releaseTip,
    pr_base_pending_fork_sha: r.mainOnlySha,
    worktree_path: r.clone,
  });

  it('keeps the pending base while the commits are still on the old base', async () => {
    repo = makeRetargetRepo();
    const clear = vi.fn();
    const out = await settleSessionRetarget({
      session: session(repo),
      io: new HostWorktreeIo(repo.clone),
      clear,
    });
    expect(out.pr_base_pending_from).toBe('main');
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears it once the commits sit on the target', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });
    const clear = vi.fn();
    const out = await settleSessionRetarget({ session: session(repo), io, clear });
    expect(out.pr_base_pending_from).toBeNull();
    expect(out.pr_base_pending_to_sha).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe('isRetargetComplete', () => {
  it('is false until the session commits sit on the pinned target tip', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    const opts = { targetSha: repo.releaseTip, forkSha: repo.mainOnlySha };
    expect(await isRetargetComplete(io, opts)).toBe(false);

    await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(await isRetargetComplete(io, opts)).toBe(true);
  });

  it('is false when the target descends from the old base and the rebase conflicted', async () => {
    // main = A, release = A -> R, session = A -> S1 -> S2 with R and S1
    // conflicting. HEAD shares nothing with main outside release, but it
    // never picked up R, so the retarget is not done.
    repo = makeRetargetRepo({ conflictOnRelease: true, noMainOnly: true });
    const io = new HostWorktreeIo(repo.clone);
    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });
    expect(outcome).toMatchObject({ kind: 'conflict', targetSha: repo.releaseTip });

    expect(
      await isRetargetComplete(io, { targetSha: repo.releaseTip, forkSha: repo.mainOnlySha }),
    ).toBe(false);
  });

  it('stays complete after the target advances past the pinned tip', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });
    git(repo.seed, 'checkout', '-q', 'release');
    writeFileSync(join(repo.seed, 'later.txt'), 'later\n');
    git(repo.seed, 'add', 'later.txt');
    git(repo.seed, 'commit', '-qm', 'R2 later');
    git(repo.seed, 'push', '-q', 'origin', 'release');

    expect(
      await isRetargetComplete(io, { targetSha: repo.releaseTip, forkSha: repo.mainOnlySha }),
    ).toBe(true);
  });

  it('is false for a plain rebase that carried old-base commits along', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    git(repo.clone, 'rebase', 'origin/release');

    expect(
      await isRetargetComplete(io, { targetSha: repo.releaseTip, forkSha: repo.mainOnlySha }),
    ).toBe(false);
  });

  it('is false without a recorded target tip', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });
    expect(await isRetargetComplete(io, { targetSha: null, forkSha: repo.mainOnlySha })).toBe(
      false,
    );
  });
});

const T = 'a'.repeat(40);
const F = 'b'.repeat(40);
const H = 'c'.repeat(40);

describe('buildRetargetAgentPrompt', () => {
  it('replays exactly the recorded range onto the pinned tip', () => {
    const prompt = buildRetargetAgentPrompt({
      fromBranch: 'main',
      toBranch: 'release-1.16.0',
      outcome: {
        kind: 'conflict',
        commits: 2,
        files: ['a.py', 'b.py'],
        forkSha: F,
        targetSha: T,
        headSha: H,
      },
    });
    expect(prompt).toContain('`a.py`');
    expect(prompt).toContain(`git merge-base --is-ancestor ${H} HEAD`);
    expect(prompt).toContain(`test -z "$(git rev-list --merges ${F}..HEAD)"`);
    expect(prompt).toContain(`git rebase --onto ${T} ${F}`);
    expect(prompt).toContain(`git range-diff ${F}..ORIG_HEAD ${T}..HEAD`);
    expect(prompt).not.toContain('git reset --soft');
    expect(prompt).toContain('ask the user to select the target branch again');
    expect(prompt).toContain('do not push');
    // Never re-derive the fork or target from the (movable) branches.
    expect(prompt).not.toMatch(/merge-base HEAD origin\//);
    expect(prompt).not.toMatch(/rebase --onto origin\//);
  });

  it('explains an unsafe hand-off', () => {
    const prompt = buildRetargetAgentPrompt({
      fromBranch: 'main',
      toBranch: 'release',
      outcome: {
        kind: 'unsafe',
        commits: 3,
        forkSha: F,
        targetSha: T,
        headSha: H,
        reason: 'the session history has 1 merge commit(s), which a rebase does not replay',
      },
    });
    expect(prompt).toContain(
      'did not rebase automatically because the session history has 1 merge commit',
    );
    expect(prompt).toContain(`git rebase --onto ${T} ${F}`);
  });
});

describe('buildSessionTargetPromptNote', () => {
  it('repeats the recorded procedure while a retarget is pending', () => {
    const note = buildSessionTargetPromptNote('release-1.16.0', {
      fromBranch: 'main',
      targetSha: T,
      forkSha: F,
      headSha: H,
    });
    expect(note).toContain(`git rebase --onto ${T} ${F}`);
    expect(note).toContain(`git merge-base --is-ancestor ${H} HEAD`);
    expect(note).toContain('Do not run a plain');
    expect(note).not.toMatch(/merge-base HEAD origin\//);
  });

  it('refuses to give hand commands for an incomplete record', () => {
    const note = buildSessionTargetPromptNote('release', { fromBranch: 'main', targetSha: T });
    expect(note).toContain('select `release` again');
    expect(note).not.toContain('git rebase --onto');
  });

  it('tells the agent to rebase onto the session target', () => {
    const note = buildSessionTargetPromptNote('release-1.16.0');
    expect(note).toContain('git rebase origin/release-1.16.0');
    expect(note).toContain('not any other branch this session targeted earlier');
  });
});

describe('agent retarget procedure (executed)', () => {
  function runProcedure(cwd: string, prompt: string): void {
    const block = prompt.split('```')[1]!.trim();
    execFileSync('bash', ['-e', '-c', block], {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Agent',
        GIT_AUTHOR_EMAIL: 'agent@example.com',
        GIT_COMMITTER_NAME: 'Agent',
        GIT_COMMITTER_EMAIL: 'agent@example.com',
      },
    });
  }

  it('moves all session work even after the old base absorbed the session commits', async () => {
    repo = makeRetargetRepo();
    const io = new HostWorktreeIo(repo.clone);
    writeFileSync(join(repo.clone, 'wip.txt'), 'wip\n');
    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });
    expect(outcome.kind).toBe('dirty');
    if (outcome.kind !== 'dirty') return;

    // During the hand-off main merges the session's existing commits (S1, S2).
    git(repo.clone, 'push', '-q', 'origin', 'HEAD:main');
    git(repo.clone, 'fetch', '-q', 'origin');
    // The agent commits the dirty tree, then follows the hand-off procedure.
    git(repo.clone, 'add', 'wip.txt');
    git(repo.clone, 'commit', '-qm', 'S3 wip');
    runProcedure(
      repo.clone,
      buildRetargetAgentPrompt({ fromBranch: 'main', toBranch: 'release', outcome }),
    );

    // S1 and S2 are not on release, so they must move too, not just S3.
    expect(git(repo.clone, 'log', '--format=%s', 'HEAD').split('\n')).toEqual([
      'S3 wip',
      'S2',
      'S1',
      'R release-only',
      'A',
    ]);
    expect(
      await isRetargetComplete(io, { targetSha: outcome.targetSha, forkSha: outcome.forkSha }),
    ).toBe(true);
  });

  it('follows a merge-history conflict hand-off through to completion', async () => {
    repo = makeRetargetRepo({ mergeOnlyChange: true, conflictOnRelease: true });
    const io = new HostWorktreeIo(repo.clone);
    const before = git(repo.clone, 'rev-parse', 'HEAD');

    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });

    expect(outcome).toMatchObject({ kind: 'conflict', files: ['shared.txt'] });
    if (outcome.kind !== 'conflict') return;
    // The hand-off starts from the Hub's flattened commit, so the procedure's
    // ancestry precondition holds without anyone rewriting history by hand.
    expect(outcome.flattened).toMatchObject({ originalHead: before, mergeCount: 1 });
    expect(outcome.headSha).toBe(git(repo.clone, 'rev-parse', 'HEAD'));
    expect(git(repo.clone, 'rev-parse', 'HEAD^')).toBe(outcome.forkSha);
    const prompt = buildRetargetAgentPrompt({ fromBranch: 'main', toBranch: 'release', outcome });
    expect(prompt).toContain(outcome.flattened!.backupRef);

    // The agent runs the chain, hits the conflict, keeps the session side, continues.
    expect(() => runProcedure(repo!.clone, prompt)).toThrow();
    git(repo.clone, 'checkout', '--theirs', 'shared.txt');
    git(repo.clone, 'add', 'shared.txt');
    git(repo.clone, '-c', 'core.editor=true', 'rebase', '--continue');

    expect(git(repo.clone, 'rev-parse', 'HEAD^')).toBe(repo.releaseTip);
    expect(git(repo.clone, 'show', 'HEAD:merge-only.txt')).toBe('only in the merge');
    expect(git(repo.clone, 'show', 'HEAD:shared.txt')).toBe('session edit');
    expect(
      await isRetargetComplete(io, { targetSha: outcome.targetSha, forkSha: outcome.forkSha }),
    ).toBe(true);
  });

  it('stops before rewriting when history was rewritten after the hand-off', async () => {
    repo = makeRetargetRepo({ conflictOnRelease: true });
    const io = new HostWorktreeIo(repo.clone);
    const outcome = await retargetSessionWorktree(io, { fromBranch: 'main', toBranch: 'release' });
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') return;
    git(repo.clone, 'commit', '-q', '--amend', '-m', 'S2 reworded');
    const rewritten = git(repo.clone, 'rev-parse', 'HEAD');

    expect(() =>
      runProcedure(
        repo!.clone,
        buildRetargetAgentPrompt({ fromBranch: 'main', toBranch: 'release', outcome }),
      ),
    ).toThrow();
    expect(git(repo.clone, 'rev-parse', 'HEAD')).toBe(rewritten);
    expect(existsSync(join(repo.clone, '.git', 'rebase-merge'))).toBe(false);
  });
});

describe('sessionTargetNoteFor', () => {
  const base = {
    pr_base_branch: null,
    pr_base_target_changed: 0,
    pr_base_pending_to_sha: null,
    pr_base_pending_fork_sha: null,
    pr_base_pending_head_sha: null,
  };

  it('restates the effective default after the override is cleared', () => {
    // Was told "target release"; the override is now cleared back to main.
    const note = sessionTargetNoteFor({
      session: { ...base, pr_base_target_changed: 1 },
      effectiveTarget: 'main',
      pendingFrom: null,
    });
    expect(note).toContain('This session targets `main`');
    expect(note).toContain('git rebase origin/main');
    expect(note).not.toContain('release');
  });

  it('names the card or epic target once the picker was used', () => {
    const note = sessionTargetNoteFor({
      session: { ...base, pr_base_target_changed: 1 },
      effectiveTarget: 'feature/epic',
      pendingFrom: null,
    });
    expect(note).toContain('This session targets `feature/epic`');
  });

  it('adds nothing for a session that never used the picker', () => {
    expect(
      sessionTargetNoteFor({ session: base, effectiveTarget: 'main', pendingFrom: null }),
    ).toBe('');
  });

  it('uses the recorded procedure while a retarget is pending', () => {
    const note = sessionTargetNoteFor({
      session: {
        ...base,
        pr_base_branch: 'release',
        pr_base_target_changed: 1,
        pr_base_pending_to_sha: T,
        pr_base_pending_fork_sha: F,
        pr_base_pending_head_sha: H,
      },
      effectiveTarget: 'release',
      pendingFrom: 'main',
    });
    expect(note).toContain('REBASE PENDING');
    expect(note).toContain(`git rebase --onto ${T} ${F}`);
  });
});
