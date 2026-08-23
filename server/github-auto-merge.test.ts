import { describe, it, expect, vi } from 'vitest';
import {
  classifyGithubCheckRollup,
  mergeOrEnableGithubAutoMerge,
  type AutoMergeCheckWaitOptions,
  type GhRunner,
} from './github-auto-merge.js';

const PR = 'https://github.com/acme/repo/pull/42';
const FAST_WAIT: AutoMergeCheckWaitOptions = {
  discoveryTimeoutMs: 0,
  stabilizationTimeoutMs: 0,
  pollIntervalMs: 0,
};

function checkRollup(rows: unknown[]): string {
  return JSON.stringify({ statusCheckRollup: rows });
}

const PASSING_CHECK = {
  __typename: 'CheckRun',
  name: 'test',
  status: 'COMPLETED',
  conclusion: 'SUCCESS',
};

describe('classifyGithubCheckRollup', () => {
  it('requires every CheckRun and StatusContext to pass', () => {
    expect(
      classifyGithubCheckRollup([
        PASSING_CHECK,
        { __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS' },
      ]),
    ).toEqual({ state: 'passed' });
    expect(
      classifyGithubCheckRollup([
        PASSING_CHECK,
        { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
      ]),
    ).toEqual({ state: 'pending' });
    expect(
      classifyGithubCheckRollup([
        PASSING_CHECK,
        { __typename: 'StatusContext', context: 'deploy', state: 'FAILURE' },
      ]),
    ).toEqual({ state: 'failed', names: ['deploy'] });
  });
});

describe('mergeOrEnableGithubAutoMerge', () => {
  it('waits for pending GitHub checks to pass before issuing the merge', async () => {
    // Regression: the direct merge used to run first. On an unprotected repo
    // it merged the PR while this Actions check was still pending.
    const calls: string[][] = [];
    let reads = 0;
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'view') {
        reads += 1;
        return {
          stdout: checkRollup([
            reads === 1
              ? { ...PASSING_CHECK, status: 'IN_PROGRESS', conclusion: null }
              : PASSING_CHECK,
          ]),
          stderr: '',
        };
      }
      return { stdout: 'Merged', stderr: '' };
    });

    const outcome = await mergeOrEnableGithubAutoMerge(PR, runGh, '--squash', {
      stabilizationTimeoutMs: 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });

    expect(outcome.merged).toBe(true);
    expect(calls).toEqual([
      ['pr', 'view', PR, '--json', 'statusCheckRollup'],
      ['pr', 'view', PR, '--json', 'statusCheckRollup'],
      ['pr', 'merge', '--squash', PR],
    ]);
  });

  it('stabilizes a passing rollup before merging when a later check appears pending', async () => {
    // Reviewer regression: one fast workflow can turn green before another
    // workflow has even created its check suite. The first green snapshot
    // must not authorize a merge.
    const calls: string[][] = [];
    let reads = 0;
    let currentTime = 0;
    const laterCheck = { ...PASSING_CHECK, name: 'integration' };
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] !== 'view') return { stdout: 'Merged', stderr: '' };
      reads += 1;
      const rows =
        reads === 1
          ? [PASSING_CHECK]
          : reads === 2
            ? [PASSING_CHECK, { ...laterCheck, status: 'IN_PROGRESS', conclusion: null }]
            : [PASSING_CHECK, laterCheck];
      return { stdout: checkRollup(rows), stderr: '' };
    });

    const outcome = await mergeOrEnableGithubAutoMerge(PR, runGh, '--squash', {
      stabilizationTimeoutMs: 10,
      pollIntervalMs: 10,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
    });

    expect(outcome.merged).toBe(true);
    expect(calls.map((args) => args[1])).toEqual(['view', 'view', 'view', 'view', 'merge']);
  });

  it('does not merge when any GitHub check fails', async () => {
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      if (args[1] === 'view') {
        return {
          stdout: checkRollup([{ ...PASSING_CHECK, conclusion: 'FAILURE' }]),
          stderr: '',
        };
      }
      throw new Error('merge must not run');
    });

    await expect(mergeOrEnableGithubAutoMerge(PR, runGh, '--squash', FAST_WAIT)).rejects.toThrow(
      `GitHub checks failed for ${PR}: test`,
    );
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it('merges after the discovery window when the repository has no checks', async () => {
    const calls: string[][] = [];
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'view') return { stdout: checkRollup([]), stderr: '' };
      return { stdout: 'Merged', stderr: '' };
    });

    const outcome = await mergeOrEnableGithubAutoMerge(PR, runGh, '--squash', FAST_WAIT);

    expect(outcome).toEqual({
      merged: true,
      autoEnabled: false,
      note: `merged ${PR} (--squash; GitHub checks not configured)`,
    });
    expect(calls).toEqual([
      ['pr', 'view', PR, '--json', 'statusCheckRollup'],
      ['pr', 'merge', '--squash', PR],
    ]);
  });

  it('falls back to native auto-merge when a requirement still blocks the merge', async () => {
    const calls: string[][] = [];
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'view') {
        return { stdout: checkRollup([PASSING_CHECK]), stderr: '' };
      }
      if (!args.includes('--auto')) throw new Error('required review missing');
      return { stdout: '', stderr: '' };
    });

    const outcome = await mergeOrEnableGithubAutoMerge(PR, runGh, '--squash', FAST_WAIT);

    expect(outcome.merged).toBe(false);
    expect(outcome.autoEnabled).toBe(true);
    expect(calls).toEqual([
      ['pr', 'view', PR, '--json', 'statusCheckRollup'],
      ['pr', 'merge', '--squash', PR],
      ['pr', 'merge', '--auto', '--squash', PR],
    ]);
  });

  it('throws with both error details when neither merge nor auto-merge works', async () => {
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      if (args[1] === 'view') return { stdout: checkRollup([PASSING_CHECK]), stderr: '' };
      throw new Error(args.includes('--auto') ? 'auto-merge not allowed' : 'not mergeable');
    });

    await expect(mergeOrEnableGithubAutoMerge(PR, runGh, '--squash', FAST_WAIT)).rejects.toThrow(
      /immediate=\[not mergeable\]; auto=\[auto-merge not allowed\]/,
    );
  });

  it('honors a non-default merge method on both merge paths', async () => {
    const calls: string[][] = [];
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'view') return { stdout: checkRollup([PASSING_CHECK]), stderr: '' };
      if (!args.includes('--auto')) throw new Error('blocked');
      return { stdout: '', stderr: '' };
    });

    await mergeOrEnableGithubAutoMerge(PR, runGh, '--merge', FAST_WAIT);

    expect(calls.slice(1)).toEqual([
      ['pr', 'merge', '--merge', PR],
      ['pr', 'merge', '--auto', '--merge', PR],
    ]);
  });
});
