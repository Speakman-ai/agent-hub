/**
 * Tests for the Finalize Code Changes orchestrator state machine.
 *
 * The orchestrator wires the four phase modules together; here we stub
 * every phase runner so the loop is deterministic. Each test exercises a
 * specific transition the state machine guarantees:
 *
 *   - Happy path: rebase → parse → review → tasks → push gate → push.
 *   - Rebase conflict: phase reports a dispatched conflict that resolves
 *     on the second outer pass (via the shared dispatchAndWaitForTurnEnd
 *     dep) — the orchestrator does not need to handle conflicts itself
 *     because the rebase phase swallows that flow internally.
 *   - Failed step: fix-dispatch fires, turn-end resolves, loop re-enters.
 *   - Reviewer requests changes: same fix-dispatch loop, no failed step.
 *   - Push gate refuses on a new HEAD: resolveHeadSha returns a different
 *     sha; orchestrator re-enters rebase rather than pushing.
 *   - Cancellation mid-run: cancel signal abort during the fix-dispatch
 *     wait resolves the whole run as cancelled.
 *   - Idempotency: a second call with the same (project, branch, head_sha)
 *     returns the existing row without re-running.
 *   - Stalled (live mode): the stall watchdog terminal is propagated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { FinalizeRunRow, KanbanCardRow, Project, ReviewerThreadRow } from '../types.js';
import {
  computeIdempotencyKey,
  runFinalize,
  setReadyToPushAutomationHook,
  __test,
  type OrchestratorDeps,
  type OrchestratorOptions,
  type PushAndCreatePrResult,
} from './orchestrator.js';
import type { RebasePhaseOutcome } from './rebase.js';
import type { ReviewerDispatchOutcome } from './reviewer-dispatch.js';
import type { StepRunResult } from './step-runner.js';
import type { FixDispatchResult } from './fix-dispatch.js';
import type { CardLifecycle } from './card-lifecycle.js';
import { createFinalizeRunSignal } from './run-abort-registry.js';

// ─── Fixtures ────────────────────────────────────────────────────────

const fakeCard: KanbanCardRow = {
  id: 'card-1',
  column_id: 'col-1',
  board_id: 'board-1',
  title: 'Finalize me',
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
  dispatched_by_autonomous: 0,
  review_status: null,
} as unknown as KanbanCardRow;

const fakeProject: Project = { id: 'proj-1', name: 'p' } as Project;

const baseOpts = (overrides: Partial<OrchestratorOptions> = {}): OrchestratorOptions => ({
  card: fakeCard,
  project: fakeProject,
  branch: 'feature/x',
  headSha: 'deadbeefcafebabe',
  baseBranch: 'main',
  worktreePath: '/tmp/wt',
  sessionId: 'sess-1',
  triggerSource: 'ui_button',
  triggeredByUserId: 'user-1',
  authorName: 'Test',
  authorEmail: 'test@example.com',
  env: undefined,
  ...overrides,
});

// ─── Fake DB ─────────────────────────────────────────────────────────

interface FakeRow extends Partial<FinalizeRunRow> {
  id: string;
  idempotency_key: string;
}

/**
 * Mirror of the per-phase pickers (`getLatestChecksRunForSession` /
 * `getLatestReviewRunForSession`): latest row for `sessionId` whose `mode`
 * is in `modes`, ordered by `started_at DESC, id DESC`.
 */
function latestRunForModes(
  rows: Map<string, FakeRow>,
  sessionId: string,
  modes: string[],
): FakeRow | undefined {
  const matches = [...rows.values()].filter(
    (r) => r.session_id === sessionId && r.mode != null && modes.includes(r.mode),
  );
  matches.sort((a, b) => {
    const sa = a.started_at ?? 0;
    const sb = b.started_at ?? 0;
    if (sb !== sa) return sb - sa;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return matches[0];
}

function makeStmts(): {
  stmts: OrchestratorDeps['stmts'];
  rows: Map<string, FakeRow>;
  byKey: Map<string, FakeRow>;
  threads: ReviewerThreadRow[];
  /** spy on phase writes */
  phaseCalls: Array<{ phase: string | null; status: string }>;
  /** spy on failFinalizeRun */
  failCalls: Array<{ status: string; reason: string; id: string }>;
} {
  const rows = new Map<string, FakeRow>();
  const byKey = new Map<string, FakeRow>();
  const threads: ReviewerThreadRow[] = [];
  const phaseCalls: Array<{ phase: string | null; status: string }> = [];
  const failCalls: Array<{ status: string; reason: string; id: string }> = [];

  const stmts: OrchestratorDeps['stmts'] = {
    getFinalizeRun: {
      get: vi.fn((id: string) => rows.get(id)),
    } as unknown as OrchestratorDeps['stmts']['getFinalizeRun'],
    getFinalizeRunByIdempotencyKey: {
      get: vi.fn((key: string) => byKey.get(key)),
    } as unknown as OrchestratorDeps['stmts']['getFinalizeRunByIdempotencyKey'],
    insertFinalizeRun: {
      run: vi.fn(
        (
          id: string,
          cardId: string,
          sessionId: string | null,
          projectId: string,
          branch: string,
          headSha: string,
          idempotencyKey: string,
          status: string,
          phase: string | null,
          triggerSource: string,
          worktreePath: string | null,
          triggeredByUserId: string,
          authorName: string,
          authorEmail: string,
          retryOfRunId: string | null,
          startedAt: number,
          mode?: string,
        ) => {
          if (byKey.has(idempotencyKey)) {
            const err = new Error('UNIQUE constraint failed: finalize_runs.idempotency_key');
            (err as unknown as { code: string }).code = 'SQLITE_CONSTRAINT_UNIQUE';
            throw err;
          }
          const row: FakeRow = {
            id,
            card_id: cardId,
            session_id: sessionId,
            project_id: projectId,
            branch,
            head_sha: headSha,
            idempotency_key: idempotencyKey,
            status: status as FinalizeRunRow['status'],
            phase: phase as FinalizeRunRow['phase'],
            trigger_source: triggerSource as FinalizeRunRow['trigger_source'],
            worktree_path: worktreePath,
            triggered_by_user_id: triggeredByUserId,
            author_name: authorName,
            author_email: authorEmail,
            retry_of_run_id: retryOfRunId,
            active_seconds_consumed: 0,
            started_at: startedAt,
            ended_at: null,
            reviewer_verdict: null,
            failure_reason: null,
            failed_step_index: null,
            failed_step_name: null,
            failed_step_exit_code: null,
            pr_url: null,
            loop_round: 0,
            mode: (mode as FinalizeRunRow['mode']) ?? 'full',
          };
          rows.set(id, row);
          byKey.set(idempotencyKey, row);
        },
      ),
    } as unknown as OrchestratorDeps['stmts']['insertFinalizeRun'],
    updateFinalizeRunPhase: {
      run: vi.fn((phase: string | null, status: string, id: string) => {
        phaseCalls.push({ phase, status });
        const row = rows.get(id);
        if (row) {
          row.phase = phase as FinalizeRunRow['phase'];
          row.status = status as FinalizeRunRow['status'];
        }
      }),
    } as unknown as OrchestratorDeps['stmts']['updateFinalizeRunPhase'],
    updateFinalizeRunActiveSeconds: {
      run: vi.fn((seconds: number, id: string) => {
        const row = rows.get(id);
        if (row) row.active_seconds_consumed = (row.active_seconds_consumed ?? 0) + seconds;
      }),
    } as unknown as OrchestratorDeps['stmts']['updateFinalizeRunActiveSeconds'],
    updateFinalizeRunSessionId: {
      run: vi.fn((sessionId: string | null, id: string) => {
        const row = rows.get(id);
        if (row) row.session_id = sessionId;
      }),
    } as unknown as OrchestratorDeps['stmts']['updateFinalizeRunSessionId'],
    updateFinalizeRunWorktreePath: {
      run: vi.fn((path: string | null, id: string) => {
        const row = rows.get(id);
        if (row) row.worktree_path = path;
      }),
    } as unknown as OrchestratorDeps['stmts']['updateFinalizeRunWorktreePath'],
    updateFinalizeRunLoopRound: {
      run: vi.fn((round: number, id: string) => {
        const row = rows.get(id);
        if (row) row.loop_round = round;
      }),
    } as unknown as OrchestratorDeps['stmts']['updateFinalizeRunLoopRound'],
    updateFinalizeRunReviewerVerdict: {
      run: vi.fn((verdict: string | null, id: string) => {
        const row = rows.get(id);
        if (row) row.reviewer_verdict = verdict as FinalizeRunRow['reviewer_verdict'];
      }),
    } as unknown as OrchestratorDeps['stmts']['updateFinalizeRunReviewerVerdict'],
    failFinalizeRun: {
      run: vi.fn((status: string, reason: string, id: string) => {
        failCalls.push({ status, reason, id });
        const row = rows.get(id);
        if (row) {
          row.status = status as FinalizeRunRow['status'];
          row.failure_reason = reason;
          row.ended_at = Date.now();
        }
      }),
    } as unknown as OrchestratorDeps['stmts']['failFinalizeRun'],
    markFinalizeRunPushed: {
      run: vi.fn((id: string) => {
        const row = rows.get(id);
        if (row) {
          row.status = 'pushed';
          row.phase = 'push';
          row.ended_at = Date.now();
        }
      }),
    } as unknown as OrchestratorDeps['stmts']['markFinalizeRunPushed'],
    markFinalizeRunReadyToPush: {
      // Mirror the guarded UPDATE (`WHERE id = ? AND status != 'cancelled'`):
      // refuse to resurrect a cancelled row and report `changes` like
      // better-sqlite3 so the orchestrator's changes-check is exercised.
      run: vi.fn((validatedHeadSha: string, id: string) => {
        const row = rows.get(id);
        if (!row || row.status === 'cancelled') {
          return { changes: 0, lastInsertRowid: 0 };
        }
        row.status = 'ready_to_push';
        row.phase = null;
        row.validated_head_sha = validatedHeadSha;
        row.ended_at = Date.now();
        return { changes: 1, lastInsertRowid: 0 };
      }),
    } as unknown as OrchestratorDeps['stmts']['markFinalizeRunReadyToPush'],
    getLatestChecksRunForSession: {
      get: vi.fn((sessionId: string) => latestRunForModes(rows, sessionId, ['checks', 'full'])),
    } as unknown as OrchestratorDeps['stmts']['getLatestChecksRunForSession'],
    getLatestReviewRunForSession: {
      get: vi.fn((sessionId: string) => latestRunForModes(rows, sessionId, ['review', 'full'])),
    } as unknown as OrchestratorDeps['stmts']['getLatestReviewRunForSession'],
    updateFinalizeRunPrUrl: {
      run: vi.fn((prUrl: string, id: string) => {
        const row = rows.get(id);
        if (row) row.pr_url = prUrl;
      }),
    } as unknown as OrchestratorDeps['stmts']['updateFinalizeRunPrUrl'],
    insertReviewerThread: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['insertReviewerThread'],
    deleteReviewerThreadsForRun: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['deleteReviewerThreadsForRun'],
    addMessage: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['addMessage'],
    touchSession: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['touchSession'],
    getMessageById: {
      get: vi.fn(() => undefined),
    } as unknown as OrchestratorDeps['stmts']['getMessageById'],
    upsertFinalizeRunStep: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['upsertFinalizeRunStep'],
    beginFinalizeRunStepAttempt: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['beginFinalizeRunStepAttempt'],
    finishFinalizeRunStepIfAttempt: {
      // Terminal writes must report changes>0 or announceStepEnd treats them
      // as stale (out-of-order) and drops the broadcast.
      run: vi.fn(() => ({ changes: 1 })),
    } as unknown as OrchestratorDeps['stmts']['finishFinalizeRunStepIfAttempt'],
    attachFinalizeRunStepLog: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['attachFinalizeRunStepLog'],
    listFinalizeRunStepsForRun: {
      all: vi.fn(() => []),
    } as unknown as OrchestratorDeps['stmts']['listFinalizeRunStepsForRun'],
    markFinalizeRunStepSkippedIfPending: {
      run: vi.fn(() => ({ changes: 0 })),
    } as unknown as OrchestratorDeps['stmts']['markFinalizeRunStepSkippedIfPending'],
    backfillFinalizeRunFailedStep: {
      run: vi.fn(() => ({ changes: 0 })),
    } as unknown as OrchestratorDeps['stmts']['backfillFinalizeRunFailedStep'],
    upsertFinalizeRunJob: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['upsertFinalizeRunJob'],
    listFinalizeRunJobsForRun: {
      all: vi.fn(() => []),
    } as unknown as OrchestratorDeps['stmts']['listFinalizeRunJobsForRun'],
    upsertFinalizeRunJobAttempt: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['upsertFinalizeRunJobAttempt'],
    listFinalizeRunJobAttemptsForRun: {
      all: vi.fn(() => []),
    } as unknown as OrchestratorDeps['stmts']['listFinalizeRunJobAttemptsForRun'],
    setFinalizeRunFlakeRecoveredJobs: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['setFinalizeRunFlakeRecoveredJobs'],
    upsertFinalizeTestHistory: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['upsertFinalizeTestHistory'],
    listFinalizeQuarantineForProject: {
      all: vi.fn(() => []),
    } as unknown as OrchestratorDeps['stmts']['listFinalizeQuarantineForProject'],
    listReviewerThreadsForRun: {
      all: vi.fn(() => threads),
    } as unknown as OrchestratorDeps['stmts']['listReviewerThreadsForRun'],
    insertFinalizeMetric: {
      run: vi.fn(),
    } as unknown as OrchestratorDeps['stmts']['insertFinalizeMetric'],
  };

  return { stmts, rows, byKey, threads, phaseCalls, failCalls };
}

// ─── Fake phase runners ──────────────────────────────────────────────

function fakeRunRebase(
  outcome: RebasePhaseOutcome,
): NonNullable<OrchestratorDeps['runRebasePhase']> {
  return vi.fn().mockResolvedValue(outcome) as never;
}

function fakeRunCi(
  result:
    | { ok: true; config: { version: 1; on: ['finalize']; timeoutMinutes: number; steps: [] } }
    | { ok: false; error: { code: 'yaml_parse_error'; message: string } },
): NonNullable<OrchestratorDeps['loadCiConfigFromFile']> {
  return vi.fn().mockResolvedValue(result) as never;
}

function fakeRunReview(
  outcome: ReviewerDispatchOutcome,
): NonNullable<OrchestratorDeps['runReviewerDispatch']> {
  return vi.fn().mockResolvedValue(outcome) as never;
}

function fakeRunSteps(outcome: StepRunResult): NonNullable<OrchestratorDeps['runStepPhase']> {
  return vi.fn().mockResolvedValue(outcome) as never;
}

function fakeDispatchFix(
  outcome: FixDispatchResult,
): NonNullable<OrchestratorDeps['dispatchFixMessage']> {
  return vi.fn().mockResolvedValue(outcome) as never;
}

// ─── Default success outcomes for "everything green" ─────────────────

const REBASE_OK: RebasePhaseOutcome = {
  kind: 'success',
  rebaseKind: 'noop',
  requiredFix: false,
  conflictsDispatchedCount: 0,
  activeSecondsBilled: 5,
};

const CI_OK = {
  ok: true as const,
  config: {
    version: 1 as const,
    on: ['finalize'] as ['finalize'],
    timeoutMinutes: 60 as const,
    steps: [] as [],
  },
};

const REVIEW_OK: ReviewerDispatchOutcome = {
  kind: 'success',
  verdict: 'approved',
  threadCount: 0,
  activeSecondsBilled: 30,
};

const STEPS_OK: StepRunResult = {
  status: 'success',
  stepResults: [],
  activeSecondsBilled: 1,
};

const FIX_TURN_ENDED: FixDispatchResult = {
  outcome: 'turn_ended',
  messageId: 'msg-1',
  activeSecondsBilled: 1,
};

// ─── Deps factory ────────────────────────────────────────────────────

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): {
  deps: OrchestratorDeps;
  broadcast: ReturnType<typeof vi.fn>;
  stmts: ReturnType<typeof makeStmts>;
  pushed: ReturnType<typeof vi.fn>;
  resolveHead: ReturnType<typeof vi.fn>;
  dispatchAndWaitForTurnEnd: ReturnType<typeof vi.fn>;
} {
  const stmts = makeStmts();
  const broadcast = vi.fn();
  const pushed = vi
    .fn()
    .mockResolvedValue({ prUrl: 'https://github.com/o/r/pull/1' } satisfies PushAndCreatePrResult);
  const resolveHead = vi.fn().mockResolvedValue('deadbeefcafebabe');
  const dispatchAndWaitForTurnEnd = vi.fn().mockResolvedValue({ userMessagePersisted: true });
  let counter = 0;

  const deps: OrchestratorDeps = {
    config: { personalOAuth: null },
    stmts: stmts.stmts,
    broadcast,
    runReviewer: vi.fn() as never,
    turnEnd: { subscribe: vi.fn(() => () => undefined) },
    pushAndCreatePr: pushed,
    spawnSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 'spawned-sess', worktreePath: '/tmp/spawn-wt' }),
    resolveHeadSha: resolveHead,
    dispatchAndWaitForTurnEnd,
    runRebasePhase: fakeRunRebase(REBASE_OK),
    loadCiConfigFromFile: fakeRunCi(CI_OK),
    runReviewerDispatch: fakeRunReview(REVIEW_OK),
    runStepPhase: fakeRunSteps(STEPS_OK),
    dispatchFixMessage: fakeDispatchFix(FIX_TURN_ENDED),
    transactional: <T>(fn: () => T) => fn(),
    now: () => 1_700_000_000_000,
    newId: () => `run-${++counter}`,
    log: vi.fn(),
    ...overrides,
  };

  return { deps, broadcast, stmts, pushed, resolveHead, dispatchAndWaitForTurnEnd };
}

