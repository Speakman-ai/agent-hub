/**
 * Integration tests for the Finalize rebase phase. We stub the bottom-most
 * I/O layer (`runGit`, `rebase`, `regenerateLockfile`, `dispatchAndWaitForTurnEnd`)
 * so the loop is deterministic, and verify:
 *
 *   - Clean rebase → `success`, phase set to `rebasing`, no dispatch.
 *   - Trivial conflict → resolver applied, `git add`/`git rebase --continue`
 *     spawned, loop retries and succeeds.
 *   - Non-trivial conflict → dispatch fires with the conflict body, the
 *     orchestrator awaits turn-end, then re-rebases on the next pass.
 *   - Budget exhaustion → terminal `timed_out`.
 *   - Dispatch with `userMessagePersisted = false` → terminal `failed`.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KanbanCardRow, Project } from '../types.js';
import type { RebaseOutcome } from '../pre-push-rebase.js';
import { buildConflictDispatchMessage, runRebasePhase } from './rebase.js';

interface FakeStmts {
  getFinalizeRun: { get: ReturnType<typeof vi.fn> };
  updateFinalizeRunPhase: { run: ReturnType<typeof vi.fn> };
  updateFinalizeRunActiveSeconds: { run: ReturnType<typeof vi.fn> };
  failFinalizeRun: { run: ReturnType<typeof vi.fn> };
}

function makeStmts(rowOverrides: Partial<{ session_id: string | null }> = {}): FakeStmts {
  return {
    getFinalizeRun: {
      get: vi.fn().mockReturnValue({ session_id: rowOverrides.session_id ?? 'sess-1' }),
    },
    updateFinalizeRunPhase: { run: vi.fn() },
    updateFinalizeRunActiveSeconds: { run: vi.fn() },
    failFinalizeRun: { run: vi.fn() },
  };
}

const fakeCard: KanbanCardRow = {
  id: 'card-1',
  column_id: 'col-1',
  board_id: 'board-1',
  title: 'Test card',
  description: '',
  priority: 'medium',
  assignee: 'agent-1',
  labels: '',
  session_id: 'sess-1',
  github_issue_url: null,
  pr_url: null,
  position: 0,
  created_by: 'user-1',
  assign_model: null,
  assign_engine: null,
  epic_id: null,
  pr_base_branch: null,
  documented: 0,
  autofix_dispatch_count: 0,
  last_dispatched_review_id: null,
  last_dispatched_check_run_id: null,
  last_dispatched_review_comment_id: null,
  review_status: null,
  created_at: '',
  updated_at: '',
} as unknown as KanbanCardRow;

const fakeProject: Project = { id: 'proj-1', name: 'p' } as Project;

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'finalize-rebase-'));
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('runRebasePhase — happy path', () => {
  it('clean rebase sets phase=rebase status=rebasing and exits success', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const rebase = vi
      .fn<(opts: unknown) => Promise<RebaseOutcome>>()
      .mockResolvedValue({ kind: 'rebased', commitsBehind: 1 });
    const dispatch = vi.fn();

    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast,
        dispatchAndWaitForTurnEnd: dispatch,
        rebase,
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.rebaseKind).toBe('rebased');
      expect(result.requiredFix).toBe(false);
    }
    expect(stmts.updateFinalizeRunPhase.run).toHaveBeenCalledWith('rebase', 'rebasing', 'run-1');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'finalize_run_phase_changed',
        run_id: 'run-1',
        phase: 'rebase',
        status: 'rebasing',
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(rebase).toHaveBeenCalledTimes(1);
  });

  it('noop rebase still reports success', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const rebase = vi.fn().mockResolvedValue({ kind: 'noop' });
    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast,
        dispatchAndWaitForTurnEnd: vi.fn(),
        rebase,
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.rebaseKind).toBe('noop');
    }
  });
});

describe('runRebasePhase — trivial conflict auto-resolved', () => {
  it('applies whitespace fix, git-adds, continues, then succeeds on re-rebase', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();

    // First rebase call (top-level) → conflict.
    // Second rebase call (re-rebase after fix) → success.
    const rebase = vi
      .fn<(opts: unknown) => Promise<RebaseOutcome>>()
      .mockResolvedValueOnce({ kind: 'conflict', detail: 'CONFLICT in foo.ts' })
      .mockResolvedValueOnce({ kind: 'rebased', commitsBehind: 1 });

    // Write a conflict file with a whitespace-only conflict.
    const conflictedRel = 'foo.ts';
    await fs.writeFile(
      path.join(tmpRoot, conflictedRel),
      ['<<<<<<< HEAD', '\tfoo', '=======', '    foo', '>>>>>>> z', ''].join('\n'),
      'utf8',
    );

    const runGit = vi.fn(async (args: string[]) => {
      // Reject the "re-issue rebase" inside attemptInlineConflictFix so the
      // conflict-listing branch runs. Other commands succeed.
      if (args[0] === 'rebase' && args[1] === 'origin/main') {
        throw new Error('CONFLICT');
      }
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: `${conflictedRel}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const dispatch = vi.fn();
    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast,
        dispatchAndWaitForTurnEnd: dispatch,
        rebase,
        runGit,
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.requiredFix).toBe(true);
    }
    expect(dispatch).not.toHaveBeenCalled();

    // File was rewritten to whitespace-resolved (ours' tab-foo).
    const after = await fs.readFile(path.join(tmpRoot, conflictedRel), 'utf8');
    expect(after).toContain('\tfoo');
    expect(after).not.toContain('<<<<<<<');

    // git add + git rebase --continue were spawned.
    const calls = runGit.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['add', '--', conflictedRel]),
        expect.arrayContaining(['rebase', '--continue']),
      ]),
    );
  });

  it('walks multi-commit conflicts: trivial conflict on commit #1 + trivial on commit #2', async () => {
    // Regression test for the bug where `git rebase --continue` exits
    // non-zero on a subsequent commit's conflict and the run aborts
    // instead of looping. We simulate two consecutive commit conflicts,
    // each trivially resolvable (whitespace), and assert the inner loop
    // walks both before reporting success.
    const stmts = makeStmts();
    const rebase = vi
      .fn<(opts: unknown) => Promise<RebaseOutcome>>()
      .mockResolvedValueOnce({ kind: 'conflict', detail: 'commit #1 conflict' })
      .mockResolvedValueOnce({ kind: 'rebased', commitsBehind: 2 });

    const relA = 'a.ts';
    const relB = 'b.ts';
    const wsConflict = ['<<<<<<< HEAD', '\tfoo', '=======', '    foo', '>>>>>>> z', ''].join('\n');
    await fs.writeFile(path.join(tmpRoot, relA), wsConflict, 'utf8');

    // Track the inner-loop state machine: how many `--continue` calls
    // have happened, and which file should be in conflict on each pass.
    let continueCalls = 0;
    let activeConflict: string | null = relA;

    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rebase' && args[1] === 'origin/main') {
        // The re-issued rebase fails with conflict #1.
        throw new Error('CONFLICT');
      }
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: activeConflict ? `${activeConflict}\n` : '', stderr: '' };
      }
      if (args.includes('--continue')) {
        continueCalls += 1;
        if (continueCalls === 1) {
          // First --continue → next commit conflicts on b.ts.
          activeConflict = relB;
          // Stage the new conflict file in the worktree.
          await fs.writeFile(path.join(tmpRoot, relB), wsConflict, 'utf8');
          throw new Error('CONFLICT');
        }
        // Second --continue → rebase finishes.
        activeConflict = null;
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const dispatch = vi.fn();
    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast: vi.fn(),
        dispatchAndWaitForTurnEnd: dispatch,
        rebase,
        runGit,
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.requiredFix).toBe(true);
    }
    // No dispatch — both conflicts were trivial, so the loop walked them
    // both without ever needing the agent.
    expect(dispatch).not.toHaveBeenCalled();
    // Both files were rewritten + git-added.
    const addCalls = runGit.mock.calls
      .map((c) => c[0])
      .filter((args) => args[0] === 'add')
      .map((args) => args[2]);
    expect(addCalls).toEqual(expect.arrayContaining([relA, relB]));
    // Two `--continue` invocations — one per commit conflict in the chain.
    expect(continueCalls).toBe(2);
  });

  it('regenerates package-lock.json via injected regenLock', async () => {
    const stmts = makeStmts();
    const rebase = vi
      .fn<(opts: unknown) => Promise<RebaseOutcome>>()
      .mockResolvedValueOnce({ kind: 'conflict', detail: 'lockfile conflict' })
      .mockResolvedValueOnce({ kind: 'rebased', commitsBehind: 1 });

    // Write the lockfile with conflict markers (body is ignored by the
    // lockfile branch — regeneration is authoritative).
    await fs.writeFile(
      path.join(tmpRoot, 'package-lock.json'),
      '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> z\n',
      'utf8',
    );

    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rebase' && args[1] === 'origin/main') {
        throw new Error('CONFLICT');
      }
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: 'package-lock.json\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const regen = vi.fn().mockResolvedValue({ ok: true });
    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast: vi.fn(),
        dispatchAndWaitForTurnEnd: vi.fn(),
        rebase,
        runGit,
        regenerateLockfile: regen,
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );

    expect(result.kind).toBe('success');
    expect(regen).toHaveBeenCalledTimes(1);
  });
});

describe('runRebasePhase — dispatch path', () => {
  it('dispatches conflict message to session, awaits turn-end, retries, succeeds', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();

    // First (outer) rebase → conflict. After the dispatch-and-wait turnaround,
    // the next outer rebase succeeds.
    const rebase = vi
      .fn<(opts: unknown) => Promise<RebaseOutcome>>()
      .mockResolvedValueOnce({ kind: 'conflict', detail: 'real conflict' })
      .mockResolvedValueOnce({ kind: 'rebased', commitsBehind: 1 });

    // Write a non-trivial conflict (semantic difference, not whitespace).
    const rel = 'src/math.ts';
    await fs.mkdir(path.join(tmpRoot, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, rel),
      [
        'export function add(a, b) {',
        '<<<<<<< HEAD',
        '  return a + b',
        '=======',
        '  return a * b',
        '>>>>>>> z',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rebase' && args[1] === 'origin/main') {
        throw new Error('CONFLICT');
      }
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
        return { stdout: `${rel}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    let dispatchResolved = false;
    const dispatch = vi.fn(async (args: { sessionId: string; cardId: string; body: string }) => {
      dispatchResolved = true;
      expect(args.sessionId).toBe('sess-1');
      expect(args.cardId).toBe('card-1');
      expect(args.body).toContain('rebase conflict needs your eyes');
      expect(args.body).toContain('src/math.ts');
      return { userMessagePersisted: true };
    });

    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast,
        dispatchAndWaitForTurnEnd: dispatch,
        rebase,
        runGit,
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );

    expect(dispatchResolved).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.requiredFix).toBe(true);
    }

    // The phase change to 'dispatching' was broadcast.
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'rebase',
        status: 'dispatching',
      }),
    );
    // Then back to 'rebasing' for the retry.
    const lastCall = broadcast.mock.calls.at(-1)?.[0] as { phase: string; status: string };
    expect(lastCall.phase).toBe('rebase');
    expect(lastCall.status).toBe('rebasing');
  });

  it('fails terminal when dispatch reports userMessagePersisted=false', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const rebase = vi
      .fn<(opts: unknown) => Promise<RebaseOutcome>>()
      .mockResolvedValueOnce({ kind: 'conflict', detail: 'real conflict' });

    const rel = 'a.ts';
    await fs.writeFile(
      path.join(tmpRoot, rel),
      ['<<<<<<< HEAD', 'one()', '=======', 'two()', '>>>>>>> z', ''].join('\n'),
      'utf8',
    );

    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rebase' && args[1] === 'origin/main') throw new Error('CONFLICT');
      if (args[0] === 'diff') return { stdout: `${rel}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const dispatch = vi.fn().mockResolvedValue({ userMessagePersisted: false });

    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast,
        dispatchAndWaitForTurnEnd: dispatch,
        rebase,
        runGit,
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('rebase_aborted');
    }
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'rebase_aborted', 'run-1');
  });
});

describe('runRebasePhase — budget exhaustion', () => {
  it('terminates with timed_out when active seconds exceed budget', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    // Always conflict; trivial fix path keeps looping. We cap budget tiny.
    const rebase = vi
      .fn<(opts: unknown) => Promise<RebaseOutcome>>()
      .mockResolvedValue({ kind: 'conflict', detail: 'loop' });

    const rel = 'ws.ts';
    await fs.writeFile(
      path.join(tmpRoot, rel),
      ['<<<<<<< HEAD', '\tfoo', '=======', '    foo', '>>>>>>> z', ''].join('\n'),
      'utf8',
    );

    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'rebase' && args[1] === 'origin/main') throw new Error('CONFLICT');
      if (args[0] === 'diff') return { stdout: `${rel}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    });

    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast,
        dispatchAndWaitForTurnEnd: vi.fn(),
        rebase,
        runGit,
        budgetSeconds: 10, // first pass bills 15s and trips the cap
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('timeout');
    }
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('timed_out', 'timeout', 'run-1');
  });
});

describe('runRebasePhase — guard rails', () => {
  it('fails fast when worktreePath missing AND emits no phantom phase event', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast,
        dispatchAndWaitForTurnEnd: vi.fn(),
        rebase: vi.fn(),
      },
      {
        runId: 'run-1',
        worktreePath: '',
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('no_worktree');
    }
    // No `rebasing` phase change should have hit the wire before the
    // guaranteed failure — the UI shouldn't render a phantom phase.
    expect(broadcast).not.toHaveBeenCalled();
    expect(stmts.updateFinalizeRunPhase.run).not.toHaveBeenCalled();
  });

  it('fails fast when baseBranch missing AND emits no phantom phase event', async () => {
    const stmts = makeStmts();
    const broadcast = vi.fn();
    const result = await runRebasePhase(
      {
        stmts: stmts as never,
        broadcast,
        dispatchAndWaitForTurnEnd: vi.fn(),
        rebase: vi.fn(),
      },
      {
        runId: 'run-1',
        worktreePath: tmpRoot,
        baseBranch: '',
        card: fakeCard,
        project: fakeProject,
      },
    );
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('unsafe_base_branch');
    }
    expect(broadcast).not.toHaveBeenCalled();
    expect(stmts.updateFinalizeRunPhase.run).not.toHaveBeenCalled();
  });
});

describe('buildConflictDispatchMessage', () => {
  it('includes file paths and base branch', () => {
    const body = buildConflictDispatchMessage(
      [
        {
          path: 'src/a.ts',
          hunks: [{ start: 0, end: 3, ours: ['o'], theirs: ['t'] }],
        },
      ],
      'main',
    );
    expect(body).toContain('src/a.ts');
    expect(body).toContain('origin/main');
    expect(body).toContain('1 hunk');
  });

  it('truncates display to 3 sample hunks per file with a more-suffix', () => {
    const hunks = Array.from({ length: 5 }, (_, i) => ({
      start: i,
      end: i + 2,
      ours: [`o${i}`],
      theirs: [`t${i}`],
    }));
    const body = buildConflictDispatchMessage([{ path: 'x.ts', hunks }], 'main');
    expect(body).toContain('and 2 more hunk');
    // Only 3 sample blocks rendered.
    expect(body.match(/Hunk \d+/g)?.length).toBe(3);
  });
});
