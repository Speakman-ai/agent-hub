/**
 * Merge engine + git-read tests against fixture bare repos (real git,
 * no network, no DB). Precedent: worktree-auto-clone.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { mergePullRequest } from './merge.js';
import { mergeTree, prCommits, prDiff, prDiffStat, prFiles, revParse } from './git-read.js';

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

describe('native-pr merge engine', () => {
  let tmpRoot: string;
  let work: string;
  let bare: string;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  /** Create a session-style branch off main with one commit, push it. */
  function makeBranch(name: string, file: string, content: string): string {
    git(work, 'checkout main');
    git(work, `checkout -b ${name}`);
    const sha = commit(file, content, `change ${file}`);
    git(work, `push -u origin ${name}`);
    git(work, 'checkout main');
    return sha;
  }

  it('squash merge: single parent, message carries PR number, head branch deleted', async () => {
    const headSha = makeBranch('feat-a', 'a.txt', 'A\n');
    const baseBefore = git(bare, 'rev-parse refs/heads/main');

    const result = await mergePullRequest({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'feat-a',
      prNumber: 7,
      prTitle: 'Add a.txt',
      prBody: 'Adds the a file.',
      method: 'squash',
      actor: 'u1',
      expectedHeadSha: headSha,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mergedSha = git(bare, 'rev-parse refs/heads/main');
    expect(mergedSha).toBe(result.mergedSha);
    // Single parent = the old base (squash).
    expect(git(bare, `rev-list --parents -n1 ${mergedSha}`)).toBe(`${mergedSha} ${baseBefore}`);
    expect(git(bare, `log --format=%s -n1 ${mergedSha}`)).toBe('Add a.txt (#7)');
    expect(git(bare, `log --format=%b -n1 ${mergedSha}`)).toContain('Merged-by: Agent Hub (u1)');
    // Head branch cleaned up.
    expect(() => git(bare, 'rev-parse refs/heads/feat-a')).toThrow();
  });

  it('merge method: two parents (old base + head)', async () => {
    const headSha = makeBranch('feat-b', 'b.txt', 'B\n');
    const baseBefore = git(bare, 'rev-parse refs/heads/main');

    const result = await mergePullRequest({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'feat-b',
      prNumber: 8,
      prTitle: 'Add b.txt',
      prBody: '',
      method: 'merge',
      actor: 'u1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git(bare, `rev-list --parents -n1 ${result.mergedSha}`)).toBe(
      `${result.mergedSha} ${baseBefore} ${headSha}`,
    );
  });

  it('conflicting branches report mergeable:false with detail and leave refs untouched', async () => {
    makeBranch('feat-c1', 'conflict.txt', 'one\n');
    // Land a conflicting change on main first.
    git(work, 'checkout main');
    commit('conflict.txt', 'two\n', 'conflicting main change');
    git(work, 'push origin main');

    const baseBefore = git(bare, 'rev-parse refs/heads/main');
    const result = await mergePullRequest({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'feat-c1',
      prNumber: 9,
      prTitle: 'Conflicting',
      prBody: '',
      method: 'squash',
      actor: 'u1',
    });

    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(baseBefore);
    expect(git(bare, 'rev-parse refs/heads/feat-c1')).toBeTruthy();
  });

  it('refuses when the head branch moved past the PR record', async () => {
    makeBranch('feat-d', 'd.txt', 'D\n');
    const result = await mergePullRequest({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'feat-d',
      prNumber: 10,
      prTitle: 'Stale',
      prBody: '',
      method: 'squash',
      actor: 'u1',
      expectedHeadSha: 'f'.repeat(40),
    });
    expect(result).toMatchObject({ ok: false, reason: 'head_moved' });
  });

  it('missing refs are reported, not thrown', async () => {
    const result = await mergePullRequest({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'no-such-branch',
      prNumber: 11,
      prTitle: 'x',
      prBody: '',
      method: 'squash',
      actor: 'u1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_ref' });
  });
});

describe('native-pr git-read', () => {
  let tmpRoot: string;
  let work: string;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `git-read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    work = path.join(tmpRoot, 'work');
    mkdirSync(work, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: work, stdio: 'pipe' });
    git(work, 'config user.email "t@example.com"');
    git(work, 'config user.name "Reader"');
    writeFileSync(path.join(work, 'one.txt'), 'line1\nline2\n');
    git(work, 'add one.txt');
    git(work, 'commit -m base');
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads diff, files, commits, and shortstat between two shas', async () => {
    const baseSha = git(work, 'rev-parse HEAD');
    git(work, 'checkout -b feature');
    writeFileSync(path.join(work, 'one.txt'), 'line1\nline2-changed\n');
    writeFileSync(path.join(work, 'two.txt'), 'new file\n');
    git(work, 'add .');
    git(work, 'commit -m "feature work"');
    const headSha = git(work, 'rev-parse HEAD');

    const diff = await prDiff(work, baseSha, headSha);
    expect(diff).toContain('line2-changed');
    expect(diff).toContain('two.txt');

    const files = await prFiles(work, baseSha, headSha);
    expect(files).toHaveLength(2);
    const byName = Object.fromEntries(files.map((f) => [f.filename, f]));
    expect(byName['one.txt']).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(byName['two.txt']).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(byName['two.txt'].patch).toContain('new file');

    const commits = await prCommits(work, baseSha, headSha);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ sha: headSha, subject: 'feature work', author: 'Reader' });

    const stat = await prDiffStat(work, baseSha, headSha);
    expect(stat).toEqual({ changedFiles: 2, additions: 2, deletions: 1 });

    const tree = await mergeTree(work, baseSha, headSha);
    expect(tree.mergeable).toBe(true);
    expect(await revParse(work, 'refs/heads/feature')).toBe(headSha);
    expect(await revParse(work, 'refs/heads/nope')).toBeNull();
  });
});
