import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { isRetryableMergeBlock } from './merge-block.js';
import {
  inspectMergeBaseDrift,
  mergeCheckBlockReason,
  mergeCheckJobsFingerprint,
  mergeCheckStateFromRun,
  updateBranchBlockReason,
} from './merge-drift.js';

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function commitFile(repo: string, file: string, message: string): string {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), `${file}\n`);
  git(repo, `add "${file}"`);
  git(repo, `commit -m "${message}"`);
  return git(repo, 'rev-parse HEAD');
}

/**
 * Repo where `feature` adds `branchFile` and, after it branched, `main` gains
 * `baseFile`. Returns the feature head sha.
 */
function repoWithDrift(branchFile: string, baseFile: string | null) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'merge-drift-'));
  git(repo, 'init --initial-branch=main');
  git(repo, 'config user.email "t@example.com"');
  git(repo, 'config user.name "T"');
  commitFile(repo, 'training/migrations/0028_base.py', 'base');
  git(repo, 'checkout -b feature');
  const headSha = commitFile(repo, branchFile, 'feature');
  git(repo, 'checkout main');
  if (baseFile) commitFile(repo, baseFile, 'main moves');
  return { repo, headSha };
}

describe('inspectMergeBaseDrift', () => {
  it('blocks when the base added a sibling migration after the PR branched', async () => {
    const { repo, headSha } = repoWithDrift(
      'training/migrations/0029_certificates.py',
      'training/migrations/0029_trainer_cleanup.py',
    );
    const drift = await inspectMergeBaseDrift({
      repoPath: repo,
      baseBranch: 'main',
      headSha,
      baseDrift: { mergeCheckJobs: ['backend-checks'] },
    });
    expect(drift).toMatchObject({
      kind: 'stale',
      baseTip: git(repo, 'rev-parse main'),
      overlap: ['training/migrations/'],
      policy: { mode: 'full', mergeCheckJobs: ['backend-checks'] },
    });
  });

  it('fast mode still blocks a hazard-path overlap even with reusable jobs', async () => {
    const { repo, headSha } = repoWithDrift(
      'training/migrations/0029_a.py',
      'training/migrations/0029_b.py',
    );
    const drift = await inspectMergeBaseDrift({
      repoPath: repo,
      baseBranch: 'main',
      headSha,
      baseDrift: { mode: 'fast', reuseJobs: ['e2e'] },
    });
    expect(drift.kind).toBe('stale');
  });

  it('allows the merge when the base moved on unrelated paths', async () => {
    const { repo, headSha } = repoWithDrift('training/views.py', 'frontend/src/app.ts');
    expect(
      await inspectMergeBaseDrift({
        repoPath: repo,
        baseBranch: 'main',
        headSha,
        baseDrift: undefined,
      }),
    ).toEqual({ kind: 'clear' });
  });

  it('allows the merge when the base has not moved', async () => {
    const { repo, headSha } = repoWithDrift('training/migrations/0029_a.py', null);
    expect(
      await inspectMergeBaseDrift({
        repoPath: repo,
        baseBranch: 'main',
        headSha,
        baseDrift: undefined,
      }),
    ).toEqual({ kind: 'clear' });
  });

  it('allows the merge when the project turned base drift off', async () => {
    const { repo, headSha } = repoWithDrift(
      'training/migrations/0029_a.py',
      'training/migrations/0029_b.py',
    );
    expect(
      await inspectMergeBaseDrift({
        repoPath: repo,
        baseBranch: 'main',
        headSha,
        baseDrift: { mode: 'off' },
      }),
    ).toEqual({ kind: 'clear' });
  });

  it('fails open with a warning when git cannot answer', async () => {
    const onWarn = vi.fn();
    const drift = await inspectMergeBaseDrift({
      repoPath: '/nonexistent',
      baseBranch: 'main',
      headSha: 'abc',
      baseDrift: undefined,
      git: () => Promise.reject(new Error('boom')),
      onWarn,
    });
    expect(drift).toEqual({ kind: 'clear' });
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('merge-check state and block reasons', () => {
  it('maps run rows to states; cancelled and infra errors read as not run', () => {
    expect(mergeCheckStateFromRun(undefined)).toBe('none');
    expect(mergeCheckStateFromRun({ status: 'queued', failure_reason: null })).toBe('running');
    expect(mergeCheckStateFromRun({ status: 'running', failure_reason: null })).toBe('running');
    expect(mergeCheckStateFromRun({ status: 'succeeded', failure_reason: null })).toBe('passed');
    expect(mergeCheckStateFromRun({ status: 'failed', failure_reason: 'checks_failed' })).toBe(
      'failed',
    );
    expect(mergeCheckStateFromRun({ status: 'failed', failure_reason: 'infra_error' })).toBe(
      'none',
    );
    expect(mergeCheckStateFromRun({ status: 'cancelled', failure_reason: 'superseded' })).toBe(
      'none',
    );
  });

  it('pending merge checks are retryable for auto-merge; failures and update-branch are not', () => {
    const overlap = ['training/migrations/'];
    expect(isRetryableMergeBlock(mergeCheckBlockReason('running', 'main', overlap))).toBe(true);
    expect(isRetryableMergeBlock(mergeCheckBlockReason('none', 'main', overlap))).toBe(true);
    expect(
      isRetryableMergeBlock(mergeCheckBlockReason('failed', 'main', overlap, 'checks_failed')),
    ).toBe(false);
    expect(isRetryableMergeBlock(updateBranchBlockReason('main', overlap))).toBe(false);
  });
});

describe('mergeCheckJobsFingerprint', () => {
  it('ignores order, duplicates and blanks but changes with the job set', () => {
    const a = mergeCheckJobsFingerprint(['backend-checks', 'frontend-build']);
    expect(
      mergeCheckJobsFingerprint([' frontend-build', 'backend-checks', 'backend-checks', '']),
    ).toBe(a);
    expect(mergeCheckJobsFingerprint(['backend-checks'])).not.toBe(a);
  });
});
