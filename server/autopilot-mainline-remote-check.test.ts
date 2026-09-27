/**
 * Remote check against real git repositories: a bare "remote" and a working
 * clone. Failures are injected by wrapping the real runner, by a slow
 * upload-pack (a real timeout kill), and by deleting objects from the store.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkCommitOnRemoteBranch,
  isSafeBranchName,
  runRemoteCheckGit,
  type RemoteCheckGitRunner,
  type RemoteCheckSource,
} from './autopilot-mainline-remote-check.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@e',
};

let root: string;
let remote: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(name: string): string {
  writeFileSync(join(work, name), name);
  git(work, 'add', name);
  git(work, 'commit', '-q', '-m', name);
  return git(work, 'rev-parse', 'HEAD');
}

/**
 * Put the work clone's HEAD on the remote branch. Done as a fetch into the
 * bare repo, not a push, so the test does not depend on push being allowed.
 */
function publish(branch: string): void {
  git(remote, 'fetch', '-q', work, `+HEAD:refs/heads/${branch}`);
}

function fetchSource(): RemoteCheckSource {
  return { kind: 'fetch', repoPath: work, env: GIT_ENV };
}

/** Real git, but one subcommand answers as if git was killed. */
function killing(subcommand: string): { runner: RemoteCheckGitRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: RemoteCheckGitRunner = async (argv, opts) => {
    calls.push(argv[0]);
    if (argv[0] === subcommand) return { exitCode: null, stdout: '', stderr: 'killed (SIGTERM)' };
    return runRemoteCheckGit(argv, opts);
  };
  return { runner, calls };
}

function recording(): { runner: RemoteCheckGitRunner; exits: Array<[string, number | null]> } {
  const exits: Array<[string, number | null]> = [];
  const runner: RemoteCheckGitRunner = async (argv, opts) => {
    const res = await runRemoteCheckGit(argv, opts);
    exits.push([argv[0], res.exitCode]);
    return res;
  };
  return { runner, exits };
}

