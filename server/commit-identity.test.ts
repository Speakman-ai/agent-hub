import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLIED_IDENTITY_KEYS,
  applySessionCommitIdentity,
  clearCommitIdentityCache,
  githubNoreplyEmail,
  identityFromGithubProfile,
  resolveOwnerCommitIdentity,
  type CommitIdentityDeps,
} from './commit-identity.js';

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function makeDeps(overrides: Partial<CommitIdentityDeps> = {}): CommitIdentityDeps {
  return {
    resolveToken: vi.fn(async () => 'tok-1'),
    fetchProfile: vi.fn(async () => ({ id: 4242, login: 'speakmanra' })),
    now: () => 1_000,
    ...overrides,
  };
}

describe('identityFromGithubProfile', () => {
  it('uses the GitHub login as the name and the ID-based noreply email', () => {
    expect(identityFromGithubProfile({ id: 7, login: 'octo' })).toEqual({
      name: 'octo',
      email: '7+octo@users.noreply.github.com',
    });
    expect(githubNoreplyEmail(1, 'a')).toBe('1+a@users.noreply.github.com');
  });
});

describe('resolveOwnerCommitIdentity', () => {
  beforeEach(() => clearCommitIdentityCache());

  it('returns null when the owner has no GitHub token', async () => {
    const deps = makeDeps({ resolveToken: vi.fn(async () => null) });
    expect(await resolveOwnerCommitIdentity('u1', deps)).toBeNull();
    expect(deps.fetchProfile).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the profile lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      fetchProfile: vi.fn(async () => {
        throw new Error('401');
      }),
    });
    expect(await resolveOwnerCommitIdentity('u1', deps)).toBeNull();
    warn.mockRestore();
  });

  it('caches the profile per token', async () => {
    const deps = makeDeps();
    await resolveOwnerCommitIdentity('u1', deps);
    await resolveOwnerCommitIdentity('u1', deps);
    expect(deps.fetchProfile).toHaveBeenCalledTimes(1);
  });
});

