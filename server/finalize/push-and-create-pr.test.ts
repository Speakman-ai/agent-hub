/**
 * Tests for the §8 push step. Mocks `child_process.execFile` so we can
 * assert the argv shape that hits `git push` and `gh pr create` without
 * spawning real subprocesses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../auto-git.js', () => ({
  resolveOrgOwnerGithubToken: vi.fn().mockResolvedValue('ghs_fake_token'),
  resolveAutoGitGithubToken: vi.fn().mockResolvedValue(null),
  // Reflect the chosen token into the env so tests can assert *which* token
  // (session owner vs org owner) the push authenticated with.
  autoGitChildEnv: vi.fn((token: string | null) => ({ PATH: '/usr/bin', GH_TOKEN: token })),
}));

import { execFile } from 'child_process';
import {
  resolveOrgOwnerGithubToken,
  resolveAutoGitGithubToken,
  autoGitChildEnv,
} from '../auto-git.js';
import { createPushAndCreatePr, __test } from './push-and-create-pr.js';
import type { KanbanCardRow, Project } from '../types.js';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockResolveOrgOwnerGithubToken = resolveOrgOwnerGithubToken as unknown as ReturnType<
  typeof vi.fn
>;
const mockResolveAutoGitGithubToken = resolveAutoGitGithubToken as unknown as ReturnType<
  typeof vi.fn
>;
const mockAutoGitChildEnv = autoGitChildEnv as unknown as ReturnType<typeof vi.fn>;

function mkCard(): KanbanCardRow {
  return {
    id: 'card-1',
    column_id: 'col-1',
    board_id: 'board-1',
    title: 'Finalize my card',
    description: 'User asked Agent Hub to fill out the PR title and description.',
    priority: 'medium',
    assignee: null,
    labels: null,
    session_id: 'sess-1',
    github_issue_url: null,
    pr_url: null,
    review_status: null,
    created_by: null,
    position: 0,
    epic_id: null,
    documented: 0,
    dispatched_by_autonomous: 0,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };
}

function mkProject(): Project {
  return {
    id: 'proj-1',
    name: 'Proj',
    cwd: '/tmp/proj',
    color: '#000',
    agents: [],
    githubRepo: 'acme/proj',
  } as unknown as Project;
}

describe('parsePrUrl', () => {
  it('extracts the first https github pull URL from gh stdout', () => {
    const stdout = `Creating pull request for branch...\n\nhttps://github.com/acme/proj/pull/42\n`;
    expect(__test.parsePrUrl(stdout)).toBe('https://github.com/acme/proj/pull/42');
  });
  it('returns null when no PR URL is present', () => {
    expect(__test.parsePrUrl('boom\nsomething went wrong\n')).toBeNull();
  });
});

describe('parsePrListUrl', () => {
  it('extracts the first PR URL from gh pr list JSON', () => {
    expect(__test.parsePrListUrl('[{"url":"https://github.com/acme/proj/pull/42"}]\n')).toBe(
      'https://github.com/acme/proj/pull/42',
    );
  });

  it('returns null when gh pr list finds no open PR', () => {
    expect(__test.parsePrListUrl('[]\n')).toBeNull();
  });
});

describe('createPushAndCreatePr', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('runs git push --force-with-lease then gh pr create with expected argv, returns the parsed prUrl', async () => {
    // The promisified execFile resolves with { stdout, stderr } — our mock
    // implements the callback-style API that util.promisify wraps.
    mockExecFile.mockImplementation(
      (
        cmd,
        args,
        _opts,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          cb(null, {
            stdout: '1111111111111111111111111111111111111111\trefs/heads/feature/x\n',
            stderr: '',
          });
          return;
        }
        if (cmd === 'gh' && args[1] === 'list') {
          cb(null, { stdout: '[]\n', stderr: '' });
          return;
        }
        if (cmd === 'git' && args[0] === 'log') {
          cb(null, {
            stdout:
              'Fill PR metadata from finalize implementation\n\nUse commit data and card context.\0',
            stderr: '',
          });
          return;
        }
        if (cmd === 'git' && args[0] === 'diff') {
          cb(null, {
            stdout: ' server/finalize/push-and-create-pr.ts | 42 +++++++++++++++++++++\n',
            stderr: '',
          });
          return;
        }
        if (cmd === 'gh' && args[1] === 'create') {
          cb(null, { stdout: 'https://github.com/acme/proj/pull/7\n', stderr: '' });
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const push = createPushAndCreatePr({
      config: { personalOAuth: null, githubApp: null } as never,
    });
    const result = await push({
      runId: 'run-1',
      worktreePath: '/tmp/wt',
      branch: 'feature/x',
      baseBranch: 'main',
      headSha: 'deadbeef',
      card: mkCard(),
      project: mkProject(),
    });
    expect(result).toEqual({ prUrl: 'https://github.com/acme/proj/pull/7' });

    // Six execFile calls: git ls-remote (lease pin), git push, gh pr list,
    // git log, git diff, then gh pr create.
    expect(mockExecFile).toHaveBeenCalledTimes(6);
    const lsRemoteArgs = mockExecFile.mock.calls[0]!;
    expect(lsRemoteArgs[0]).toBe('git');
    expect(lsRemoteArgs[1]).toEqual(['ls-remote', 'origin', 'refs/heads/feature/x']);

    const firstArgs = mockExecFile.mock.calls[1]!;
    expect(firstArgs[0]).toBe('git');
    // Lease is pinned to the ls-remote SHA, not bare — this is what keeps the
    // push from being rejected as `(stale info)` on a non-`main` branch.
    expect(firstArgs[1]).toEqual([
      'push',
      '--force-with-lease=feature/x:1111111111111111111111111111111111111111',
      '-u',
      'origin',
      'feature/x',
    ]);
    const firstOpts = firstArgs[2] as { cwd: string; env: NodeJS.ProcessEnv };
    expect(firstOpts.cwd).toBe('/tmp/wt');
    expect(firstOpts.env.GH_TOKEN).toBe('ghs_fake_token');

    const secondArgs = mockExecFile.mock.calls[2]!;
    expect(secondArgs[0]).toBe('gh');
    expect(secondArgs[1]).toEqual([
      'pr',
      'list',
      '--head',
      'feature/x',
      '--json',
      'url',
      '--limit',
      '1',
    ]);

    const thirdArgs = mockExecFile.mock.calls[3]!;
    expect(thirdArgs[0]).toBe('git');
    expect(thirdArgs[1]).toEqual(['log', 'main..HEAD', '-z', '--format=%s%n%b']);

    const fourthArgs = mockExecFile.mock.calls[4]!;
    expect(fourthArgs[0]).toBe('git');
    expect(fourthArgs[1]).toEqual(['diff', '--stat', 'main...HEAD']);

    const fifthArgs = mockExecFile.mock.calls[5]!;
    expect(fifthArgs[0]).toBe('gh');
    expect(fifthArgs[1]).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'feature/x',
      '--title',
      'Fill PR metadata from finalize implementation',
      '--body',
      expect.stringContaining('## Summary'),
    ]);
    const body = fifthArgs[1][9] as string;
    expect(body).toContain('Use commit data and card context.');
    expect(body).toContain('## Original task');
    expect(body).toContain('User asked Agent Hub to fill out the PR title and description.');
    expect(body).toContain('## Files changed');
    expect(body).toContain('server/finalize/push-and-create-pr.ts');
    expect(body).not.toBe('Auto-generated by Finalize Code Changes.');
  });

  it('returns the open PR URL after pushing an existing PR branch without creating a duplicate PR', async () => {
    mockExecFile.mockImplementation(
      (
        cmd,
        args,
        _opts,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          cb(null, {
            stdout:
              '2222222222222222222222222222222222222222\trefs/heads/feature/fix-reviewer-initial-reply-routing\n',
            stderr: '',
          });
          return;
        }
        if (cmd === 'gh' && args[1] === 'list') {
          cb(null, {
            stdout: '[{"url":"https://github.com/acme/proj/pull/1241"}]\n',
            stderr: '',
          });
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const push = createPushAndCreatePr({
      config: { personalOAuth: null, githubApp: null } as never,
    });
    const result = await push({
      runId: 'run-1241',
      worktreePath: '/tmp/wt',
      branch: 'feature/fix-reviewer-initial-reply-routing',
      baseBranch: 'main',
      headSha: '160cc09',
      card: mkCard(),
      project: mkProject(),
    });

    expect(result).toEqual({ prUrl: 'https://github.com/acme/proj/pull/1241' });
    // ls-remote (lease pin) → git push → gh pr list.
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecFile.mock.calls[0]![1]).toEqual([
      'ls-remote',
      'origin',
      'refs/heads/feature/fix-reviewer-initial-reply-routing',
    ]);
    expect(mockExecFile.mock.calls[1]![1]).toEqual([
      'push',
      '--force-with-lease=feature/fix-reviewer-initial-reply-routing:2222222222222222222222222222222222222222',
      '-u',
      'origin',
      'feature/fix-reviewer-initial-reply-routing',
    ]);
    expect(mockExecFile.mock.calls[2]![1]).toEqual([
      'pr',
      'list',
      '--head',
      'feature/fix-reviewer-initial-reply-routing',
      '--json',
      'url',
      '--limit',
      '1',
    ]);
  });

  it('throws when gh emits no parseable URL', async () => {
    mockExecFile.mockImplementation(
      (
        cmd,
        args,
        _opts,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === 'gh' && args[1] === 'list') {
          cb(null, { stdout: '[]\n', stderr: '' });
          return;
        }
        cb(null, { stdout: 'boom no url here', stderr: '' });
      },
    );
    const push = createPushAndCreatePr({
      config: { personalOAuth: null, githubApp: null } as never,
    });
    await expect(
      push({
        runId: 'run-2',
        worktreePath: '/tmp/wt',
        branch: 'feature/y',
        baseBranch: 'main',
        headSha: 'cafef00d',
        card: mkCard(),
        project: mkProject(),
      }),
    ).rejects.toThrow(/no parseable PR URL/);
  });
});

/**
 * Regression: bare `--force-with-lease` is rejected with `! [rejected]
 * <branch> -> <branch> (stale info)` when force-updating any branch not covered
 * by origin's fetch refspec. Agent Hub session clones fetch only
 * `+refs/heads/main:refs/remotes/origin/main`, so a Resolve-PR session pushing
 * its PR head branch hit this and the Finalize push 502'd
 * (`github_push_5xx`) — the work never reached the PR. The push now pins the
 * lease to an explicit `ls-remote` SHA, which does not depend on the refspec.
 */
