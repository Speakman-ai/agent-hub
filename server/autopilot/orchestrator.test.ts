import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { createAutopilotController } from './controller.js';
import { createAutopilotOrchestrator } from './orchestrator.js';
import type {
  AutopilotBaselineSpec,
  AutopilotBoardPort,
  AutopilotDeployPort,
  AutopilotDeployResult,
  AutopilotEvaluatePort,
  AutopilotFinalizePort,
  AutopilotFinalizeResult,
  AutopilotPlannerPort,
  AutopilotSessionPort,
} from './orchestrator.js';
import {
  type AutopilotEvaluationReport,
  type AutopilotExecutionCapture,
  writeCycleVerification,
} from './evaluate.js';
import { AutopilotStore } from './store.js';
import { ensureAutopilotSchema } from './schema.js';

const PROJECT = 'demo-app';
const ACTOR = { userId: 'user-1' };

const READY = {
  brief: 'Build a disposable todo API with a browser-testable list page.',
  target: {
    targetId: 'local-preview',
    origin: 'http://127.0.0.1:4310',
    readinessProbeUrl: 'http://127.0.0.1:4310/health',
  },
  limits: {
    cycleMode: 'continuous' as const,
    maxWallTimeMs: 60 * 60 * 1000,
    maxStageTimeoutMs: 10 * 60 * 1000,
    maxRetriesPerStage: 2,
  },
  credentialOwnerUserId: 'user-1',
};

const SPEC: AutopilotBaselineSpec = {
  assumptions: ['single-user', 'disposable data'],
  acceptanceJourneys: [
    { action: 'create a todo', expectedResult: 'it appears in the list' },
    { action: 'see the list', expectedResult: 'existing todos are shown' },
  ],
  nonGoals: ['auth', 'multi-tenant'],
  specDecisions: [{ key: 'storage', decision: 'in-memory sqlite' }],
  storageRecovery: 'disposable',
  qualityRubricVersion: 1,
};

function fakePlanner(spec: AutopilotBaselineSpec = SPEC): AutopilotPlannerPort {
  return { expandBrief: async () => spec };
}

function fakeBoard(opts?: { ordering?: { ok: boolean; reason?: string } }): AutopilotBoardPort {
  return {
    createBaselineBoard: async () => ({
      epicId: 'epic-1',
      primaryCardId: 'card-1',
      cards: [
        { cardId: 'card-1', title: 'baseline API', phase: 1, blockedBy: [] },
        { cardId: 'card-2', title: 'list page', phase: 1, blockedBy: ['card-1'] },
      ],
    }),
    validatePhaseOrder: async () => opts?.ordering ?? { ok: true },
  };
}

function fakeSession(sessionId = 'sess-1'): AutopilotSessionPort {
  return { dispatchImplementation: async () => ({ sessionId }) };
}

function fakeFinalize(finalizeRunId = 'fin-1'): AutopilotFinalizePort {
  return { startFinalize: async () => ({ finalizeRunId }) };
}

function fakeEvaluate(sessionId = 'eval-1'): AutopilotEvaluatePort {
  return { dispatchEvaluation: async () => ({ sessionId }) };
}

function fakeDeploy(opts?: {
  deploymentId?: string;
  rollback?: AutopilotDeployResult | (() => Promise<AutopilotDeployResult>);
}): AutopilotDeployPort {
  return {
    deployRevision: async () => ({ deploymentId: opts?.deploymentId ?? 'dep-1' }),
    rollback: async () => {
      if (typeof opts?.rollback === 'function') return opts.rollback();
      return (
        opts?.rollback ?? {
          status: 'success',
          deploymentId: 'dep-rollback',
          deployedSha: 'verified-sha',
        }
      );
    },
  };
}

function stubWorkerCreds() {
  return {
    assertContainment: () => undefined,
    issueWorkerCredential: ({ projectId, runId }: { projectId: string; runId: string }) => ({
      keyName: `autopilot:${projectId}:${runId}`,
      keyId: `key-${runId}`,
      token: `ahub_worker_${runId}`,
    }),
    revokeWorkerCredential: () => undefined,
  };
}

function harness(opts?: {
  holderId?: string;
  planner?: AutopilotPlannerPort;
  board?: AutopilotBoardPort;
  session?: AutopilotSessionPort;
  finalize?: AutopilotFinalizePort;
  deploy?: AutopilotDeployPort;
  evaluate?: AutopilotEvaluatePort;
  db?: Database.Database;
  getDeployedRevision?: (projectId: string, targetId: string) => string | null;
}) {
  const db = opts?.db ?? new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureAutopilotSchema(db);
  const stubs = stubWorkerCreds();
  const controller = createAutopilotController({
    db,
    isServerEnabled: () => true,
    credentialOwnerExists: () => true,
    holderId: opts?.holderId ?? 'hub-a',
    assertContainment: stubs.assertContainment,
    issueWorkerCredential: stubs.issueWorkerCredential,
    revokeWorkerCredential: stubs.revokeWorkerCredential,
    getDeployedRevision: opts?.getDeployedRevision ?? (() => 'deadbeefcafe'),
  });
  const orchestrator = createAutopilotOrchestrator({
    controller,
    db,
    planner: opts?.planner ?? fakePlanner(),
    board: opts?.board ?? fakeBoard(),
    session: opts?.session ?? fakeSession(),
    finalize: opts?.finalize ?? fakeFinalize(),
    deploy: opts?.deploy ?? fakeDeploy(),
    evaluate: opts?.evaluate ?? fakeEvaluate(),
    artifactExists: () => ({ exists: true, mtimeMs: Date.now(), journeyTrace: true }),
  });
  const store = new AutopilotStore(db);
  return { db, controller, orchestrator, store };
}

function start(controller: ReturnType<typeof createAutopilotController>) {
  controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
  return controller.start(PROJECT, {}, ACTOR);
}

const MERGED: AutopilotFinalizeResult = {
  status: 'merged',
  mergedSha: 'deadbeefcafe',
  reviewStatus: 'approved',
};

