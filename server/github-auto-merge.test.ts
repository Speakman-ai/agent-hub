import { describe, it, expect, vi } from 'vitest';
import { mergeOrEnableGithubAutoMerge, type GhRunner } from './github-auto-merge.js';

const PR = 'https://github.com/acme/repo/pull/42';

describe('mergeOrEnableGithubAutoMerge', () => {
  it('merges immediately when the PR is already mergeable (no branch protection)', async () => {
    // Regression: the old code only ran `gh pr merge --auto`, which silently
    // no-ops on a repo with no pending required checks — the PR never merged.
    const calls: string[][] = [];
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: 'Merged', stderr: '' };
    });

    const outcome = await mergeOrEnableGithubAutoMerge(PR, runGh);

    expect(outcome).toEqual({
      merged: true,
      autoEnabled: false,
      note: `merged ${PR} (--squash)`,
    });
    // Exactly one call: the immediate merge. We must NOT also run `--auto`.
    expect(calls).toEqual([['pr', 'merge', '--squash', PR]]);
    expect(calls.some((c) => c.includes('--auto'))).toBe(false);
  });

  it('falls back to native auto-merge when the immediate merge is blocked', async () => {
    // Branch protection: required checks still pending → immediate merge fails,
    // so we enable native auto-merge to let GitHub finish it later.
    const calls: string[][] = [];
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (!args.includes('--auto')) {
        throw new Error('Pull request is not mergeable: required status checks pending');
      }
      return { stdout: '', stderr: '' };
    });

    const outcome = await mergeOrEnableGithubAutoMerge(PR, runGh);

    expect(outcome.merged).toBe(false);
    expect(outcome.autoEnabled).toBe(true);
    expect(outcome.note).toContain('enabled GitHub native auto-merge');
    expect(calls).toEqual([
      ['pr', 'merge', '--squash', PR],
      ['pr', 'merge', '--auto', '--squash', PR],
    ]);
  });

  it('throws with both error details when neither merge nor auto-merge works', async () => {
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      throw new Error(args.includes('--auto') ? 'auto-merge not allowed' : 'not mergeable');
    });

    await expect(mergeOrEnableGithubAutoMerge(PR, runGh)).rejects.toThrow(
      /immediate=\[not mergeable\]; auto=\[auto-merge not allowed\]/,
    );
  });

  it('honors a non-default merge method on both the immediate and fallback paths', async () => {
    const calls: string[][] = [];
    const runGh: GhRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (!args.includes('--auto')) throw new Error('blocked');
      return { stdout: '', stderr: '' };
    });

    await mergeOrEnableGithubAutoMerge(PR, runGh, '--merge');

    expect(calls).toEqual([
      ['pr', 'merge', '--merge', PR],
      ['pr', 'merge', '--auto', '--merge', PR],
    ]);
  });
});
