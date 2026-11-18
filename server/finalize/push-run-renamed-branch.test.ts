/**
 * A pre-push hook rename must follow through to the session's stored branch
 * only when the session worktree really is on the new branch. Runs against
 * real throwaway git repos.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../session-worktree-io.js', () => ({
  sessionWorktreeIoFor: vi.fn(async (_id: string, wt: string) => ({
    git: async (argv: string[]) => {
      const r = spawnSync('git', argv, { cwd: wt, encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
  })),
}));

import { recordRenamedPushBranch } from './push-run.js';
import type { SessionRow } from '../types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoOn(branch: string, extraBranches: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'renamed-branch-test-'));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  writeFileSync(path.join(dir, 'a'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  for (const b of extraBranches) git('branch', b);
  return dir;
}

function stmts() {
  return {
    updateSessionWorktreeBranch: { run: vi.fn() },
    setSessionWorktreeCheckoutBranch: { run: vi.fn() },
  };
}

function session(worktreePath: string, checkout: string | null = null): SessionRow {
  return {
    id: 's1',
    worktree_path: worktreePath,
    worktree_branch: 'feature/x',
    worktree_checkout_branch: checkout,
  } as unknown as SessionRow;
}

const currentBranch = (dir: string) =>
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

describe('recordRenamedPushBranch', () => {
  it('stores the branch the hook renamed the session worktree to', async () => {
    const wt = repoOn('12-fix');
    const s = stmts();
    await recordRenamedPushBranch({
      stmts: s as never,
      session: session(wt),
      sourcePath: wt,
      from: 'feature/x',
      to: '12-fix',
    });
    expect(s.updateSessionWorktreeBranch.run).toHaveBeenCalledWith('12-fix', 's1');
    expect(s.setSessionWorktreeCheckoutBranch.run).not.toHaveBeenCalled();
  });

  it('renames the session worktree and checkout branch for a staged run', async () => {
    const wt = repoOn('feature/x');
    const s = stmts();
    await recordRenamedPushBranch({
      stmts: s as never,
      session: session(wt, 'feature/x'),
      sourcePath: '/staging',
      from: 'feature/x',
      to: '7-feature-x',
    });
    expect(currentBranch(wt)).toBe('7-feature-x');
    expect(s.updateSessionWorktreeBranch.run).toHaveBeenCalledWith('7-feature-x', 's1');
    expect(s.setSessionWorktreeCheckoutBranch.run).toHaveBeenCalledWith('7-feature-x', 's1');
  });

  it('throws and stores nothing when the destination branch already exists', async () => {
    const wt = repoOn('feature/x', ['7-feature-x']);
    const s = stmts();
    await expect(
      recordRenamedPushBranch({
        stmts: s as never,
        session: session(wt, 'feature/x'),
        sourcePath: '/staging',
        from: 'feature/x',
        to: '7-feature-x',
      }),
    ).rejects.toThrow(/could not rename the session worktree branch feature\/x to 7-feature-x/);
    expect(currentBranch(wt)).toBe('feature/x');
    expect(s.updateSessionWorktreeBranch.run).not.toHaveBeenCalled();
    expect(s.setSessionWorktreeCheckoutBranch.run).not.toHaveBeenCalled();
  });

  it('throws when the session worktree is not on the reported branch', async () => {
    const wt = repoOn('something-else');
    const s = stmts();
    await expect(
      recordRenamedPushBranch({
        stmts: s as never,
        session: session(wt),
        sourcePath: wt,
        from: 'feature/x',
        to: '12-fix',
      }),
    ).rejects.toThrow(/on something-else, not 12-fix/);
    expect(s.updateSessionWorktreeBranch.run).not.toHaveBeenCalled();
  });
});