describe('autopilot orchestrator', () => {
  it('drives a baseline cycle from plan to merged SHA (success path)', async () => {
    const { controller, orchestrator, store } = harness();
    const started = start(controller);
    const runId = started.run.id;

    // Planning expands the brief, persists the spec + board, advances to implementing.
    const afterPlan = await orchestrator.runPlanning(PROJECT);
    expect(afterPlan.run.stage).toBe('implementing');
    const brief = store.getBrief(started.run.briefId!)!;
    expect(JSON.parse(brief.spec_json!)).toMatchObject({ nonGoals: ['auth', 'multi-tenant'] });
    let cycle = store.getCycle(runId, 1)!;
    expect(cycle.specRevision).toBe(brief.revision);
    expect(cycle.cardId).toBe('card-1');
    const pinned = (
      cycle.verification as { pinned?: { criteria?: { id: string; source: string }[] } } | null
    )?.pinned;
    expect(pinned?.criteria?.map((c) => c.id)).toEqual([
      'baseline-1',
      'baseline-2',
      'cycle-1',
      'cycle-2',
    ]);

    // Implementation dispatch records the session and leaves work in flight.
    const implOp = await orchestrator.dispatchImplementation(PROJECT);
    expect(implOp.kind).toBe('implement');
    expect(implOp.sessionId).toBe('sess-1');
    cycle = store.getCycle(runId, 1)!;
    expect(cycle.sessionId).toBe('sess-1');

    // A committed session advances to finalizing.
    const implResult = await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true, commitSha: 'abc123' },
    });
    expect(implResult.advanced).toBe(true);
    expect(implResult.snapshot.run.stage).toBe('finalizing');

    // Finalize dispatch records the finalize run.
    const finOp = await orchestrator.dispatchFinalize(PROJECT);
    expect(finOp.kind).toBe('finalize');
    expect(finOp.finalizeRunId).toBe('fin-1');
    expect(store.getCycle(runId, 1)!.finalizeRunId).toBe('fin-1');

    // A merged + approved Finalize result records the tested/merged SHA.
    const finResult = await orchestrator.reconcileFinalize(PROJECT, {
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      result: MERGED,
    });
    expect(finResult.advanced).toBe(true);
    expect(finResult.outcome).toBe('succeeded');
    expect(store.getCycle(runId, 1)!.testedCommitSha).toBe('deadbeefcafe');
    expect(finResult.snapshot.run.stage).toBe('deploying');
    // Deploy verification is a later stage; the run is not yet marked verified.
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();
  });

  it('fails planning when the saved phase dependency order is invalid, but persists the chosen spec first', async () => {
    const { controller, orchestrator, store } = harness({
      board: fakeBoard({ ordering: { ok: false, reason: 'cycle: card-2 -> card-1 -> card-2' } }),
    });
    const started = start(controller);
    const snap = await orchestrator.runPlanning(PROJECT);
    // Planning failed and was scheduled for retry; the run stays running in planning.
    expect(snap.run.stage).toBe('planning');
    // The chosen spec is persisted BEFORE any work is filed, so a validation
    // failure never strands filed work without a recorded decision.
    const cycle = store.getCycle(started.run.id, 1)!;
    expect(cycle.specRevision).toBe(store.getBrief(started.run.briefId!)!.revision);
    expect(store.getBrief(started.run.briefId!)!.spec_json).toBeTruthy();
    const stages = snap.stages.filter((s) => s.stage === 'planning');
    expect(stages.some((s) => s.status === 'failed')).toBe(true);
    expect(stages.some((s) => s.status === 'pending')).toBe(true);
  });

  it('reuses the persisted spec on a planning retry instead of re-expanding the brief', async () => {
    let plannerCalls = 0;
    const countingPlanner = {
      expandBrief: async () => {
        plannerCalls += 1;
        return SPEC;
      },
    };
    // Board validation fails the first attempt, succeeds the retry.
    let validateCalls = 0;
    const togglingBoard = {
      ...fakeBoard(),
      validatePhaseOrder: async () => {
        validateCalls += 1;
        return validateCalls === 1 ? { ok: false, reason: 'transient cycle' } : { ok: true };
      },
    };
    const { controller, orchestrator, store } = harness({
      planner: countingPlanner,
      board: togglingBoard,
    });
    const started = start(controller);

    const first = await orchestrator.runPlanning(PROJECT);
    expect(first.run.stage).toBe('planning');
    expect(plannerCalls).toBe(1);

    const second = await orchestrator.runPlanning(PROJECT);
    expect(second.run.stage).toBe('implementing');
    // The planner was NOT re-invoked; the persisted decisions were reused verbatim.
    expect(plannerCalls).toBe(1);
    expect(store.getCycle(started.run.id, 1)!.cardId).toBe('card-1');
  });

  it('does not advance the cycle when Finalize review is rejected', async () => {
    const { controller, orchestrator, store } = harness();
    const started = start(controller);
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);
    await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    const finOp = await orchestrator.dispatchFinalize(PROJECT);

    const rejected = await orchestrator.reconcileFinalize(PROJECT, {
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      result: { status: 'review_rejected', reviewStatus: 'changes_requested' },
    });
    expect(rejected.advanced).toBe(false);
    expect(rejected.outcome).toBe('rejected');
    const cycle = store.getCycle(started.run.id, 1)!;
    expect(cycle.testedCommitSha).toBeNull();
    // finalizeRunId is still recorded, and the run keeps running with a retry scheduled.
    expect(cycle.finalizeRunId).toBe('fin-1');
    expect(rejected.snapshot.run.controlState).toBe('running');
    const finStages = rejected.snapshot.stages.filter((s) => s.stage === 'finalizing');
    expect(finStages.some((s) => s.status === 'failed')).toBe(true);
    expect(finStages.some((s) => s.status === 'pending')).toBe(true);
  });

  it('treats a merged claim without a real SHA as a rejection', async () => {
    const { controller, orchestrator, store } = harness();
    const started = start(controller);
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);
    await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    const finOp = await orchestrator.dispatchFinalize(PROJECT);
    const res = await orchestrator.reconcileFinalize(PROJECT, {
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      result: { status: 'merged', mergedSha: '', reviewStatus: 'approved' },
    });
    expect(res.advanced).toBe(false);
    expect(store.getCycle(started.run.id, 1)!.testedCommitSha).toBeNull();
  });

  it('does not advance after a restart supersedes the in-flight operation', async () => {
    const { db, controller, orchestrator } = harness({ holderId: 'hub-a' });
    start(controller);
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);

    // A second controller reconciles after restart: in-flight work becomes
    // ambiguous and the run parks paused with a bumped fencing generation.
    const restarted = createAutopilotController({
      db,
      isServerEnabled: () => true,
      credentialOwnerExists: () => true,
      holderId: 'hub-b',
      assertContainment: () => undefined,
      issueWorkerCredential: ({ runId }: { runId: string }) => ({
        keyName: `autopilot:${PROJECT}:${runId}`,
        keyId: `key-${runId}`,
        token: `ahub_worker_${runId}`,
      }),
      revokeWorkerCredential: () => undefined,
    });
    const reconciled = await restarted.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');

    const restartedOrch = createAutopilotOrchestrator({
      controller: restarted,
      db,
      planner: fakePlanner(),
      board: fakeBoard(),
      session: fakeSession(),
      finalize: fakeFinalize(),
      deploy: fakeDeploy(),
      evaluate: fakeEvaluate(),
    });

    // A late session callback for the superseded operation must not advance.
    const late = await restartedOrch.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    expect(late.advanced).toBe(false);
    expect(late.idempotent).toBe(true);
    expect(restarted.getRun(PROJECT, reconciled[0].run.id).run.stage).toBe('implementing');
    expect(restarted.getRun(PROJECT, reconciled[0].run.id).run.controlState).toBe('paused');
  });

  it('does not let a delayed callback from an earlier cycle advance a later cycle', async () => {
    const { controller, orchestrator, store } = harness();
    const started = start(controller);
    const runId = started.run.id;
    const cycle1Id = store.getCycle(runId, 1)!.id;

    // Cycle 1: plan, dispatch, settle the implement operation succeeded.
    await orchestrator.runPlanning(PROJECT);
    const implOp1 = await orchestrator.dispatchImplementation(PROJECT);
    await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp1.id,
      fencingGeneration: implOp1.fencingGeneration,
      result: { committed: true },
    });
    expect(implOp1.cycleId).toBe(cycle1Id);

    // Open cycle 2 and bring it to implementing with a fresh pending stage that
    // has NOT been dispatched yet (same fencing generation, no bump on new cycle).
    store.updateCycle(cycle1Id, { status: 'succeeded' });
    await controller.openNextCycle(PROJECT);
    const cycle2Id = store.getCycle(runId, 2)!.id;
    store.updateRun(runId, { stage: 'implementing' });
    store.insertStage({
      id: 'stage-cycle2-impl',
      cycleId: cycle2Id,
      stage: 'implementing',
      status: 'pending',
      attempt: 1,
      operationId: null,
      startedAt: '2026-01-01 00:00:00',
    });

    // The delayed cycle-1 callback must NOT advance cycle 2.
    const res = await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp1.id,
      fencingGeneration: implOp1.fencingGeneration,
      result: { committed: true },
    });
    expect(res.advanced).toBe(false);
    expect(store.getRun(runId)!.stage).toBe('implementing');
    const cycle2ImplStages = store.listStages(cycle2Id).filter((s) => s.stage === 'implementing');
    expect(cycle2ImplStages.every((s) => s.status === 'pending')).toBe(true);
  });

  it('runs the planner once under concurrent runPlanning calls', async () => {
    let plannerCalls = 0;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const blockingPlanner = {
      expandBrief: async () => {
        plannerCalls += 1;
        await gate;
        return SPEC;
      },
    };
    let boardCalls = 0;
    const countingBoard = {
      createBaselineBoard: async () => {
        boardCalls += 1;
        return {
          epicId: 'epic-1',
          primaryCardId: 'card-1',
          cards: [{ cardId: 'card-1', title: 'baseline', phase: 1, blockedBy: [] }],
        };
      },
      validatePhaseOrder: async () => ({ ok: true }),
    };
    const { controller, orchestrator } = harness({
      planner: blockingPlanner,
      board: countingBoard,
    });
    start(controller);

    // Two overlapping planning calls: the first claims the planning operation
    // and blocks in the planner; the second must back off, not re-plan.
    const p1 = orchestrator.runPlanning(PROJECT);
    const p2 = orchestrator.runPlanning(PROJECT);
    const r2 = await p2;
    expect(r2.run.stage).toBe('planning');
    expect(plannerCalls).toBe(1);

    releaseGate();
    const r1 = await p1;
    expect(r1.run.stage).toBe('implementing');
    // The planner and board creation each ran exactly once.
    expect(plannerCalls).toBe(1);
    expect(boardCalls).toBe(1);
  });

  it('disowns a superseded implementation dispatch instead of overwriting the current session', async () => {
    let signalLaunched: () => void = () => undefined;
    const launched = new Promise<void>((resolve) => {
      signalLaunched = resolve;
    });
    let resolveLaunch: (v: { sessionId: string }) => void = () => undefined;
    const slowSession = {
      dispatchImplementation: () => {
        signalLaunched();
        return new Promise<{ sessionId: string }>((resolve) => {
          resolveLaunch = resolve;
        });
      },
    };
    const { controller, orchestrator, store } = harness({ session: slowSession });
    const started = start(controller);
    const runId = started.run.id;
    const cycle1Id = store.getCycle(runId, 1)!.id;
    await orchestrator.runPlanning(PROJECT);

    // Reserve op1 and block in the pending launch (wait until the port is
    // actually invoked, so op1 is reserved and resolveLaunch is live).
    const p = orchestrator.dispatchImplementation(PROJECT);
    await launched;
    const op1 = store.listInFlightOperations(runId).find((o) => o.kind === 'implement')!;

    // Simulate a retry taking over while the original launch is still pending:
    // op1 is superseded (cancelled) and a newer session is recorded on the cycle.
    store.updateOperation(op1.id, { status: 'cancelled' });
    store.updateCycle(cycle1Id, { sessionId: 'sess-retry' });

    // The original launch resolves late.
    resolveLaunch({ sessionId: 'sess-obsolete' });
    await expect(p).rejects.toThrow(/superseded/);

    // The obsolete response did NOT clobber the current retry's association,
    // but is still recorded on the disowned operation for cancellation.
    expect(store.getCycle(runId, 1)!.sessionId).toBe('sess-retry');
    expect(store.getOperation(op1.id)!.sessionId).toBe('sess-obsolete');
  });

  it('disowns a superseded Finalize dispatch instead of overwriting the current finalize run', async () => {
    let signalLaunched: () => void = () => undefined;
    const launched = new Promise<void>((resolve) => {
      signalLaunched = resolve;
    });
    let resolveLaunch: (v: { finalizeRunId: string }) => void = () => undefined;
    const slowFinalize = {
      startFinalize: () => {
        signalLaunched();
        return new Promise<{ finalizeRunId: string }>((resolve) => {
          resolveLaunch = resolve;
        });
      },
    };
    const { controller, orchestrator, store } = harness({ finalize: slowFinalize });
    const started = start(controller);
    const runId = started.run.id;
    const cycle1Id = store.getCycle(runId, 1)!.id;
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);
    await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });

    const p = orchestrator.dispatchFinalize(PROJECT);
    await launched;
    const finOp = store.listInFlightOperations(runId).find((o) => o.kind === 'finalize')!;

    store.updateOperation(finOp.id, { status: 'cancelled' });
    store.updateCycle(cycle1Id, { finalizeRunId: 'fin-retry' });

    resolveLaunch({ finalizeRunId: 'fin-obsolete' });
    await expect(p).rejects.toThrow(/superseded/);

    expect(store.getCycle(runId, 1)!.finalizeRunId).toBe('fin-retry');
    expect(store.getOperation(finOp.id)!.finalizeRunId).toBe('fin-obsolete');
  });

  it('rejects a reconcile whose operation is the wrong kind', async () => {
    const { controller, orchestrator } = harness();
    start(controller);
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);
    await expect(
      orchestrator.reconcileFinalize(PROJECT, {
        operationId: implOp.id,
        fencingGeneration: implOp.fencingGeneration,
        result: MERGED,
      }),
    ).rejects.toThrow(/not a finalize operation/);
  });

  it('is idempotent when a session callback is delivered twice', async () => {
    const { controller, orchestrator, store } = harness();
    const started = start(controller);
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);

    const first = await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    expect(first.advanced).toBe(true);
    expect(first.snapshot.run.stage).toBe('finalizing');

    const second = await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    expect(second.advanced).toBe(false);
    expect(second.idempotent).toBe(true);
    // The duplicate callback did not open a second finalizing stage.
    const cycle = store.getCycle(started.run.id, 1)!;
    const finalizingStages = store.listStages(cycle.id).filter((s) => s.stage === 'finalizing');
    expect(finalizingStages).toHaveLength(1);
  });

  it('reserves the operation before dispatching, keyed on its durable id', async () => {
    let received: { operationId: string; bounds: { maxStageTimeoutMs: number } } | null = null;
    const capturingSession = {
      dispatchImplementation: async (input: {
        operationId: string;
        bounds: { maxStageTimeoutMs: number };
      }) => {
        // The controller operation is reserved (in flight) before we are called.
        const inFlight = store
          .listInFlightOperations(started.run.id)
          .find((o) => o.kind === 'implement');
        expect(inFlight?.id).toBe(input.operationId);
        received = { operationId: input.operationId, bounds: input.bounds };
        return { sessionId: 'sess-cap' };
      },
    };
    const { controller, orchestrator, store } = harness({ session: capturingSession });
    const started = start(controller);
    await orchestrator.runPlanning(PROJECT);
    const op = await orchestrator.dispatchImplementation(PROJECT);
    expect(received).not.toBeNull();
    expect(received!.operationId).toBe(op.id);
    expect(received!.bounds.maxStageTimeoutMs).toBe(READY.limits.maxStageTimeoutMs);
    expect(op.sessionId).toBe('sess-cap');
    // A second dispatch dedups to the same reserved operation (no new session).
    const again = await orchestrator.dispatchImplementation(PROJECT);
    expect(again.id).toBe(op.id);
  });

  it('settles the operation failed and does not orphan a session when dispatch throws', async () => {
    const throwingSession = {
      dispatchImplementation: async () => {
        throw new Error('spawn failed');
      },
    };
    const { controller, orchestrator, store } = harness({ session: throwingSession });
    const started = start(controller);
    await orchestrator.runPlanning(PROJECT);
    await expect(orchestrator.dispatchImplementation(PROJECT)).rejects.toThrow(/spawn failed/);
    // The reserved operation was settled failed (retry scheduled), not left in flight.
    const inFlight = store.listInFlightOperations(started.run.id);
    expect(inFlight).toHaveLength(0);
    expect(store.getRun(started.run.id)!.controlState).toBe('running');
  });

  it('reconciles a missing implement advance after a crash between settle and advance', async () => {
    const { controller, orchestrator, store } = harness();
    const started = start(controller);
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);

    // Simulate a crash: the operation is settled succeeded via the controller,
    // but the run never advanced out of implementing.
    await controller.completeOperation({
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      outcome: 'succeeded',
      result: { commitSha: 'abc' },
    });
    expect(store.getRun(started.run.id)!.stage).toBe('implementing');

    // A repeated callback reconciles the missing advance forward.
    const res = await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    expect(res.idempotent).toBe(true);
    expect(res.advanced).toBe(true);
    expect(res.snapshot.run.stage).toBe('finalizing');
  });

  it('recovers a merged SHA from the durable operation result after a crash', async () => {
    const { controller, orchestrator, store } = harness();
    const started = start(controller);
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);
    await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    const finOp = await orchestrator.dispatchFinalize(PROJECT);

    // Simulate a crash: the finalize operation is settled succeeded with the
    // merged SHA on its durable result, but the cycle write never happened.
    await controller.completeOperation({
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      outcome: 'succeeded',
      result: { mergedSha: 'deadbeefcafe' },
    });
    expect(store.getCycle(started.run.id, 1)!.testedCommitSha).toBeNull();

    const res = await orchestrator.reconcileFinalize(PROJECT, {
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      result: MERGED,
    });
    expect(res.idempotent).toBe(true);
    expect(res.advanced).toBe(true);
    expect(store.getCycle(started.run.id, 1)!.testedCommitSha).toBe('deadbeefcafe');
    expect(store.getRun(started.run.id)!.stage).toBe('deploying');
  });

  it('reconciles a missing planning advance after a crash between settle and advance', async () => {
    let plannerCalls = 0;
    const countingPlanner = {
      expandBrief: async () => {
        plannerCalls += 1;
        return SPEC;
      },
    };
    const { controller, orchestrator, store } = harness({ planner: countingPlanner });
    const started = start(controller);
    const cycleId = store.getCycle(started.run.id, 1)!.id;
    // Simulate a crash: the pre-created planning operation is settled succeeded
    // (spec persisted) via the controller, but the run never advanced.
    store.updateBriefSpec(started.run.briefId!, JSON.stringify(SPEC));
    store.updateCycle(cycleId, {
      specRevision: store.getBrief(started.run.briefId!)!.revision,
      cardId: 'card-1',
    });
    const planOp = started.operations[0];
    await controller.completeOperation({
      operationId: planOp.id,
      fencingGeneration: planOp.fencingGeneration,
      outcome: 'succeeded',
      result: { epicId: 'epic-1' },
    });
    expect(store.getRun(started.run.id)!.stage).toBe('planning');

    const snap = await orchestrator.runPlanning(PROJECT);
    expect(snap.run.stage).toBe('implementing');
    // Planning was never re-run: the succeeded planning stage reconciled forward.
    expect(plannerCalls).toBe(0);
  });

  it('is idempotent when a Finalize callback is delivered twice', async () => {
    const { controller, orchestrator, store } = harness();
    const started = start(controller);
    await orchestrator.runPlanning(PROJECT);
    const implOp = await orchestrator.dispatchImplementation(PROJECT);
    await orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    const finOp = await orchestrator.dispatchFinalize(PROJECT);
    const first = await orchestrator.reconcileFinalize(PROJECT, {
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      result: MERGED,
    });
    expect(first.advanced).toBe(true);
    const second = await orchestrator.reconcileFinalize(PROJECT, {
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      result: MERGED,
    });
    expect(second.idempotent).toBe(true);
    expect(second.advanced).toBe(false);
    // The tested SHA was recorded exactly once and remains stable.
    expect(store.getCycle(started.run.id, 1)!.testedCommitSha).toBe('deadbeefcafe');
    expect(store.getRun(started.run.id)!.stage).toBe('deploying');
  });
});

