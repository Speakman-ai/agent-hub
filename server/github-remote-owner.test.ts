import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseGithubRemote,
  getRepoOwnerForCwd,
  clearRepoOwnerCache,
} from './github-remote-owner.js';

describe('parseGithubRemote', () => {
  it('returns null for null/empty input', () => {
    expect(parseGithubRemote(null)).toBeNull();
    expect(parseGithubRemote(undefined)).toBeNull();
    expect(parseGithubRemote('')).toBeNull();
    expect(parseGithubRemote('   ')).toBeNull();
  });

  it('parses https://github.com/owner/repo', () => {
    expect(parseGithubRemote('https://github.com/acme/webapp')).toEqual({
      owner: 'acme',
      repo: 'webapp',
    });
  });

  it('parses https://github.com/owner/repo.git', () => {
    expect(parseGithubRemote('https://github.com/acme/webapp.git')).toEqual({
      owner: 'acme',
      repo: 'webapp',
    });
  });

  it('strips a token-style userinfo from https URLs', () => {
    expect(
      parseGithubRemote('https://x-access-token:ghs_xyz@github.com/Speakman-ai/agent-hub.git'),
    ).toEqual({ owner: 'Speakman-ai', repo: 'agent-hub' });
  });

  it('parses git@github.com:owner/repo.git', () => {
    expect(parseGithubRemote('git@github.com:acme/webapp.git')).toEqual({
      owner: 'acme',
      repo: 'webapp',
    });
  });

  it('parses git@github.com:owner/repo (no .git suffix)', () => {
    expect(parseGithubRemote('git@github.com:Speakman-ai/agent-hub')).toEqual({
      owner: 'Speakman-ai',
      repo: 'agent-hub',
    });
  });

  it('trims surrounding whitespace from git remote output', () => {
    expect(parseGithubRemote('  https://github.com/acme/webapp.git\n')).toEqual({
      owner: 'acme',
      repo: 'webapp',
    });
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseGithubRemote('https://gitlab.com/foo/bar.git')).toBeNull();
    expect(parseGithubRemote('git@gitlab.com:foo/bar.git')).toBeNull();
    expect(parseGithubRemote('https://bitbucket.org/foo/bar')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(parseGithubRemote('not-a-url')).toBeNull();
    expect(parseGithubRemote('https://github.com/onlyone')).toBeNull();
  });
});

describe('getRepoOwnerForCwd', () => {
  beforeEach(() => clearRepoOwnerCache());

  it('returns null for null/empty cwd', async () => {
    expect(await getRepoOwnerForCwd(null)).toBeNull();
    expect(await getRepoOwnerForCwd('')).toBeNull();
    expect(await getRepoOwnerForCwd(undefined)).toBeNull();
  });

  it('runs `git remote get-url origin` and parses the result', async () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const exec = async (cmd: string, args: string[], opts: { cwd: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { stdout: 'https://github.com/acme/webapp.git\n', stderr: '' };
    };
    const owner = await getRepoOwnerForCwd('/tmp/some-project', exec);
    expect(owner).toEqual({ owner: 'acme', repo: 'webapp' });
    expect(calls).toEqual([
      {
        cmd: 'git',
        args: ['-C', '/tmp/some-project', 'remote', 'get-url', 'origin'],
        cwd: '/tmp/some-project',
      },
    ]);
  });

  it('caches per-cwd so repeat calls do not re-exec git', async () => {
    let invocations = 0;
    const exec = async () => {
      invocations++;
      return { stdout: 'git@github.com:foo/bar.git\n', stderr: '' };
    };
    expect(await getRepoOwnerForCwd('/tmp/x', exec)).toEqual({ owner: 'foo', repo: 'bar' });
    expect(await getRepoOwnerForCwd('/tmp/x', exec)).toEqual({ owner: 'foo', repo: 'bar' });
    expect(await getRepoOwnerForCwd('/tmp/x', exec)).toEqual({ owner: 'foo', repo: 'bar' });
    expect(invocations).toBe(1);
  });

  it('returns null and caches when git fails (non-git dir, no remote, etc.)', async () => {
    let invocations = 0;
    const exec = async () => {
      invocations++;
      throw new Error('fatal: not a git repository');
    };
    expect(await getRepoOwnerForCwd('/tmp/not-a-repo', exec)).toBeNull();
    // Cached null — second call should not re-invoke.
    expect(await getRepoOwnerForCwd('/tmp/not-a-repo', exec)).toBeNull();
    expect(invocations).toBe(1);
  });

  it('returns null for non-GitHub remotes', async () => {
    const exec = async () => ({ stdout: 'https://gitlab.com/foo/bar.git', stderr: '' });
    expect(await getRepoOwnerForCwd('/tmp/gitlab-proj', exec)).toBeNull();
  });

  it('handles distinct cwds independently', async () => {
    let call = 0;
    const exec = async () => {
      call++;
      if (call === 1) return { stdout: 'https://github.com/a/x.git', stderr: '' };
      return { stdout: 'https://github.com/b/y.git', stderr: '' };
    };
    expect(await getRepoOwnerForCwd('/tmp/a', exec)).toEqual({ owner: 'a', repo: 'x' });
    expect(await getRepoOwnerForCwd('/tmp/b', exec)).toEqual({ owner: 'b', repo: 'y' });
    expect(call).toBe(2);
  });
});