describe('buildForceWithLeasePushArgs', () => {
  it('pins the lease to the expected SHA when known', () => {
    expect(__test.buildForceWithLeasePushArgs('fix/pr-head', 'abc123')).toEqual([
      'push',
      '--force-with-lease=fix/pr-head:abc123',
      '-u',
      'origin',
      'fix/pr-head',
    ]);
  });

  it('falls back to a bare lease when the expected SHA is unknown (brand-new branch)', () => {
    expect(__test.buildForceWithLeasePushArgs('agent-hub/dev/session-1', null)).toEqual([
      'push',
      '--force-with-lease',
      '-u',
      'origin',
      'agent-hub/dev/session-1',
    ]);
  });
});

describe('createPushAndCreatePr — force-with-lease pinning', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('pins the lease to the ls-remote SHA for an existing branch (Resolve-PR head)', async () => {
    mockExecFile.mockImplementation(
      (
        cmd,
        args,
        _opts,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          cb(null, {
            stdout: 'cafef00dcafef00dcafef00dcafef00dcafef00d\trefs/heads/fix/pr-head\n',
            stderr: '',
          });
          return;
        }
        if (cmd === 'gh' && args[1] === 'list') {
          cb(null, { stdout: '[{"url":"https://github.com/acme/proj/pull/5"}]\n', stderr: '' });
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const push = createPushAndCreatePr({
      config: { personalOAuth: null, githubApp: null } as never,
    });
    await push({
      runId: 'run-lease',
      worktreePath: '/tmp/wt',
      branch: 'fix/pr-head',
      baseBranch: 'main',
      headSha: 'deadbeef',
      card: mkCard(),
      project: mkProject(),
    });

    // calls[0] = ls-remote (lease pin), calls[1] = git push.
    expect(mockExecFile.mock.calls[0]![1]).toEqual([
      'ls-remote',
      'origin',
      'refs/heads/fix/pr-head',
    ]);
    expect(mockExecFile.mock.calls[1]![1]).toEqual([
      'push',
      '--force-with-lease=fix/pr-head:cafef00dcafef00dcafef00dcafef00dcafef00d',
      '-u',
      'origin',
      'fix/pr-head',
    ]);
  });

  it('falls back to a bare lease for a brand-new branch (empty ls-remote)', async () => {
    mockExecFile.mockImplementation(
      (
        cmd,
        args,
        _opts,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === 'git' && args[0] === 'ls-remote') {
          // Empty output = branch not yet on origin (brand-new session branch).
          cb(null, { stdout: '', stderr: '' });
          return;
        }
        if (cmd === 'gh' && args[1] === 'list') {
          cb(null, { stdout: '[{"url":"https://github.com/acme/proj/pull/5"}]\n', stderr: '' });
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );

    const push = createPushAndCreatePr({
      config: { personalOAuth: null, githubApp: null } as never,
    });
    await push({
      runId: 'run-lease-new',
      worktreePath: '/tmp/wt',
      branch: 'agent-hub/dev/session-1',
      baseBranch: 'main',
      headSha: 'deadbeef',
      card: mkCard(),
      project: mkProject(),
    });

    expect(mockExecFile.mock.calls[1]![1]).toEqual([
      'push',
      '--force-with-lease',
      '-u',
      'origin',
      'agent-hub/dev/session-1',
    ]);
  });
});

/**
 * Regression for card 2657c2a7 — Finalize push must be attributed to the
 * user who triggered it, not an arbitrary org Owner. Before the fix the push
 * always resolved the org-owner token, so a non-owner (e.g. "Kevin") pushed
 * and opened PRs as the owner ("Speakmanra"). The push now prefers the
 * session owner's personal token, falling back to the org owner only when the
 * session owner has no usable GitHub identity.
 */
describe('createPushAndCreatePr — GitHub identity attribution', () => {
  // After the push, `gh pr list` reports an open PR so the flow short-circuits
  // (push + list only) — keeps these tests focused on token resolution.
  function mockExistingPr(): void {
    mockExecFile.mockImplementation(
      (
        cmd,
        args,
        _opts,
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        if (cmd === 'gh' && args[1] === 'list') {
          cb(null, { stdout: '[{"url":"https://github.com/acme/proj/pull/9"}]\n', stderr: '' });
          return;
        }
        cb(null, { stdout: '', stderr: '' });
      },
    );
  }

  beforeEach(() => {
    mockExecFile.mockReset();
    mockResolveOrgOwnerGithubToken.mockReset().mockResolvedValue('ghs_org_owner_token');
    mockResolveAutoGitGithubToken.mockReset().mockResolvedValue(null);
    mockAutoGitChildEnv
      .mockReset()
      .mockImplementation((token: string | null) => ({ PATH: '/usr/bin', GH_TOKEN: token }));
    mockExistingPr();
  });

  it('pushes with the session owner token when the session owner has a connected GitHub identity', async () => {
    mockResolveAutoGitGithubToken.mockResolvedValue('ghs_kevin_token');

    const push = createPushAndCreatePr({
      config: { personalOAuth: null, githubApp: null } as never,
    });
    await push({
      runId: 'run-kevin',
      worktreePath: '/tmp/wt',
      branch: 'feature/kevin',
      baseBranch: 'main',
      headSha: 'deadbeef',
      card: mkCard(),
      project: mkProject(),
      sessionId: 'sess-kevin',
    });

    // Session owner's token is resolved for this session...
    expect(mockResolveAutoGitGithubToken).toHaveBeenCalledWith('sess-kevin', expect.anything());
    // ...and the org-owner token is never consulted when a session token exists.
    expect(mockResolveOrgOwnerGithubToken).not.toHaveBeenCalled();
    // The git push runs with Kevin's token, so GitHub attributes it to Kevin.
    const pushOpts = mockExecFile.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(pushOpts.env.GH_TOKEN).toBe('ghs_kevin_token');
  });

  it('falls back to the org owner token when the session owner has no usable token', async () => {
    mockResolveAutoGitGithubToken.mockResolvedValue(null);

    const push = createPushAndCreatePr({
      config: { personalOAuth: null, githubApp: null } as never,
    });
    await push({
      runId: 'run-fallback',
      worktreePath: '/tmp/wt',
      branch: 'feature/fallback',
      baseBranch: 'main',
      headSha: 'deadbeef',
      card: mkCard(),
      project: mkProject(),
      sessionId: 'sess-no-token',
    });

    expect(mockResolveAutoGitGithubToken).toHaveBeenCalledWith('sess-no-token', expect.anything());
    expect(mockResolveOrgOwnerGithubToken).toHaveBeenCalledTimes(1);
    const pushOpts = mockExecFile.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(pushOpts.env.GH_TOKEN).toBe('ghs_org_owner_token');
  });

  it('uses the org owner token when there is no session scope at all', async () => {
    const push = createPushAndCreatePr({
      config: { personalOAuth: null, githubApp: null } as never,
    });
    await push({
      runId: 'run-no-session',
      worktreePath: '/tmp/wt',
      branch: 'feature/no-session',
      baseBranch: 'main',
      headSha: 'deadbeef',
      card: mkCard(),
      project: mkProject(),
      // no sessionId
    });

    // No session scope → don't even attempt per-user resolution.
    expect(mockResolveAutoGitGithubToken).not.toHaveBeenCalled();
    expect(mockResolveOrgOwnerGithubToken).toHaveBeenCalledTimes(1);
    const pushOpts = mockExecFile.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(pushOpts.env.GH_TOKEN).toBe('ghs_org_owner_token');
  });
});