async function reachDeploying(
  orchestrator: ReturnType<typeof createAutopilotOrchestrator>,
  controller: ReturnType<typeof createAutopilotController>,
) {
  start(controller);
  await orchestrator.runPlanning(PROJECT);
  const implOp = await orchestrator.dispatchImplementation(PROJECT);
  await orchestrator.reconcileImplementation(PROJECT, {
    operationId: implOp.id,
    fencingGeneration: implOp.fencingGeneration,
    result: { committed: true },
  });
  const finOp = await orchestrator.dispatchFinalize(PROJECT);
  await orchestrator.reconcileFinalize(PROJECT, {
    operationId: finOp.id,
    fencingGeneration: finOp.fencingGeneration,
    result: MERGED,
  });
}

describe('autopilot orchestrator — deploy', () => {
  it('deploys the exact merged SHA and advances to verifying without marking last-known-good', async () => {
    const { controller, orchestrator, store } = harness();
    await reachDeploying(orchestrator, controller);
    const depOp = await orchestrator.dispatchDeploy(PROJECT);
    expect(depOp.kind).toBe('deploy');
    expect(depOp.deploymentId).toBe('dep-1');
    const runId = store.getActiveRun(PROJECT)!.id;
    expect(store.getCycle(runId, 1)!.deploymentId).toBe('dep-1');

    const result = await orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'success', deploymentId: 'dep-1', deployedSha: 'deadbeefcafe' },
    });
    expect(result.advanced).toBe(true);
    expect(result.snapshot.run.stage).toBe('verifying');
    expect(store.getCycle(runId, 1)!.deploymentId).toBe('dep-1');
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();
    expect(store.getRun(runId)!.lastDeploymentId).toBeNull();
  });

  it('does not advance when the live SHA does not match the merged revision', async () => {
    const { controller, orchestrator, store } = harness();
    await reachDeploying(orchestrator, controller);
    const depOp = await orchestrator.dispatchDeploy(PROJECT);
    const result = await orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'success', deploymentId: 'dep-1', deployedSha: 'wrong-sha' },
    });
    expect(result.advanced).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(store.getActiveRun(PROJECT)!.controlState).toBe('paused');
    expect(store.getActiveRun(PROJECT)!.pauseReason).toMatch(/no last-known-good/);
    expect(store.getActiveRun(PROJECT)!.lastVerifiedSha).toBeNull();
  });

  it('rolls back to the last verified artifact on a failed candidate', async () => {
    const { controller, orchestrator, store } = harness({
      deploy: fakeDeploy({
        rollback: {
          status: 'success',
          deploymentId: 'dep-lkg',
          deployedSha: 'verified-sha',
        },
      }),
    });
    await reachDeploying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
      updatedAt: store.getRun(runId)!.updatedAt,
    });
    const depOp = await orchestrator.dispatchDeploy(PROJECT);
    const result = await orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'error', deploymentId: 'dep-1', message: 'step failed' },
    });
    expect(result.advanced).toBe(false);
    expect(store.getRun(runId)!.controlState).toBe('paused');
    expect(store.getRun(runId)!.pauseReason).toMatch(/recovered last-known-good/);
    expect(store.getRun(runId)!.lastVerifiedSha).toBe('verified-sha');
    expect(store.getRun(runId)!.lastDeploymentId).toBe('dep-lkg');
  });

  it('pauses when rollback does not restore the last verified SHA', async () => {
    const { controller, orchestrator, store } = harness({
      deploy: fakeDeploy({
        rollback: {
          status: 'success',
          deploymentId: 'dep-bad',
          deployedSha: 'not-the-lkg',
        },
      }),
    });
    await reachDeploying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
      updatedAt: store.getRun(runId)!.updatedAt,
    });
    const depOp = await orchestrator.dispatchDeploy(PROJECT);
    await orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'error', deploymentId: 'dep-1' },
    });
    expect(store.getRun(runId)!.controlState).toBe('paused');
    expect(store.getRun(runId)!.pauseReason).toBe('rollback failed');
    expect(store.getRun(runId)!.lastVerifiedSha).toBe('verified-sha');
  });

  it('reuses an in-flight deploy operation instead of launching a duplicate', async () => {
    const { controller, orchestrator } = harness();
    await reachDeploying(orchestrator, controller);
    const first = await orchestrator.dispatchDeploy(PROJECT);
    const second = await orchestrator.dispatchDeploy(PROJECT);
    expect(second.id).toBe(first.id);
  });

  it('halts when the experiment target parks for approval', async () => {
    const { controller, orchestrator, store } = harness();
    await reachDeploying(orchestrator, controller);
    const depOp = await orchestrator.dispatchDeploy(PROJECT);
    await orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'awaiting_approval', deploymentId: 'dep-1' },
    });
    expect(store.getActiveRun(PROJECT)!.controlState).toBe('paused');
    expect(store.getActiveRun(PROJECT)!.pauseReason).toMatch(/unattended deploy is not authorized/);
  });

  it('pauses before deploying when a last-known-good exists and storage cannot be rolled back', async () => {
    const { controller, orchestrator, store } = harness();
    await reachDeploying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    const run = store.getRun(runId)!;
    store.updateBriefSpec(
      run.briefId!,
      JSON.stringify({
        ...SPEC,
        specDecisions: [{ key: 'storage', decision: 'postgres migration rewriting user rows' }],
        storageRecovery: 'unsupported',
      }),
    );
    store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
      updatedAt: run.updatedAt,
    });
    await orchestrator.dispatchDeploy(PROJECT);
    expect(store.getRun(runId)!.controlState).toBe('paused');
    expect(store.getRun(runId)!.pauseReason).toMatch(/unsupported data migration/);
  });

  it('pauses before deploying when mixed storage prose is not an exact recovery contract', async () => {
    const { controller, orchestrator, store } = harness();
    await reachDeploying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    const run = store.getRun(runId)!;
    store.updateBriefSpec(
      run.briefId!,
      JSON.stringify({
        ...SPEC,
        specDecisions: [
          {
            key: 'storage',
            decision: 'persistent PostgreSQL; destructive migration; disposable test fixtures',
          },
        ],
        storageRecovery: 'unknown',
      }),
    );
    store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
      updatedAt: run.updatedAt,
    });
    await orchestrator.dispatchDeploy(PROJECT);
    expect(store.getRun(runId)!.controlState).toBe('paused');
    expect(store.getRun(runId)!.pauseReason).toMatch(/cannot be established/);
  });

  it('pauses a first deploy when storageRecovery is unsupported', async () => {
    const { controller, orchestrator, store } = harness();
    await reachDeploying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    const run = store.getRun(runId)!;
    expect(run.lastVerifiedSha).toBeNull();
    store.updateBriefSpec(
      run.briefId!,
      JSON.stringify({ ...SPEC, storageRecovery: 'unsupported' }),
    );
    await orchestrator.dispatchDeploy(PROJECT);
    expect(store.getRun(runId)!.controlState).toBe('paused');
    expect(store.getRun(runId)!.pauseReason).toMatch(/unsupported data migration/);
  });

  it('pauses a first deploy when storageRecovery is unknown', async () => {
    const { controller, orchestrator, store } = harness();
    await reachDeploying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    const run = store.getRun(runId)!;
    expect(run.lastVerifiedSha).toBeNull();
    store.updateBriefSpec(run.briefId!, JSON.stringify({ ...SPEC, storageRecovery: 'unknown' }));
    await orchestrator.dispatchDeploy(PROJECT);
    expect(store.getRun(runId)!.controlState).toBe('paused');
    expect(store.getRun(runId)!.pauseReason).toMatch(/cannot be established/);
  });
});