beforeEach(() => {
  vi.useRealTimers();
  // The §10/§14 retry tests in this file were written against the historical
  // single-auto-retry contract. The generation cap now defaults to 2 (generic
  // infra) so a run survives a double reclaim; pin it back to 1 here for
  // deterministic single-retry mechanics. The raised-cap behavior has its own
  // dedicated coverage (see "double-reclaim survival" below + infra-retry.test).
  process.env.FINALIZE_MAX_INFRA_RETRY_GENERATIONS = '1';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FINALIZE_MAX_INFRA_RETRY_GENERATIONS;
  delete process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS;
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('computeIdempotencyKey', () => {
  it('produces a stable 64-char hex digest', () => {
    const a = computeIdempotencyKey({ projectId: 'p', branch: 'feature/x', headSha: 'aaa' });
    const b = computeIdempotencyKey({ projectId: 'p', branch: 'feature/x', headSha: 'aaa' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs when any input differs', () => {
    const base = { projectId: 'p', branch: 'feature/x', headSha: 'aaa' };
    expect(computeIdempotencyKey(base)).not.toBe(
      computeIdempotencyKey({ ...base, headSha: 'bbb' }),
    );
    expect(computeIdempotencyKey(base)).not.toBe(
      computeIdempotencyKey({ ...base, branch: 'feature/y' }),
    );
    expect(computeIdempotencyKey(base)).not.toBe(
      computeIdempotencyKey({ ...base, projectId: 'q' }),
    );
  });

  it('separates split-mode runs on the same head sha', () => {
    const base = { projectId: 'p', branch: 'feature/x', headSha: 'aaa' } as const;
    const full = computeIdempotencyKey({ ...base, mode: 'full' });
    const checks = computeIdempotencyKey({ ...base, mode: 'checks' });
    const review = computeIdempotencyKey({ ...base, mode: 'review' });
    expect(new Set([full, checks, review]).size).toBe(3);
    // Omitting `mode` resolves to the historical `'full'` key.
    expect(computeIdempotencyKey(base)).toBe(full);
  });
});

describe('runFinalize — split modes', () => {
  afterEach(() => {
    setReadyToPushAutomationHook(null);
  });

  it('checks mode runs the tasks phase, skips the reviewer, and parks at ready_to_push', async () => {
    const review = fakeRunReview(REVIEW_OK);
    const steps = fakeRunSteps(STEPS_OK);
    const { deps, stmts } = makeDeps({
      runReviewerDispatch: review,
      runStepPhase: steps,
    });

    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));

    expect(result.kind).toBe('ready_to_push');
    expect(review).not.toHaveBeenCalled();
    expect(steps).toHaveBeenCalledTimes(1);
    expect(stmts.stmts.markFinalizeRunReadyToPush.run).toHaveBeenCalledTimes(1);
  });

  it('review mode runs the reviewer, skips the tasks phase, and parks at ready_to_push', async () => {
    const review = fakeRunReview(REVIEW_OK);
    const steps = fakeRunSteps(STEPS_OK);
    const { deps, stmts } = makeDeps({
      runReviewerDispatch: review,
      runStepPhase: steps,
    });

    const result = await runFinalize(deps, baseOpts({ mode: 'review' }));

    expect(result.kind).toBe('ready_to_push');
    expect(review).toHaveBeenCalledTimes(1);
    expect(steps).not.toHaveBeenCalled();
    expect(stmts.stmts.markFinalizeRunReadyToPush.run).toHaveBeenCalledTimes(1);
  });

  it('fails closed (terminates) when a NON-clean flake gate cannot be persisted', async () => {
    const { deps, stmts } = makeDeps({
      runReviewerDispatch: fakeRunReview(REVIEW_OK),
      runStepPhase: fakeRunSteps(STEPS_OK),
    });
    // History query throws → classifyRunFlakeRecovery yields a `blocked` gate…
    (stmts.stmts.listFinalizeRunJobAttemptsForRun as unknown as { all: () => unknown }).all =
      () => {
        throw new Error('attempts query down');
      };
    // …and persisting that blocked verdict also throws → it can't be durably
    // recorded, so the run must NOT park as auto-pushable.
    (stmts.stmts.setFinalizeRunFlakeRecoveredJobs as unknown as { run: () => unknown }).run =
      () => {
        throw new Error('gate write down');
      };

    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));

    // Terminate instead of ready_to_push: a later automation pass would
    // otherwise read the NULL column as clean and auto-push the unverified run.
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.status).toBe('infra_error');
    expect(stmts.stmts.markFinalizeRunReadyToPush.run).not.toHaveBeenCalled();
  });

  it('still parks (automation withheld) when a NON-clean gate IS persisted', async () => {
    const { deps, stmts } = makeDeps({
      runReviewerDispatch: fakeRunReview(REVIEW_OK),
      runStepPhase: fakeRunSteps(STEPS_OK),
    });
    // Blocked gate (history query throws) but the verdict persists fine.
    (stmts.stmts.listFinalizeRunJobAttemptsForRun as unknown as { all: () => unknown }).all =
      () => {
        throw new Error('attempts query down');
      };

    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));

    expect(result.kind).toBe('ready_to_push');
    expect(stmts.stmts.markFinalizeRunReadyToPush.run).toHaveBeenCalledTimes(1);
    // The blocked verdict was durably written so the automation-runner can
    // re-check it and withhold auto-push.
    expect(stmts.stmts.setFinalizeRunFlakeRecoveredJobs.run).toHaveBeenCalled();
  });

  it('withholds auto-push when a v2 shard recovered a flake via same-commit config retry', async () => {
    // Reviewer regression: a shard that fails a genuine test then PASSES on a
    // same-commit `retries:` rerun makes the round green, but that recovery is
    // invisible to the cross-round attempt history (the retry overwrote the job
    // state to `passed`). Without folding the intra-phase signal into the gate,
    // the run would auto-push as clean — laundering the flake. The gate must be
    // flake_recovered so automation is withheld.
    const ciV2 = {
      ok: true as const,
      config: {
        version: 2 as const,
        on: ['finalize'] as ['finalize'],
        timeoutMinutes: 45,
        jobs: {
          server: {
            runsOn: 'ubuntu-24.04',
            failFast: false,
            warmup: false,
            needs: [],
            retries: 2,
            matrixInclude: [{}],
            steps: [{ name: 't', run: 'npm test' }],
          },
        },
      },
    };
    const { deps, stmts } = makeDeps({
      loadCiConfigFromFile: vi.fn().mockResolvedValue(ciV2) as never,
      // Green phase, but one shard only passed after a config-retry rerun.
      runJobPhase: vi.fn().mockResolvedValue({
        status: 'success',
        stepResults: [],
        activeSecondsBilled: 5,
        flakeRecoveredInstances: [{ jobId: 'server', matrixKey: '', failureCount: 1 }],
      }) as never,
    });
    // A CLEAN cross-round history (one passed attempt) so classifyRunFlakeRecovery
    // itself returns `clean` — the intra-phase recovery is the ONLY flake signal.
    (stmts.stmts.listFinalizeRunJobAttemptsForRun as unknown as { all: () => unknown }).all =
      () => [
        {
          job_id: 'server',
          matrix_key: '',
          round: 1,
          state: 'passed',
          exit_code: 0,
          head_sha: 'sha',
        },
      ];

    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));

    // Run parks (a human may still push); it must NOT terminate.
    expect(result.kind).toBe('ready_to_push');
    // The gate persisted a NON-null flake_recovered verdict → auto-push withheld.
    const calls = (
      stmts.stmts.setFinalizeRunFlakeRecoveredJobs.run as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls;
    const serialized = calls[calls.length - 1][0] as string | null;
    expect(serialized).not.toBeNull();
    const gate = JSON.parse(serialized as string) as {
      status: string;
      jobs: Array<{ jobId: string }>;
    };
    expect(gate.status).toBe('flake_recovered');
    expect(gate.jobs.map((j) => j.jobId)).toContain('server');
  });

  it('checks mode still dispatches a fix when the tasks phase fails', async () => {
    const failingSteps = fakeRunSteps({
      status: 'failure',
      stepResults: [],
      failedStep: {
        index: 0,
        name: 'unit-tests',
        run: 'npm test',
        exitCode: 1,
        outputTail: ['boom'],
      },
      activeSecondsBilled: 5,
    });
    // Re-enter after the fix turn ends with green steps so the run lands.
    const review = fakeRunReview(REVIEW_OK);
    const dispatch = fakeDispatchFix(FIX_TURN_ENDED);
    const { deps } = makeDeps({
      runReviewerDispatch: review,
      runStepPhase: failingSteps,
      dispatchFixMessage: dispatch,
    });

    // Stop after the first failing pass to keep the test bounded.
    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));
    void result;
    expect(review).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalled();
  });

  it('does NOT fire the ready-to-push automation hook for a partial run', async () => {
    const hook = vi.fn();
    setReadyToPushAutomationHook(hook);
    const { deps } = makeDeps();

    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));
    expect(result.kind).toBe('ready_to_push');
    expect(hook).not.toHaveBeenCalled();
  });

  it('DOES fire the ready-to-push automation hook for a full run', async () => {
    const hook = vi.fn();
    setReadyToPushAutomationHook(hook);
    const { deps } = makeDeps();

    const result = await runFinalize(deps, baseOpts({ mode: 'full' }));
    expect(result.kind).toBe('ready_to_push');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('suppresses the "ready to push" timeline for a checks-only run with no review sibling', async () => {
    const { deps, stmts } = makeDeps();

    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));
    expect(result.kind).toBe('ready_to_push');
    // The row still parks at ready_to_push internally...
    expect(stmts.stmts.markFinalizeRunReadyToPush.run).toHaveBeenCalledTimes(1);
    // ...but it must NOT announce "Ready to push to GitHub" — the reviewer
    // phase has not passed yet.
    const timelineKinds = (stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => JSON.parse(call[7] as string).kind,
    );
    expect(timelineKinds).not.toContain('finalize_ready_to_push');
  });

  it('announces ready-to-push once a review sibling passed the same head', async () => {
    const hook = vi.fn();
    setReadyToPushAutomationHook(hook);
    const { deps, stmts } = makeDeps();
    // Seed a passing review-only run validated against the same head the
    // checks run will validate (resolveHead → 'deadbeefcafebabe').
    stmts.rows.set('review-sibling', {
      id: 'review-sibling',
      idempotency_key: 'idem-review',
      session_id: 'sess-1',
      mode: 'review',
      status: 'ready_to_push',
      validated_head_sha: 'deadbeefcafebabe',
      started_at: 1,
    });

    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));
    expect(result.kind).toBe('ready_to_push');
    const timelineKinds = (stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => JSON.parse(call[7] as string).kind,
    );
    expect(timelineKinds).toContain('finalize_ready_to_push');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('does NOT promote when the review sibling validated a different head', async () => {
    const { deps, stmts } = makeDeps();
    // Sibling review passed, but against an older commit — the branch moved
    // since, so checks-now + review-then is not a coherent full validation.
    stmts.rows.set('stale-review', {
      id: 'stale-review',
      idempotency_key: 'idem-stale',
      session_id: 'sess-1',
      mode: 'review',
      status: 'ready_to_push',
      validated_head_sha: 'an-older-commit-sha',
      started_at: 1,
    });

    const result = await runFinalize(deps, baseOpts({ mode: 'checks' }));
    expect(result.kind).toBe('ready_to_push');
    const timelineKinds = (stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => JSON.parse(call[7] as string).kind,
    );
    expect(timelineKinds).not.toContain('finalize_ready_to_push');
  });

  it('cancels instead of parking ready_to_push when Stop is pressed during CI', async () => {
    // Regression: a Stop pressed while the CI/runner phase is in flight must
    // end the run `cancelled`, never `ready_to_push`, and must not fire the
    // auto-push hook. Previously the runner ran to completion and the
    // orchestrator clobbered the cancelled row back to ready_to_push, so
    // auto-push shipped a run the user had explicitly stopped.
    const hook = vi.fn();
    setReadyToPushAutomationHook(hook);
    const { signal, abort } = createFinalizeRunSignal();
    // The runner does not yet honor the signal, so it completes normally — but
    // by the time it returns the user has pressed Stop (the cancel endpoint
    // tripped the in-process signal).
    const steps = vi.fn().mockImplementation(async () => {
      abort();
      return STEPS_OK;
    }) as unknown as NonNullable<OrchestratorDeps['runStepPhase']>;
    const { deps, stmts } = makeDeps({ runStepPhase: steps });

    const result = await runFinalize(deps, baseOpts({ mode: 'full', signal }));

    expect(steps).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('cancelled');
    expect(stmts.stmts.markFinalizeRunReadyToPush.run).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it('refuses to resurrect a row cancelled in the mark window (guarded UPDATE)', async () => {
    // Defense in depth: even if Stop lands in the race window AFTER the
    // post-CI abort check but BEFORE markFinalizeRunReadyToPush, the guarded
    // UPDATE (`status != 'cancelled'`) reports changes === 0 and the
    // orchestrator bails to the cancelled terminal instead of pushing.
    const hook = vi.fn();
    setReadyToPushAutomationHook(hook);
    const { deps, stmts } = makeDeps();
    // No signal is tripped here, so only the guarded write can catch it: the
    // mock flips the run's own row to `cancelled` as the CI phase returns,
    // standing in for a concurrent cancel-endpoint write.
    (deps as { runStepPhase?: unknown }).runStepPhase = vi
      .fn()
      .mockImplementation(async (_deps: unknown, o: { runId: string }) => {
        const row = stmts.rows.get(o.runId);
        if (row) row.status = 'cancelled';
        return STEPS_OK;
      });

    const result = await runFinalize(deps, baseOpts({ mode: 'full' }));

    expect(result.kind).toBe('cancelled');
    expect(stmts.stmts.markFinalizeRunReadyToPush.run).toHaveBeenCalledTimes(1);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('runFinalize — happy path', () => {
  it('runs rebase → parse → review → tasks and parks at ready_to_push', async () => {
    const { deps, broadcast, stmts, pushed } = makeDeps();

    const result = await runFinalize(deps, baseOpts());

    expect(result.kind).toBe('ready_to_push');
    if (result.kind === 'ready_to_push') {
      expect(result.runId).toBeTruthy();
    }

    // Insert happened exactly once.
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);

    // Push step is deferred — operator confirms via POST .../push.
    expect(pushed).not.toHaveBeenCalled();
    expect(stmts.stmts.markFinalizeRunReadyToPush.run).toHaveBeenCalledTimes(1);
    expect(stmts.stmts.markFinalizeRunPushed.run).not.toHaveBeenCalled();

    // Terminal ready_to_push events broadcast.
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('finalize_run_created');
    expect(types).toContain('finalize_run_phase_changed');
    expect(types).toContain('finalize_run_completed');

    const timelineMetaKinds = (
      stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => JSON.parse(call[7] as string).kind);
    expect(timelineMetaKinds).toContain('finalize_run_started');
    expect(timelineMetaKinds).toContain('finalize_rebase_result');
    expect(timelineMetaKinds).toContain('finalize_ready_to_push');
  });
});

describe('runFinalize — rebase failure', () => {
  it('terminates with rebase_aborted when the rebase phase fails', async () => {
    const { deps } = makeDeps({
      runRebasePhase: fakeRunRebase({
        kind: 'failed',
        failureReason: 'rebase_aborted',
        detail: 'session never resolved the conflict',
        activeSecondsBilled: 30,
      }),
    });

    const result = await runFinalize(deps, baseOpts());

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('rebase_aborted');
      expect(result.status).toBe('failed');
    }
  });

  it('terminates with failed/rebase_aborted when rebase reports skipped', async () => {
    const { deps } = makeDeps({
      runRebasePhase: fakeRunRebase({
        kind: 'success',
        rebaseKind: 'skipped',
        requiredFix: false,
        conflictsDispatchedCount: 0,
        activeSecondsBilled: 5,
      }),
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('rebase_aborted');
    }
  });
});

describe('runFinalize — ci.yaml invalid', () => {
  it('terminates with ci_config_invalid when the parser rejects the config', async () => {
    const { deps } = makeDeps({
      loadCiConfigFromFile: fakeRunCi({
        ok: false,
        error: { code: 'yaml_parse_error', message: 'broken YAML' },
      }),
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('ci_config_invalid');
      expect(result.detail).toContain('yaml_parse_error');
    }
  });
});

describe('runFinalize — failed step triggers fix dispatch', () => {
  it('dispatches fix message on step failure, then re-enters rebase on turn-end', async () => {
    const failedSteps: StepRunResult = {
      status: 'failure',
      stepResults: [],
      activeSecondsBilled: 5,
      failedStep: {
        index: 1,
        name: 'Test',
        run: 'npm test',
        exitCode: 1,
        outputTail: ['1 failing test'],
      },
    };
    // First call to runSteps fails, second succeeds.
    const runSteps = vi
      .fn<(...args: unknown[]) => Promise<StepRunResult>>()
      .mockResolvedValueOnce(failedSteps)
      .mockResolvedValueOnce(STEPS_OK);

    // The fix dispatch lands a real commit, so the post-rebase HEAD
    // advances on iteration 2 (otherwise the no-progress guard fires).
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValueOnce('sha-pre-fix') // iter 1 baseline
      .mockResolvedValueOnce('sha-post-fix') // iter 2 baseline (fix landed)
      .mockResolvedValueOnce('sha-post-fix'); // iter 2 push gate (stable)

    const { deps } = makeDeps({
      runStepPhase: runSteps as never,
      resolveHeadSha: resolveHead,
    });

    const result = await runFinalize(deps, baseOpts());

    expect(result.kind).toBe('ready_to_push');
    expect(runSteps).toHaveBeenCalledTimes(2);
    // The dispatch fn should have fired once with the failed step in the trigger.
    expect(deps.dispatchFixMessage).toHaveBeenCalledTimes(1);
    const dispatchArgs = (deps.dispatchFixMessage as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(dispatchArgs.trigger.failedStep).toBeDefined();
    expect(dispatchArgs.trigger.failedStep.name).toBe('Test');
    expect(dispatchArgs.trigger.failedStep.exitCode).toBe(1);
    // The rebase phase should have run twice (once per outer pass).
    expect(deps.runRebasePhase).toHaveBeenCalledTimes(2);
  });
});

describe('runFinalize — reviewer requests changes triggers fix dispatch', () => {
  it('loops the dispatch when reviewer verdict is changes_requested then approved', async () => {
    const runReview = vi
      .fn<(...args: unknown[]) => Promise<ReviewerDispatchOutcome>>()
      .mockResolvedValueOnce({
        kind: 'success',
        verdict: 'changes_requested',
        threadCount: 1,
        activeSecondsBilled: 30,
      })
      .mockResolvedValueOnce(REVIEW_OK);

    const runSteps = vi
      .fn<(...args: unknown[]) => Promise<StepRunResult>>()
      .mockResolvedValue(STEPS_OK);

    // The fix dispatch for the changes_requested verdict lands a real
    // commit, advancing the post-rebase HEAD on iteration 2 (otherwise
    // the no-progress guard fires before the second review runs).
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValueOnce('sha-pre-fix') // iter 1 baseline
      .mockResolvedValueOnce('sha-post-fix') // iter 2 baseline (fix landed)
      .mockResolvedValueOnce('sha-post-fix'); // iter 2 push gate (stable)

    const { deps } = makeDeps({
      runReviewerDispatch: runReview as never,
      runStepPhase: runSteps as never,
      resolveHeadSha: resolveHead,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
    expect(runReview).toHaveBeenCalledTimes(2);
    expect(runSteps).toHaveBeenCalledTimes(1);
    expect(deps.dispatchFixMessage).toHaveBeenCalledTimes(1);
    const dispatchArgs = (deps.dispatchFixMessage as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(dispatchArgs.trigger.reviewerVerdict).toBe('changes_requested');
  });
});

describe('runFinalize — step phase status mapping', () => {
  it('maps timeout to timed_out outcome', async () => {
    const { deps } = makeDeps({
      runStepPhase: fakeRunSteps({
        status: 'timeout',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 1,
          name: 'Long',
          run: 'sleep 999',
          exitCode: -1,
          outputTail: [],
        },
      }),
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('timed_out');
      expect(result.failureReason).toBe('timeout');
    }
  });

  // Regression (card 3214afda, observed on run 0e803638 2026-07-08): the v2
  // job path defers the run-level terminal write to the orchestrator
  // (job-runner passes `deferRunTerminal: true` so a failing shard never
  // stamps the row while sibling shards run). A v2 `timeout` outcome must
  // therefore cause the ORCHESTRATOR itself to stamp the finalize_runs row
  // terminal. Before the fix, `outcomeFromFailed` assumed the sub-phase had
  // already written it (true only for v1), so nobody wrote it: broadcasts
  // fired once but the durable row stayed status='running' forever and the
  // run sat parked with a failed step and nothing in flight.
  it('writes the run-terminal row itself when a v2 job phase times out (deferred terminal write)', async () => {
    const ciV2 = {
      ok: true as const,
      config: {
        version: 2 as const,
        on: ['finalize'] as ['finalize'],
        timeoutMinutes: 45,
        jobs: {},
      },
    };
    const { deps, stmts } = makeDeps({
      loadCiConfigFromFile: vi.fn().mockResolvedValue(ciV2) as never,
      runJobPhase: vi.fn().mockResolvedValue({
        status: 'timeout',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 17,
          name: 'test / suite=electron / Tests (electron)',
          run: 'npm run test:electron',
          exitCode: -1,
          outputTail: [],
        },
      }) as never,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('timed_out');
      expect(result.failureReason).toBe('timeout');
    }
    // The orchestrator (not the sub-phase) owns the terminal write on the
    // deferred v2 path — the durable row must not be left 'running'.
    expect(stmts.failCalls).toContainEqual(
      expect.objectContaining({ status: 'timed_out', reason: 'timeout' }),
    );
    const row = [...stmts.rows.values()][0];
    expect(row.status).toBe('timed_out');
    expect(row.failure_reason).toBe('timeout');
    expect(row.ended_at).not.toBeNull();
  });

  // Companion invariant: when the sub-phase DID write the terminal row (the
  // v1 step-runner's own `terminate()` path), `outcomeFromFailed` must skip
  // its defensive write — no double `failFinalizeRun` / `ended_at` update.
  it('does not double-write the terminal row when the v1 step phase already wrote it', async () => {
    const { deps, stmts } = makeDeps();
    deps.runStepPhase = vi.fn().mockImplementation(async () => {
      // Simulate the real v1 step-runner: it stamps the run row terminal
      // itself before returning the timeout-shaped outcome.
      const row = [...stmts.rows.values()][0];
      row.status = 'timed_out';
      row.failure_reason = 'timeout';
      row.ended_at = 1_700_000_000_123;
      return {
        status: 'timeout',
        stepResults: [],
        activeSecondsBilled: 5,
      };
    }) as never;
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('timed_out');
    }
    // The sub-phase owned the write; the orchestrator must not re-write.
    expect(stmts.failCalls).toHaveLength(0);
    expect([...stmts.rows.values()][0].ended_at).toBe(1_700_000_000_123);
  });

  // Regression: a CI step that ran past the per-run `timeout_minutes`
  // wall-clock cap (step execution bills only a flat tick to active time, so
  // the §13 active-time budget is nowhere near exhausted) was surfaced to the
  // session with the active-time-budget header — "active-time budget
  // exhausted. Budget: 3600s. Consumed: 96s." — which made a hung-step
  // timeout look like the run had used up its 60-min budget. The step-phase
  // timeout must post the pipeline-step header instead, carrying the CI
  // timeout_minutes, NOT the active-budget framing.
  it('posts the pipeline-step timeout header (not the active-budget message) on a step timeout', async () => {
    const { deps, stmts } = makeDeps({
      // A step killed by its wall-clock cap; its child can exit 1 on the kill
      // signal, so a timeout outcome legitimately carries exitCode 1.
      runStepPhase: fakeRunSteps({
        status: 'timeout',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 1,
          name: 'backend / Backend tests',
          run: 'npm run test:backend',
          exitCode: 1,
          outputTail: ['FAIL backend', 'timed out'],
        },
      }),
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.status).toBe('timed_out');

    const inserts = (stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>).mock.calls;
    const timeoutInsert = inserts.find((c) => {
      const metadataRaw = c[7] as string | null;
      let metadata: Record<string, unknown> | null = null;
      try {
        metadata = metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : null;
      } catch {
        metadata = null;
      }
      return metadata?.kind === 'finalize_timeout_dispatch';
    });
    expect(timeoutInsert).toBeDefined();
    const body = timeoutInsert![3] as string;
    expect(body).toContain('a CI step exceeded the pipeline timeout');
    // CI_OK pins timeout_minutes: 60 — the message must cite the pipeline cap.
    expect(body).toContain('Pipeline step timeout: 60min.');
    expect(body).toContain('Last attempted step: "backend / Backend tests" (exit 1).');
    // The misleading active-time-budget framing must NOT appear.
    expect(body).not.toContain('active-time budget exhausted');
    expect(body).not.toContain('(active time). Consumed:');
    const metadata = JSON.parse(timeoutInsert![7] as string) as Record<string, unknown>;
    expect(metadata.timeoutClass).toBe('pipeline_step');
    expect(metadata.timeoutMinutes).toBe(60);
  });

  it('maps infra_error to infra_error outcome', async () => {
    const { deps, stmts } = makeDeps({
      runStepPhase: fakeRunSteps({
        status: 'infra_error',
        stepResults: [],
        activeSecondsBilled: 5,
        infraErrorDetail: 'docker daemon down',
      }),
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
    }
    expect(stmts.failCalls.some((c) => c.status === 'infra_error')).toBe(true);
  });

  // Regression for the recurring "appears to be running but has failed" report:
  // when a run reaches a terminal failure, the orchestrator must reconcile the
  // step rows — backfill which step failed AND sweep any sibling shard left
  // non-terminal — so the checks/Runners panel doesn't show steps running forever.
  it('reconciles step rows on terminal failure: backfills failed-step summary and sweeps stranded shards', async () => {
    const { deps, stmts, broadcast } = makeDeps({
      // A genuine step failure (exit 1) drives the run terminal via the step phase.
      runStepPhase: fakeRunSteps({
        status: 'failure',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 8,
          name: 'server 1/3',
          run: 'npm test',
          exitCode: 1,
          outputTail: ['FAIL'],
        },
      }),
      // No fix progress, so the loop reaches a real terminal instead of retrying.
      dispatchFixMessage: fakeDispatchFix({
        outcome: 'spawn_failed',
        messageId: 'msg-fix',
        activeSecondsBilled: 1,
      }),
    });

    // Persisted step rows at terminal time: shard 1 failed, shard 2 passed, and
    // two siblings (shards 3 + client) were still in flight — the exact shape
    // that strands rows in `queued`/`running` forever.
    (stmts.stmts.listFinalizeRunStepsForRun.all as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        run_id: 'run-1',
        step_index: 8,
        name: 'server 1/3',
        state: 'failed',
        exit_code: 1,
        job_id: 'test',
        matrix_key: 's1',
      },
      {
        run_id: 'run-1',
        step_index: 9,
        name: 'server 2/3',
        state: 'passed',
        exit_code: 0,
        job_id: 'test',
        matrix_key: 's2',
      },
      {
        run_id: 'run-1',
        step_index: 10,
        name: 'server 3/3',
        state: 'queued',
        exit_code: null,
        job_id: 'test',
        matrix_key: 's3',
      },
      {
        run_id: 'run-1',
        step_index: 11,
        name: 'client',
        state: 'running',
        exit_code: null,
        job_id: 'test',
        matrix_key: 'client',
      },
    ]);
    (
      stmts.stmts.markFinalizeRunStepSkippedIfPending.run as ReturnType<typeof vi.fn>
    ).mockReturnValue({
      changes: 1,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');

    // Failed-step summary backfilled from the FIRST failed step (idx 8).
    const backfill = stmts.stmts.backfillFinalizeRunFailedStep.run as ReturnType<typeof vi.fn>;
    expect(backfill).toHaveBeenCalledWith(8, 'server 1/3', 1, 'run-1');

    // Both stranded siblings swept; passed/failed rows never touched.
    const skip = stmts.stmts.markFinalizeRunStepSkippedIfPending.run as ReturnType<typeof vi.fn>;
    const sweptIndexes = skip.mock.calls.map((c) => c[1]);
    expect(sweptIndexes).toEqual([10, 11]);

    // A terminal `skipped` step event is broadcast for each swept row.
    const skipEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_step_state' && e.state === 'skipped');
    expect(skipEvents.map((e) => e.step_index)).toEqual([10, 11]);
    expect(skipEvents[0]).toMatchObject({ run_id: 'run-1', state: 'skipped' });
  });
});

describe('runFinalize — push gate refuses on new HEAD', () => {
  it('re-enters rebase when HEAD moved between post-rebase snapshot and push', async () => {
    // Each loop iteration calls resolveHead TWICE:
    //   1. Post-rebase snapshot (`headValidatedAgainst`).
    //   2. Push-gate read (`currentHead`).
    // The gate refuses when the two differ within a single iteration —
    // someone landed a commit during review/steps.
    //
    // Iteration 1: snapshot=A, push-gate=B → refuse, re-enter.
    // Iteration 2: snapshot=B, push-gate=B → push.
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValueOnce('iter1-snapshot') // iter 1 baseline
      .mockResolvedValueOnce('iter1-drifted') // iter 1 gate (drifted)
      .mockResolvedValueOnce('iter2-snapshot') // iter 2 baseline
      .mockResolvedValueOnce('iter2-snapshot'); // iter 2 gate (stable)

    const { deps } = makeDeps({
      resolveHeadSha: resolveHead,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
    // Rebase ran twice — once for the initial pass, once after gate refusal.
    expect(deps.runRebasePhase).toHaveBeenCalledTimes(2);
    expect(deps.pushAndCreatePr).not.toHaveBeenCalled();
    expect(resolveHead).toHaveBeenCalledTimes(4);
  });

  it('does NOT refuse when HEAD is the post-rebase sha (even if ≠ trigger sha)', async () => {
    // The previous-implementation bug: comparing against `opts.headSha`
    // (the trigger-time sha) refuses forever after any rebase that
    // rewrites commit shas — including the very first pass when the
    // upstream actually moved. This test pins the fix: the gate
    // compares against the per-iteration baseline, so a single-iteration
    // run with shifted-from-trigger sha pushes cleanly.
    const postRebaseSha = 'totally-different-from-trigger-sha';
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValue(postRebaseSha);

    const { deps } = makeDeps({
      resolveHeadSha: resolveHead,
    });

    const result = await runFinalize(
      deps,
      baseOpts({ headSha: 'original-trigger-sha-that-no-longer-exists' }),
    );
    expect(result.kind).toBe('ready_to_push');
    expect(deps.runRebasePhase).toHaveBeenCalledTimes(1);
    expect(deps.pushAndCreatePr).not.toHaveBeenCalled();
  });

  it('pushes after fix dispatch produces new commits', async () => {
    // Realistic scenario: step fails → fix dispatch → session commits
    // → iteration 2 snapshot reflects the new sha → push goes through
    // with the post-fix sha (not the trigger-time sha).
    //
    // iter 1: snapshot=A (post-rebase pre-fix), step fails → dispatch
    //         (no gate read — dispatch path skips the push gate).
    // iter 2: snapshot=B (post-rebase post-fix-commit, different sha),
    //         step succeeds, gate=B → push.
    const failedSteps: StepRunResult = {
      status: 'failure',
      stepResults: [],
      activeSecondsBilled: 5,
      failedStep: {
        index: 1,
        name: 'Test',
        run: 'npm test',
        exitCode: 1,
        outputTail: ['1 failing test'],
      },
    };
    const runSteps = vi
      .fn<(...args: unknown[]) => Promise<StepRunResult>>()
      .mockResolvedValueOnce(failedSteps)
      .mockResolvedValueOnce(STEPS_OK);
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValueOnce('sha-pre-fix') // iter 1 baseline (after rebase, before fix)
      .mockResolvedValueOnce('sha-post-fix') // iter 2 baseline (after fix landed)
      .mockResolvedValueOnce('sha-post-fix'); // iter 2 gate (stable through review+steps)

    const { deps } = makeDeps({
      runStepPhase: runSteps as never,
      resolveHeadSha: resolveHead,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
    expect(deps.runRebasePhase).toHaveBeenCalledTimes(2);
    expect(deps.dispatchFixMessage).toHaveBeenCalledTimes(1);
    expect(deps.pushAndCreatePr).not.toHaveBeenCalled();
  });
});

describe('runFinalize — cancellation', () => {
  it('honors a pre-aborted signal before kicking off the loop', async () => {
    let aborted = true;
    const signal = {
      get aborted() {
        return aborted;
      },
      onAbort(_listener: () => void): () => void {
        return () => undefined;
      },
    };
    const { deps, stmts } = makeDeps();
    const result = await runFinalize(deps, baseOpts({ signal }));
    expect(result.kind).toBe('cancelled');
    // The orchestrator wrote `cancelled` to the row.
    expect(stmts.failCalls.some((c) => c.status === 'cancelled')).toBe(true);
    void aborted; // suppress unused-let warning
  });

  it('propagates cancelled when fix-dispatch returns cancelled', async () => {
    const failedSteps: StepRunResult = {
      status: 'failure',
      stepResults: [],
      activeSecondsBilled: 5,
      failedStep: {
        index: 1,
        name: 'Test',
        run: 'npm test',
        exitCode: 1,
        outputTail: ['failed'],
      },
    };
    const { deps } = makeDeps({
      runStepPhase: fakeRunSteps(failedSteps),
      dispatchFixMessage: fakeDispatchFix({
        outcome: 'cancelled',
        messageId: 'msg-x',
        activeSecondsBilled: 1,
      }),
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('cancelled');
  });
});

describe('runFinalize — stall watchdog', () => {
  it('propagates stalled outcome when the watchdog trips', async () => {
    const failedSteps: StepRunResult = {
      status: 'failure',
      stepResults: [],
      activeSecondsBilled: 5,
      failedStep: {
        index: 1,
        name: 'Test',
        run: 'npm test',
        exitCode: 1,
        outputTail: ['failed'],
      },
    };
    const { deps } = makeDeps({
      runStepPhase: fakeRunSteps(failedSteps),
      dispatchFixMessage: fakeDispatchFix({
        outcome: 'stalled_no_response',
        messageId: 'msg-y',
        activeSecondsBilled: 1,
      }),
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('stalled');
  });
});

describe('runFinalize — idempotency', () => {
  it('returns reused when a row for the same (project, branch, head_sha) already exists', async () => {
    const { deps, stmts } = makeDeps();
    const first = await runFinalize(deps, baseOpts());
    expect(first.kind).toBe('ready_to_push');

    // Second invocation with the same triple — the orchestrator should
    // find the existing row by idempotency key and return `reused`.
    const second = await runFinalize(deps, baseOpts());
    expect(second.kind).toBe('reused');
    if (second.kind === 'reused') {
      expect(second.runId).toBe((first as { runId: string }).runId);
      expect(second.status).toBe('ready_to_push');
    }
    // Only one row inserted.
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh row when head_sha differs', async () => {
    const { deps, stmts } = makeDeps();
    await runFinalize(deps, baseOpts({ headSha: 'sha-A' }));
    await runFinalize(deps, baseOpts({ headSha: 'sha-B' }));
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(2);
  });

  it('two simultaneous triggers with same head_sha yield exactly one row', async () => {
    const { deps, stmts } = makeDeps();
    // Drive both runs concurrently. The DB enforces UNIQUE on
    // idempotency_key; the orchestrator's pre-insert idempotency lookup
    // also short-circuits when a row already exists. Either path keeps
    // the row count at exactly one.
    const [a, b] = await Promise.all([
      runFinalize(deps, baseOpts()),
      runFinalize(deps, baseOpts()),
    ]);
    // Exactly one row in the registry — same idempotency key, one INSERT
    // attempt actually persists.
    expect(stmts.byKey.size).toBe(1);
    expect(stmts.rows.size).toBe(1);
    // One ran to terminal, one surfaced as reused.
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toContain('reused');
    expect(kinds).toContain('ready_to_push');
  });

  it('a UNIQUE collision races at insert time and is surfaced as reused', async () => {
    const { deps, stmts } = makeDeps();
    // Seed an existing row OUT-OF-BAND (simulating a competing process
    // that won the race between the lookup and the insert in the same
    // tick). We do this by patching the lookup to return undefined the
    // first time (so the orchestrator decides to insert) but seeding the
    // byKey map so the INSERT throws UNIQUE.
    const key = computeIdempotencyKey({
      projectId: fakeProject.id,
      branch: 'feature/x',
      headSha: 'racy',
    });
    stmts.byKey.set(key, {
      id: 'existing-run',
      idempotency_key: key,
      status: 'rebasing',
    } as never);
    // First call to getFinalizeRunByIdempotencyKey returns undefined
    // (race), second returns the seeded row (post-collision lookup).
    const get = stmts.stmts.getFinalizeRunByIdempotencyKey.get as unknown as ReturnType<
      typeof vi.fn
    >;
    get.mockImplementationOnce(() => undefined);
    get.mockImplementationOnce(() => stmts.byKey.get(key));

    const result = await runFinalize(deps, baseOpts({ headSha: 'racy' }));
    expect(result.kind).toBe('reused');
    if (result.kind === 'reused') {
      expect(result.runId).toBe('existing-run');
    }
  });
});

describe('runFinalize — budget enforcement', () => {
  it('terminates with timed_out when the active-time budget is exhausted', async () => {
    const { deps } = makeDeps({
      runRebasePhase: vi
        .fn()
        .mockImplementation(async (depArg: { stmts: OrchestratorDeps['stmts'] }) => {
          // Burn the budget on the first rebase pass via the stmts side-effect.
          depArg.stmts.updateFinalizeRunActiveSeconds.run(99999, 'run-1');
          return REBASE_OK;
        }) as never,
      // Force the loop to iterate at least once by failing a step.
      runStepPhase: fakeRunSteps({
        status: 'failure',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 1,
          name: 'Test',
          run: 'npm test',
          exitCode: 1,
          outputTail: ['failed'],
        },
      }),
      // Fix dispatch resolves so the loop re-enters; the budget check at
      // the top will catch the overspend.
      dispatchFixMessage: fakeDispatchFix(FIX_TURN_ENDED),
      budgetSeconds: 60,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('timed_out');
      expect(result.failureReason).toBe('timeout');
    }
  });
});

describe('runFinalize — spawns session when card has none', () => {
  it('calls spawnSession and updates session_id + worktree_path on the row', async () => {
    const cardNoSession = { ...fakeCard, session_id: null } as KanbanCardRow;
    const { deps, stmts } = makeDeps();
    const result = await runFinalize(
      deps,
      baseOpts({ card: cardNoSession, sessionId: null, worktreePath: null }),
    );
    expect(result.kind).toBe('ready_to_push');
    expect(deps.spawnSession).toHaveBeenCalledTimes(1);
    expect(stmts.stmts.updateFinalizeRunSessionId.run).toHaveBeenCalled();
    expect(stmts.stmts.updateFinalizeRunWorktreePath.run).toHaveBeenCalled();
  });

  it('fails with worktree_create_failed when spawnSession returns null', async () => {
    const cardNoSession = { ...fakeCard, session_id: null } as KanbanCardRow;
    const { deps } = makeDeps({
      spawnSession: vi.fn().mockResolvedValue(null),
    });
    const result = await runFinalize(
      deps,
      baseOpts({ card: cardNoSession, sessionId: null, worktreePath: null }),
    );
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('worktree_create_failed');
    }
  });
});

describe('runFinalize — error containment', () => {
  it('surfaces a thrown rebase phase as infra_error', async () => {
    const { deps } = makeDeps({
      runRebasePhase: vi.fn().mockRejectedValue(new Error('boom')) as never,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
    }
  });

  it('surfaces a thrown reviewer dispatch as review_failed', async () => {
    const { deps } = makeDeps({
      runReviewerDispatch: vi.fn().mockRejectedValue(new Error('llm timeout')) as never,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('review_failed');
    }
  });

  it('does not invoke push during orchestrator — push is a separate human step', async () => {
    const { deps, pushed } = makeDeps({
      pushAndCreatePr: vi.fn().mockRejectedValue(new Error('502 from github')),
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
    expect(pushed).not.toHaveBeenCalled();
  });
});

// ─── Broadcast-contract tests for outcomeFromFailed paths ────────────
//
// The orchestrator promises every terminal path emits a
// `finalize_run_completed` event so subscribers can rely on one signal
// for "this run is over". `terminate()` always does this; this section
// proves `outcomeFromFailed()` (which sub-phase modules already wrote
// the row's status before returning) also does so.

describe('runFinalize — terminal broadcasts on outcomeFromFailed paths', () => {
  it('emits finalize_run_completed on rebase phase failure', async () => {
    const { deps, broadcast } = makeDeps({
      runRebasePhase: fakeRunRebase({
        kind: 'failed',
        failureReason: 'rebase_aborted',
        detail: 'unresolved conflict',
        activeSecondsBilled: 30,
      }),
    });
    await runFinalize(deps, baseOpts());
    const completedEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].status).toBe('failed');
    expect(completedEvents[0].failure_reason).toBe('rebase_aborted');
  });

  it('emits finalize_run_completed on reviewer dispatch failure', async () => {
    const { deps, broadcast } = makeDeps({
      runReviewerDispatch: fakeRunReview({
        kind: 'failed',
        failureReason: 'review_failed',
        detail: 'agent crashed',
        activeSecondsBilled: 0,
      }),
    });
    await runFinalize(deps, baseOpts());
    const completedEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].failure_reason).toBe('review_failed');
  });

  it('emits finalize_run_completed when step phase reports timeout', async () => {
    const { deps, broadcast } = makeDeps({
      runStepPhase: fakeRunSteps({
        status: 'timeout',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 1,
          name: 'Long',
          run: 'sleep',
          exitCode: -1,
          outputTail: [],
        },
      }),
    });
    await runFinalize(deps, baseOpts());
    const completedEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].status).toBe('timed_out');
  });
});

// ─── MAX_FIX_DISPATCH_LOOPS backstop ─────────────────────────────────

describe('runFinalize — MAX_FIX_DISPATCH_LOOPS', () => {
  it('terminates with distinct max_fix_iterations reason (not review_failed)', async () => {
    // A pathological session that never commits anything in response to
    // fix dispatches will spin the loop forever. The backstop catches
    // this BEFORE the active-time budget can; it must surface with a
    // dedicated code so dashboards can tell it apart from a reviewer
    // crash.
    const failedSteps: StepRunResult = {
      status: 'failure',
      stepResults: [],
      activeSecondsBilled: 1,
      failedStep: {
        index: 1,
        name: 'Test',
        run: 'npm test',
        exitCode: 1,
        outputTail: ['still failing'],
      },
    };
    // The fixer commits SOMETHING every round (HEAD advances) but never
    // actually goes green — this exercises the MAX_FIX_DISPATCH_LOOPS
    // backstop rather than the no-progress guard, which only fires when
    // HEAD does NOT advance between rounds.
    let headCounter = 0;
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockImplementation(() => Promise.resolve(`sha-round-${++headCounter}`));

    const { deps } = makeDeps({
      // Always fail steps so the loop dispatches a fix forever.
      runStepPhase: fakeRunSteps(failedSteps),
      resolveHeadSha: resolveHead,
      // Generous budget so the backstop fires before the budget guard.
      budgetSeconds: 999_999_999,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('max_fix_iterations');
      expect(result.failureReason).not.toBe('review_failed');
    }
  });

  const FROZEN_FAILED_STEPS: StepRunResult = {
    status: 'failure',
    stepResults: [],
    activeSecondsBilled: 1,
    failedStep: {
      index: 1,
      name: 'Test',
      run: 'npm test',
      exitCode: 1,
      outputTail: ['still failing'],
    },
  };

  it('allows one same-SHA rerun then terminates fix_no_progress (default budget)', async () => {
    // The exact production trap (session b8dc59b7): the fixer's commits land on
    // a DIFFERENT branch than the one finalize tracks, so the post-rebase HEAD
    // never moves. A transient/flaky failure that left HEAD unchanged now gets
    // ONE bounded same-SHA rerun (DEFAULT_MAX_SAME_SHA_RERUNS=1) before the
    // guard terminates — it must NOT spin to MAX_FIX_DISPATCH_LOOPS.
    const runSteps = fakeRunSteps(FROZEN_FAILED_STEPS);
    // resolveHead returns the SAME sha every call → HEAD never advances.
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValue('frozen-sha');

    const { deps } = makeDeps({
      runStepPhase: runSteps,
      resolveHeadSha: resolveHead,
      budgetSeconds: 999_999_999,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('fix_no_progress');
      expect(result.failureReason).not.toBe('max_fix_iterations');
      expect(result.detail).toContain(baseOpts().branch);
      expect(result.detail).toContain('same-SHA rerun');
    }
    // Round 1: steps run + fix. Round 2: HEAD unchanged → 1 same-SHA rerun
    // (steps run again) + fix. Round 3: budget spent → guard terminates before
    // steps re-run. So 2 step runs, 2 fix dispatches, 3 rebases — bounded.
    expect(runSteps).toHaveBeenCalledTimes(2);
    expect(deps.dispatchFixMessage).toHaveBeenCalledTimes(2);
    expect(deps.runRebasePhase).toHaveBeenCalledTimes(3);
  });

  it('FINALIZE_MAX_SAME_SHA_RERUNS=0 restores strict immediate fix_no_progress', async () => {
    const prev = process.env.FINALIZE_MAX_SAME_SHA_RERUNS;
    process.env.FINALIZE_MAX_SAME_SHA_RERUNS = '0';
    try {
      const runSteps = fakeRunSteps(FROZEN_FAILED_STEPS);
      const resolveHead = vi
        .fn<(...args: unknown[]) => Promise<string>>()
        .mockResolvedValue('frozen-sha');
      const { deps } = makeDeps({
        runStepPhase: runSteps,
        resolveHeadSha: resolveHead,
        budgetSeconds: 999_999_999,
      });

      const result = await runFinalize(deps, baseOpts());
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.failureReason).toBe('fix_no_progress');
      }
      // No rerun budget → the guard fires at round 2 before steps re-run.
      expect(runSteps).toHaveBeenCalledTimes(1);
      expect(deps.dispatchFixMessage).toHaveBeenCalledTimes(1);
      expect(deps.runRebasePhase).toHaveBeenCalledTimes(2);
    } finally {
      if (prev === undefined) delete process.env.FINALIZE_MAX_SAME_SHA_RERUNS;
      else process.env.FINALIZE_MAX_SAME_SHA_RERUNS = prev;
    }
  });
});

// ─── card-lifecycle integration ──────────────────────────────────────

function makeSpyLifecycle(): CardLifecycle & {
  calls: Array<{ method: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const record = (method: string) => (args: Record<string, unknown>) => {
    calls.push({ method, args });
  };
  return {
    calls,
    onStarted: record('onStarted'),
    onRebaseClean: record('onRebaseClean'),
    onRebaseConflictDispatched: record('onRebaseConflictDispatched'),
    onRebaseAborted: record('onRebaseAborted'),
    onReviewerVerdict: record('onReviewerVerdict'),
    onStepFailed: record('onStepFailed'),
    onPushed: record('onPushed'),
    onStalled: record('onStalled'),
    onReadyToPush: record('onReadyToPush'),
    onTerminalFailed: record('onTerminalFailed'),
  };
}

describe('runFinalize — card lifecycle integration', () => {
  it('happy path emits onStarted → onRebaseClean → onReviewerVerdict → onReadyToPush in order', async () => {
    const lifecycle = makeSpyLifecycle();
    const { deps } = makeDeps({ cardLifecycle: lifecycle });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');

    const methods = lifecycle.calls.map((c) => c.method);
    expect(methods).toEqual(['onStarted', 'onRebaseClean', 'onReviewerVerdict', 'onReadyToPush']);

    expect(lifecycle.calls[0].args).toMatchObject({ triggerSource: 'ui_button' });
    expect(lifecycle.calls[2].args).toMatchObject({ verdict: 'approved' });
    expect(lifecycle.calls[3].args).toMatchObject({ runId: expect.any(String) });
  });

  it('rebase with dispatched conflict emits onRebaseConflictDispatched (not clean)', async () => {
    const lifecycle = makeSpyLifecycle();
    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runRebasePhase: fakeRunRebase({
        kind: 'success',
        rebaseKind: 'rebased',
        requiredFix: true,
        conflictsDispatchedCount: 1,
        activeSecondsBilled: 30,
      }),
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');

    const methods = lifecycle.calls.map((c) => c.method);
    expect(methods).toContain('onRebaseConflictDispatched');
    expect(methods).not.toContain('onRebaseClean');
  });

  it('trivial-only fix path emits onRebaseClean (no session dispatch)', async () => {
    const lifecycle = makeSpyLifecycle();
    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runRebasePhase: fakeRunRebase({
        kind: 'success',
        rebaseKind: 'rebased',
        requiredFix: true,
        conflictsDispatchedCount: 0,
        activeSecondsBilled: 30,
      }),
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');

    const methods = lifecycle.calls.map((c) => c.method);
    expect(methods).toContain('onRebaseClean');
    expect(methods).not.toContain('onRebaseConflictDispatched');
  });

  it('rebase failure emits onRebaseAborted with the detail', async () => {
    const lifecycle = makeSpyLifecycle();
    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runRebasePhase: fakeRunRebase({
        kind: 'failed',
        failureReason: 'rebase_aborted',
        detail: 'session never resolved the conflict',
        activeSecondsBilled: 30,
      }),
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');

    const abort = lifecycle.calls.find((c) => c.method === 'onRebaseAborted');
    expect(abort).toBeDefined();
    expect(abort!.args).toMatchObject({ detail: 'session never resolved the conflict' });
  });

  it('rebase skipped emits onRebaseAborted with the skip detail', async () => {
    const lifecycle = makeSpyLifecycle();
    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runRebasePhase: fakeRunRebase({
        kind: 'success',
        rebaseKind: 'skipped',
        requiredFix: false,
        conflictsDispatchedCount: 0,
        activeSecondsBilled: 5,
      }),
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    const abort = lifecycle.calls.find((c) => c.method === 'onRebaseAborted');
    expect(abort).toBeDefined();
    expect(abort!.args.detail).toContain('rebase skipped');
  });

  it('changes_requested emits onReviewerVerdict on each pass, not onStepFailed', async () => {
    const lifecycle = makeSpyLifecycle();
    const runReview = vi
      .fn<(...args: unknown[]) => Promise<ReviewerDispatchOutcome>>()
      .mockResolvedValueOnce({
        kind: 'success',
        verdict: 'changes_requested',
        threadCount: 1,
        activeSecondsBilled: 30,
      })
      .mockResolvedValueOnce(REVIEW_OK);

    // Fix dispatch lands a commit → HEAD advances on iteration 2.
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValueOnce('sha-pre-fix')
      .mockResolvedValueOnce('sha-post-fix')
      .mockResolvedValueOnce('sha-post-fix');

    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runReviewerDispatch: runReview as never,
      resolveHeadSha: resolveHead,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');

    const verdicts = lifecycle.calls
      .filter((c) => c.method === 'onReviewerVerdict')
      .map((c) => c.args.verdict);
    expect(verdicts).toEqual(['changes_requested', 'approved']);
    // Step failure not invoked — the loop was reviewer-driven.
    const stepFailures = lifecycle.calls.filter((c) => c.method === 'onStepFailed');
    expect(stepFailures).toHaveLength(0);
  });

  it('failed step emits onStepFailed with step name and exit code', async () => {
    const lifecycle = makeSpyLifecycle();
    const failedSteps: StepRunResult = {
      status: 'failure',
      stepResults: [],
      activeSecondsBilled: 5,
      failedStep: {
        index: 2,
        name: 'Type check',
        run: 'npm run typecheck',
        exitCode: 2,
        outputTail: ['tsc: 3 errors'],
      },
    };
    const runSteps = vi
      .fn<(...args: unknown[]) => Promise<StepRunResult>>()
      .mockResolvedValueOnce(failedSteps)
      .mockResolvedValueOnce(STEPS_OK);

    // Fix dispatch lands a commit → HEAD advances on iteration 2.
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValueOnce('sha-pre-fix')
      .mockResolvedValueOnce('sha-post-fix')
      .mockResolvedValueOnce('sha-post-fix');

    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runStepPhase: runSteps as never,
      resolveHeadSha: resolveHead,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');

    const stepFail = lifecycle.calls.find((c) => c.method === 'onStepFailed');
    expect(stepFail).toBeDefined();
    expect(stepFail!.args).toMatchObject({ stepName: 'Type check', exitCode: 2 });
  });

  it('stalled fix-dispatch emits onStalled', async () => {
    const lifecycle = makeSpyLifecycle();
    const failedSteps: StepRunResult = {
      status: 'failure',
      stepResults: [],
      activeSecondsBilled: 5,
      failedStep: {
        index: 1,
        name: 'Test',
        run: 'npm test',
        exitCode: 1,
        outputTail: ['fail'],
      },
    };
    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runStepPhase: fakeRunSteps(failedSteps),
      dispatchFixMessage: fakeDispatchFix({
        outcome: 'stalled_no_response',
        messageId: 'msg-stalled',
        activeSecondsBilled: 1,
      }),
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('stalled');

    const stalled = lifecycle.calls.find((c) => c.method === 'onStalled');
    expect(stalled).toBeDefined();
  });

  it('re-trigger on same head_sha (reused) emits NO lifecycle calls', async () => {
    const lifecycle = makeSpyLifecycle();
    const { deps, stmts } = makeDeps({ cardLifecycle: lifecycle });

    // First run drives the full pipeline.
    const first = await runFinalize(deps, baseOpts());
    expect(first.kind).toBe('ready_to_push');
    const firstCallCount = lifecycle.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Reset the "in-flight" side-effects so the dedup row remains and
    // the second call short-circuits with `reused`.
    void stmts; // keep the row in place — that's what we want

    const second = await runFinalize(deps, baseOpts());
    expect(second.kind).toBe('reused');

    // Critically: the reused path adds NO additional comments or moves.
    // Otherwise a re-trigger would duplicate the start comment and bounce
    // the card around uselessly.
    expect(lifecycle.calls.length).toBe(firstCallCount);
  });

  it('default no-op lifecycle keeps the orchestrator running without injected dep', async () => {
    // Sanity: every previous test in this file used `makeDeps()` without
    // injecting `cardLifecycle`; if the default were non-noop those would
    // already explode. This test makes the contract explicit so future
    // edits cannot accidentally require the dep.
    const { deps } = makeDeps();
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
  });
});

// ─── §13 active-time budget enforcement ──────────────────────────────

describe('runFinalize — §13 budget integration', () => {
  it('posts a session timeout message with the last attempt output tail on budget exhaustion', async () => {
    const failedSteps: StepRunResult = {
      status: 'failure',
      stepResults: [],
      activeSecondsBilled: 5,
      failedStep: {
        index: 1,
        name: 'npm test',
        run: 'npm test',
        exitCode: 1,
        outputTail: ['FAIL: a.test.js > does the thing', 'Expected 1, got 2'],
      },
    };
    const { deps, stmts } = makeDeps({
      // Burn the budget on the first rebase pass via the stmts side-effect.
      runRebasePhase: vi
        .fn()
        .mockImplementation(async (depArg: { stmts: OrchestratorDeps['stmts'] }) => {
          depArg.stmts.updateFinalizeRunActiveSeconds.run(99_999, 'run-1');
          return REBASE_OK;
        }) as never,
      runStepPhase: fakeRunSteps(failedSteps),
      dispatchFixMessage: fakeDispatchFix(FIX_TURN_ENDED),
      budgetSeconds: 60,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('timed_out');
      expect(result.failureReason).toBe('timeout');
    }
    // A system message was posted into the originating session carrying
    // the last attempt's failed step + output tail.
    const inserts = (stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>).mock.calls;
    const timeoutInsert = inserts.find((c) => {
      const body = c[3] as string;
      const metadataRaw = c[7] as string | null;
      let metadata: Record<string, unknown> | null = null;
      try {
        metadata = metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : null;
      } catch {
        metadata = null;
      }
      return (
        metadata?.kind === 'finalize_timeout_dispatch' &&
        body.includes('npm test') &&
        body.includes('FAIL: a.test.js')
      );
    });
    expect(timeoutInsert).toBeDefined();
  });

  it('clamps the cap to ci.yaml timeout_minutes (lower than dep budget)', async () => {
    // ci.yaml says 1 minute; dep budget injected at 60s. After parse the
    // orchestrator narrows to 60s (lesser of the two — ci can lower).
    // We burn 70s of active time during rebase and then the loop guard
    // should trip on the next iteration.
    const ciLowered = {
      ok: true as const,
      config: {
        version: 1 as const,
        on: ['finalize'] as ['finalize'],
        timeoutMinutes: 1 as const,
        steps: [] as [],
      },
    };
    const { deps, stmts } = makeDeps({
      loadCiConfigFromFile: fakeRunCi(ciLowered) as never,
      runRebasePhase: vi
        .fn()
        .mockImplementation(async (depArg: { stmts: OrchestratorDeps['stmts'] }) => {
          // 70 seconds — more than the ci-lowered 60s cap.
          depArg.stmts.updateFinalizeRunActiveSeconds.run(70, 'run-1');
          return REBASE_OK;
        }) as never,
      runStepPhase: fakeRunSteps({
        status: 'failure',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 1,
          name: 'lint',
          run: 'npm run lint',
          exitCode: 2,
          outputTail: ['lint failed'],
        },
      }),
      dispatchFixMessage: fakeDispatchFix(FIX_TURN_ENDED),
      // Dep budget is generous; the ci.yaml value should win because it
      // is the narrower of the two.
      budgetSeconds: 3600,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('timed_out');
      expect(result.failureReason).toBe('timeout');
    }
    // Detail string reflects the narrowed cap (60s = 1 minute).
    if (result.kind === 'failed') {
      expect(result.detail).toMatch(/60s/);
    }
    void stmts;
  });

  it('shares the budget with the retry parent — the retry does NOT get a fresh 60 min', async () => {
    // Seed a "parent" run that already burned 3500 seconds. Then start a
    // retry of that parent — the retry only gets 100 more seconds before
    // the family total trips the 3600s cap.
    const { deps, stmts } = makeDeps({
      runRebasePhase: vi
        .fn()
        .mockImplementation(async (depArg: { stmts: OrchestratorDeps['stmts'] }) => {
          // 200 seconds on this iteration alone.
          depArg.stmts.updateFinalizeRunActiveSeconds.run(200, 'run-1');
          return REBASE_OK;
        }) as never,
      runStepPhase: fakeRunSteps({
        status: 'failure',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 1,
          name: 't',
          run: 'r',
          exitCode: 1,
          outputTail: [],
        },
      }),
      dispatchFixMessage: fakeDispatchFix(FIX_TURN_ENDED),
      // Inject a "parent" row by running once first with a low budget
      // to get the parent in place, then re-trigger with retryOfRunId.
      budgetSeconds: 3600,
    });

    // Manually pre-seed the parent row at 3500s consumed.
    stmts.rows.set('parent', {
      id: 'parent',
      idempotency_key: 'parent-key',
      active_seconds_consumed: 3500,
      retry_of_run_id: null,
    } as never);

    // The "retry" run uses a different head_sha so it gets its own row.
    const result = await runFinalize(
      deps,
      baseOpts({ headSha: 'bbbbbbbbbbbbbbbb', retryOfRunId: 'parent' }),
    );
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('timed_out');
      expect(result.failureReason).toBe('timeout');
    }
  });

  it('emits finalize_run_active_seconds broadcasts after each phase', async () => {
    const { deps, broadcast } = makeDeps();
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
    const evtTypes = broadcast.mock.calls
      .map((c) => (c[0] as { type: string }).type)
      .filter((t) => t === 'finalize_run_active_seconds');
    // At least 3 ticks: after rebase, review, tasks (push gate is a pure
    // check — it does not bill / broadcast).
    expect(evtTypes.length).toBeGreaterThanOrEqual(3);
    // Each carries the running total of active_seconds_consumed.
    const sample = broadcast.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'finalize_run_active_seconds',
    );
    expect(sample?.[0]).toMatchObject({
      type: 'finalize_run_active_seconds',
      run_id: expect.any(String),
      active_seconds_consumed: expect.any(Number),
    });
  });
});

// ─── §10 infra-failure classifier + one-auto-retry semantics ─────────
//
// The orchestrator's §10 contract:
//   - infra-class failures (worktree_create_failed, container_unavailable,
//     github_push_5xx) auto-retry exactly once.
//   - CI-class failures (step_failed, reviewer_changes_requested,
//     rebase_aborted, ci_config_invalid, timeout, etc.) never auto-retry.
//   - The retry row's `retry_of_run_id` points at the original.
//   - The retry inherits the family active-time budget — it does NOT
//     get a fresh 60-min window.
//   - On second infra failure, a system message is posted into the
//     originating session with the machine code + detail + escalation
//     hint. No GitHub surfaces touched.

describe('runFinalize — §10 infra retry on first infra failure', () => {
  it('first spawnSession failure opens a retry row pointing at the original', async () => {
    const cardNoSession = { ...fakeCard, session_id: null } as KanbanCardRow;
    const spawnSession = vi.fn().mockResolvedValue(null);
    const { deps, stmts } = makeDeps({ spawnSession: spawnSession as never });
    const result = await runFinalize(
      deps,
      baseOpts({ card: cardNoSession, sessionId: null, worktreePath: null }),
    );
    // Both attempts terminate with the same infra reason; the final
    // outcome is the retry's terminal infra_error.
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
      expect(result.failureReason).toBe('worktree_create_failed');
    }
    // Exactly two rows were inserted — the original + one retry.
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(2);
    // The retry row carries `retry_of_run_id` pointing at the original.
    const rows = Array.from(stmts.rows.values());
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => !r.retry_of_run_id);
    const retry = rows.find((r) => r.retry_of_run_id);
    expect(original).toBeDefined();
    expect(retry).toBeDefined();
    expect(retry!.retry_of_run_id).toBe(original!.id);
    // spawnSession was called for both attempts (the retry inherits null
    // session/worktree because the original never resolved one).
    expect(spawnSession).toHaveBeenCalledTimes(2);
  });

  it('orchestrator parks at ready_to_push — push failures are handled in push-run.ts', async () => {
    const pushMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('502 from github'))
      .mockResolvedValueOnce({
        prUrl: 'https://github.com/o/r/pull/2',
      } satisfies PushAndCreatePrResult);
    const { deps, stmts, pushed } = makeDeps({ pushAndCreatePr: pushMock });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
    expect(pushed).not.toHaveBeenCalled();
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);
    const row = Array.from(stmts.rows.values())[0];
    expect(row?.status).toBe('ready_to_push');
  });

  it('CI-class failure (review_failed thrown) does NOT auto-retry', async () => {
    const runReview = vi.fn().mockRejectedValue(new Error('llm timeout'));
    const { deps, stmts } = makeDeps({
      runReviewerDispatch: runReview as never,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('review_failed');
      // review_failed is CI-class → status remains `failed`, NOT
      // `infra_error`.
      expect(result.status).toBe('failed');
    }
    // No retry row — the reviewer phase ran exactly once.
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);
  });

  it('CI-class rebase_aborted does NOT auto-retry', async () => {
    const rebase = vi.fn().mockResolvedValue({
      kind: 'failed',
      failureReason: 'rebase_aborted',
      detail: 'unresolved conflict',
      activeSecondsBilled: 30,
    });
    const { deps, stmts } = makeDeps({ runRebasePhase: rebase as never });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('rebase_aborted');
    }
    expect(rebase).toHaveBeenCalledTimes(1);
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);
  });

  it('CI-class ci_config_invalid does NOT auto-retry', async () => {
    const { deps, stmts } = makeDeps({
      loadCiConfigFromFile: fakeRunCi({
        ok: false,
        error: { code: 'yaml_parse_error', message: 'bad indent' },
      }) as never,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('ci_config_invalid');
    }
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);
  });

  it('CI-class timeout (active-budget exhausted) does NOT auto-retry', async () => {
    // Defense: the §13 timeout is CI-class. A test could pass if we
    // accidentally classified timeout as infra (auto-retry once) AND
    // the retry also tripped the family-budget guard → identical outer
    // outcome (status=timed_out). The difference is whether the
    // orchestrator opened a second row. Asserting exactly one
    // insertFinalizeRun call pins the "no auto-retry on timeout"
    // contract.
    const { deps, stmts } = makeDeps({
      runRebasePhase: vi
        .fn()
        .mockImplementation(async (depArg: { stmts: OrchestratorDeps['stmts'] }) => {
          depArg.stmts.updateFinalizeRunActiveSeconds.run(99_999, 'run-1');
          return REBASE_OK;
        }) as never,
      runStepPhase: fakeRunSteps({
        status: 'failure',
        stepResults: [],
        activeSecondsBilled: 5,
        failedStep: {
          index: 1,
          name: 'Test',
          run: 'npm test',
          exitCode: 1,
          outputTail: ['failed'],
        },
      }),
      dispatchFixMessage: fakeDispatchFix(FIX_TURN_ENDED),
      budgetSeconds: 60,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('timed_out');
      expect(result.failureReason).toBe('timeout');
    }
    // Exactly ONE row — no retry was opened.
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);
  });

  it('an unknown failure_reason does NOT trigger auto-retry (defensive default)', async () => {
    // If a future phase module ever emits a failure_reason that hasn't
    // been added to either whitelist (CI nor INFRA), the classifier
    // returns 'unknown' and the orchestrator MUST treat it as
    // non-retryable. Auto-retrying on a novel code could silently hide
    // a CI regression behind a duplicate run; the correct fix is for
    // the new code to be added to the appropriate list explicitly.
    //
    // We exercise this by stubbing rebase to return a `kind: 'failed'`
    // with a failure_reason that is in neither whitelist.
    const rebase = vi.fn().mockResolvedValue({
      kind: 'failed',
      failureReason: 'novel_failure_class_not_in_whitelist',
      detail: 'some new failure source',
      activeSecondsBilled: 30,
    });
    const { deps, stmts } = makeDeps({ runRebasePhase: rebase as never });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      // outcomeFromFailed maps unknown reasons to status='failed' (the
      // status='infra_error' branch only fires for known infra codes),
      // and the retry gate also reads infra-class only — so no retry.
      expect(result.failureReason).toBe('novel_failure_class_not_in_whitelist');
      expect(result.status).toBe('failed');
    }
    // Rebase ran exactly once — no retry.
    expect(rebase).toHaveBeenCalledTimes(1);
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);
  });
});

describe('runFinalize — §10 second infra failure terminates as infra_error + posts session message', () => {
  it('two consecutive worktree_create_failed → infra_error + system message posted', async () => {
    const cardNoSession = { ...fakeCard, session_id: null } as KanbanCardRow;
    const { deps, stmts } = makeDeps({
      spawnSession: vi.fn().mockResolvedValue(null) as never,
    });
    const result = await runFinalize(
      deps,
      baseOpts({ card: cardNoSession, sessionId: null, worktreePath: null }),
    );
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
      expect(result.failureReason).toBe('worktree_create_failed');
    }
    // No session was ever resolved → no terminal message can be posted
    // (the helper no-ops when sessionId is null). This is the expected
    // graceful behavior for the worktree_create_failed code path.
    const inserts = (stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>).mock.calls;
    const infraTerminalInsert = inserts.find((c) => {
      const metadataRaw = c[7] as string | null;
      let metadata: Record<string, unknown> | null = null;
      try {
        metadata = metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : null;
      } catch {
        metadata = null;
      }
      return metadata?.kind === 'finalize_infra_terminal';
    });
    // No session, no message — graceful no-op.
    expect(infraTerminalInsert).toBeUndefined();
  });

  it('two consecutive container_unavailable (rebase phase throws twice) → posts terminal session message', async () => {
    // Session pre-resolved (so the terminal message has a place to land).
    const rebase = vi.fn().mockRejectedValue(new Error('worktree wedged'));
    const { deps, stmts } = makeDeps({ runRebasePhase: rebase as never });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
      expect(result.failureReason).toBe('container_unavailable');
    }
    // Both attempts re-ran rebase (which throws each time).
    expect(rebase).toHaveBeenCalledTimes(2);
    // Two rows: original + retry, both infra_error.
    const rows = Array.from(stmts.rows.values());
    expect(rows).toHaveLength(2);
    const retry = rows.find((r) => r.retry_of_run_id)!;
    expect(retry.status).toBe('infra_error');
    expect(retry.failure_reason).toBe('container_unavailable');
    // System message posted: structured metadata + escalation hint.
    const inserts = (stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>).mock.calls;
    const infraTerminalInsert = inserts.find((c) => {
      const metadataRaw = c[7] as string | null;
      let metadata: Record<string, unknown> | null = null;
      try {
        metadata = metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : null;
      } catch {
        metadata = null;
      }
      return metadata?.kind === 'finalize_infra_terminal';
    });
    expect(infraTerminalInsert).toBeDefined();
    // The body carries the machine code + escalation hint.
    const body = infraTerminalInsert![3] as string;
    expect(body).toContain('container_unavailable');
    expect(body).toContain('Re-trigger Finalize Code Changes');
  });

  it('orchestrator does not auto-retry push — github_push_5xx is push-run.ts scope', async () => {
    const pushMock = vi.fn().mockRejectedValue(new Error('502 from github'));
    const { deps, stmts, pushed } = makeDeps({ pushAndCreatePr: pushMock });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
    expect(pushed).not.toHaveBeenCalled();
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);
  });
});