function looseObjectPath(repo: string, sha: string): string {
  return join(repo, 'objects', sha.slice(0, 2), sha.slice(2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mainline-remote-check-'));
  remote = join(root, 'remote.git');
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'remote', 'add', 'origin', remote);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkCommitOnRemoteBranch through a fetch', () => {
  it('present when the branch tip is the commit', async () => {
    const a = commit('a');
    publish('main');
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: a,
      branch: 'main',
    });
    expect(answer.kind).toBe('present');
  });

  it('present when the commit is behind the tip', async () => {
    const a = commit('a');
    commit('b');
    publish('main');
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: a,
      branch: 'main',
    });
    expect(answer.kind).toBe('present');
  });

  it('absent from merge-base exit 1 after a fetch that exited 0', async () => {
    commit('a');
    publish('main');
    const b = commit('b');
    const rec = recording();
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: b,
      branch: 'main',
      git: rec.runner,
    });
    expect(answer.kind).toBe('absent');
    expect(rec.exits).toEqual([
      ['remote', 0],
      ['fetch', 0],
      ['rev-parse', 0],
      ['merge-base', 1],
    ]);
  });

  it('writes neither FETCH_HEAD nor the remote-tracking ref', async () => {
    commit('a');
    publish('main');
    const b = commit('b');
    await checkCommitOnRemoteBranch({ source: fetchSource(), sha: b, branch: 'main' });
    expect(() => git(work, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main')).toThrow();
    expect(() => git(work, 'rev-parse', '--verify', '-q', 'FETCH_HEAD')).toThrow();
  });

  it('unknown when the fetch is killed by a real timeout', async () => {
    const a = commit('a');
    publish('main');
    // An ssh push URL whose "ssh" just hangs.
    git(work, 'remote', 'set-url', 'origin', 'ssh://git.invalid/repo.git');
    const slow: RemoteCheckGitRunner = (argv, opts) =>
      runRemoteCheckGit(argv, { ...opts, timeoutMs: argv[0] === 'fetch' ? 300 : opts.timeoutMs });
    const answer = await checkCommitOnRemoteBranch({
      source: { kind: 'fetch', repoPath: work, env: { ...GIT_ENV, GIT_SSH_COMMAND: 'sleep 3; :' } },
      sha: a,
      branch: 'main',
      git: slow,
    });
    expect(answer.kind).toBe('unknown');
    expect(answer.detail).toContain('no exit code');
  });

  it('unknown when the remote cannot be reached, and present once it can', async () => {
    const a = commit('a');
    publish('main');
    git(work, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
    const down = await checkCommitOnRemoteBranch({ source: fetchSource(), sha: a, branch: 'main' });
    expect(down.kind).toBe('unknown');
    git(work, 'remote', 'set-url', 'origin', remote);
    const up = await checkCommitOnRemoteBranch({ source: fetchSource(), sha: a, branch: 'main' });
    expect(up.kind).toBe('present');
  });

  it('unknown when the branch does not exist on the remote (fetch exits 128)', async () => {
    const a = commit('a');
    publish('other');
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: a,
      branch: 'main',
    });
    expect(answer.kind).toBe('unknown');
  });

  it('unknown when the remote object store is damaged', async () => {
    commit('a');
    publish('main');
    const b = commit('b');
    // Someone else lands c; the fetch has to transfer it, and its tree is gone.
    const other = join(root, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    writeFileSync(join(other, 'c'), 'c');
    git(other, 'add', 'c');
    git(other, 'commit', '-q', '-m', 'c');
    git(remote, 'fetch', '-q', other, '+HEAD:refs/heads/main');
    unlinkSync(looseObjectPath(remote, git(other, 'rev-parse', 'HEAD^{tree}')));
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: b,
      branch: 'main',
    });
    expect(answer.kind).toBe('unknown');
  });

  it('a killed merge-base falls back to a completed rev-list', async () => {
    commit('a');
    publish('main');
    const b = commit('b');
    const k = killing('merge-base');
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: b,
      branch: 'main',
      git: k.runner,
    });
    expect(answer.kind).toBe('absent');
    expect(k.calls).toEqual(['remote', 'fetch', 'rev-parse', 'merge-base', 'rev-list']);
  });

  it('unknown when merge-base and rev-list are both killed', async () => {
    commit('a');
    publish('main');
    const b = commit('b');
    const runner: RemoteCheckGitRunner = async (argv, opts) =>
      argv[0] === 'merge-base' || argv[0] === 'rev-list'
        ? { exitCode: null, stdout: '', stderr: 'timed out' }
        : runRemoteCheckGit(argv, opts);
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: b,
      branch: 'main',
      git: runner,
    });
    expect(answer.kind).toBe('unknown');
  });

  it('a killed rev-list with partial output is never absent', async () => {
    commit('a');
    publish('main');
    const b = commit('b');
    const runner: RemoteCheckGitRunner = async (argv, opts) => {
      if (argv[0] === 'merge-base') return { exitCode: 128, stdout: '', stderr: 'bad object' };
      if (argv[0] === 'rev-list') {
        const full = await runRemoteCheckGit(argv, opts);
        return { exitCode: null, stdout: full.stdout, stderr: 'maxBuffer exceeded' };
      }
      return runRemoteCheckGit(argv, opts);
    };
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: b,
      branch: 'main',
      git: runner,
    });
    expect(answer.kind).toBe('unknown');
  });

  it('unknown when git cannot be spawned', async () => {
    const runner: RemoteCheckGitRunner = async () => {
      throw new Error('spawn git ENOENT');
    };
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: 'a'.repeat(40),
      branch: 'main',
      git: runner,
    });
    expect(answer).toEqual({ kind: 'unknown', detail: expect.stringContaining('ENOENT') });
  });

  it('unknown when the probe ref read is killed after a good fetch', async () => {
    const a = commit('a');
    publish('main');
    const k = killing('rev-parse');
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: a,
      branch: 'main',
      git: k.runner,
    });
    expect(answer.kind).toBe('unknown');
  });
});

