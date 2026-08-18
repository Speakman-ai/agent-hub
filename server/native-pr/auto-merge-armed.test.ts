import '../test/setup.js';
import { describe, it, expect, vi } from 'vitest';
import { tryAutoMergeArmedNativePr, NATIVE_AUTO_MERGE_ACTOR } from './auto-merge-armed.js';
import type { Stmts } from '../types.js';
import type { NativePrService } from './service.js';

const project = { id: 'proj', gitHost: 'agenthub' } as any;

function deps(row: any, mergeImpl: any) {
  const stmts = {
    getPullRequestByNumber: { get: vi.fn().mockReturnValue(row) },
  } as unknown as Stmts;
  const nativePr = { merge: vi.fn(mergeImpl) } as unknown as NativePrService;
  return { stmts, nativePr };
}

describe('tryAutoMergeArmedNativePr', () => {
  it('no-ops when the PR is missing, not open, or not armed', async () => {
    for (const row of [
      undefined,
      { number: 1, status: 'merged', auto_merge: 1 },
      { number: 1, status: 'open', auto_merge: 0 },
    ]) {
      const d = deps(row, () => ({ ok: true, mergedSha: 'x' }));
      const out = await tryAutoMergeArmedNativePr(d, { project, number: 1 });
      expect(out.merged).toBe(false);
      expect(d.nativePr.merge).not.toHaveBeenCalled();
    }
  });

  it('merges an armed open PR with the auto-merge actor (squash)', async () => {
    const d = deps({ number: 7, status: 'open', auto_merge: 1 }, () => ({
      ok: true,
      mergedSha: 'abc',
    }));
    const out = await tryAutoMergeArmedNativePr(d, { project, number: 7 });
    expect(out.merged).toBe(true);
    expect(d.nativePr.merge).toHaveBeenCalledWith({
      project,
      number: 7,
      mergeMethod: 'squash',
      actor: NATIVE_AUTO_MERGE_ACTOR,
    });
  });

  it('stays unmerged (with the block reason) when merge is not yet allowed', async () => {
    const d = deps({ number: 3, status: 'open', auto_merge: 1 }, () => ({
      ok: false,
      status: 409,
      error: 'Branch protection: an approving review is required to merge.',
    }));
    const out = await tryAutoMergeArmedNativePr(d, { project, number: 3 });
    expect(out.merged).toBe(false);
    expect(out.reason).toMatch(/approving review/);
  });
});
