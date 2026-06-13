import { describe, it, expect, vi } from 'vitest';
import { autoMergeReadyPr, AUTO_MERGE_ACTOR, type NativePrMerger } from './auto-merge-ready-pr.js';
import type { GhRunner } from '../github-auto-merge.js';
import type { Project } from '../types.js';

const PROJECT = { id: 'agent-hub', gitHost: 'agenthub' } as unknown as Project;
const NATIVE_PR = '/projects/agent-hub/pulls/11';
const GITHUB_PR = 'https://github.com/acme/repo/pull/42';

function fakeGh(impl?: (args: string[]) => void): GhRunner {
  return vi.fn(async (args: string[]) => {
    impl?.(args);
    return { stdout: 'Merged', stderr: '' };
  });
}

describe('autoMergeReadyPr', () => {
  it('merges a native Hub PR in-process and never shells out to gh', async () => {
    // Regression: the old auto-merge always ran `gh pr merge`, which cannot
    // touch the Hub's bare repo, so native PRs sat open with checks green.
    const merge = vi.fn(async () => ({ ok: true as const, mergedSha: 'abcdef1234567890' }));
    const nativePr: NativePrMerger = { merge };
    const runGh = fakeGh();

    const result = await autoMergeReadyPr({ prUrl: NATIVE_PR, project: PROJECT, nativePr, runGh });

    expect(result).toEqual({
      source: 'agenthub',
      merged: true,
      note: `merged native PR ${NATIVE_PR} (squash) sha=abcdef123456`,
    });
    expect(merge).toHaveBeenCalledWith({
      project: PROJECT,
      number: 11,
      mergeMethod: 'squash',
      actor: AUTO_MERGE_ACTOR,
    });
    expect(runGh).not.toHaveBeenCalled();
  });

  it('merges a native PR without resolving GitHub creds (lazy runGh never invoked)', async () => {
    // Regression: a Hub-hosted project may have no GitHub repo/token. The
    // caller passes a lazy runGh that resolves credentials only when called;
    // for native PRs it must never be invoked, so a missing/failing GitHub
    // identity can't strand a green native PR. Modeled here as a runGh that
    // throws if touched.
    const merge = vi.fn(async () => ({ ok: true as const, mergedSha: 'feedface00000000' }));
    const runGh: GhRunner = vi.fn(async () => {
      throw new Error('no GitHub credentials configured');
    });

    const result = await autoMergeReadyPr({
      prUrl: NATIVE_PR,
      project: PROJECT,
      nativePr: { merge },
      runGh,
    });

    expect(result.source).toBe('agenthub');
    expect(result.merged).toBe(true);
    expect(runGh).not.toHaveBeenCalled();
  });

  it('maps an explicit --merge method to a native merge commit', async () => {
    const merge = vi.fn(async () => ({ ok: true as const, mergedSha: 'deadbeefcafe0000' }));
    await autoMergeReadyPr({
      prUrl: NATIVE_PR,
      project: PROJECT,
      nativePr: { merge },
      runGh: fakeGh(),
      method: '--merge',
    });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ mergeMethod: 'merge' }));
  });

  it('throws when a native PR has no NativePrService wired', async () => {
    await expect(
      autoMergeReadyPr({ prUrl: NATIVE_PR, project: PROJECT, nativePr: null, runGh: fakeGh() }),
    ).rejects.toThrow(/NativePrService is not wired/);
  });

  it('throws (for the caller to log) when the native merge is refused', async () => {
    const merge = vi.fn(async () => ({
      ok: false as const,
      status: 409,
      error: 'merge conflict: foo.ts',
    }));
    await expect(
      autoMergeReadyPr({
        prUrl: NATIVE_PR,
        project: PROJECT,
        nativePr: { merge },
        runGh: fakeGh(),
      }),
    ).rejects.toThrow(/native merge failed.*status 409.*merge conflict/);
  });

  it('routes a github.com PR through the gh merge path, not native', async () => {
    const calls: string[][] = [];
    const runGh = fakeGh((args) => calls.push(args));
    const merge = vi.fn();

    const result = await autoMergeReadyPr({
      prUrl: GITHUB_PR,
      project: { id: 'gh', gitHost: 'github' } as unknown as Project,
      nativePr: { merge },
      runGh,
    });

    expect(result.source).toBe('github');
    expect(result.merged).toBe(true);
    expect(merge).not.toHaveBeenCalled();
    expect(calls).toEqual([['pr', 'merge', '--squash', GITHUB_PR]]);
  });
});