function parsePinned(store: AutopilotStore, runId: string) {
  return (
    (
      store.getCycle(runId, 1)!.verification as {
        pinned?: { criteria?: { source: string }[] };
      } | null
    )?.pinned?.criteria ?? []
  );
}

function passingEvalCaptures(
  operationId: string,
  report: AutopilotEvaluationReport = passingEvalReport(),
): AutopilotExecutionCapture[] {
  const capturedAt = report.capturedAt || new Date().toISOString();
  const mtimeMs = Date.parse(capturedAt) || Date.now();
  return report.criteria.flatMap((ev, i): AutopilotExecutionCapture[] => {
    if (ev.kind === 'api_check' && ev.apiCheck) {
      return [
        {
          captureId: `cap-${ev.criterionId}`,
          criterionId: ev.criterionId,
          kind: 'api_check' as const,
          capturedAt,
          operationId,
          deploymentId: 'dep-1',
          expectedSha: 'deadbeefcafe',
          origin: 'http://127.0.0.1:4310',
          screenshot: null,
          trace: null,
          api: {
            requestId: `req-${ev.criterionId}-${i}`,
            method: ev.apiCheck.method,
            url: ev.apiCheck.url,
            status: ev.apiCheck.status,
            body: ev.apiCheck.body ?? ev.apiCheck.bodyExcerpt,
            bodyComplete: ev.apiCheck.bodyComplete,
            bodyExcerpt: ev.apiCheck.bodyExcerpt,
          },
        },
      ];
    }
    if (!ev.screenshotPath && !ev.tracePath) return [];
    return [
      {
        captureId: `cap-${ev.criterionId}`,
        criterionId: ev.criterionId,
        kind: 'browser_journey' as const,
        capturedAt,
        operationId,
        deploymentId: 'dep-1',
        expectedSha: 'deadbeefcafe',
        origin: 'http://127.0.0.1:4310',
        screenshot: ev.screenshotPath ? { path: ev.screenshotPath, mtimeMs } : null,
        trace: ev.tracePath ? { path: ev.tracePath, mtimeMs } : null,
        api: null,
      },
    ];
  });
}

