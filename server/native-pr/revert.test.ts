/**
 * Revert engine tests against fixture bare repos (real git, no network, no
 * DB) — same harness as merge.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { mergePullRequest } from './merge.js';
import { revertPullRequest } from './revert.js';

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

describe('native-pr revert engine', () => {
  let tmpRoot: string;
  let work: string;
  let bare: string;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `revert-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    work = path.join(tmpRoot, 'work');
    bare = path.join(tmpRoot, 'repo.git');
    mkdirSync(work, { recursive: true });
    mkdirSync(bare, { recursive: true });
    execSync('git init --bare --initial-branch=main', { cwd: bare, stdio: 'pipe' });
    execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
    git(work, 'config user.email "t@example.com"');
    git(work, 'config user.name "T"');
    git(work, `remote add origin "${bare}"`);
    commit('base.txt', 'base\n', 'initial');
    git(work, 'push -u origin main');
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  function commit(file: string, content: string, message: string): string {
    writeFileSync(path.join(work, file), content);
    git(work, `add "${file}"`);
    git(work, `commit -m "${message}"`);
    return git(work, 'rev-parse HEAD');
  }

  function makeBranch(name: string, file: string, content: string): string {
    git(work, 'checkout main');
    git(work, `checkout -b ${name}`);
    const sha = commit(file, content, `change ${file}`);
    git(work, `push -u origin ${name}`);
    git(work, 'checkout main');
    return sha;
  }

  /** Land a squash merge of `branch` on main, returning the merge sha. */
  async function squashMerge(branch: string, prNumber: number): Promise<string> {
    const result = await mergePullRequest({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: branch,
      prNumber,
      prTitle: `Land ${branch}`,
      prBody: '',
      method: 'squash',
      actor: 'u1',
    });
    if (!result.ok) throw new Error(`fixture merge failed: ${JSON.stringify(result)}`);
    return result.mergedSha;
  }

  it('reverts a squash merge: undoes its files, keeps later work, adds a commit', async () => {
    makeBranch('feat-a', 'a.txt', 'A\n');
    const mergedSha = await squashMerge('feat-a', 7);

    // Unrelated work lands after the merge — the revert must not touch it.
    git(work, 'fetch origin main');
    git(work, 'reset --hard origin/main');
    commit('later.txt', 'later\n', 'later work');
    git(work, 'push origin main');
    const tipBefore = git(bare, 'rev-parse refs/heads/main');

    const result = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'main',
      mergedSha,
      prNumber: 7,
      actor: 'u2',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tipAfter = git(bare, 'rev-parse refs/heads/main');
    expect(tipAfter).toBe(result.revertSha);
    // Forward revert: a new commit on top, history intact.
    expect(git(bare, `rev-list --parents -n1 ${tipAfter}`)).toBe(`${tipAfter} ${tipBefore}`);
    expect(git(bare, `rev-list --count ${mergedSha}..${tipAfter}`)).toBe('2');
    // The merged file is gone; the later commit survives.
    const files = git(bare, `ls-tree --name-only ${tipAfter}`).split('\n');
    expect(files).not.toContain('a.txt');
    expect(files).toContain('later.txt');
    expect(files).toContain('base.txt');
  });

  it('writes a git-revert-shaped message naming the reverted commit and actor', async () => {
    makeBranch('feat-msg', 'm.txt', 'M\n');
    const mergedSha = await squashMerge('feat-msg', 12);

    const result = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'main',
      mergedSha,
      prNumber: 12,
      actor: 'alice',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git(bare, `log --format=%s -n1 ${result.revertSha}`)).toBe(
      'Revert "Land feat-msg (#12)"',
    );
    const body = git(bare, `log --format=%b -n1 ${result.revertSha}`);
    expect(body).toContain(`This reverts commit ${mergedSha}.`);
    expect(body).toContain('Reverted-by: Agent Hub (alice)');
  });

  it('reverts a merge-commit merge via its first parent', async () => {
    const headSha = makeBranch('feat-two', 'two.txt', 'TWO\n');
    const merged = await mergePullRequest({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'feat-two',
      prNumber: 21,
      prTitle: 'Two parents',
      prBody: '',
      method: 'merge',
      actor: 'u1',
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    // Sanity: the fixture really is a two-parent merge.
    expect(git(bare, `rev-list --parents -n1 ${merged.mergedSha}`)).toContain(headSha);

    const result = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'main',
      mergedSha: merged.mergedSha,
      prNumber: 21,
      actor: 'u2',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git(bare, `ls-tree --name-only refs/heads/main`).split('\n')).not.toContain('two.txt');
  });

  it('reports a conflict and leaves the base untouched when later work collides', async () => {
    makeBranch('feat-c', 'c.txt', 'one\n');
    const mergedSha = await squashMerge('feat-c', 30);

    git(work, 'fetch origin main');
    git(work, 'reset --hard origin/main');
    commit('c.txt', 'rewritten by someone else\n', 'edit the same file');
    git(work, 'push origin main');
    const tipBefore = git(bare, 'rev-parse refs/heads/main');

    const result = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'main',
      mergedSha,
      prNumber: 30,
      actor: 'u2',
    });

    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(tipBefore);
  });

  it('refuses a second revert of the same commit', async () => {
    makeBranch('feat-twice', 't.txt', 'T\n');
    const mergedSha = await squashMerge('feat-twice', 41);

    const first = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'main',
      mergedSha,
      prNumber: 41,
      actor: 'u2',
    });
    expect(first.ok).toBe(true);
    const tipBefore = git(bare, 'rev-parse refs/heads/main');

    const second = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'main',
      mergedSha,
      prNumber: 41,
      actor: 'u2',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(['conflict', 'empty']).toContain(second.reason);
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(tipBefore);
  });

  it('reports not_on_base when the commit never reached the branch', async () => {
    const strayHead = makeBranch('stray', 's.txt', 'S\n');
    const result = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'main',
      mergedSha: strayHead,
      prNumber: 55,
      actor: 'u2',
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_on_base' });
  });

  it('reports missing refs instead of throwing', async () => {
    const unknownBase = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'no-such-branch',
      mergedSha: 'f'.repeat(40),
      prNumber: 60,
      actor: 'u2',
    });
    expect(unknownBase).toMatchObject({ ok: false, reason: 'missing_ref' });

    const unknownCommit = await revertPullRequest({
      repoPath: bare,
      baseBranch: 'main',
      mergedSha: 'f'.repeat(40),
      prNumber: 61,
      actor: 'u2',
    });
    expect(unknownCommit).toMatchObject({ ok: false, reason: 'missing_ref' });
  });
});
