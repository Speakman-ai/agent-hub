/**
 * Tests for `pre-push-rebase.ts`. Uses a real ephemeral git repo (no remote
 * is needed — we set up a bare `origin` and clone it locally). The whole
 * thing runs under `os.tmpdir()` and is cleaned up after each test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { rebaseOntoBase } from './pre-push-rebase.js';

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

describe('rebaseOntoBase', () => {
  let tmpRoot: string;
  let originBare: string;
  let clone: string;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `pre-push-rebase-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpRoot, { recursive: true });

    originBare = path.join(tmpRoot, 'origin.git');
    mkdirSync(originBare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: originBare, stdio: 'pipe' });

    // Seed origin with one commit on main so we can clone it.
    const seeder = path.join(tmpRoot, 'seeder');
    execSync(`git clone --quiet "${originBare}" "${seeder}"`, { stdio: 'pipe' });
    git(seeder, 'config user.email "seed@example.com"');
    git(seeder, 'config user.name "Seed"');
    writeFileSync(path.join(seeder, 'main.txt'), 'main v1\n');
    git(seeder, 'add main.txt');
    git(seeder, 'commit -m "initial"');
    git(seeder, 'push -u origin main');

    // Clone for the session and check out a feature branch.
    clone = path.join(tmpRoot, 'clone');
    execSync(`git clone --quiet "${originBare}" "${clone}"`, { stdio: 'pipe' });
    git(clone, 'config user.email "feature@example.com"');
    git(clone, 'config user.name "Feature"');
    git(clone, 'checkout -b feature/x');
    writeFileSync(path.join(clone, 'feature.txt'), 'feature v1\n');
    git(clone, 'add feature.txt');
    git(clone, 'commit -m "feature commit"');
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('returns "noop" when origin/<base> has not advanced', async () => {
    const out = await rebaseOntoBase({ cwd: clone, baseBranch: 'main' });
    expect(out.kind).toBe('noop');
  });

  it('returns "skipped" when baseBranch is empty or unsafe', async () => {
    const out1 = await rebaseOntoBase({ cwd: clone, baseBranch: '' });
    expect(out1.kind).toBe('skipped');
    const out2 = await rebaseOntoBase({ cwd: clone, baseBranch: '../etc/passwd' });
    expect(out2.kind).toBe('skipped');
    const out3 = await rebaseOntoBase({ cwd: clone, baseBranch: 'main; rm -rf /' });
    expect(out3.kind).toBe('skipped');
  });

  it('rebases cleanly when origin/main advances with a non-conflicting commit', async () => {
    // Sibling pushes a non-conflicting change to main.
    const sibling = path.join(tmpRoot, 'sibling');
    execSync(`git clone --quiet "${originBare}" "${sibling}"`, { stdio: 'pipe' });
    git(sibling, 'config user.email "sib@example.com"');
    git(sibling, 'config user.name "Sib"');
    writeFileSync(path.join(sibling, 'sibling.txt'), 'sibling change\n');
    git(sibling, 'add sibling.txt');
    git(sibling, 'commit -m "sibling commit"');
    git(sibling, 'push origin main');

    const beforeHead = git(clone, 'rev-parse HEAD');
    const out = await rebaseOntoBase({ cwd: clone, baseBranch: 'main' });
    expect(out.kind).toBe('rebased');
    if (out.kind === 'rebased') {
      expect(out.commitsBehind).toBe(1);
    }
    // HEAD moved (rebase rewrote our commit on top of the new base tip).
    expect(git(clone, 'rev-parse HEAD')).not.toBe(beforeHead);
    // The sibling's file is now present in our worktree.
    expect(git(clone, 'log --oneline -10')).toContain('sibling commit');
    expect(git(clone, 'log --oneline -10')).toContain('feature commit');
  });

  it('transplants only session commits when an epic base differs from main', async () => {
    const epic = path.join(tmpRoot, 'epic-base');
    execSync(`git clone --quiet "${originBare}" "${epic}"`, { stdio: 'pipe' });
    git(epic, 'config user.email "epic@example.com"');
    git(epic, 'config user.name "Epic"');
    git(epic, 'checkout -b feature/auto/auth origin/main');
    writeFileSync(path.join(epic, 'auth.ts'), 'smtp transport baseline\n');
    git(epic, 'add auth.ts');
    git(epic, 'commit -m "smtp baseline"');
    git(epic, 'push -u origin feature/auto/auth');

    const main = path.join(tmpRoot, 'main-advance');
    execSync(`git clone --quiet "${originBare}" "${main}"`, { stdio: 'pipe' });
    git(main, 'config user.email "main@example.com"');
    git(main, 'config user.name "Main"');
    writeFileSync(path.join(main, 'auth.ts'), 'password reset baseline\n');
    git(main, 'add auth.ts');
    git(main, 'commit -m "password reset baseline"');
    git(main, 'push origin main');

    git(clone, 'fetch origin main feature/auto/auth');
    git(clone, 'checkout -B feature/main-based origin/main');
    writeFileSync(path.join(clone, 'invite.ts'), 'invite email delivery\n');
    git(clone, 'add invite.ts');
    git(clone, 'commit -m "invite email delivery"');

    const out = await rebaseOntoBase({ cwd: clone, baseBranch: 'feature/auto/auth' });

    expect(out.kind).toBe('rebased');
    expect(git(clone, 'merge-base HEAD origin/feature/auto/auth')).toBe(
      git(clone, 'rev-parse origin/feature/auto/auth'),
    );
    expect(git(clone, 'log --oneline origin/feature/auto/auth..HEAD')).toContain(
      'invite email delivery',
    );
    expect(git(clone, 'log --oneline origin/feature/auto/auth..HEAD')).not.toContain(
      'password reset baseline',
    );
    expect(git(clone, 'show HEAD:auth.ts')).toBe('smtp transport baseline');
    expect(git(clone, 'show HEAD:invite.ts')).toBe('invite email delivery');
  });

  it('restores the original branch tip when transplant cherry-pick conflicts', async () => {
    const epic = path.join(tmpRoot, 'epic-conflict-base');
    execSync(`git clone --quiet "${originBare}" "${epic}"`, { stdio: 'pipe' });
    git(epic, 'config user.email "epic@example.com"');
    git(epic, 'config user.name "Epic"');
    git(epic, 'checkout -b feature/auto/auth origin/main');
    writeFileSync(path.join(epic, 'auth.ts'), 'smtp transport baseline\n');
    git(epic, 'add auth.ts');
    git(epic, 'commit -m "smtp baseline"');
    git(epic, 'push -u origin feature/auto/auth');

    const main = path.join(tmpRoot, 'main-conflict-advance');
    execSync(`git clone --quiet "${originBare}" "${main}"`, { stdio: 'pipe' });
    git(main, 'config user.email "main@example.com"');
    git(main, 'config user.name "Main"');
    writeFileSync(path.join(main, 'auth.ts'), 'password reset baseline\n');
    git(main, 'add auth.ts');
    git(main, 'commit -m "password reset baseline"');
    git(main, 'push origin main');

    git(clone, 'fetch origin main feature/auto/auth');
    git(clone, 'checkout -B feature/main-based origin/main');
    writeFileSync(path.join(clone, 'auth.ts'), 'invite email delivery\n');
    git(clone, 'add auth.ts');
    git(clone, 'commit -m "invite email delivery"');

    const originalHead = git(clone, 'rev-parse HEAD');
    const epicTip = git(clone, 'rev-parse origin/feature/auto/auth');
    const logs: string[] = [];

    const out = await rebaseOntoBase({
      cwd: clone,
      baseBranch: 'feature/auto/auth',
      prLog: (line) => logs.push(line),
    });

    expect(out.kind).toBe('conflict');
    expect(logs.join('')).toContain('transplant failed, restoring original HEAD');
    expect(git(clone, 'rev-parse HEAD')).toBe(originalHead);
    expect(git(clone, 'rev-parse HEAD')).not.toBe(epicTip);
    expect(git(clone, 'status --porcelain')).toBe('');
    expect(git(clone, 'show HEAD:auth.ts')).toBe('invite email delivery');
  });

  it('sets a repo-local fallback committer identity when the runner has none', async () => {
    // Sibling pushes a non-conflicting change to main so the rebase must
    // rewrite the feature commit and therefore needs a committer identity.
    const sibling = path.join(tmpRoot, 'sibling-no-identity');
    execSync(`git clone --quiet "${originBare}" "${sibling}"`, { stdio: 'pipe' });
    git(sibling, 'config user.email "sib@example.com"');
    git(sibling, 'config user.name "Sib"');
    writeFileSync(path.join(sibling, 'sibling.txt'), 'sibling change\n');
    git(sibling, 'add sibling.txt');
    git(sibling, 'commit -m "sibling commit"');
    git(sibling, 'push origin main');

    git(clone, 'config --unset user.email');
    git(clone, 'config --unset user.name');
    const isolatedHome = path.join(tmpRoot, 'empty-home');
    mkdirSync(isolatedHome, { recursive: true });
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedHome,
    };

    const out = await rebaseOntoBase({ cwd: clone, baseBranch: 'main', env });

    expect(out.kind).toBe('rebased');
    expect(git(clone, 'config --get user.name')).toBe('Agent Hub Finalize');
    expect(git(clone, 'config --get user.email')).toBe('agent-hub-finalize@example.invalid');
    expect(git(clone, 'log --oneline -10')).toContain('sibling commit');
    expect(git(clone, 'log --oneline -10')).toContain('feature commit');
  });

  it('aborts cleanly and returns "conflict" when the rebase produces conflicts', async () => {
    // Feature branch edits main.txt one way …
    writeFileSync(path.join(clone, 'main.txt'), 'feature-side edit\n');
    git(clone, 'add main.txt');
    git(clone, 'commit -m "feature edits main.txt"');
    const featureTipBefore = git(clone, 'rev-parse HEAD');

    // … and sibling pushes a conflicting edit to the same file on main.
    const sibling = path.join(tmpRoot, 'sibling');
    execSync(`git clone --quiet "${originBare}" "${sibling}"`, { stdio: 'pipe' });
    git(sibling, 'config user.email "sib@example.com"');
    git(sibling, 'config user.name "Sib"');
    writeFileSync(path.join(sibling, 'main.txt'), 'sibling-side edit\n');
    git(sibling, 'add main.txt');
    git(sibling, 'commit -m "sibling edits main.txt"');
    git(sibling, 'push origin main');

    const out = await rebaseOntoBase({ cwd: clone, baseBranch: 'main' });
    expect(out.kind).toBe('conflict');
    if (out.kind === 'conflict') {
      // The git output should mention the conflict somewhere.
      expect(out.detail.toLowerCase()).toMatch(/conflict|merge|rebase/);
    }
    // Rebase aborted — HEAD is restored to the pre-rebase tip.
    expect(git(clone, 'rev-parse HEAD')).toBe(featureTipBefore);
    // No rebase-in-progress sentinels left behind.
    expect(() => git(clone, 'status --porcelain')).not.toThrow();
  });

  it('returns "skipped" when origin is unreachable for fetch', async () => {
    // Point the remote at a nonexistent path so `git fetch` fails fast.
    git(clone, `remote set-url origin "${path.join(tmpRoot, 'does-not-exist.git')}"`);
    const out = await rebaseOntoBase({ cwd: clone, baseBranch: 'main' });
    expect(out.kind).toBe('skipped');
  });

  it('streams `$ git …` lines through prLog when supplied', async () => {
    const logged: string[] = [];
    await rebaseOntoBase({
      cwd: clone,
      baseBranch: 'main',
      prLog: (s) => logged.push(s),
    });
    const joined = logged.join('');
    expect(joined).toContain('git fetch origin main');
  });

  it('aborts a leftover mid-rebase state before starting a new rebase', async () => {
    // Simulate the scenario where a previous `rebaseOntoBase` invocation
    // was SIGTERM'd / timed out mid-rebase: `.git/rebase-merge` exists,
    // git would otherwise refuse the next rebase with "already a
    // rebase-merge directory". Capture the spawn order to assert the
    // probe → abort → fetch → rebase sequence.
    const calls: string[][] = [];
    const probe = vi.fn().mockReturnValueOnce(true);

    const out = await rebaseOntoBase({
      cwd: clone,
      baseBranch: 'main',
      isRebaseInProgress: probe,
      runGit: async (args) => {
        calls.push(args);
        // Simulate base hasn't advanced → noop after the abort.
        if (args[0] === 'merge-base' || args[0] === 'rev-parse') {
          return { stdout: 'abc\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    // The first git invocation MUST be `rebase --abort`, before any
    // fetch / merge-base / rebase activity.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(['rebase', '--abort']);
    expect(calls[1]).toEqual(['fetch', '--no-tags', 'origin', 'main']);
    // Noop outcome because we faked merge-base === origin tip.
    expect(out.kind).toBe('noop');
  });

  it('does not invoke `rebase --abort` when no leftover state is detected', async () => {
    const calls: string[][] = [];
    const probe = vi.fn().mockReturnValueOnce(false);

    await rebaseOntoBase({
      cwd: clone,
      baseBranch: 'main',
      isRebaseInProgress: probe,
      runGit: async (args) => {
        calls.push(args);
        if (args[0] === 'merge-base' || args[0] === 'rev-parse') {
          return { stdout: 'abc\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    expect(probe).toHaveBeenCalledTimes(1);
    // First call must be the fetch — no leading abort.
    expect(calls[0]).toEqual(['fetch', '--no-tags', 'origin', 'main']);
    expect(calls.some((c) => c[0] === 'rebase' && c[1] === '--abort')).toBe(false);
  });

  describe('featureBranch → expectedRemoteSha (lease pinning support)', () => {
    // These tests cover the new `featureBranch` option that lets the caller
    // pin `--force-with-lease=<branch>:<sha>` instead of falling back to the
    // bare lease (which compares against the local
    // `refs/remotes/origin/<branch>` cache and trips `(stale info)` whenever
    // a parallel actor pushed the same branch in between).

    it('returns the live origin SHA for the feature branch even when the rebase is a noop', async () => {
      // Push the feature branch to origin so it has a SHA we can compare.
      git(clone, 'push -u origin feature/x');
      const expected = git(clone, 'rev-parse refs/remotes/origin/feature/x');

      const out = await rebaseOntoBase({
        cwd: clone,
        baseBranch: 'main',
        featureBranch: 'feature/x',
      });

      expect(out.kind).toBe('noop');
      if (out.kind === 'noop') {
        expect(out.expectedRemoteSha).toBe(expected);
      }
    });

    it('returns the live origin SHA when the rebase actually runs', async () => {
      // Establish the feature branch on origin first.
      git(clone, 'push -u origin feature/x');
      const expected = git(clone, 'rev-parse refs/remotes/origin/feature/x');

      // Sibling pushes a non-conflicting change to main → rebase will run.
      const sibling = path.join(tmpRoot, 'sibling-rebased');
      execSync(`git clone --quiet "${originBare}" "${sibling}"`, { stdio: 'pipe' });
      git(sibling, 'config user.email "sib@example.com"');
      git(sibling, 'config user.name "Sib"');
      writeFileSync(path.join(sibling, 'sibling.txt'), 'sibling change\n');
      git(sibling, 'add sibling.txt');
      git(sibling, 'commit -m "sibling commit"');
      git(sibling, 'push origin main');

      const out = await rebaseOntoBase({
        cwd: clone,
        baseBranch: 'main',
        featureBranch: 'feature/x',
      });

      expect(out.kind).toBe('rebased');
      if (out.kind === 'rebased') {
        // The expected SHA is whatever was on origin BEFORE this push attempt
        // — it must not reflect any post-rebase local activity, only the
        // server-side snapshot we use for the lease check.
        expect(out.expectedRemoteSha).toBe(expected);
      }
    });

    it('returns expectedRemoteSha === null when the feature branch is brand-new on origin', async () => {
      // feature/x has NOT been pushed to origin yet; ls-remote returns empty.
      const out = await rebaseOntoBase({
        cwd: clone,
        baseBranch: 'main',
        featureBranch: 'feature/brand-new-never-pushed',
      });

      expect(out.kind).toBe('noop');
      if (out.kind === 'noop') {
        expect(out.expectedRemoteSha).toBeNull();
      }
    });

    it('reflects a concurrent push by another actor in the SHA returned to the caller', async () => {
      // First push gets origin into a known state.
      git(clone, 'push -u origin feature/x');
      const firstPushSha = git(clone, 'rev-parse refs/remotes/origin/feature/x');

      // A parallel actor (reviewer agent on a different worktree, second Hub
      // session, human) pushes a fix commit to the same branch.
      const parallel = path.join(tmpRoot, 'parallel');
      execSync(`git clone --quiet "${originBare}" "${parallel}"`, { stdio: 'pipe' });
      git(parallel, 'config user.email "rev@example.com"');
      git(parallel, 'config user.name "Reviewer"');
      git(parallel, 'fetch origin feature/x');
      git(parallel, 'checkout -b feature/x origin/feature/x');
      writeFileSync(path.join(parallel, 'reviewer-fix.txt'), 'reviewer fix\n');
      git(parallel, 'add reviewer-fix.txt');
      git(parallel, 'commit -m "reviewer fix"');
      git(parallel, 'push origin feature/x');

      // Our clone's local `refs/remotes/origin/feature/x` is now stale —
      // it still says `firstPushSha`, but origin has advanced.
      expect(git(clone, 'rev-parse refs/remotes/origin/feature/x')).toBe(firstPushSha);

      // The whole point of using ls-remote: we get the authoritative origin
      // value back, NOT the stale local cache. This is what makes
      // `--force-with-lease=<branch>:<sha>` safe in this scenario — when we
      // pin the lease to this value, GitHub will accept the push iff origin
      // is still at this SHA; otherwise it rejects loudly so we can recover.
      const out = await rebaseOntoBase({
        cwd: clone,
        baseBranch: 'main',
        featureBranch: 'feature/x',
      });

      expect(out.kind).toBe('noop');
      if (out.kind === 'noop') {
        expect(out.expectedRemoteSha).not.toBe(firstPushSha);
        // It must equal whatever ls-remote sees on origin right now, which is
        // the parallel actor's commit. Re-resolve via a fresh ls-remote
        // (without updating local refs) to compare.
        const livestamp = execSync(`git ls-remote origin refs/heads/feature/x`, { cwd: clone })
          .toString()
          .trim()
          .split(/\s/)[0];
        expect(out.expectedRemoteSha).toBe(livestamp);
      }
    });

    it('omits expectedRemoteSha from the outcome when featureBranch is not supplied (legacy contract)', async () => {
      // Existing callers that haven't migrated to the new option get the
      // original outcome shape. The field is `undefined`, not `null`.
      const out = await rebaseOntoBase({ cwd: clone, baseBranch: 'main' });
      expect(out.kind).toBe('noop');
      expect((out as { expectedRemoteSha?: unknown }).expectedRemoteSha).toBeUndefined();
    });

    it('rejects an unsafe feature branch name but still completes the rebase', async () => {
      // We don't want to abort the rebase entirely just because the feature
      // branch name failed validation — the rebase doesn't depend on it.
      // The caller falls back to a bare lease.
      const out = await rebaseOntoBase({
        cwd: clone,
        baseBranch: 'main',
        featureBranch: 'evil; rm -rf /',
      });

      expect(out.kind).toBe('noop');
      if (out.kind === 'noop') {
        expect(out.expectedRemoteSha).toBeNull();
      }
    });

    it('falls back to expectedRemoteSha === null when ls-remote itself fails', async () => {
      // Stub runGit so the base fetch + merge-base + rev-parse succeed but
      // the ls-remote call throws. The rebase should still complete its
      // normal contract (noop in this case) and just report null for the
      // expected SHA so the caller falls back to bare --force-with-lease.
      const out = await rebaseOntoBase({
        cwd: clone,
        baseBranch: 'main',
        featureBranch: 'feature/x',
        runGit: async (args) => {
          if (args[0] === 'ls-remote') {
            throw new Error('simulated network error during ls-remote');
          }
          // Pretend nothing has moved on origin so we end up in 'noop'.
          if (args[0] === 'merge-base' || args[0] === 'rev-parse') {
            return { stdout: 'abc123\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      });

      expect(out.kind).toBe('noop');
      if (out.kind === 'noop') {
        expect(out.expectedRemoteSha).toBeNull();
      }
    });
  });

  it('passes through a real conflict + real abort and the worktree returns clean', async () => {
    // End-to-end equivalent of the unit test above using a real git repo:
    // ensures the default on-disk probe correctly sees that we've cleaned
    // up after a conflicting rebase and the helper is re-callable.
    writeFileSync(path.join(clone, 'main.txt'), 'feature-side edit\n');
    execSync('git add main.txt && git commit -m "feature edit"', { cwd: clone, stdio: 'pipe' });

    const sibling = path.join(tmpRoot, 'sibling-cleanup');
    execSync(`git clone --quiet "${originBare}" "${sibling}"`, { stdio: 'pipe' });
    execSync('git config user.email "sib@example.com"', { cwd: sibling });
    execSync('git config user.name "Sib"', { cwd: sibling });
    writeFileSync(path.join(sibling, 'main.txt'), 'sibling edit\n');
    execSync('git add main.txt && git commit -m "sib edit"', { cwd: sibling, stdio: 'pipe' });
    execSync('git push origin main', { cwd: sibling, stdio: 'pipe' });

    const first = await rebaseOntoBase({ cwd: clone, baseBranch: 'main' });
    expect(first.kind).toBe('conflict');
    // No leftover sentinels after the helper's own abort.
    expect(existsSync(path.join(clone, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(path.join(clone, '.git', 'rebase-apply'))).toBe(false);
  });
});
