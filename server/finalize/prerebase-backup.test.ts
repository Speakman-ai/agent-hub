/**
 * Unit tests for the Finalize rebase-phase commit-loss guard.
 *
 * Regression anchor: card AH-1219 lost a fully-reviewed commit when a rebase
 * onto an advanced `main` (which already carried a competing implementation)
 * dropped the session's changes, leaving a zero-diff branch tip that Finalize
 * pushed and auto-moved the card to Done. The `rebaseDroppedAllChanges` /
 * baseline path below would have turned that silent success into a loud
 * `rebase_dropped_commits` failure, and the backup ref keeps the orphaned
 * commit recoverable.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  backupRefName,
  capturePreRebaseBaseline,
  rebaseDroppedAllChanges,
  worktreeHasChangesVsBase,
  type RunGitFn,
} from './prerebase-backup.js';

describe('backupRefName', () => {
  it('namespaces under refs/finalize/prerebase/', () => {
    expect(backupRefName('run-123')).toBe('refs/finalize/prerebase/run-123');
  });

  it('sanitizes characters that are illegal in a git ref path', () => {
    expect(backupRefName('a b:c~d^e?f')).toBe('refs/finalize/prerebase/a_b_c_d_e_f');
  });

  it('falls back to a placeholder for an empty id', () => {
    expect(backupRefName('')).toBe('refs/finalize/prerebase/unknown');
  });
});

describe('rebaseDroppedAllChanges', () => {
  it('fires only when there was a real baseline with changes and none remain', () => {
    expect(rebaseDroppedAllChanges({ headSha: 'abc', hadChangesVsBase: true }, false)).toBe(true);
  });

  it('does not fire when the post-rebase branch still has changes', () => {
    expect(rebaseDroppedAllChanges({ headSha: 'abc', hadChangesVsBase: true }, true)).toBe(false);
  });

  it('does not fire for an intentionally empty session (no pre-rebase changes)', () => {
    expect(rebaseDroppedAllChanges({ headSha: 'abc', hadChangesVsBase: false }, false)).toBe(false);
  });

  it('does not fire when no baseline SHA could be captured', () => {
    expect(rebaseDroppedAllChanges({ headSha: null, hadChangesVsBase: true }, false)).toBe(false);
  });
});

describe('worktreeHasChangesVsBase', () => {
  it('reports changes when --shortstat is non-empty', async () => {
    const runGit: RunGitFn = vi
      .fn()
      .mockResolvedValue({ stdout: ' 3 files changed, 100 insertions(+)\n', stderr: '' });
    await expect(
      worktreeHasChangesVsBase(runGit, { cwd: '/wt', baseBranch: 'main' }),
    ).resolves.toBe(true);
    expect(runGit).toHaveBeenCalledWith(
      ['diff', '--shortstat', 'origin/main...HEAD'],
      expect.objectContaining({ cwd: '/wt' }),
    );
  });

  it('reports no changes when --shortstat is empty', async () => {
    const runGit: RunGitFn = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });
    await expect(
      worktreeHasChangesVsBase(runGit, { cwd: '/wt', baseBranch: 'main' }),
    ).resolves.toBe(false);
  });
});

describe('capturePreRebaseBaseline', () => {
  it('writes the backup ref to HEAD and records that the branch has changes', async () => {
    const calls: string[][] = [];
    const runGit: RunGitFn = vi.fn(async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { stdout: 'deadbeef\n', stderr: '' };
      if (args[0] === 'update-ref') return { stdout: '', stderr: '' };
      if (args[0] === 'diff') return { stdout: ' 1 file changed, 9 insertions(+)\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const baseline = await capturePreRebaseBaseline(runGit, {
      cwd: '/wt',
      baseBranch: 'main',
      runId: 'run-1',
    });

    expect(baseline).toEqual({
      headSha: 'deadbeef',
      hadChangesVsBase: true,
      backupRef: 'refs/finalize/prerebase/run-1',
      backupWritten: true,
    });
    expect(calls).toContainEqual(['update-ref', 'refs/finalize/prerebase/run-1', 'deadbeef']);
  });

  it('degrades gracefully (disables drop-detection) when rev-parse throws', async () => {
    const runGit: RunGitFn = vi.fn(async (args) => {
      if (args[0] === 'rev-parse') throw new Error('not a git repository');
      return { stdout: '', stderr: '' };
    });

    const baseline = await capturePreRebaseBaseline(runGit, {
      cwd: '/tmp/empty',
      baseBranch: 'main',
      runId: 'run-1',
    });

    expect(baseline.headSha).toBeNull();
    expect(baseline.backupWritten).toBe(false);
    // A null baseline disables drop-detection — never a false failure.
    expect(rebaseDroppedAllChanges(baseline, false)).toBe(false);
  });

  it('records the SHA even if the backup-ref write fails, and stays best-effort', async () => {
    const runGit: RunGitFn = vi.fn(async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'cafe\n', stderr: '' };
      if (args[0] === 'update-ref') throw new Error('ref lock failed');
      if (args[0] === 'diff') return { stdout: ' 2 files changed\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const baseline = await capturePreRebaseBaseline(runGit, {
      cwd: '/wt',
      baseBranch: 'main',
      runId: 'run-1',
    });

    expect(baseline.headSha).toBe('cafe');
    expect(baseline.backupWritten).toBe(false);
    expect(baseline.hadChangesVsBase).toBe(true);
  });
});
