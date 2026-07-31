/**
 * branch-facts reads the git facts that feed both PR bodies and the Finalize
 * session summary, so the base ref it picks decides whose work those describe.
 *
 * These tests drive real git repos: the bug being pinned is entirely about how
 * git resolves `main` vs `origin/main` in a clone, which a mocked exec cannot
 * reproduce. `git` is not one of the agent CLIs the test guard blocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, rm } from 'fs/promises';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { collectPrCommits, collectPrDiffStat, resolveBaseRef } from './branch-facts.js';

const execFileAsync = promisify(execFile);

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: ENV });
  return String(stdout).trim();
}

async function commitFile(cwd: string, file: string, contents: string, subject: string) {
  writeFileSync(path.join(cwd, file), `${contents}\n`);
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-q', '-m', subject);
}

let root: string;
let originPath: string;
let sessionPath: string;

/**
 * Build the exact shape a session worktree has: a clone of an upstream repo,
 * on its own branch, whose local `main` is pinned at clone time.
 */
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'branch-facts-'));
  originPath = path.join(root, 'origin');
  sessionPath = path.join(root, 'session');

  await execFileAsync('git', ['init', '-q', '-b', 'main', originPath], { env: ENV });
  await git(originPath, 'config', 'user.email', 'test@example.com');
  await git(originPath, 'config', 'user.name', 'Test');
  await commitFile(originPath, 'base.txt', 'base', 'base commit');

  await execFileAsync('git', ['clone', '-q', originPath, sessionPath], { env: ENV });
  await git(sessionPath, 'config', 'user.email', 'test@example.com');
  await git(sessionPath, 'config', 'user.name', 'Test');
  await git(sessionPath, 'checkout', '-q', '-b', 'agent-hub/dev/session-1');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('branch-facts base ref resolution', () => {
  it('prefers the remote-tracking ref over a stale local branch of the same name', async () => {
    expect(await resolveBaseRef(sessionPath, 'main', ENV)).toBe('refs/remotes/origin/main');
  });

  it('falls back to the local branch when there is no remote-tracking ref', async () => {
    // A repo that was never cloned (local-only project) still has to work.
    expect(await resolveBaseRef(originPath, 'main', ENV)).toBe('refs/heads/main');
  });

  it('uses an already-qualified base verbatim', async () => {
    expect(await resolveBaseRef(sessionPath, 'origin/main', ENV)).toBe('origin/main');
  });

  it('returns null when the base cannot be resolved', async () => {
    expect(await resolveBaseRef(sessionPath, 'no-such-branch', ENV)).toBeNull();
    expect(await resolveBaseRef(sessionPath, '   ', ENV)).toBeNull();
  });
});

describe('branch-facts after a rebase onto a moved base', () => {
  /**
   * Regression for "session summary includes previous merged info": while this
   * session was open, two other sessions merged to main. Finalize fetches and
   * rebases onto the new `origin/main`, which makes their commits ancestors of
   * HEAD. The clone's local `main` still points at the clone-time commit, so a
   * `main..HEAD` range attributes their work to this session.
   */
  beforeEach(async () => {
    await commitFile(sessionPath, 'mine.txt', 'mine', 'My session commit');
    await commitFile(originPath, 'other.txt', 'other', 'Other session merged commit');
    await commitFile(originPath, 'other2.txt', 'other2', 'Another merged commit');
    await git(sessionPath, 'fetch', '-q', 'origin');
    await git(sessionPath, 'rebase', '-q', 'origin/main');
  });

  it('reports only this session own commits, not ones the rebase pulled in', async () => {
    const commits = await collectPrCommits(sessionPath, 'main', ENV);
    expect(commits.map((c) => c.subject)).toEqual(['My session commit']);
  });

  it('reports only this session own files in the diff stat', async () => {
    const diffStat = await collectPrDiffStat(sessionPath, 'main', ENV);
    expect(diffStat).toContain('mine.txt');
    expect(diffStat).not.toContain('other.txt');
    expect(diffStat).not.toContain('other2.txt');
    expect(diffStat).toContain('1 file changed');
  });

  it('keeps the local stale ref demonstrably wrong, proving the test bites', async () => {
    // Guards the guard: if local `main` ever started tracking origin, the two
    // assertions above would pass for the wrong reason.
    const stale = await git(sessionPath, 'log', 'main..HEAD', '--format=%s');
    expect(stale.split('\n')).toHaveLength(3);
  });
});

describe('branch-facts commit parsing', () => {
  it('splits subject from body and omits empty bodies', async () => {
    await commitFile(sessionPath, 'a.txt', 'a', 'Subject only');
    writeFileSync(path.join(sessionPath, 'b.txt'), 'b\n');
    await git(sessionPath, 'add', '-A');
    await git(sessionPath, 'commit', '-q', '-m', 'With body', '-m', 'Line one\n\nLine two');

    const commits = await collectPrCommits(sessionPath, 'main', ENV);
    expect(commits).toEqual([
      { subject: 'With body', body: 'Line one\n\nLine two' },
      { subject: 'Subject only' },
    ]);
  });

  it('degrades to empty results instead of throwing on an unresolvable base', async () => {
    await commitFile(sessionPath, 'a.txt', 'a', 'Only commit');
    expect(await collectPrCommits(sessionPath, 'nope', ENV)).toEqual([]);
    expect(await collectPrDiffStat(sessionPath, 'nope', ENV)).toBe('');
  });
});