describe('runFinalize — §10 retry inherits the family active-time budget', () => {
  it('retry does NOT get a fresh 60-min — family total caps the cumulative spend', async () => {
    // Each rebase burns 1800s (30 min). Attempt 1 fails infra (rebase
    // throws on the SECOND call, after the first attempt's loop has
    // already burned budget). Attempt 2 has only the remainder. The
    // budget guard at the top of the retry loop sees the family total
    // and trips immediately.
    //
    // Setup: budget = 3600s (60 min). Attempt 1's rebase succeeds once,
    // burning 1800s, then steps fail green-but-not-approved → fix
    // dispatch → second rebase pass throws (infra_error). At that
    // point parent's active_seconds_consumed = 1800. The retry attempt
    // starts with a fresh runId; if it had a fresh budget it would
    // happily burn another 3600s. With the family-shared cap, the next
    // rebase pass (which would burn 1800s, total 3600s) starts but the
    // top-of-loop guard checks isBudgetExhausted(retryRunId, 3600)
    // which sums parent+retry; after the retry's rebase the family
    // total is 3600 and the guard trips.
    //
    // To make the assertion crisp: we mock rebase to ALWAYS throw
    // (infra_error). Attempt 1: budget burn during the throw is zero
    // (the rebase throws before billing). Both attempts terminate
    // immediately with container_unavailable, BUT we then check the
    // family-budget reading:
    //   - parent active_seconds_consumed: 0
    //   - retry active_seconds_consumed: 0
    //   - family total: 0
    // The budget guard doesn't trip because nothing was consumed.
    //
    // For the inherited-budget assertion, we instead pre-seed the
    // original row with active_seconds_consumed at the cap. The retry
    // path's top-of-loop budget guard should then trip on the FIRST
    // rebase pass — before even calling rebase — because the family
    // total already crosses the cap.
    //
    // We achieve this by: spawnSession is the infra failure on attempt
    // 1, but BEFORE returning null the spawnSession mock writes the
    // parent's active_seconds_consumed to 3600. On the retry the
    // top-of-loop guard sees parent=3600 + retry=0 = 3600 vs cap 3600
    // → exhausted → returns timed_out terminal IMMEDIATELY without
    // burning any further work.
    //
    // We assert: the retry terminates as timed_out (CI-class), not
    // infra_error. The family budget caps the retry's reach.

    const cardNoSession = { ...fakeCard, session_id: null } as KanbanCardRow;
    let spawnCallCount = 0;
    const spawnSession = vi.fn(async ({ card: _c, project: _p }) => {
      void _c;
      void _p;
      spawnCallCount += 1;
      if (spawnCallCount === 1) {
        // First spawn: pre-burn the parent's budget so the retry will
        // trip the top-of-loop guard immediately, then return null
        // (worktree_create_failed → infra retry path).
        const rows = Array.from(stmts.rows.values());
        const original = rows[0];
        if (original) {
          original.active_seconds_consumed = 3600; // exactly at cap
        }
        return null;
      }
      // Second spawn (on retry): also returns null → another
      // worktree_create_failed.
      return null;
    });

    const { deps, stmts } = makeDeps({
      spawnSession: spawnSession as never,
      budgetSeconds: 3600, // 60 min
    });
    const result = await runFinalize(
      deps,
      baseOpts({ card: cardNoSession, sessionId: null, worktreePath: null }),
    );
    // The retry's session-resolution layer (still null) hits the same
    // worktree_create_failed terminal. The family budget was at the cap
    // BEFORE the retry even started; the guard inside driveAttempt's
    // main loop would have tripped on the next iteration, but the
    // worktree_create_failed surface happens BEFORE the loop. We assert
    // the family budget is respected: both rows together should not
    // consume more than the cap.
    expect(result.kind).toBe('failed');
    const rows = Array.from(stmts.rows.values());
    expect(rows).toHaveLength(2);
    const parent = rows.find((r) => !r.retry_of_run_id)!;
    const retry = rows.find((r) => r.retry_of_run_id)!;
    // Parent was pre-seeded at the cap; the retry's own bill is 0.
    expect(parent.active_seconds_consumed).toBe(3600);
    expect(retry.active_seconds_consumed).toBe(0);
    // Sum is exactly the cap; retry did NOT get a fresh 60 min.
    const familyTotal =
      (parent.active_seconds_consumed ?? 0) + (retry.active_seconds_consumed ?? 0);
    expect(familyTotal).toBe(3600);
    expect(familyTotal).not.toBeGreaterThan(3600);
  });

  it('does NOT trip the budget on the retry when the parent burned it via an infra failure', async () => {
    // Hardening (#4): the original fails infra inside the main loop (rebase
    // throws AFTER consuming the ENTIRE budget). Previously the retry's
    // top-of-loop budget guard tripped immediately (family total ≥ cap) and
    // surfaced `timed_out` — a reclaim masquerading as a CI timeout. Now the
    // parent's infra-wasted time is non-billable, so the family total resets
    // to ~0 for the retry: the retry MUST actually enter its rebase (call 2)
    // instead of being pre-empted, and the outcome is the genuine infra
    // terminal (cap pinned to 1 here), NOT a timeout.
    let rebaseCallCount = 0;
    const rebase = vi.fn(async (depArg: { stmts: OrchestratorDeps['stmts'] }) => {
      rebaseCallCount += 1;
      if (rebaseCallCount === 1) {
        // Original attempt: consume the entire budget, then throw infra.
        depArg.stmts.updateFinalizeRunActiveSeconds.run(3600, 'run-1');
        throw new Error('worktree wedged');
      }
      // Retry attempt: reached because the forgiven budget did not pre-empt
      // it. Throw infra again so the (cap-1) family terminates deterministically.
      throw new Error('worktree wedged again');
    });

    const { deps, stmts } = makeDeps({
      runRebasePhase: rebase as never,
      budgetSeconds: 3600,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      // The forgiven budget means the retry is NOT timed out — it runs and
      // surfaces the genuine infra terminal.
      expect(result.status).toBe('infra_error');
      expect(result.failureReason).toBe('container_unavailable');
    }
    // Proof the guard did NOT pre-empt the retry: rebase ran a SECOND time.
    expect(rebaseCallCount).toBe(2);
    // Parent kept its (forgiven) seconds on its own row; the retry's own
    // bill is 0. The family total the guard sees for the retry excludes the
    // parent → no spurious timeout.
    const rows = Array.from(stmts.rows.values());
    const parent = rows.find((r) => !r.retry_of_run_id)!;
    const retry = rows.find((r) => r.retry_of_run_id)!;
    expect(parent.active_seconds_consumed).toBe(3600);
    expect(retry.active_seconds_consumed).toBe(0);
  });
});

describe('runFinalize — §10 retry inherits resolved session + worktree from parent', () => {
  it('spawnSession ran on attempt 1 → retry uses the same sessionId, does NOT re-spawn', async () => {
    // Attempt 1: card has no session_id; spawnSession succeeds, then
    // the rebase phase throws (infra) BEFORE any further session work.
    // Attempt 2: should inherit the spawned session/worktree and NOT
    // re-fire spawnSession — the worktree belongs to the session.
    const cardNoSession = { ...fakeCard, session_id: null } as KanbanCardRow;
    const spawnSession = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'spawned-sess', worktreePath: '/tmp/spawned-wt' })
      .mockResolvedValue(null); // would NULL if called a second time
    const rebase = vi.fn().mockRejectedValue(new Error('worktree wedged'));
    const { deps } = makeDeps({
      spawnSession: spawnSession as never,
      runRebasePhase: rebase as never,
    });
    const result = await runFinalize(
      deps,
      baseOpts({ card: cardNoSession, sessionId: null, worktreePath: null }),
    );
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
      expect(result.failureReason).toBe('container_unavailable');
    }
    // spawnSession called exactly ONCE — the retry inherited the
    // original's resolved session.
    expect(spawnSession).toHaveBeenCalledTimes(1);
    // Rebase called twice — the retry actually ran the state machine.
    expect(rebase).toHaveBeenCalledTimes(2);
  });
});