function passingEvalReport(
  overrides: Partial<AutopilotEvaluationReport> = {},
): AutopilotEvaluationReport {
  return {
    expectedSha: 'deadbeefcafe',
    observedSha: 'deadbeefcafe',
    origin: 'http://127.0.0.1:4310',
    healthCheck: { url: 'http://127.0.0.1:4310/health', ok: true },
    capturedAt: new Date().toISOString(),
    criteria: [
      {
        criterionId: 'baseline-1',
        passed: true,
        kind: 'browser_journey',
        screenshotPath: '/tmp/eval/list.png',
        tracePath: '/tmp/eval/list.trace',
        observed: 'todos are shown',
      },
      {
        criterionId: 'baseline-2',
        passed: true,
        kind: 'browser_journey',
        screenshotPath: '/tmp/eval/list2.png',
        tracePath: '/tmp/eval/list2.trace',
        observed: 'existing todos are shown',
      },
      {
        criterionId: 'cycle-1',
        passed: true,
        kind: 'browser_journey',
        screenshotPath: '/tmp/eval/cycle1.png',
        tracePath: '/tmp/eval/cycle1.trace',
        observed: 'todos are shown',
      },
      {
        criterionId: 'cycle-2',
        passed: true,
        kind: 'browser_journey',
        screenshotPath: '/tmp/eval/cycle2.png',
        tracePath: '/tmp/eval/cycle2.trace',
        observed: 'existing todos are shown',
      },
    ],
    ...overrides,
  };
}

