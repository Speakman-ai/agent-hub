import { describe, expect, it } from 'vitest';
import { blocksPrematureDoneMove } from './kanban-premature-done.js';
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
});
