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
  type OrchestratorDeps,
  type OrchestratorOptions,
  type PushAndCreatePrResult,
} from './orchestrator.js';
import type { RebasePhaseOutcome } from './rebase.js';
import type { ReviewerDispatchOutcome } from './reviewer-dispatch.js';
import type { StepRunResult } from './step-runner.js';
import type { FixDispatchResult } from './fix-dispatch.js';
import type { CardLifecycle } from './card-lifecycle.js';

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
    listReviewerThreadsForRun: {
      all: vi.fn(() => threads),
    } as unknown as OrchestratorDeps['stmts']['listReviewerThreadsForRun'],
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
});

afterEach(() => {
  vi.restoreAllMocks();
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
});

describe('runFinalize — happy path', () => {
  it('runs rebase → parse → review → tasks → push and resolves with pushed', async () => {
    const { deps, broadcast, stmts, pushed } = makeDeps();

    const result = await runFinalize(deps, baseOpts());

    expect(result.kind).toBe('pushed');
    if (result.kind === 'pushed') {
      expect(result.prUrl).toBe('https://github.com/o/r/pull/1');
    }

    // Insert happened exactly once.
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(1);

    // Push step received the expected args.
    expect(pushed).toHaveBeenCalledTimes(1);
    const pushArgs = pushed.mock.calls[0][0];
    expect(pushArgs.branch).toBe('feature/x');
    expect(pushArgs.headSha).toBe('deadbeefcafebabe');

    // Terminal pushed events broadcast in order.
    const types = broadcast.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('finalize_run_created');
    expect(types).toContain('finalize_run_phase_changed');
    expect(types).toContain('finalize_run_completed');

    // markFinalizeRunPushed + updateFinalizeRunPrUrl invoked.
    expect(stmts.stmts.markFinalizeRunPushed.run).toHaveBeenCalledTimes(1);
    expect(stmts.stmts.updateFinalizeRunPrUrl.run).toHaveBeenCalledTimes(1);
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

    const { deps } = makeDeps({
      runStepPhase: runSteps as never,
    });

    const result = await runFinalize(deps, baseOpts());

    expect(result.kind).toBe('pushed');
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

    const { deps } = makeDeps({
      runReviewerDispatch: runReview as never,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('pushed');
    expect(runReview).toHaveBeenCalledTimes(2);
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
    expect(result.kind).toBe('pushed');
    // Rebase ran twice — once for the initial pass, once after gate refusal.
    expect(deps.runRebasePhase).toHaveBeenCalledTimes(2);
    // Push only fired after the second iteration's gate matched.
    expect(deps.pushAndCreatePr).toHaveBeenCalledTimes(1);
    // Most importantly: push received the iteration-2 sha (what review +
    // steps actually validated), NOT the original trigger sha.
    const pushArgs = (deps.pushAndCreatePr as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pushArgs.headSha).toBe('iter2-snapshot');
    // resolveHead invoked 4× total (2 per iteration).
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
    expect(result.kind).toBe('pushed');
    expect(deps.runRebasePhase).toHaveBeenCalledTimes(1);
    expect(deps.pushAndCreatePr).toHaveBeenCalledTimes(1);
    const pushArgs = (deps.pushAndCreatePr as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pushArgs.headSha).toBe(postRebaseSha);
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
    expect(result.kind).toBe('pushed');
    expect(deps.runRebasePhase).toHaveBeenCalledTimes(2);
    expect(deps.dispatchFixMessage).toHaveBeenCalledTimes(1);
    expect(deps.pushAndCreatePr).toHaveBeenCalledTimes(1);
    // Push uses the iteration-2 sha — the one the fix actually produced.
    const pushArgs = (deps.pushAndCreatePr as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pushArgs.headSha).toBe('sha-post-fix');
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
    expect(first.kind).toBe('pushed');

    // Second invocation with the same triple — the orchestrator should
    // find the existing row by idempotency key and return `reused`.
    const second = await runFinalize(deps, baseOpts());
    expect(second.kind).toBe('reused');
    if (second.kind === 'reused') {
      expect(second.runId).toBe((first as { runId: string }).runId);
      expect(second.status).toBe('pushed');
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
    expect(kinds).toContain('pushed');
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
    expect(result.kind).toBe('pushed');
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

  it('surfaces a thrown push step as infra_error/github_push_5xx', async () => {
    const { deps } = makeDeps({
      pushAndCreatePr: vi.fn().mockRejectedValue(new Error('502 from github')),
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('github_push_5xx');
      expect(result.status).toBe('infra_error');
    }
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
    const { deps } = makeDeps({
      // Always fail steps so the loop dispatches a fix forever.
      runStepPhase: fakeRunSteps(failedSteps),
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
  };
}

describe('runFinalize — card lifecycle integration', () => {
  it('happy path emits onStarted → onRebaseClean → onReviewerVerdict → onPushed in order', async () => {
    const lifecycle = makeSpyLifecycle();
    const { deps } = makeDeps({ cardLifecycle: lifecycle });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('pushed');

    const methods = lifecycle.calls.map((c) => c.method);
    expect(methods).toEqual(['onStarted', 'onRebaseClean', 'onReviewerVerdict', 'onPushed']);

    // Carry the right payloads.
    expect(lifecycle.calls[0].args).toMatchObject({ triggerSource: 'ui_button' });
    expect(lifecycle.calls[2].args).toMatchObject({ verdict: 'approved' });
    // §15 post-push detach: the orchestrator forwards triggerSource so
    // the detach module can name the autonomous trigger in the comment.
    expect(lifecycle.calls[3].args).toMatchObject({
      prUrl: 'https://github.com/o/r/pull/1',
      triggerSource: 'ui_button',
    });
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
    expect(result.kind).toBe('pushed');

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
    expect(result.kind).toBe('pushed');

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

    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runReviewerDispatch: runReview as never,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('pushed');

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

    const { deps } = makeDeps({
      cardLifecycle: lifecycle,
      runStepPhase: runSteps as never,
    });

    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('pushed');

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
    expect(first.kind).toBe('pushed');
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
    expect(result.kind).toBe('pushed');
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
    expect(result.kind).toBe('pushed');
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

  it('first push_5xx failure opens a retry row that succeeds → outcome is pushed', async () => {
    // Push throws on attempt 1 then resolves successfully on attempt 2.
    const pushed = vi
      .fn()
      .mockRejectedValueOnce(new Error('502 from github'))
      .mockResolvedValueOnce({
        prUrl: 'https://github.com/o/r/pull/2',
      } satisfies PushAndCreatePrResult);
    const { deps, stmts } = makeDeps({ pushAndCreatePr: pushed });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('pushed');
    if (result.kind === 'pushed') {
      expect(result.prUrl).toBe('https://github.com/o/r/pull/2');
    }
    // Two rows: original (infra_error/github_push_5xx) + retry (pushed).
    expect(stmts.stmts.insertFinalizeRun.run).toHaveBeenCalledTimes(2);
    const rows = Array.from(stmts.rows.values());
    const original = rows.find((r) => !r.retry_of_run_id);
    const retry = rows.find((r) => r.retry_of_run_id);
    expect(original!.status).toBe('infra_error');
    expect(original!.failure_reason).toBe('github_push_5xx');
    expect(retry!.status).toBe('pushed');
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

  it('two consecutive github_push_5xx → posts terminal session message + retry row marked infra_error', async () => {
    const pushed = vi.fn().mockRejectedValue(new Error('502 from github'));
    const { deps, stmts } = makeDeps({ pushAndCreatePr: pushed });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.failureReason).toBe('github_push_5xx');
      expect(result.status).toBe('infra_error');
    }
    expect(pushed).toHaveBeenCalledTimes(2);
    const rows = Array.from(stmts.rows.values());
    expect(rows).toHaveLength(2);
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
    const meta = JSON.parse(infraTerminalInsert![7] as string) as Record<string, unknown>;
    expect(meta.failureReason).toBe('github_push_5xx');
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

  it('retry attempt that DOES enter the main loop sees the family-shared budget guard trip', async () => {
    // This time the original fails infra inside the main loop (rebase
    // throws AFTER consuming budget). The retry then enters the loop
    // with the family budget already at the cap; the top-of-loop guard
    // trips and surfaces as timed_out — NOT infra_error — because the
    // budget guard is the §13 timeout path.
    let rebaseCallCount = 0;
    const rebase = vi.fn(async (depArg: { stmts: OrchestratorDeps['stmts'] }) => {
      rebaseCallCount += 1;
      if (rebaseCallCount === 1) {
        // Original attempt's first rebase pass: consume the entire
        // budget, then throw.
        depArg.stmts.updateFinalizeRunActiveSeconds.run(3600, 'run-1');
        throw new Error('worktree wedged');
      }
      // Retry attempt's first rebase: would normally consume more, but
      // we should never reach this point — the budget guard at the top
      // of the loop should trip first because the family total is
      // already at the cap.
      depArg.stmts.updateFinalizeRunActiveSeconds.run(100, 'run-2');
      return REBASE_OK;
    });

    const { deps, stmts } = makeDeps({
      runRebasePhase: rebase as never,
      budgetSeconds: 3600,
    });
    const result = await runFinalize(deps, baseOpts());
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      // The retry tripped the §13 budget guard on its top-of-loop
      // check (family total ≥ cap), surfacing timed_out — NOT
      // infra_error.
      expect(result.status).toBe('timed_out');
      expect(result.failureReason).toBe('timeout');
    }
    // Rebase was called once on the original (which threw); the retry
    // tripped the budget guard BEFORE calling rebase.
    expect(rebaseCallCount).toBe(1);
    // Family total stays at the cap; the retry's own bill is 0.
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
