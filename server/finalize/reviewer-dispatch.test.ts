/**
 * Integration tests for the Finalize reviewer-dispatch helper. We stub
 * the reviewer driver + git spawn so the loop is deterministic, and
 * verify:
 *
 *   - Approved with zero threads → verdict written, no thread inserts,
 *     no `reviewer_thread_added` broadcasts.
 *   - Changes-requested with N threads → all N persisted, verdict set,
 *     one event per row, dispatch-body formatter renders them inline.
 *   - Driver failure → terminal `failed` with `failureReason = 'review_failed'`.
 *   - Missing worktree → terminal without invoking the driver.
 *   - Re-entry wipes previous threads (loop invariant: review reflects
 *     current pass only).
 *   - `collectLocalDiffInputs` calls git rev-parse + diff with the
 *     expected args and parses the output.
 *   - Threads inputs are sanitised (blank body dropped, line coercion,
 *     hard cap on count, body truncation).
 *   - Local-diff prompt builder includes the diff body verbatim and the
 *     severity rubric.
 *
 * No real CLI binaries are spawned — every git call is injected via the
 * `runGit` dep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KanbanCardRow, Project, ReviewerThreadRow } from '../types.js';
import {
  REVIEWER_THREAD_HARD_CAP,
  REVIEWER_THREAD_BODY_LIMIT,
  REVIEW_PHASE_ACTIVE_SECONDS,
  buildLocalDiffReviewerPrompt,
  collectLocalDiffInputs,
  formatThreadsForDispatchBody,
  runReviewerDispatch,
  type ReviewerDispatchDeps,
  type ReviewerLocalDiffInputs,
  type ReviewerRunResult,
} from './reviewer-dispatch.js';

interface FakeStmts {
  getFinalizeRun: { get: ReturnType<typeof vi.fn> };
  updateFinalizeRunPhase: { run: ReturnType<typeof vi.fn> };
  updateFinalizeRunActiveSeconds: { run: ReturnType<typeof vi.fn> };
  updateFinalizeRunReviewerVerdict: { run: ReturnType<typeof vi.fn> };
  insertReviewerThread: { run: ReturnType<typeof vi.fn> };
  deleteReviewerThreadsForRun: { run: ReturnType<typeof vi.fn> };
  failFinalizeRun: { run: ReturnType<typeof vi.fn> };
}

interface ThreadStoreState {
  rows: ReviewerThreadRow[];
}

function makeStmts(store?: ThreadStoreState): FakeStmts {
  const inMemory = store ?? { rows: [] };
  return {
    getFinalizeRun: { get: vi.fn().mockReturnValue({ session_id: 'sess-1' }) },
    updateFinalizeRunPhase: { run: vi.fn() },
    updateFinalizeRunActiveSeconds: { run: vi.fn() },
    updateFinalizeRunReviewerVerdict: { run: vi.fn() },
    insertReviewerThread: {
      run: vi.fn(
        (
          id: string,
          run_id: string,
          file_path: string,
          line_start: number | null,
          line_end: number | null,
          body: string,
          author: string,
          created_at: number,
        ) => {
          inMemory.rows.push({
            id,
            run_id,
            file_path,
            line_start,
            line_end,
            body,
            author,
            created_at,
          });
        },
      ),
    },
    deleteReviewerThreadsForRun: {
      run: vi.fn((runId: string) => {
        inMemory.rows = inMemory.rows.filter((r) => r.run_id !== runId);
      }),
    },
    failFinalizeRun: { run: vi.fn() },
  };
}

const fakeCard: KanbanCardRow = {
  id: 'card-1',
  column_id: 'col-1',
  board_id: 'board-1',
  title: 'Wire reviewer dispatch',
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

const fakeProject: Project = { id: 'proj-1', name: 'agent-hub' } as Project;

const fakeInputs: ReviewerLocalDiffInputs = {
  baseSha: 'aaa1111',
  headSha: 'bbb2222',
  changedFiles: ['server/foo.ts', 'server/bar.ts'],
  unifiedDiff: 'diff --git a/server/foo.ts b/server/foo.ts\n+const x = 1;\n',
};

let idCounter = 0;
beforeEach(() => {
  idCounter = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeDeps(
  store: ThreadStoreState,
  runner: ReviewerDispatchDeps['runReviewer'],
  broadcast: ReturnType<typeof vi.fn>,
): { deps: ReviewerDispatchDeps; stmts: FakeStmts } {
  const stmts = makeStmts(store);
  const deps: ReviewerDispatchDeps = {
    stmts: stmts as never,
    broadcast: broadcast as unknown as ReviewerDispatchDeps['broadcast'],
    runReviewer: runner,
    // Production wires a real `db.transaction(...)` here. The
    // identity wrapper is sufficient for tests because FakeStmts are
    // deterministic and don't simulate crashes mid-transaction.
    // Required: `defaultTransactional` throws to refuse silent
    // atomicity loss, so every caller (including this test harness)
    // MUST inject a wrapper.
    transactional: <T>(fn: () => T): T => fn(),
    now: () => 1_700_000_000_000,
    newId: () => `thr-${++idCounter}`,
  };
  return { deps, stmts };
}

describe('runReviewerDispatch — approved verdict, no threads', () => {
  it('writes verdict, inserts no rows, emits no thread events', async () => {
    const store: ThreadStoreState = { rows: [] };
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>().mockResolvedValue({
      verdict: 'approved',
      threads: [],
    });
    const broadcast = vi.fn();
    const { deps, stmts } = makeDeps(store, runner, broadcast);

    const outcome = await runReviewerDispatch(deps, {
      runId: 'run-1',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });

    expect(outcome).toEqual({
      kind: 'success',
      verdict: 'approved',
      threadCount: 0,
      activeSecondsBilled: REVIEW_PHASE_ACTIVE_SECONDS,
    });
    expect(stmts.updateFinalizeRunPhase.run).toHaveBeenCalledWith('review', 'reviewing', 'run-1');
    expect(stmts.updateFinalizeRunReviewerVerdict.run).toHaveBeenCalledWith('approved', 'run-1');
    expect(stmts.insertReviewerThread.run).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);

    // Phase event always fires; thread events never fire when threads is empty.
    const events = broadcast.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(events.some((e) => e.type === 'finalize_run_phase_changed')).toBe(true);
    expect(events.some((e) => e.type === 'reviewer_thread_added')).toBe(false);
  });
});

describe('runReviewerDispatch — changes_requested with threads', () => {
  it('persists every thread + verdict, broadcasts one event per row', async () => {
    const store: ThreadStoreState = { rows: [] };
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>().mockResolvedValue({
      verdict: 'changes_requested',
      threads: [
        {
          file_path: 'server/foo.ts',
          line_start: 42,
          line_end: 45,
          body: '**[6/10]** Race on config.bin — overlapping writes.',
        },
        {
          file_path: 'server/bar.ts',
          line_start: 10,
          line_end: 10,
          body: '**[4/10]** Missing null guard.',
        },
        {
          file_path: 'README.md',
          line_start: null,
          line_end: null,
          body: '**[2/10]** Nit: stale link.',
        },
      ],
    });
    const broadcast = vi.fn();
    const { deps, stmts } = makeDeps(store, runner, broadcast);

    const outcome = await runReviewerDispatch(deps, {
      runId: 'run-2',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') throw new Error('unreachable');
    expect(outcome.verdict).toBe('changes_requested');
    expect(outcome.threadCount).toBe(3);

    expect(stmts.deleteReviewerThreadsForRun.run).toHaveBeenCalledWith('run-2');
    expect(stmts.insertReviewerThread.run).toHaveBeenCalledTimes(3);
    expect(stmts.updateFinalizeRunReviewerVerdict.run).toHaveBeenCalledWith(
      'changes_requested',
      'run-2',
    );
    expect(stmts.updateFinalizeRunActiveSeconds.run).toHaveBeenCalledWith(
      REVIEW_PHASE_ACTIVE_SECONDS,
      'run-2',
    );

    // Every persisted row carries the run id + reviewer-agent author.
    expect(store.rows).toHaveLength(3);
    for (const row of store.rows) {
      expect(row.run_id).toBe('run-2');
      expect(row.author).toBe('reviewer-agent');
      expect(row.created_at).toBe(1_700_000_000_000);
    }
    expect(store.rows[2]?.line_start).toBeNull();
    expect(store.rows[2]?.line_end).toBeNull();

    // One reviewer_thread_added event per row, after the COMMIT.
    const threadEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'reviewer_thread_added');
    expect(threadEvents).toHaveLength(3);
    expect(threadEvents[0]).toMatchObject({
      run_id: 'run-2',
      thread_id: 'thr-1',
      file_path: 'server/foo.ts',
      line_start: 42,
    });
    expect(threadEvents[2]).toMatchObject({
      run_id: 'run-2',
      file_path: 'README.md',
      line_start: null,
    });

    // Dispatch-body formatter consumes the persisted rows verbatim
    // (per card 490d6c41 — reviewer notes flow into the fix message).
    const body = formatThreadsForDispatchBody(store.rows);
    expect(body).toContain('Reviewer notes:');
    expect(body).toContain('server/foo.ts:42-45');
    expect(body).toContain('server/bar.ts:10');
    expect(body).toContain('README.md ');
    expect(body).toContain('Race on config.bin');
  });
});

describe('runReviewerDispatch — orchestrator reads back persisted state', () => {
  it('downstream reads see the verdict + threads written this pass', async () => {
    const store: ThreadStoreState = { rows: [] };
    const reviewerVerdict = { current: null as string | null };
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>().mockResolvedValue({
      verdict: 'changes_requested',
      threads: [
        {
          file_path: 'server/x.ts',
          line_start: 1,
          line_end: 1,
          body: '**[7/10]** Real bug.',
        },
      ],
    });
    const broadcast = vi.fn();
    const { deps, stmts } = makeDeps(store, runner, broadcast);
    // Wire the verdict statement into a fake row store so an orchestrator
    // read-back through `getFinalizeRun` reflects what we wrote.
    stmts.updateFinalizeRunReviewerVerdict.run.mockImplementation((v: string) => {
      reviewerVerdict.current = v;
    });
    stmts.getFinalizeRun.get.mockImplementation(() => ({
      session_id: 'sess-1',
      reviewer_verdict: reviewerVerdict.current,
    }));

    await runReviewerDispatch(deps, {
      runId: 'run-r',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });

    // Orchestrator-style read-back: row carries verdict, store has the threads.
    const readBack = (stmts.getFinalizeRun.get as (id: string) => { reviewer_verdict: string })(
      'run-r',
    );
    expect(readBack.reviewer_verdict).toBe('changes_requested');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.file_path).toBe('server/x.ts');
  });
});

describe('runReviewerDispatch — re-entry wipes previous threads', () => {
  it('a fresh dispatch deletes the prior pass before inserting new rows', async () => {
    const store: ThreadStoreState = { rows: [] };
    let nextResult: ReviewerRunResult = {
      verdict: 'changes_requested',
      threads: [
        { file_path: 'a.ts', line_start: 1, line_end: 1, body: 'old' },
        { file_path: 'b.ts', line_start: 2, line_end: 2, body: 'old' },
      ],
    };
    const runner = vi
      .fn<ReviewerDispatchDeps['runReviewer']>()
      .mockImplementation(() => Promise.resolve(nextResult));
    const broadcast = vi.fn();
    const { deps } = makeDeps(store, runner, broadcast);

    await runReviewerDispatch(deps, {
      runId: 'run-3',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });
    expect(store.rows.map((r) => r.body)).toEqual(['old', 'old']);

    // Second pass: agent fixed everything, reviewer returns one new note.
    nextResult = {
      verdict: 'approved',
      threads: [{ file_path: 'a.ts', line_start: 1, line_end: 1, body: 'new' }],
    };
    await runReviewerDispatch(deps, {
      runId: 'run-3',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });

    // Prior 'old' rows tied to run-3 are gone; only the fresh 'new' row remains.
    expect(store.rows.filter((r) => r.run_id === 'run-3').map((r) => r.body)).toEqual(['new']);
  });
});

describe('runReviewerDispatch — driver failure', () => {
  it('surfaces review_failed when the reviewer driver throws', async () => {
    const store: ThreadStoreState = { rows: [] };
    const runner = vi
      .fn<ReviewerDispatchDeps['runReviewer']>()
      .mockRejectedValue(new Error('engine refused: model overloaded'));
    const broadcast = vi.fn();
    const { deps, stmts } = makeDeps(store, runner, broadcast);

    const outcome = await runReviewerDispatch(deps, {
      runId: 'run-4',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('unreachable');
    expect(outcome.failureReason).toBe('review_failed');
    expect(outcome.detail).toContain('engine refused');
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'review_failed', 'run-4');
    expect(stmts.insertReviewerThread.run).not.toHaveBeenCalled();
    expect(stmts.updateFinalizeRunReviewerVerdict.run).not.toHaveBeenCalled();

    // The reviewer-failure path fires AFTER setPhase has emitted
    // `reviewing`; subscribers must also see the corrective `failed`
    // event so the UI's checks spinner clears.
    const phaseEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_phase_changed');
    expect(phaseEvents).toEqual([
      { type: 'finalize_run_phase_changed', run_id: 'run-4', phase: 'review', status: 'reviewing' },
      {
        type: 'finalize_run_phase_changed',
        run_id: 'run-4',
        phase: 'review',
        status: 'failed',
        failure_reason: 'review_failed',
      },
    ]);
  });
});

describe('runReviewerDispatch — guard-rails', () => {
  it('rejects missing worktree without invoking the driver', async () => {
    const store: ThreadStoreState = { rows: [] };
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>();
    const broadcast = vi.fn();
    const { deps, stmts } = makeDeps(store, runner, broadcast);

    const outcome = await runReviewerDispatch(deps, {
      runId: 'run-5',
      worktreePath: '',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });

    expect(outcome).toMatchObject({ kind: 'failed', failureReason: 'no_worktree' });
    expect(runner).not.toHaveBeenCalled();
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'no_worktree', 'run-5');
    expect(stmts.updateFinalizeRunPhase.run).not.toHaveBeenCalled();

    // The no-worktree path fires before any setPhase, but we still
    // emit a terminal phase event so a late-joining subscriber sees
    // the run finished (instead of polling for status forever).
    const phaseEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_phase_changed');
    expect(phaseEvents).toEqual([
      {
        type: 'finalize_run_phase_changed',
        run_id: 'run-5',
        phase: 'review',
        status: 'failed',
        failure_reason: 'no_worktree',
      },
    ]);
  });

  it('rejects missing diff inputs when no baseBranch is provided', async () => {
    const store: ThreadStoreState = { rows: [] };
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>();
    const broadcast = vi.fn();
    const { deps, stmts } = makeDeps(store, runner, broadcast);

    const outcome = await runReviewerDispatch(deps, {
      runId: 'run-6',
      worktreePath: '/tmp/wt',
      card: fakeCard,
      project: fakeProject,
    });

    expect(outcome).toMatchObject({ kind: 'failed', failureReason: 'no_diff_inputs' });
    expect(runner).not.toHaveBeenCalled();
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('failed', 'no_diff_inputs', 'run-6');

    // setPhase fired for `reviewing` before the guard rail; check that
    // the `failed` correction also fired so the UI's spinner clears.
    const phaseEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_phase_changed');
    expect(phaseEvents.map((e) => e.status)).toEqual(['reviewing', 'failed']);
    expect(phaseEvents.at(-1)).toMatchObject({
      status: 'failed',
      failure_reason: 'no_diff_inputs',
    });
  });
});

describe('runReviewerDispatch — defaultTransactional', () => {
  it('throws when no transactional wrapper is injected, refusing silent atomicity loss', async () => {
    const store: ThreadStoreState = { rows: [] };
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>().mockResolvedValue({
      verdict: 'approved',
      threads: [],
    });
    const broadcast = vi.fn();
    const stmts = makeStmts(store);
    // Note: deliberately omit `transactional` to exercise the
    // production-guard fallback. The helper must throw rather than
    // run inserts + verdict update outside any transaction.
    const deps: ReviewerDispatchDeps = {
      stmts: stmts as never,
      broadcast: broadcast as unknown as ReviewerDispatchDeps['broadcast'],
      runReviewer: runner,
      now: () => 1_700_000_000_000,
      newId: () => `thr-${++idCounter}`,
    };
    await expect(
      runReviewerDispatch(deps, {
        runId: 'run-tx',
        worktreePath: '/tmp/wt',
        inputs: fakeInputs,
        card: fakeCard,
        project: fakeProject,
      }),
    ).rejects.toThrow(/transactional/i);
  });
});

describe('runReviewerDispatch — sanitisation', () => {
  it('drops blank-body threads, coerces invalid line numbers, caps body length', async () => {
    const store: ThreadStoreState = { rows: [] };
    const longBody = 'x'.repeat(REVIEWER_THREAD_BODY_LIMIT + 100);
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>().mockResolvedValue({
      verdict: 'changes_requested',
      threads: [
        // Kept, coerced
        {
          file_path: 'a.ts',
          line_start: 0 as unknown as number,
          line_end: -5 as unknown as number,
          body: '**[5/10]** invalid lines',
        },
        // Dropped (blank body)
        { file_path: 'b.ts', line_start: 1, line_end: 1, body: '   ' },
        // Dropped (blank path)
        { file_path: '', line_start: 1, line_end: 1, body: 'no path' },
        // Truncated body
        { file_path: 'c.ts', line_start: 99, line_end: 99, body: longBody },
      ],
    });
    const broadcast = vi.fn();
    const { deps } = makeDeps(store, runner, broadcast);

    const outcome = await runReviewerDispatch(deps, {
      runId: 'run-7',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });

    expect(outcome.kind).toBe('success');
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]).toMatchObject({
      file_path: 'a.ts',
      line_start: null,
      line_end: null,
    });
    expect(store.rows[1]?.file_path).toBe('c.ts');
    expect(store.rows[1]?.body.length).toBeLessThanOrEqual(REVIEWER_THREAD_BODY_LIMIT + 64);
    expect(store.rows[1]?.body).toContain('chars truncated');
  });

  it('caps the number of threads at REVIEWER_THREAD_HARD_CAP', async () => {
    const store: ThreadStoreState = { rows: [] };
    const tooMany = Array.from({ length: REVIEWER_THREAD_HARD_CAP + 25 }, (_, i) => ({
      file_path: `f${i}.ts`,
      line_start: 1,
      line_end: 1,
      body: `**[2/10]** nit ${i}`,
    }));
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>().mockResolvedValue({
      verdict: 'changes_requested',
      threads: tooMany,
    });
    const broadcast = vi.fn();
    const { deps } = makeDeps(store, runner, broadcast);

    await runReviewerDispatch(deps, {
      runId: 'run-8',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });
    expect(store.rows).toHaveLength(REVIEWER_THREAD_HARD_CAP);
  });
});

describe('runReviewerDispatch — bills custom active-seconds', () => {
  it('honors driver-reported active-seconds when present', async () => {
    const store: ThreadStoreState = { rows: [] };
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>().mockResolvedValue({
      verdict: 'approved',
      threads: [],
      activeSecondsBilled: 17,
    });
    const broadcast = vi.fn();
    const { deps, stmts } = makeDeps(store, runner, broadcast);

    const outcome = await runReviewerDispatch(deps, {
      runId: 'run-9',
      worktreePath: '/tmp/wt',
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });
    if (outcome.kind !== 'success') throw new Error('unreachable');
    expect(outcome.activeSecondsBilled).toBe(17);
    expect(stmts.updateFinalizeRunActiveSeconds.run).toHaveBeenCalledWith(17, 'run-9');
  });
});

describe('collectLocalDiffInputs', () => {
  it('runs the expected git invocations and returns SHAs + file list + diff', async () => {
    const runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') {
        return Promise.resolve({ stdout: 'aaa1111\n', stderr: '' });
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return Promise.resolve({ stdout: 'bbb2222\n', stderr: '' });
      }
      if (args[0] === 'diff' && args[1] === '--name-only') {
        expect(args[2]).toBe('aaa1111..bbb2222');
        return Promise.resolve({ stdout: 'a.ts\nb.ts\n\n', stderr: '' });
      }
      if (args[0] === 'diff') {
        expect(args[1]).toBe('aaa1111..bbb2222');
        return Promise.resolve({ stdout: 'diff body\n', stderr: '' });
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    });

    const result = await collectLocalDiffInputs({
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      runGit,
    });

    expect(result).toEqual({
      baseSha: 'aaa1111',
      headSha: 'bbb2222',
      changedFiles: ['a.ts', 'b.ts'],
      unifiedDiff: 'diff body\n',
    });
    expect(runGit).toHaveBeenCalledTimes(4);
  });

  it('throws when SHA resolution returns empty output', async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    await expect(
      collectLocalDiffInputs({ worktreePath: '/tmp/wt', baseBranch: 'main', runGit }),
    ).rejects.toThrow(/failed to resolve base\/head SHA/);
  });

  it('dispatch surfaces no_diff_inputs when git fails and no inputs were pre-computed', async () => {
    const store: ThreadStoreState = { rows: [] };
    const runner = vi.fn<ReviewerDispatchDeps['runReviewer']>();
    const broadcast = vi.fn();
    const { deps } = makeDeps(store, runner, broadcast);
    const failingGit = vi
      .fn<NonNullable<ReviewerDispatchDeps['runGit']>>()
      .mockRejectedValue(new Error('fatal: ambiguous argument'));

    const outcome = await runReviewerDispatch(
      { ...deps, runGit: failingGit },
      {
        runId: 'run-10',
        worktreePath: '/tmp/wt',
        baseBranch: 'main',
        card: fakeCard,
        project: fakeProject,
      },
    );
    expect(outcome).toMatchObject({
      kind: 'failed',
      failureReason: 'no_diff_inputs',
    });
    expect(runner).not.toHaveBeenCalled();

    // setPhase fired before the git spawn; the terminate path must
    // emit a corrective `failed` event to clear the spinner.
    const phaseEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_phase_changed');
    expect(phaseEvents.map((e) => e.status)).toEqual(['reviewing', 'failed']);
    expect(phaseEvents.at(-1)).toMatchObject({
      status: 'failed',
      failure_reason: 'no_diff_inputs',
    });
  });
});

describe('buildLocalDiffReviewerPrompt', () => {
  it('embeds the diff verbatim and forbids GitHub API calls', () => {
    const prompt = buildLocalDiffReviewerPrompt({
      inputs: fakeInputs,
      card: fakeCard,
      project: fakeProject,
    });
    expect(prompt).toContain('Pre-PR Code Review (Local Diff)');
    expect(prompt).toContain('No GitHub PR exists yet');
    expect(prompt).toContain('Do NOT call');
    expect(prompt).toContain(fakeInputs.baseSha);
    expect(prompt).toContain(fakeInputs.headSha);
    expect(prompt).toContain('server/foo.ts');
    expect(prompt).toContain('server/bar.ts');
    expect(prompt).toContain(fakeInputs.unifiedDiff.trim().split('\n')[0]);
    expect(prompt).toContain('Severity rubric');
    expect(prompt).toContain('"verdict": "approved" | "changes_requested"');
  });

  it('handles empty file list without crashing', () => {
    const prompt = buildLocalDiffReviewerPrompt({
      inputs: { ...fakeInputs, changedFiles: [], unifiedDiff: '' },
      card: fakeCard,
      project: fakeProject,
    });
    expect(prompt).toContain('_(no files changed)_');
  });
});

describe('formatThreadsForDispatchBody', () => {
  it('returns empty string when there are no threads', () => {
    expect(formatThreadsForDispatchBody([])).toBe('');
  });

  it('renders single-line, range, and file-level anchors distinctly', () => {
    const rows: ReviewerThreadRow[] = [
      {
        id: '1',
        run_id: 'r',
        file_path: 'a.ts',
        line_start: 10,
        line_end: 10,
        body: 'single',
        author: 'reviewer-agent',
        created_at: 0,
      },
      {
        id: '2',
        run_id: 'r',
        file_path: 'b.ts',
        line_start: 5,
        line_end: 12,
        body: 'range',
        author: 'reviewer-agent',
        created_at: 0,
      },
      {
        id: '3',
        run_id: 'r',
        file_path: 'c.md',
        line_start: null,
        line_end: null,
        body: 'file-level',
        author: 'reviewer-agent',
        created_at: 0,
      },
    ];
    const body = formatThreadsForDispatchBody(rows);
    expect(body).toContain('a.ts:10 — single');
    expect(body).toContain('b.ts:5-12 — range');
    expect(body).toContain('c.md — file-level');
  });
});