describe('runFinalize — §10 retry broadcasts and lifecycle', () => {
  it('emits TWO finalize_run_created events (one per run row)', async () => {
    const rebase = vi.fn().mockRejectedValue(new Error('worktree wedged'));
    const { deps, broadcast } = makeDeps({ runRebasePhase: rebase as never });
    await runFinalize(deps, baseOpts());
    const createdEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_created');
    expect(createdEvents).toHaveLength(2);
  });

  it('emits TWO finalize_run_completed events on double-infra terminal', async () => {
    const rebase = vi.fn().mockRejectedValue(new Error('worktree wedged'));
    const { deps, broadcast } = makeDeps({ runRebasePhase: rebase as never });
    await runFinalize(deps, baseOpts());
    const completedEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_completed');
    expect(completedEvents).toHaveLength(2);
    for (const e of completedEvents) {
      expect(e.status).toBe('infra_error');
      expect(e.failure_reason).toBe('container_unavailable');
    }
  });
});

describe('runFinalize — §10 double-reclaim survival (generation cap > 1)', () => {
  // The headline hardening: with the generation cap raised above 1, a run that
  // loses its driving agent to back-to-back Spot reclaims (each surfacing as
  // `container_unavailable`) RECOVERS instead of terminating green code as
  // infra_error. These would have failed under the historical single-retry cap.
  it('recovers on the 3rd attempt when the first two fail infra (cap=2)', async () => {
    process.env.FINALIZE_MAX_INFRA_RETRY_GENERATIONS = '2';
    let rebaseCalls = 0;
    const rebase = vi.fn(async () => {
      rebaseCalls += 1;
      if (rebaseCalls <= 2) throw new Error('agent reclaimed'); // container_unavailable ×2
      return REBASE_OK;
    });
    const { deps, stmts } = makeDeps({ runRebasePhase: rebase as never });
    const result = await runFinalize(deps, baseOpts());
    // Two reclaims survived → the third attempt completes the pipeline.
    expect(result.kind).toBe('ready_to_push');
    expect(rebaseCalls).toBe(3);
    // Three rows: original + 2 retries, chained generation 0 → 1 → 2.
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(3);
    const rows = Array.from(stmts.rows.values());
    expect(rows).toHaveLength(3);
    const gen0 = rows.find((r) => !r.retry_of_run_id)!;
    const gen1 = rows.find((r) => r.retry_of_run_id === gen0.id)!;
    const gen2 = rows.find((r) => r.retry_of_run_id === gen1.id)!;
    expect(gen0).toBeDefined();
    expect(gen1).toBeDefined();
    expect(gen2).toBeDefined();
  });

  it('still terminates infra_error if EVERY attempt up to the cap fails (cap=2 → 3 attempts)', async () => {
    process.env.FINALIZE_MAX_INFRA_RETRY_GENERATIONS = '2';
    const rebase = vi.fn().mockRejectedValue(new Error('agent reclaimed'));
    const { deps, stmts } = makeDeps({ runRebasePhase: rebase as never });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
      expect(result.failureReason).toBe('container_unavailable');
    }
    // original + 2 retries = exactly 3 attempts at cap 2 (no runaway).
    expect(rebase).toHaveBeenCalledTimes(3);
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(3);
  });

  it('finalizes the LAST attempt even when the env cap exceeds the loop backstop (no dropped terminal)', async () => {
    // Regression for the review finding: the loop previously had a FIXED bound
    // of 8 and finalized each attempt on the NEXT iteration's top, so with an
    // env cap > 8 the last-opened retry was driven but never had its terminal
    // metrics / infra message run. The backstop is now DERIVED from the live
    // cap, and the backstop routes through the terminal path — so every run,
    // including the highest generation, is finalized.
    process.env.FINALIZE_MAX_INFRA_RETRY_GENERATIONS = '10';
    const rebase = vi.fn().mockRejectedValue(new Error('agent reclaimed'));
    const { deps, stmts, broadcast } = makeDeps({ runRebasePhase: rebase as never });
    const result = await runFinalize(deps, baseOpts());

    // The genuine infra terminal is surfaced — NOT a raw, unfinalized attempt.
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
      expect(result.failureReason).toBe('container_unavailable');
    }

    // cap 10 → original + 10 retries = 11 attempts, all driven, all infra.
    expect(rebase).toHaveBeenCalledTimes(11);
    expect(Array.from(stmts.rows.values())).toHaveLength(11);

    // EVERY run row is finalized — a finalize_run_completed per attempt,
    // including the highest generation. Under the old fixed-8 bound the runs
    // past generation 8 would be driven but never finalized (< 11 events).
    const completedEvents = broadcast.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === 'finalize_run_completed');
    expect(completedEvents).toHaveLength(11);

    // The terminal infra session message fires exactly once, for the final run.
    const terminalMsgs = (stmts.stmts.addMessage.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => {
        const raw = c[7] as string | null;
        try {
          return raw
            ? (JSON.parse(raw) as { kind?: string }).kind === 'finalize_infra_terminal'
            : false;
        } catch {
          return false;
        }
      },
    );
    expect(terminalMsgs).toHaveLength(1);
  });

  // The reclaim-detection follow-up is now wired: a runner lost to an EC2 Spot
  // reclaim surfaces `spot_reclaimed` from the step phase (step-runner lifts the
  // fleet reaper's marker), the orchestrator honours it, and it earns the
  // generous reclaim generation cap rather than the conservative infra cap.
  const STEP_INFRA_SPOT: StepRunResult = {
    status: 'infra_error',
    stepResults: [],
    activeSecondsBilled: 0,
    failureReason: 'spot_reclaimed',
    infraErrorDetail: '[spot_reclaimed] runner agent lost after an EC2 Spot interruption notice',
  };

  it('a spot_reclaimed step terminal earns the generous reclaim cap (recovers past the generic cap)', async () => {
    // Generic infra cap = 1 (would give up after 2 attempts); reclaim cap = 3.
    // The step phase reports `spot_reclaimed` three times then succeeds. If the
    // reclaim were mis-classified as `container_unavailable` (the pre-fix bug),
    // the generic cap of 1 would terminate it after 2 attempts. Recovery on the
    // 4th attempt proves the reclaim cap was applied — the regression guard.
    process.env.FINALIZE_MAX_INFRA_RETRY_GENERATIONS = '1';
    process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS = '3';
    let calls = 0;
    const steps = vi.fn(async () => {
      calls += 1;
      return calls <= 3 ? STEP_INFRA_SPOT : STEPS_OK;
    });
    const { deps, stmts } = makeDeps({ runStepPhase: steps as never });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');
    expect(calls).toBe(4); // original + 3 reclaim retries
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(4);
  });

  it('terminates as spot_reclaimed (not container_unavailable) when reclaim retries are exhausted', async () => {
    process.env.FINALIZE_MAX_RECLAIM_RETRY_GENERATIONS = '2';
    const steps = vi.fn(async () => STEP_INFRA_SPOT);
    const { deps, stmts } = makeDeps({ runStepPhase: steps as never });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.status).toBe('infra_error');
      expect(result.failureReason).toBe('spot_reclaimed');
    }
    expect(steps).toHaveBeenCalledTimes(3); // original + 2 reclaim retries
    const rows = Array.from(stmts.rows.values());
    expect(rows).toHaveLength(3);
    const retry = rows.find((r) => r.retry_of_run_id)!;
    expect(retry.failure_reason).toBe('spot_reclaimed');
  });
});

