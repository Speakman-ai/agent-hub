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
    | { ok: true; config: { version: 1; on: ['finalize']; timeoutMinutes: 60; steps: [] } }
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