async function reachVerifying(
  orchestrator: ReturnType<typeof createAutopilotOrchestrator>,
  controller: ReturnType<typeof createAutopilotController>,
) {
  await reachDeploying(orchestrator, controller);
  const depOp = await orchestrator.dispatchDeploy(PROJECT);
  await orchestrator.reconcileDeploy(PROJECT, {
    operationId: depOp.id,
    fencingGeneration: depOp.fencingGeneration,
    result: { status: 'success', deploymentId: 'dep-1', deployedSha: 'deadbeefcafe' },
  });
}

describe('autopilot orchestrator — evaluate', () => {
  it('promotes last-known-good only after passing deployed evidence and advances to documenting', async () => {
    const { controller, orchestrator, store } = harness();
    await reachVerifying(orchestrator, controller);
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    expect(evalOp.kind).toBe('evaluate');
    expect(evalOp.sessionId).toBe('eval-1');
    const runId = store.getActiveRun(PROJECT)!.id;
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();

    const passing = passingEvalReport();
    const result = await orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: passing,
      captures: passingEvalCaptures(evalOp.id, passing),
    });
    expect(result.advanced).toBe(true);
    expect(result.snapshot.run.stage).toBe('documenting');
    expect(store.getRun(runId)!.lastVerifiedSha).toBe('deadbeefcafe');
    expect(store.getRun(runId)!.lastDeploymentId).toBe('dep-1');
  });

  it('rejects the wrong live revision, recovers last-known-good, and opens bounded repair', async () => {
    const { controller, orchestrator, store } = harness({
      getDeployedRevision: () => 'not-the-merged-sha',
    });
    await reachVerifying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
    });
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    const result = await orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: passingEvalReport(),
    });
    expect(result.snapshot.run.stage).toBe('implementing');
    expect(store.getRun(runId)!.stage).not.toBe('selecting-next');
    expect(store.getRun(runId)!.lastVerifiedSha).toBe('verified-sha');
    expect(store.getRun(runId)!.controlState).toBe('running');
    expect(parsePinned(store, runId).map((c) => c.source)).toContain('cycle');
  });

  it('rejects health-only false positives and starts bounded repair without promoting last-known-good', async () => {
    const { controller, orchestrator, store } = harness();
    await reachVerifying(orchestrator, controller);
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    const result = await orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: passingEvalReport({
        criteria: [],
        healthCheck: { url: 'http://127.0.0.1:4310/health', ok: true },
      }),
    });
    const runId = store.getActiveRun(PROJECT)!.id;
    expect(result.snapshot.run.stage).toBe('implementing');
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();
    expect(store.getRun(runId)!.stage).not.toBe('selecting-next');
    expect(store.getRun(runId)!.controlState).toBe('running');
    const verification = store.getCycle(runId, 1)!.verification as {
      judgement?: { reason?: string };
    };
    expect(verification.judgement?.reason).toBe('health_only');
  });

  it('treats a baseline regression as recovery plus bounded repair, not improvement selection', async () => {
    const { controller, orchestrator, store } = harness();
    await reachVerifying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
    });
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    const failing = passingEvalReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: false,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/fail.png',
          tracePath: '/tmp/eval/fail.trace',
          observed: 'list stayed empty',
        },
        {
          criterionId: 'baseline-2',
          passed: true,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/ok.png',
          tracePath: '/tmp/eval/ok.trace',
        },
        {
          criterionId: 'cycle-1',
          passed: true,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/cycle1.png',
          tracePath: '/tmp/eval/cycle1.trace',
        },
        {
          criterionId: 'cycle-2',
          passed: true,
          kind: 'browser_journey',
          screenshotPath: '/tmp/eval/cycle2.png',
          tracePath: '/tmp/eval/cycle2.trace',
        },
      ],
    });
    await orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: failing,
      captures: passingEvalCaptures(evalOp.id, failing),
    });
    expect(store.getRun(runId)!.stage).toBe('implementing');
    expect(store.getRun(runId)!.stage).not.toBe('documenting');
    expect(store.getRun(runId)!.stage).not.toBe('selecting-next');
    expect(store.getRun(runId)!.lastVerifiedSha).toBe('verified-sha');
    expect(store.getRun(runId)!.controlState).toBe('running');
    expect(parsePinned(store, runId)).toHaveLength(4);
  });

  it('pauses when the repair budget is exhausted instead of selecting an improvement', async () => {
    const { controller, orchestrator, store, db } = harness();
    await reachVerifying(orchestrator, controller);
    const runId = store.getActiveRun(PROJECT)!.id;
    store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
    });
    db.prepare(`UPDATE autopilot_runs SET limits_json = ? WHERE id = ?`).run(
      JSON.stringify({ ...READY.limits, maxRetriesPerStage: 0 }),
      runId,
    );
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    await orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: passingEvalReport({
        criteria: [],
        healthCheck: { url: 'http://127.0.0.1:4310/health', ok: true },
      }),
    });
    expect(store.getRun(runId)!.controlState).toBe('paused');
    expect(store.getRun(runId)!.stage).not.toBe('selecting-next');
    expect(store.getRun(runId)!.pauseReason).toMatch(/repair budget exhausted|health_only/);
  });

  it('promotes a primary-cycle API evaluation when Hub recorded distinct requests', async () => {
    const apiSpec: AutopilotBaselineSpec = {
      ...SPEC,
      acceptanceJourneys: [
        { action: 'GET /api/todos', expectedResult: 'returns the stored items as JSON' },
      ],
    };
    const { controller, orchestrator, store } = harness({ planner: fakePlanner(apiSpec) });
    await reachVerifying(orchestrator, controller);
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    const report = passingEvalReport({
      criteria: [
        {
          criterionId: 'baseline-1',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: 'http://127.0.0.1:4310/api/todos',
            status: 200,
            bodyExcerpt: '[{"title":"x"}]',
          },
        },
        {
          criterionId: 'cycle-1',
          passed: true,
          kind: 'api_check',
          apiCheck: {
            method: 'GET',
            url: 'http://127.0.0.1:4310/api/todos',
            status: 200,
            bodyExcerpt: '[{"title":"x"}]',
          },
        },
      ],
    });
    const result = await orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: report,
      captures: passingEvalCaptures(evalOp.id, report),
    });
    const runId = store.getActiveRun(PROJECT)!.id;
    expect(parsePinned(store, runId).map((c) => c.source)).toEqual(['baseline', 'cycle']);
    expect(result.advanced).toBe(true);
    expect(store.getRun(runId)!.lastVerifiedSha).toBe('deadbeefcafe');
    expect(store.getRun(runId)!.stage).toBe('documenting');
  });

  it('promotes last-known-good from a succeeded evaluate op after a crash before advance', async () => {
    const { controller, orchestrator, store } = harness();
    await reachVerifying(orchestrator, controller);
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    const runId = store.getActiveRun(PROJECT)!.id;
    const cycle = store.getCycle(runId, 1)!;
    store.updateCycle(cycle.id, {
      verificationJson: writeCycleVerification(cycle.verification, {
        judgement: { ok: true, sha: 'deadbeefcafe' },
        hubEvidence: {
          binding: {
            operationId: evalOp.id,
            deploymentId: 'dep-1',
            expectedSha: 'deadbeefcafe',
            observedSha: 'deadbeefcafe',
            origin: 'http://127.0.0.1:4310',
            operationStartedAt: evalOp.createdAt,
          },
          captures: [
            {
              captureId: 'cap-crash',
              criterionId: 'baseline-1',
              kind: 'browser_journey',
              capturedAt: evalOp.createdAt,
              screenshotPath: '/tmp/eval/list.png',
              screenshotPresent: true,
              screenshotMtimeMs: Date.parse(evalOp.createdAt) || Date.now(),
              tracePresent: false,
              apiOriginMatches: false,
            },
          ],
        },
      }),
    });
    await controller.completeOperation({
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      outcome: 'succeeded',
      result: { sha: 'deadbeefcafe', deploymentId: 'dep-1' },
    });
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();
    expect(store.getRun(runId)!.stage).toBe('verifying');

    const res = await orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: null,
    });
    expect(res.idempotent).toBe(true);
    expect(res.advanced).toBe(true);
    expect(store.getRun(runId)!.lastVerifiedSha).toBe('deadbeefcafe');
    expect(store.getRun(runId)!.stage).toBe('documenting');
  });

  it('does not promote last-known-good from a succeeded evaluate op without passing evidence', async () => {
    const { controller, orchestrator, store } = harness();
    await reachVerifying(orchestrator, controller);
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    const runId = store.getActiveRun(PROJECT)!.id;
    await controller.completeOperation({
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      outcome: 'succeeded',
      result: { sha: 'deadbeefcafe', deploymentId: 'dep-1' },
    });
    await expect(
      orchestrator.reconcileEvaluate(PROJECT, {
        operationId: evalOp.id,
        fencingGeneration: evalOp.fencingGeneration,
        result: null,
      }),
    ).rejects.toThrow(/passing evaluation bound to this SHA and deployment/);
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();
    expect(store.getRun(runId)!.stage).toBe('verifying');
  });
});