// ─── §14 metric emission contract ─────────────────────────────────────

/**
 * Pull every `insertFinalizeMetric.run` call as a structured row so
 * tests can assert on the metric name + labels without re-parsing JSON
 * on every line.
 */
function readMetricCalls(stmts: ReturnType<typeof makeStmts>): Array<{
  projectId: string;
  name: string;
  labels: Record<string, unknown>;
  value: number;
  runId: string | null;
}> {
  const fn = stmts.stmts.insertFinalizeMetric.run as unknown as ReturnType<typeof vi.fn>;
  return fn.mock.calls.map((c) => ({
    projectId: c[0] as string,
    name: c[1] as string,
    labels: JSON.parse(c[2] as string) as Record<string, unknown>,
    value: c[3] as number,
    runId: c[4] as string | null,
  }));
}

describe('__test.statusFromOutcome', () => {
  it('maps each outcome kind to the §14 status label', () => {
    const map = __test.statusFromOutcome;
    expect(map({ kind: 'pushed', runId: 'r', prUrl: 'u' })).toBe('pushed');
    expect(map({ kind: 'cancelled', runId: 'r' })).toBe('cancelled');
    expect(map({ kind: 'stalled', runId: 'r' })).toBe('stalled_no_response');
    expect(map({ kind: 'failed', runId: 'r', status: 'infra_error', failureReason: 'x' })).toBe(
      'infra_error',
    );
    expect(map({ kind: 'failed', runId: 'r', status: 'timed_out', failureReason: 't' })).toBe(
      'timed_out',
    );
  });

  it('returns undefined for the `reused` short-circuit so terminal metrics suppress', () => {
    expect(
      __test.statusFromOutcome({ kind: 'reused', runId: 'r', status: 'pushed' }),
    ).toBeUndefined();
  });
});

