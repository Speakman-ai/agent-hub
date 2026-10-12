import { describe, expect, it } from 'vitest';
import { blocksPrematureDoneMove, cardLinkedPrMerged } from './kanban-premature-done.js';
import type { Stmts } from './types.js';

type GuardStmts = Pick<Stmts, 'getSession' | 'getPushedFinalizeRunForSession'>;

function makeStmts(opts: {
  worktreePath?: string | null;
  sessionExists?: boolean;
  pushed?: boolean;
}): GuardStmts {
  return {
    getSession: {
      get: () =>
        opts.sessionExists === false
          ? undefined
          : {
              id: 's1',
              worktree_path: opts.worktreePath === undefined ? '/tmp/wt' : opts.worktreePath,
            },
    },
    getPushedFinalizeRunForSession: {
      get: () => (opts.pushed ? { status: 'pushed' } : undefined),
    },
  } as unknown as GuardStmts;
}

const linkedCard = { session_id: 's1' };

describe('blocksPrematureDoneMove', () => {
  it('blocks a Done move for a Finalize-gated session that has not pushed', () => {
    expect(
      blocksPrematureDoneMove({
        stmts: makeStmts({}),
        card: linkedCard,
        targetColumnName: 'Done',
        hasFinalizeCi: () => true,
      }),
    ).toBe(true);
  });

  it('matches renamed Done-ish columns (isColumnDone semantics)', () => {
    expect(
      blocksPrematureDoneMove({
        stmts: makeStmts({}),
        card: linkedCard,
        targetColumnName: 'Deployed / Done ✅',
        hasFinalizeCi: () => true,
      }),
    ).toBe(true);
  });

  it('force bypasses the guard', () => {
    expect(
      blocksPrematureDoneMove({
        stmts: makeStmts({}),
        card: linkedCard,
        targetColumnName: 'Done',
        force: true,
        hasFinalizeCi: () => true,
      }),
    ).toBe(false);
  });

  it('allows moves into non-Done columns (including Cancelled)', () => {
    for (const name of ['In Progress', 'To Do', 'Cancelled']) {
      expect(
        blocksPrematureDoneMove({
          stmts: makeStmts({}),
          card: linkedCard,
          targetColumnName: name,
          hasFinalizeCi: () => true,
        }),
      ).toBe(false);
    }
  });

  it('allows Done for unlinked cards', () => {
    expect(
      blocksPrematureDoneMove({
        stmts: makeStmts({}),
        card: { session_id: null },
        targetColumnName: 'Done',
        hasFinalizeCi: () => true,
      }),
    ).toBe(false);
  });

  it('allows Done when the linked session is gone or has no worktree', () => {
    expect(
      blocksPrematureDoneMove({
        stmts: makeStmts({ sessionExists: false }),
        card: linkedCard,
        targetColumnName: 'Done',
        hasFinalizeCi: () => true,
      }),
    ).toBe(false);
    expect(
      blocksPrematureDoneMove({
        stmts: makeStmts({ worktreePath: null }),
        card: linkedCard,
        targetColumnName: 'Done',
        hasFinalizeCi: () => true,
      }),
    ).toBe(false);
  });

  it('allows Done when the worktree is not Finalize-gated', () => {
    expect(
      blocksPrematureDoneMove({
        stmts: makeStmts({}),
        card: linkedCard,
        targetColumnName: 'Done',
        hasFinalizeCi: () => false,
      }),
    ).toBe(false);
  });

  it('allows Done once the session pushed through Finalize', () => {
    expect(
      blocksPrematureDoneMove({
        stmts: makeStmts({ pushed: true }),
        card: linkedCard,
        targetColumnName: 'Done',
        hasFinalizeCi: () => true,
      }),
    ).toBe(false);
  });

  it('allows Done when the linked native PR merged, even without a Finalize push', () => {
    const stmts = {
      ...makeStmts({}),
      getPullRequestByNumber: { get: () => ({ status: 'merged' }) },
    } as unknown as Parameters<typeof blocksPrematureDoneMove>[0]['stmts'];
    expect(
      blocksPrematureDoneMove({
        stmts,
        card: { session_id: 's1', pr_url: '/projects/st/pulls/1558' },
        targetColumnName: 'Done',
        hasFinalizeCi: () => true,
      }),
    ).toBe(false);
  });

  it('still blocks when the linked native PR is open', () => {
    const stmts = {
      ...makeStmts({}),
      getPullRequestByNumber: { get: () => ({ status: 'open' }) },
    } as unknown as Parameters<typeof blocksPrematureDoneMove>[0]['stmts'];
    expect(
      blocksPrematureDoneMove({
        stmts,
        card: { session_id: 's1', pr_url: '/projects/st/pulls/1558' },
        targetColumnName: 'Done',
        hasFinalizeCi: () => true,
      }),
    ).toBe(true);
  });
});

describe('cardLinkedPrMerged', () => {
  const lookup = (status: string | null) => {
    const calls: unknown[][] = [];
    const stmts = {
      getPullRequestByNumber: {
        get: (...args: unknown[]) => {
          calls.push(args);
          return status ? { status } : undefined;
        },
      },
    } as unknown as Parameters<typeof cardLinkedPrMerged>[0];
    return { stmts, calls };
  };

  it('looks up the native PR by project and number', () => {
    const { stmts, calls } = lookup('merged');
    expect(cardLinkedPrMerged(stmts, { pr_url: '/projects/surveytracker/pulls/1574' })).toBe(true);
    expect(calls).toEqual([['surveytracker', 1574]]);
  });

  it('is false for open, missing, GitHub, and absent PR links', () => {
    expect(cardLinkedPrMerged(lookup('open').stmts, { pr_url: '/projects/p/pulls/2' })).toBe(false);
    expect(cardLinkedPrMerged(lookup(null).stmts, { pr_url: '/projects/p/pulls/2' })).toBe(false);
    const gh = lookup('merged');
    expect(cardLinkedPrMerged(gh.stmts, { pr_url: 'https://github.com/o/r/pull/9' })).toBe(false);
    expect(gh.calls).toEqual([]);
    expect(cardLinkedPrMerged(lookup('merged').stmts, { pr_url: null })).toBe(false);
  });
});
