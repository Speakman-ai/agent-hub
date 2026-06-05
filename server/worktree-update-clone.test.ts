/**
 * Integration tests for `updateProjectCloneToOrigin` using real local git
 * repos wired through a bare "remote" — no network, no forbidden CLIs (git is
 * allowed; only claude/cursor/gemini/codex are blocked by setup.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { updateProjectCloneToOrigin } from './worktree.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

let base: string;
let remote: string; // bare
let clone: string; // the "project clone" under test
let upstream: string; // a second clone used to advance the remote

function commitTo(repo: string, file: string, content: string, msg: string): string {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, '-c', 'user.email=t@t.io', '-c', 'user.name=t', 'commit', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'clone-poll-'));
  remote = path.join(base, 'remote.git');
  clone = path.join(base, 'clone');
  upstream = path.join(base, 'upstream');

  git(base, 'init', '--bare', '-b', 'main', remote);
  // Seed the remote via the project clone, then make a sibling to advance it.
  git(base, 'clone', remote, clone);
  commitTo(clone, 'a.txt', 'one\n', 'init');
  git(clone, 'push', '-u', 'origin', 'main');
  git(base, 'clone', remote, upstream);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function advanceRemote(): string {
  const sha = commitTo(upstream, 'a.txt', 'two\n', 'advance');
  git(upstream, 'push', 'origin', 'main');
  return sha;
}

describe('updateProjectCloneToOrigin', () => {
  it('fast-forwards a behind clone to origin (updated)', async () => {
    const before = git(clone, 'rev-parse', 'HEAD');
    const remoteSha = advanceRemote();

    const res = await updateProjectCloneToOrigin(clone, []);
    expect(res.status).toBe('updated');
    expect(res.branch).toBe('main');
    expect(res.beforeSha).toBe(before);
    expect(res.afterSha).toBe(remoteSha);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(remoteSha);
  });

  it('is a noop when already at origin', async () => {
    const res = await updateProjectCloneToOrigin(clone, []);
    expect(res.status).toBe('noop');
  });

  it('FORCE-discards uncommitted tracked changes but preserves untracked files', async () => {
    // Local tracked edit (uncommitted) + an untracked scratch file.
    writeFileSync(path.join(clone, 'a.txt'), 'LOCAL EDIT\n');
    writeFileSync(path.join(clone, 'MEMORY.md'), 'agent scratch\n');
    const remoteSha = advanceRemote();

    const res = await updateProjectCloneToOrigin(clone, []);
    expect(res.status).toBe('updated');
    // tracked file reset to remote content...
    expect(readFileSync(path.join(clone, 'a.txt'), 'utf8')).toBe('two\n');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(remoteSha);
    // ...untracked file survives (no git clean).
    expect(existsSync(path.join(clone, 'MEMORY.md'))).toBe(true);
  });

  it('FORCE-resets even when the clone has diverged (local commit) — untracked kept', async () => {
    commitTo(clone, 'a.txt', 'local divergent\n', 'local-only');
    writeFileSync(path.join(clone, 'untracked.txt'), 'keep\n');
    const remoteSha = advanceRemote();

    const res = await updateProjectCloneToOrigin(clone, []);
    expect(res.status).toBe('updated');
    expect(res.afterSha).toBe(remoteSha);
    expect(existsSync(path.join(clone, 'untracked.txt'))).toBe(true);
  });

  it('skips a detached HEAD rather than guessing a target', async () => {
    const head = git(clone, 'rev-parse', 'HEAD');
    git(clone, 'checkout', '--detach', head);
    advanceRemote();

    const res = await updateProjectCloneToOrigin(clone, []);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('detached-head');
  });

  it('skips a directory that is not a git repo', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'not-git-'));
    try {
      const res = await updateProjectCloneToOrigin(empty, []);
      expect(res.status).toBe('skipped');
      expect(res.reason).toBe('not-a-git-repo');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('skips when the checked-out branch has no origin counterpart', async () => {
    git(clone, 'checkout', '-b', 'local-only-branch');
    const res = await updateProjectCloneToOrigin(clone, []);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('no-remote-branch:origin/local-only-branch');
  });
});