describe('runFinalize — §14 metric emission', () => {
  it('emits started + every terminal metric on a single-attempt ready_to_push run', async () => {
    const { deps, stmts } = makeDeps();
    await runFinalize(deps, baseOpts());
    const rows = readMetricCalls(stmts);
    const names = rows.map((r) => r.name);
    // One started, one completed, one active_seconds, one wall_seconds,
    // one fix_dispatch_count (single attempt = family terminal).
    expect(names.filter((n) => n === 'finalize_run_started')).toHaveLength(1);
    expect(names.filter((n) => n === 'finalize_run_completed')).toHaveLength(1);
    expect(names.filter((n) => n === 'finalize_run_active_seconds')).toHaveLength(1);
    expect(names.filter((n) => n === 'finalize_run_wall_seconds')).toHaveLength(1);
    expect(names.filter((n) => n === 'finalize_fix_dispatch_count')).toHaveLength(1);
    const completed = rows.find((r) => r.name === 'finalize_run_completed');
    expect(completed?.labels).toMatchObject({
      status: 'ready_to_push',
      trigger_source: 'ui_button',
    });
    const started = rows.find((r) => r.name === 'finalize_run_started');
    expect(started?.labels).toMatchObject({ trigger_source: 'ui_button' });
  });

  it('emits one reviewer-verdict row per loop iteration with attempt_index', async () => {
    const { deps, stmts } = makeDeps();
    await runFinalize(deps, baseOpts());
    const verdicts = readMetricCalls(stmts).filter((r) => r.name === 'finalize_reviewer_verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].labels).toMatchObject({ verdict: 'approved', attempt_index: 1 });
  });

  it('emits no metrics on the `reused` short-circuit (idempotent re-trigger)', async () => {
    // First call seeds the row; second call short-circuits as `reused`.
    const { deps, stmts } = makeDeps();
    await runFinalize(deps, baseOpts());
    const fn = stmts.stmts.insertFinalizeMetric.run as unknown as ReturnType<typeof vi.fn>;
    const callsBefore = fn.mock.calls.length;
    const second = await runFinalize(deps, baseOpts());
    expect(second.kind).toBe('reused');
    // Zero additional metric rows: started suppressed by the early
    // `reused` return, terminal suppressed by `statusFromOutcome` → undefined.
    expect(fn.mock.calls.length).toBe(callsBefore);
  });

  it('keeps started/completed symmetric across an infra-retried family', async () => {
    // First rebase attempt throws → `container_unavailable` (infra) →
    // §10 triggers the one auto-retry. Second attempt also throws so
    // the retry terminates `infra_error` too. We're not asserting the
    // retry succeeds; we're asserting metric symmetry.
    const rebase = vi
      .fn()
      .mockRejectedValueOnce(new Error('first wedge'))
      .mockRejectedValueOnce(new Error('second wedge'));
    const { deps, stmts } = makeDeps({ runRebasePhase: rebase as never });
    await runFinalize(deps, baseOpts());
    const rows = readMetricCalls(stmts);
    const counts = (name: string) => rows.filter((r) => r.name === name).length;
    // One started + one completed per attempt = 2 of each.
    expect(counts('finalize_run_started')).toBe(2);
    expect(counts('finalize_run_completed')).toBe(2);
    expect(counts('finalize_run_active_seconds')).toBe(2);
    expect(counts('finalize_run_wall_seconds')).toBe(2);
    // fix_dispatch_count fires ONCE per family (cumulative counter,
    // sealed only at the FINAL terminal — attempt 2).
    expect(counts('finalize_fix_dispatch_count')).toBe(1);
  });
});

// ─── §3 decision trace ───────────────────────────────────────────────
// Regression for the "Finalize is acting funny and there's no way to see
// which branch the state machine took" report (session fcc171ca). The
// orchestrator emits one structured `[finalize-trace]` line per phase
// decision so the implementation→test→review→push path is reconstructable
// from PM2 logs without a debugger.

/** Pull the `event=` token out of a `[finalize-trace] ...` line. */
function traceEvents(log: ReturnType<typeof vi.fn>): string[] {
  return log.mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.startsWith('[finalize-trace] '))
    .map((line) => {
      const m = line.match(/\bevent=(\S+)/);
      return m ? m[1] : '';
    })
    .filter(Boolean);
}

