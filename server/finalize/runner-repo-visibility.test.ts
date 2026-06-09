import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  detectRepoVisibility,
  parseVisibility,
  clearRepoVisibilityCache,
} from './runner-repo-visibility.js';

describe('parseVisibility', () => {
  it('maps GitHub visibility strings to RepoVisibility', () => {
    expect(parseVisibility('public')).toBe('public');
    expect(parseVisibility('PUBLIC\n')).toBe('public');
    expect(parseVisibility('private')).toBe('private');
    expect(parseVisibility('  Private ')).toBe('private');
    // internal (enterprise org-wide) sizes like private on GitHub Actions.
    expect(parseVisibility('internal')).toBe('private');
  });

  it('returns unknown for blank / unexpected / nullish input', () => {
    expect(parseVisibility(undefined)).toBe('unknown');
    expect(parseVisibility(null)).toBe('unknown');
    expect(parseVisibility('')).toBe('unknown');
    expect(parseVisibility('weird')).toBe('unknown');
  });
});

describe('detectRepoVisibility', () => {
  beforeEach(() => {
    clearRepoVisibilityCache();
  });

  const owner = { owner: 'acme', repo: 'widgets' };

  it('returns public for a public repo (gh .visibility = public)', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'public\n', stderr: '' });
    const v = await detectRepoVisibility({
      worktreePath: '/wt',
      env: {},
      getRepoOwner: async () => owner,
      exec,
    });
    expect(v).toBe('public');
    expect(exec).toHaveBeenCalledOnce();
    const [cmd, args] = exec.mock.calls[0]!;
    expect(cmd).toBe('gh');
    expect(args).toEqual(['api', 'repos/acme/widgets', '--jq', '.visibility']);
  });

  it('returns private for a private repo', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'private', stderr: '' });
    const v = await detectRepoVisibility({
      worktreePath: '/wt',
      env: {},
      getRepoOwner: async () => owner,
      exec,
    });
    expect(v).toBe('private');
  });

  it('returns unknown when the worktree has no GitHub origin', async () => {
    const exec = vi.fn();
    const v = await detectRepoVisibility({
      worktreePath: '/wt',
      env: {},
      getRepoOwner: async () => null,
      exec,
    });
    expect(v).toBe('unknown');
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns unknown when gh fails (missing, unauth, 404, timeout)', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('gh: command not found'));
    const v = await detectRepoVisibility({
      worktreePath: '/wt',
      env: {},
      getRepoOwner: async () => owner,
      exec,
    });
    expect(v).toBe('unknown');
  });

  it('passes a resolved GH_TOKEN into the gh subprocess env', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'private', stderr: '' });
    await detectRepoVisibility({
      worktreePath: '/wt',
      env: { GITHUB_TOKEN: 'ghp_fromhost' },
      getRepoOwner: async () => owner,
      exec,
    });
    const opts = exec.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv };
    expect(opts.env?.GH_TOKEN).toBe('ghp_fromhost');
  });

  it('caches per slug — a second call does not re-run gh', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'public', stderr: '' });
    const args = {
      worktreePath: '/wt',
      env: {},
      getRepoOwner: async () => owner,
      exec,
    };
    expect(await detectRepoVisibility(args)).toBe('public');
    expect(await detectRepoVisibility(args)).toBe('public');
    expect(exec).toHaveBeenCalledOnce();
  });

  it('caches unknown too so a transient failure does not re-probe per shard', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('timeout'));
    const args = {
      worktreePath: '/wt',
      env: {},
      getRepoOwner: async () => owner,
      exec,
    };
    expect(await detectRepoVisibility(args)).toBe('unknown');
    expect(await detectRepoVisibility(args)).toBe('unknown');
    expect(exec).toHaveBeenCalledOnce();
  });
});