describe('applySessionCommitIdentity', () => {
  let root: string;
  let projectCwd: string;
  let cwd: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    clearCommitIdentityCache();
    // Isolate from the developer's global/system git identity.
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    root = mkdtempSync(path.join(tmpdir(), 'commit-identity-'));
    projectCwd = path.join(root, 'project');
    cwd = path.join(root, 'session');
    execFileSync('git', ['init', '-q', projectCwd]);
    execFileSync('git', ['init', '-q', cwd]);
    git(projectCwd, 'config', 'user.name', 'Agent Hub');
    git(projectCwd, 'config', 'user.email', 'agent@agent-hub.com');
    git(cwd, 'config', 'user.name', 'Agent Hub');
    git(cwd, 'config', 'user.email', 'agent@agent-hub.com');
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  const on = { commitAsOwner: { enabled: true } };

  it('writes the owner GitHub identity when the toggle is on', async () => {
    const outcome = await applySessionCommitIdentity(
      { cwd, projectCwd, project: on, ownerUserId: 'u1' },
      makeDeps(),
    );
    expect(outcome).toBe('owner');
    expect(git(cwd, 'config', 'user.name')).toBe('speakmanra');
    expect(git(cwd, 'config', 'user.email')).toBe('4242+speakmanra@users.noreply.github.com');
    // The shared project checkout is untouched.
    expect(git(projectCwd, 'config', 'user.email')).toBe('agent@agent-hub.com');
  });

  it('leaves the Agent Hub identity alone when the toggle is off', async () => {
    const deps = makeDeps();
    const outcome = await applySessionCommitIdentity(
      { cwd, projectCwd, project: {}, ownerUserId: 'u1' },
      deps,
    );
    expect(outcome).toBe('unchanged');
    expect(git(cwd, 'config', 'user.email')).toBe('agent@agent-hub.com');
    expect(deps.resolveToken).not.toHaveBeenCalled();
  });

  it('keeps the Agent Hub identity when the owner has no GitHub connection', async () => {
    const outcome = await applySessionCommitIdentity(
      { cwd, projectCwd, project: on, ownerUserId: 'u1' },
      makeDeps({ resolveToken: vi.fn(async () => null) }),
    );
    expect(outcome).toBe('unchanged');
    expect(git(cwd, 'config', 'user.email')).toBe('agent@agent-hub.com');
  });

  it('keeps the Agent Hub identity for ownerless (system) sessions', async () => {
    const outcome = await applySessionCommitIdentity(
      { cwd, projectCwd, project: on, ownerUserId: null },
      makeDeps(),
    );
    expect(outcome).toBe('unchanged');
  });

  it('restores the project identity after the toggle is turned off', async () => {
    const deps = makeDeps();
    await applySessionCommitIdentity({ cwd, projectCwd, project: on, ownerUserId: 'u1' }, deps);
    const outcome = await applySessionCommitIdentity(
      { cwd, projectCwd, project: { commitAsOwner: { enabled: false } }, ownerUserId: 'u1' },
      deps,
    );
    expect(outcome).toBe('restored');
    expect(git(cwd, 'config', 'user.name')).toBe('Agent Hub');
    expect(git(cwd, 'config', 'user.email')).toBe('agent@agent-hub.com');
    expect(git(cwd, 'config', APPLIED_IDENTITY_KEYS['user.name'])).toBe('');
    expect(git(cwd, 'config', APPLIED_IDENTITY_KEYS['user.email'])).toBe('');
  });

  it('keeps an identity a human set after the toggle applied one', async () => {
    const deps = makeDeps();
    await applySessionCommitIdentity({ cwd, projectCwd, project: on, ownerUserId: 'u1' }, deps);
    git(cwd, 'config', 'user.name', 'Human Choice');
    git(cwd, 'config', 'user.email', 'human@example.com');
    const outcome = await applySessionCommitIdentity(
      { cwd, projectCwd, project: {}, ownerUserId: 'u1' },
      deps,
    );
    expect(outcome).toBe('restored');
    expect(git(cwd, 'config', 'user.name')).toBe('Human Choice');
    expect(git(cwd, 'config', 'user.email')).toBe('human@example.com');
    expect(git(cwd, 'config', APPLIED_IDENTITY_KEYS['user.email'])).toBe('');
  });

  it('restores only the keys a human did not change', async () => {
    const deps = makeDeps();
    await applySessionCommitIdentity({ cwd, projectCwd, project: on, ownerUserId: 'u1' }, deps);
    git(cwd, 'config', 'user.email', 'human@example.com');
    await applySessionCommitIdentity({ cwd, projectCwd, project: {}, ownerUserId: 'u1' }, deps);
    expect(git(cwd, 'config', 'user.name')).toBe('Agent Hub');
    expect(git(cwd, 'config', 'user.email')).toBe('human@example.com');
  });

  it('unsets the identity on restore when the project checkout has none', async () => {
    git(projectCwd, 'config', '--unset', 'user.name');
    git(projectCwd, 'config', '--unset', 'user.email');
    const deps = makeDeps();
    await applySessionCommitIdentity({ cwd, projectCwd, project: on, ownerUserId: 'u1' }, deps);
    await applySessionCommitIdentity({ cwd, projectCwd, project: {}, ownerUserId: 'u1' }, deps);
    expect(git(cwd, 'config', 'user.email')).toBe('');
  });

  it('never writes into the shared checkout when the session has no worktree', async () => {
    const outcome = await applySessionCommitIdentity(
      { cwd: projectCwd, projectCwd, project: on, ownerUserId: 'u1' },
      makeDeps(),
    );
    expect(outcome).toBe('unchanged');
    expect(git(projectCwd, 'config', 'user.email')).toBe('agent@agent-hub.com');
  });

  it('commits made after applying are attributed to the owner', async () => {
    await applySessionCommitIdentity(
      { cwd, projectCwd, project: on, ownerUserId: 'u1' },
      makeDeps(),
    );
    git(cwd, 'commit', '--allow-empty', '-q', '-m', 'x');
    expect(git(cwd, 'log', '-1', '--format=%an <%ae>')).toBe(
      'speakmanra <4242+speakmanra@users.noreply.github.com>',
    );
  });
});