describe('finalizeTraceEnabled', () => {
  const original = process.env.FINALIZE_TRACE;
  afterEach(() => {
    if (original === undefined) delete process.env.FINALIZE_TRACE;
    else process.env.FINALIZE_TRACE = original;
  });

  it('defaults ON when the env var is unset', () => {
    delete process.env.FINALIZE_TRACE;
    expect(__test.finalizeTraceEnabled()).toBe(true);
  });

  it('treats off / 0 / false (any case, padded) as disabled', () => {
    for (const v of ['off', '0', 'false', 'OFF', ' Off ', 'False']) {
      process.env.FINALIZE_TRACE = v;
      expect(__test.finalizeTraceEnabled()).toBe(false);
    }
  });

  it('treats any other value as enabled', () => {
    for (const v of ['on', '1', 'true', 'yes', '']) {
      process.env.FINALIZE_TRACE = v;
      expect(__test.finalizeTraceEnabled()).toBe(true);
    }
  });
});

describe('formatTraceFields', () => {
  it('renders key=value, dropping null/undefined and JSON-encoding non-strings', () => {
    const line = __test.formatTraceFields({
      event: 'rebase',
      run: 'run-1',
      round: 2,
      ok: true,
      head: 'deadbeef',
      missing: null,
      absent: undefined,
    });
    expect(line).toBe('event=rebase run=run-1 round=2 ok=true head=deadbeef');
  });

  it('quotes string values that contain whitespace so they stay one field', () => {
    // A failedStep like `npm run test` must not spill into the next field.
    const line = __test.formatTraceFields({
      event: 'checks',
      failedStep: 'npm run test',
      decision: 'fix_dispatch',
    });
    expect(line).toBe('event=checks failedStep="npm run test" decision=fix_dispatch');
    // A quote-aware tokenizer sees exactly three `key=value` fields — the
    // spaces inside the quoted value did not open new fields.
    const fields = line.match(/\w+=(?:"(?:[^"\\]|\\.)*"|[^\s]*)/g);
    expect(fields).toEqual(['event=checks', 'failedStep="npm run test"', 'decision=fix_dispatch']);
  });

  it('escapes newlines, quotes, equals, and backslashes in string values', () => {
    expect(__test.formatTraceFields({ reason: 'line1\nline2' })).toBe('reason="line1\\nline2"');
    expect(__test.formatTraceFields({ name: 'a=b' })).toBe('name="a=b"');
    expect(__test.formatTraceFields({ name: 'say "hi"' })).toBe('name="say \\"hi\\""');
    expect(__test.formatTraceFields({ path: 'a\\b' })).toBe('path="a\\\\b"');
    // An empty string is quoted rather than rendering a bare `key=`.
    expect(__test.formatTraceFields({ empty: '' })).toBe('empty=""');
  });
});