describe('checkCommitOnRemoteBranch with distinct fetch and push destinations', () => {
  let mirror: string;

  /** origin fetches from a stale mirror and pushes to the project repo. */
  function splitOrigin(): void {
    mirror = join(root, 'mirror.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', mirror]);
    git(work, 'remote', 'set-url', 'origin', mirror);
    git(work, 'remote', 'set-url', '--push', 'origin', remote);
  }

  it('present when the commit is on the push destination but not the fetch URL', async () => {
    commit('base');
    splitOrigin();
    git(mirror, 'fetch', '-q', work, '+HEAD:refs/heads/main');
    const landed = commit('landed');
    publish('main'); // only the push destination has it
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: landed,
      branch: 'main',
    });
    expect(answer.kind).toBe('present');
  });

  it('absent when only the fetch URL has the commit', async () => {
    commit('base');
    splitOrigin();
    publish('main');
    const notLanded = commit('mirror-only');
    git(mirror, 'fetch', '-q', work, '+HEAD:refs/heads/main');
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: notLanded,
      branch: 'main',
    });
    expect(answer.kind).toBe('absent');
  });

  it('unknown when origin has more than one push URL', async () => {
    const a = commit('a');
    publish('main');
    git(work, 'remote', 'set-url', '--add', '--push', 'origin', remote);
    git(work, 'remote', 'set-url', '--add', '--push', 'origin', join(root, 'other.git'));
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: a,
      branch: 'main',
    });
    expect(answer).toEqual({ kind: 'unknown', detail: expect.stringContaining('2 push URLs') });
  });

  it('unknown when the clone has no origin', async () => {
    const a = commit('a');
    git(work, 'remote', 'remove', 'origin');
    const answer = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: a,
      branch: 'main',
    });
    expect(answer.kind).toBe('unknown');
  });
});

describe('checkCommitOnRemoteBranch against the hosted repo itself', () => {
  const local = (): RemoteCheckSource => ({ kind: 'local', repoPath: remote });

  it('present without any fetch', async () => {
    const a = commit('a');
    commit('b');
    publish('main');
    const rec = recording();
    const answer = await checkCommitOnRemoteBranch({
      source: local(),
      sha: a,
      branch: 'main',
      git: rec.runner,
    });
    expect(answer.kind).toBe('present');
    expect(rec.exits.map(([cmd]) => cmd)).not.toContain('fetch');
  });

  it('absent from a completed rev-list when the remote never had the object', async () => {
    commit('a');
    publish('main');
    const b = commit('b');
    const rec = recording();
    const answer = await checkCommitOnRemoteBranch({
      source: local(),
      sha: b,
      branch: 'main',
      git: rec.runner,
    });
    expect(answer.kind).toBe('absent');
    expect(rec.exits).toEqual([
      ['rev-parse', 0],
      ['merge-base', 128],
      ['rev-list', 0],
    ]);
  });

  it('unknown when history is damaged so rev-list cannot finish', async () => {
    const a = commit('a');
    commit('b');
    publish('main');
    const c = commit('c'); // never pushed
    unlinkSync(looseObjectPath(remote, a));
    const answer = await checkCommitOnRemoteBranch({ source: local(), sha: c, branch: 'main' });
    expect(answer.kind).toBe('unknown');
  });

  it('unknown when the branch tip object is gone', async () => {
    const a = commit('a');
    publish('main');
    unlinkSync(looseObjectPath(remote, a));
    const answer = await checkCommitOnRemoteBranch({ source: local(), sha: a, branch: 'main' });
    expect(answer.kind).toBe('unknown');
  });
});

describe('input guards', () => {
  it('refuses unusable branch names and shas without running git', async () => {
    const calls: string[][] = [];
    const runner: RemoteCheckGitRunner = async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    for (const branch of ['-main', 'a..b', 'a b', 'x:y', '']) {
      const answer = await checkCommitOnRemoteBranch({
        source: fetchSource(),
        sha: 'a'.repeat(40),
        branch,
        git: runner,
      });
      expect(answer.kind).toBe('unknown');
    }
    const badSha = await checkCommitOnRemoteBranch({
      source: fetchSource(),
      sha: 'HEAD',
      branch: 'main',
      git: runner,
    });
    expect(badSha.kind).toBe('unknown');
    expect(calls).toEqual([]);
    expect(isSafeBranchName('release/2026')).toBe(true);
  });
});
