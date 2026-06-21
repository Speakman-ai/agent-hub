/**
 * Tests for the Finalize §8 push-target lock (origin-guard.ts).
 *
 * Regression intent: before this guard, the GitHub push path ran
 * `git push -u origin` + `gh pr create` against WHATEVER the worktree's
 * origin was, with no check that it pointed at the project's own repo. A
 * tampered / stale / mis-pointed origin could ship commits and a PR to an
 * arbitrary repository. These tests pin the decision matrix that now
 * refuses that — including the NO-fail-open contract: a project with no
 * verifiable target is hard-refused, never silently allowed through.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

// origin-guard pulls in push-and-create-pr.ts for `execGit`, which transitively
// imports auto-git.ts → worktree.ts (the latter calls `promisify(exec)` at load).
// Stub auto-git so that heavy chain never loads — mirrors push-and-create-pr.test.ts.
vi.mock('../auto-git.js', () => ({
  resolveOrgOwnerGithubToken: vi.fn(),
  resolveAutoGitGithubToken: vi.fn(),
  autoGitChildEnv: vi.fn(() => ({})),
}));

import { execFile } from 'child_process';
import {
  evaluateOriginGuard,
  resolveProjectExpectedRepo,
  assertWorktreeOriginMatchesProject,
} from './origin-guard.js';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const ACME = { owner: 'acme', repo: 'proj' };

describe('resolveProjectExpectedRepo', () => {
  it('prefers the githubRepo owner/repo slug', () => {
    expect(resolveProjectExpectedRepo({ githubRepo: 'acme/proj' })).toEqual(ACME);
  });

  it('strips a trailing .git from the slug', () => {
    expect(resolveProjectExpectedRepo({ githubRepo: 'acme/proj.git' })).toEqual(ACME);
  });

  it('falls back to parsing the repoUrl HTTPS clone URL', () => {
    expect(resolveProjectExpectedRepo({ repoUrl: 'https://github.com/acme/proj.git' })).toEqual(
      ACME,
    );
  });

  it('returns null when neither field is set (caller derives a fallback)', () => {
    expect(resolveProjectExpectedRepo({})).toBeNull();
    expect(resolveProjectExpectedRepo({ githubRepo: undefined, repoUrl: null })).toBeNull();
  });
});

describe('evaluateOriginGuard', () => {
  it('passes when the worktree origin matches the expected repo', () => {
    const d = evaluateOriginGuard('proj-1', ACME, 'https://github.com/acme/proj.git');
    expect(d.ok).toBe(true);
    expect(d.reason).toBe('match');
  });

  it('matches case-insensitively (GitHub owner/repo are case-insensitive)', () => {
    const d = evaluateOriginGuard('proj-1', ACME, 'https://github.com/ACME/Proj.git');
    expect(d.ok).toBe(true);
    expect(d.reason).toBe('match');
  });

  it('matches an SSH-form origin for the same repo', () => {
    expect(evaluateOriginGuard('proj-1', ACME, 'git@github.com:acme/proj.git').ok).toBe(true);
  });

  it('matches an origin carrying an inline token', () => {
    const d = evaluateOriginGuard(
      'proj-1',
      ACME,
      'https://x-access-token:ghs_abc@github.com/acme/proj.git',
    );
    expect(d.ok).toBe(true);
  });

  it('REFUSES when the origin points at a different repo', () => {
    const d = evaluateOriginGuard('proj-1', ACME, 'https://github.com/attacker/evil.git');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('mismatch');
    if (!d.ok) {
      expect(d.message).toContain('attacker/evil');
      expect(d.message).toContain('acme/proj');
    }
  });

  it('REFUSES when the origin owner differs but repo name matches', () => {
    const d = evaluateOriginGuard('proj-1', ACME, 'https://github.com/attacker/proj.git');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('mismatch');
  });

  it('REFUSES a non-GitHub / unparseable origin when an expected repo is known', () => {
    const d = evaluateOriginGuard('proj-1', ACME, 'https://gitlab.com/acme/proj.git');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('unparseable-origin');
  });

  it('REFUSES an empty/unset origin when an expected repo is known', () => {
    const d = evaluateOriginGuard('proj-1', ACME, '');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('unparseable-origin');
  });

  it('HARD-REFUSES (no fail-open) when no trusted expected repo could be resolved', () => {
    // Regression for the reviewer note: a project with no verifiable target
    // must NOT proceed to push against an arbitrary origin.
    const d = evaluateOriginGuard('proj-2', null, 'https://github.com/anything/at-all.git');
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('no-trusted-repo');
    if (!d.ok) expect(d.message).toMatch(/cannot be verified/);
  });
});

describe('assertWorktreeOriginMatchesProject', () => {
  // Dispatch the mocked `git remote get-url origin` by which checkout it reads:
  // the project checkout (`project.cwd`) vs the session worktree.
  function mockOrigins(byCwd: Record<string, string | Error>): void {
    mockExecFile.mockReset();
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        opts: { cwd?: string },
        cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
      ) => {
        const value = byCwd[opts.cwd ?? ''];
        if (value instanceof Error) {
          cb(value, { stdout: '', stderr: '' });
          return;
        }
        cb(null, { stdout: `${value ?? ''}\n`, stderr: '' });
      },
    );
  }

  it('locks to the config repo (source: config) for a matching origin', async () => {
    mockOrigins({ '/tmp/wt': 'https://github.com/acme/proj.git' });
    const r = await assertWorktreeOriginMatchesProject(
      { id: 'proj-1', cwd: '/tmp/proj', githubRepo: 'acme/proj' },
      '/tmp/wt',
      undefined,
    );
    expect(r.expectedSource).toBe('config');
    expect(r.summary).toContain('acme/proj');
    expect(r.summary).toContain('source: config');
    // Config resolved the expected repo, so the project checkout is NOT read —
    // only the worktree origin.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect((mockExecFile.mock.calls[0]![2] as { cwd: string }).cwd).toBe('/tmp/wt');
  });

  it('throws for a mismatched origin', async () => {
    mockOrigins({ '/tmp/wt': 'https://github.com/attacker/evil.git' });
    await expect(
      assertWorktreeOriginMatchesProject(
        { id: 'proj-1', cwd: '/tmp/proj', githubRepo: 'acme/proj' },
        '/tmp/wt',
        undefined,
      ),
    ).rejects.toThrow(/push refused/);
  });

  it('falls back to the project checkout origin (source: project-checkout) when no config repo is set', async () => {
    // No githubRepo/repoUrl → derive the trusted anchor from project.cwd's
    // origin, then verify the worktree matches it. Both point at acme/proj.
    mockOrigins({
      '/tmp/proj': 'git@github.com:acme/proj.git',
      '/tmp/wt': 'https://github.com/acme/proj.git',
    });
    const r = await assertWorktreeOriginMatchesProject(
      { id: 'proj-3', cwd: '/tmp/proj' },
      '/tmp/wt',
      undefined,
    );
    expect(r.expectedSource).toBe('project-checkout');
    expect(r.summary).toContain('source: project-checkout');
    // Two reads: project checkout (anchor) then worktree (actual).
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect((mockExecFile.mock.calls[0]![2] as { cwd: string }).cwd).toBe('/tmp/proj');
    expect((mockExecFile.mock.calls[1]![2] as { cwd: string }).cwd).toBe('/tmp/wt');
  });

  it('throws when the fallback derives acme/proj but the worktree points elsewhere', async () => {
    mockOrigins({
      '/tmp/proj': 'https://github.com/acme/proj.git',
      '/tmp/wt': 'https://github.com/attacker/evil.git',
    });
    await expect(
      assertWorktreeOriginMatchesProject({ id: 'proj-3', cwd: '/tmp/proj' }, '/tmp/wt', undefined),
    ).rejects.toThrow(/push refused/);
  });

  it('HARD-REFUSES when neither config nor project checkout yields a repo (no fail-open)', async () => {
    // No config repo AND the project checkout has a non-GitHub origin → there
    // is no trusted target, so the push must be refused, not allowed through.
    mockOrigins({
      '/tmp/proj': 'https://gitlab.com/acme/proj.git',
      '/tmp/wt': 'https://github.com/whoever/whatever.git',
    });
    await expect(
      assertWorktreeOriginMatchesProject({ id: 'proj-3', cwd: '/tmp/proj' }, '/tmp/wt', undefined),
    ).rejects.toThrow(/cannot be verified/);
  });

  it('HARD-REFUSES when the project checkout origin cannot be read at all', async () => {
    mockOrigins({
      '/tmp/proj': new Error('not a git repository'),
      '/tmp/wt': 'https://github.com/whoever/whatever.git',
    });
    await expect(
      assertWorktreeOriginMatchesProject({ id: 'proj-3', cwd: '/tmp/proj' }, '/tmp/wt', undefined),
    ).rejects.toThrow(/cannot be verified/);
  });

  it('throws when the worktree origin cannot be read but a config repo is set', async () => {
    mockOrigins({ '/tmp/wt': new Error('not a git repository') });
    await expect(
      assertWorktreeOriginMatchesProject(
        { id: 'proj-1', cwd: '/tmp/proj', githubRepo: 'acme/proj' },
        '/tmp/wt',
        undefined,
      ),
    ).rejects.toThrow(/push refused/);
  });
});