describe('runFinalize — decision trace', () => {
  const original = process.env.FINALIZE_TRACE;
  afterEach(() => {
    if (original === undefined) delete process.env.FINALIZE_TRACE;
    else process.env.FINALIZE_TRACE = original;
  });

  it('emits one trace line per phase decision across a happy-path run', async () => {
    delete process.env.FINALIZE_TRACE;
    const log = vi.fn();
    const { deps } = makeDeps({ log });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');

    const events = traceEvents(log);
    // The full implementation→test→review→push path is reconstructable.
    expect(events).toContain('attempt_start');
    expect(events).toContain('loop_enter');
    expect(events).toContain('rebase');
    expect(events).toContain('ci_parsed');
    expect(events).toContain('reviewer');
    expect(events).toContain('checks');
    expect(events).toContain('combined_gate');
    expect(events).toContain('push_gate');
    expect(events).toContain('ready_to_push');

    // Every trace line carries the run id and mode for log correlation.
    const traceLines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith('[finalize-trace] '));
    expect(traceLines.length).toBeGreaterThan(0);
    for (const line of traceLines) {
      expect(line).toMatch(/\brun=run-1\b/);
      expect(line).toMatch(/\bmode=full\b/);
    }

    // The combined gate records the actual decision it took.
    const gateLine = traceLines.find((l) => l.includes('event=combined_gate'));
    expect(gateLine).toMatch(/stepsGreen=true/);
    expect(gateLine).toMatch(/reviewerApproved=true/);
    expect(gateLine).toMatch(/decision=push_gate/);
  });

  it('emits nothing when FINALIZE_TRACE=off', async () => {
    process.env.FINALIZE_TRACE = 'off';
    const log = vi.fn();
    const { deps } = makeDeps({ log });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');

    const traceLines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith('[finalize-trace] '));
    expect(traceLines).toHaveLength(0);
  });

  it('traces the reviewer-changes-requested → fix-dispatch branch', async () => {
    delete process.env.FINALIZE_TRACE;
    const log = vi.fn();
    // First review pass requests changes, second approves; fix dispatch
    // ends the turn so the loop re-enters.
    const review = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'success',
        verdict: 'changes_requested',
        threadCount: 1,
        activeSecondsBilled: 5,
      } satisfies ReviewerDispatchOutcome)
      .mockResolvedValueOnce({
        kind: 'success',
        verdict: 'approved',
        threadCount: 0,
        activeSecondsBilled: 5,
      } satisfies ReviewerDispatchOutcome);
    // Fix dispatch lands a commit → HEAD advances on iteration 2 so the
    // no-progress guard does not short-circuit the second review pass.
    const resolveHead = vi
      .fn<(...args: unknown[]) => Promise<string>>()
      .mockResolvedValueOnce('sha-pre-fix')
      .mockResolvedValueOnce('sha-post-fix')
      .mockResolvedValueOnce('sha-post-fix');
    const { deps } = makeDeps({
      runReviewerDispatch: review as never,
      resolveHeadSha: resolveHead,
      log,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('ready_to_push');

    const events = traceEvents(log);
    expect(events).toContain('fix_dispatch');
    // Two loop iterations means two combined_gate decisions.
    expect(events.filter((e) => e === 'combined_gate').length).toBeGreaterThanOrEqual(2);

    const fixLines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('event=fix_dispatch'));
    expect(fixLines.some((l) => l.includes('phase=dispatching'))).toBe(true);
    expect(fixLines.some((l) => l.includes('phase=settled'))).toBe(true);
  });
});
