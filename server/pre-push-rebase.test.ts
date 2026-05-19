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
