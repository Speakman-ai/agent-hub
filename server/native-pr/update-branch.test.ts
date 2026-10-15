/** Update-branch engine tests against fixture bare repos (real git, no network, no DB). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { commitsBehind, updatePullRequestBranch } from './update-branch.js';

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

describe('native-pr update branch', () => {
  let tmpRoot: string;
  let work: string;
  let bare: string;

  beforeEach(() => {
    tmpRoot = path.join(
      os.tmpdir(),
      `update-branch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  function advanceMain(file: string, content: string): string {
    git(work, 'checkout main');
    const sha = commit(file, content, `main ${file}`);
    git(work, 'push origin main');
    return sha;
  }

  it('merges base into head with a two-parent commit and leaves base untouched', async () => {
    const headBefore = makeBranch('feat', 'a.txt', 'A\n');
    const mainSha = advanceMain('m.txt', 'M\n');
    expect(await commitsBehind(bare, mainSha, headBefore)).toBe(1);

    const result = await updatePullRequestBranch({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'feat',
      actor: 'u1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.previousHeadSha).toBe(headBefore);
    expect(git(bare, 'rev-parse refs/heads/feat')).toBe(result.headSha);
    expect(git(bare, `rev-list --parents -n 1 ${result.headSha}`).split(' ').slice(1)).toEqual([
      headBefore,
      mainSha,
    ]);
    expect(git(bare, 'rev-parse refs/heads/main')).toBe(mainSha);
    expect(git(bare, `show ${result.headSha}:m.txt`)).toBe('M');
    expect(git(bare, `show ${result.headSha}:a.txt`)).toBe('A');
    expect(git(bare, `log -1 --format=%s ${result.headSha}`)).toBe("Merge branch 'main' into feat");
    expect(await commitsBehind(bare, mainSha, result.headSha)).toBe(0);
  });

  it('reports up_to_date when head already contains base', async () => {
    const headBefore = makeBranch('feat', 'a.txt', 'A\n');
    const result = await updatePullRequestBranch({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'feat',
      actor: 'u1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'up_to_date' });
    expect(git(bare, 'rev-parse refs/heads/feat')).toBe(headBefore);
  });

  it('refuses on conflict without moving the head', async () => {
    const headBefore = makeBranch('feat', 'base.txt', 'head side\n');
    advanceMain('base.txt', 'main side\n');
    const result = await updatePullRequestBranch({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'feat',
      actor: 'u1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(git(bare, 'rev-parse refs/heads/feat')).toBe(headBefore);
  });

  it('reports missing_ref for an unknown head branch', async () => {
    const result = await updatePullRequestBranch({
      repoPath: bare,
      baseBranch: 'main',
      headBranch: 'nope',
      actor: 'u1',
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing_ref' });
  });
});
