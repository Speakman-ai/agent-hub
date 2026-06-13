import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

/**
 * Regression: the global test setup (server/test/setup.ts) sets
 * AGENT_HUB_ALLOW_BRANCH_OPS=1 so the session-branch git guard
 * (server/finalize/spawn-guards/git) does NOT block `git checkout -b` in the
 * throwaway repos many server tests build — even when the Finalize CI runner
 * sets AGENT_HUB_PROTECT_SESSION_BRANCH=1.
 *
 * This test forces PROTECT=1 for a spawned guard `git` and asserts the override
 * lets a branch op through, while removing the override re-arms the guard. If
 * setup.ts's neutralization is ever dropped, worktree.test.ts / native-pr/*
 * et al. would go red under Finalize; this pins the override directly.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD_GIT = path.resolve(__dirname, '../finalize/spawn-guards/git');

// Resolve a real git binary for the guard to exec (the guard reads
// AGENT_HUB_REAL_GIT, falling back to `git` on PATH — which is the guard
// itself in the runner, so be explicit).
function resolveRealGit(): string {
  const fromEnv = process.env.AGENT_HUB_REAL_GIT;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of ['/usr/bin/git', '/bin/git', '/usr/local/bin/git']) {
    if (existsSync(candidate)) return candidate;
  }
  return 'git';
}

describe('session-branch git guard is neutralized in tests', () => {
  let repo: string;
  const realGit = resolveRealGit();

  beforeEach(() => {
    repo = path.join(
      os.tmpdir(),
      `branch-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(repo, { recursive: true });
    // Build the throwaway repo with the REAL git so setup never trips the guard.
    execFileSync(realGit, ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' });
    execFileSync(realGit, ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
      stdio: 'pipe',
    });
    execFileSync(realGit, ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'pipe' });
    writeFileSync(path.join(repo, 'README.md'), 'hi\n');
    execFileSync(realGit, ['add', 'README.md'], { cwd: repo, stdio: 'pipe' });
    execFileSync(realGit, ['commit', '-m', 'init'], { cwd: repo, stdio: 'pipe' });
  });

  afterEach(() => {
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  it('lets `git checkout -b` through when PROTECT=1 because ALLOW_BRANCH_OPS=1 (setup.ts override)', () => {
    // ALLOW_BRANCH_OPS is inherited from process.env (set in setup.ts).
    expect(process.env.AGENT_HUB_ALLOW_BRANCH_OPS).toBe('1');

    execFileSync(GUARD_GIT, ['checkout', '-b', 'feature/guarded'], {
      cwd: repo,
      stdio: 'pipe',
      env: {
        ...process.env,
        AGENT_HUB_PROTECT_SESSION_BRANCH: '1',
        AGENT_HUB_REAL_GIT: realGit,
      },
    });

    const branch = execFileSync(realGit, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    expect(branch).toBe('feature/guarded');
  });

  it('still blocks `git checkout -b` when the override is removed (guard is real)', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_HUB_PROTECT_SESSION_BRANCH: '1',
      AGENT_HUB_REAL_GIT: realGit,
    };
    delete env.AGENT_HUB_ALLOW_BRANCH_OPS;

    expect(() =>
      execFileSync(GUARD_GIT, ['checkout', '-b', 'feature/blocked'], {
        cwd: repo,
        stdio: 'pipe',
        env,
      }),
    ).toThrow();

    // The branch must NOT have been created.
    const branch = execFileSync(realGit, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo,
      stdio: 'pipe',
    })
      .toString()
      .trim();
    expect(branch).toBe('main');
  });
});
