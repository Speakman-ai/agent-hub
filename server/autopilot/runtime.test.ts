import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import { createAutopilotController } from './controller.js';
import {
  createAutopilotRuntime,
  succeededDeployCoversCycleSha,
  type AutopilotAdapters,
} from './runtime.js';
import { buildFinalizeOps, readFinalizeOutcome } from './wiring.js';
import type { RouteDeps } from '../types.js';
import { AutopilotStore } from './store.js';
import { ensureAutopilotSchema } from './schema.js';
import { writeCycleVerification } from './evaluate.js';
import type {
  AutopilotDeployResult,
  AutopilotFinalizeResult,
  AutopilotSessionResult,
} from './orchestrator.js';

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

function fakeAdapters(): AutopilotAdapters {
  return {
    planner: {
      expandBrief: async () => ({
        assumptions: ['single-user'],
        acceptanceJourneys: [{ action: 'create a todo', expectedResult: 'it appears in the list' }],
        nonGoals: ['auth'],
        specDecisions: [{ key: 'storage', decision: 'sqlite' }],
        storageRecovery: 'disposable',
        qualityRubricVersion: 1,
      }),
    },
    board: {
      createBaselineBoard: async () => ({
        epicId: 'epic-1',
        primaryCardId: 'card-1',
        cards: [{ cardId: 'card-1', title: 'baseline', phase: 1, blockedBy: [] }],
      }),
      validatePhaseOrder: async () => ({ ok: true }),
      priorPhaseComplete: async () => ({ ok: true }),
      createImprovementBoard: async () => ({
        epicId: 'epic-1',
        primaryCardId: 'card-improve',
        cards: [{ cardId: 'card-improve', title: 'improve', phase: 2, blockedBy: ['card-1'] }],
      }),
    },
    session: {
      dispatchImplementation: async () => ({ sessionId: 'sess-1' }),
    },
    finalize: {
      startFinalize: async () => ({ finalizeRunId: 'fin-1' }),
    },
    deploy: {
      deployRevision: async () => ({ deploymentId: 'dep-1' }),
      rollback: async () => ({
        status: 'success' as const,
        deploymentId: 'dep-rb',
        deployedSha: 'verified',
      }),
    },
    evaluate: {
      dispatchEvaluation: async () => ({ sessionId: 'eval-1' }),
    },
  };
}

function buildController(db: Database.Database) {
  return createAutopilotController({
    db,
    credentialOwnerExists: () => true,
    holderId: 'hub-a',
    assertContainment: () => undefined,
    issueWorkerCredential: ({ projectId, runId }) => ({
      keyName: `autopilot:${projectId}:${runId}`,
      keyId: `key-${runId}`,
      token: `ahub_worker_${runId}`,
    }),
    revokeWorkerCredential: () => undefined,
  });
}

describe('autopilot runtime driver', () => {
  it('drives a run from planning to a merged SHA across ticks', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const store = new AutopilotStore(db);

    // Start a run.
    const controller = buildController(db);
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const started = controller.start(PROJECT, {}, ACTOR);
    const runId = started.run.id;

    let sessionOutcome: AutopilotSessionResult | null = null;
    let finalizeOutcome: AutopilotFinalizeResult | null = null;
    let deployOutcome: AutopilotDeployResult | null = null;

    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => fakeAdapters(),
      readSessionOutcome: () => sessionOutcome,
      readFinalizeOutcome: () => finalizeOutcome,
      readDeployOutcome: () => deployOutcome,
      readEvaluateOutcome: () => null,
    });

    // Tick 1: planning -> implementing.
    await runtime.tick();
    expect(store.getRun(runId)!.stage).toBe('implementing');

    // Tick 2: dispatch the implementation session (leaves it in flight).
    await runtime.tick();
    let cycle = store.getCycle(runId, 1)!;
    expect(cycle.sessionId).toBe('sess-1');
    expect(store.getRun(runId)!.stage).toBe('implementing');

    // Tick 3: session still running -> no advance.
    await runtime.tick();
    expect(store.getRun(runId)!.stage).toBe('implementing');

    // Session committed -> tick 4 advances to finalizing.
    sessionOutcome = { committed: true, commitSha: 'abc123' };
    await runtime.tick();
    expect(store.getRun(runId)!.stage).toBe('finalizing');

    // Tick 5: dispatch Finalize.
    await runtime.tick();
    cycle = store.getCycle(runId, 1)!;
    expect(cycle.finalizeRunId).toBe('fin-1');

    // Tick 6: finalize still running -> no change.
    await runtime.tick();
    expect(store.getCycle(runId, 1)!.testedCommitSha).toBeNull();

    // Finalize merged -> tick 7 records the tested SHA and advances to deploying.
    finalizeOutcome = { status: 'merged', mergedSha: 'deadbeef', reviewStatus: 'approved' };
    await runtime.tick();
    expect(store.getCycle(runId, 1)!.testedCommitSha).toBe('deadbeef');
    expect(store.getRun(runId)!.stage).toBe('deploying');

    // Tick 8: dispatch the deployment.
    await runtime.tick();
    expect(store.getCycle(runId, 1)!.deploymentId).toBe('dep-1');
    expect(store.getRun(runId)!.stage).toBe('deploying');

    // Exact SHA at the live target -> tick 9 advances to verifying without marking LKG.
    deployOutcome = { status: 'success', deploymentId: 'dep-1', deployedSha: 'deadbeef' };
    await runtime.tick();
    expect(store.getRun(runId)!.stage).toBe('verifying');
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();
  });

  it('does not dispatch another baseline implement after a capture-evidence failure', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const store = new AutopilotStore(db);
    const controller = buildController(db);
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const runId = controller.start(PROJECT, {}, ACTOR).run.id;

    let implementCalls = 0;
    const adapters = fakeAdapters();
    adapters.session = {
      dispatchImplementation: async () => {
        implementCalls += 1;
        return { sessionId: `sess-${implementCalls}` };
      },
    };

    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => adapters,
      readSessionOutcome: () => ({ committed: true, commitSha: 'abc123' }),
      readFinalizeOutcome: () => ({
        status: 'merged',
        mergedSha: 'deadbeef',
        reviewStatus: 'approved',
      }),
      readDeployOutcome: () => ({
        status: 'success',
        deploymentId: 'dep-1',
        deployedSha: 'deadbeef',
      }),
      readEvaluateOutcome: () => null,
    });

    await runtime.tick(); // plan
    await runtime.tick(); // dispatch impl
    await runtime.tick(); // reconcile impl
    await runtime.tick(); // dispatch finalize
    await runtime.tick(); // reconcile finalize
    await runtime.tick(); // dispatch deploy
    await runtime.tick(); // settle deploy -> verifying
    expect(store.getRun(runId)!.stage).toBe('verifying');
    expect(implementCalls).toBe(1);

    const cycle = store.getCycle(runId, 1)!;
    const open = store.getOpenStage(cycle.id);
    if (open) {
      store.updateStage(open.id, { status: 'failed', completedAt: new Date().toISOString() });
    }
    store.updateCycle(cycle.id, {
      verificationJson: writeCycleVerification(cycle.verification, {
        judgement: {
          ok: false,
          reason: 'missing_evidence',
          detail: 'no Hub captures',
          recover: false,
        },
      }),
    });
    store.updateRun(runId, { stage: 'implementing' });
    store.insertStage({
      id: 'stg-repair',
      cycleId: cycle.id,
      stage: 'implementing',
      status: 'pending',
      attempt: 2,
      operationId: null,
      startedAt: new Date().toISOString(),
    });

    await runtime.tick();
    expect(implementCalls).toBe(1);
    expect(store.getRun(runId)!.stage).toBe('verifying');
  });

  it('is a no-op when no run is active', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => fakeAdapters(),
      readSessionOutcome: () => null,
      readFinalizeOutcome: () => null,
      readDeployOutcome: () => null,
      readEvaluateOutcome: () => null,
    });
    await expect(runtime.tick()).resolves.toBeUndefined();
  });

  it('does not advance when Finalize reports a rejected review', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const store = new AutopilotStore(db);
    const controller = buildController(db);
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const runId = controller.start(PROJECT, {}, ACTOR).run.id;

    let sessionOutcome: AutopilotSessionResult | null = null;
    let finalizeOutcome: AutopilotFinalizeResult | null = null;
    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => fakeAdapters(),
      readSessionOutcome: () => sessionOutcome,
      readFinalizeOutcome: () => finalizeOutcome,
      readDeployOutcome: () => null,
      readEvaluateOutcome: () => null,
    });

    await runtime.tick(); // plan -> implementing
    await runtime.tick(); // dispatch impl
    sessionOutcome = { committed: true };
    await runtime.tick(); // -> finalizing
    await runtime.tick(); // dispatch finalize
    finalizeOutcome = { status: 'review_rejected', reviewStatus: 'changes_requested' };
    await runtime.tick(); // rejected

    const cycle = store.getCycle(runId, 1)!;
    expect(cycle.testedCommitSha).toBeNull();
    expect(store.getRun(runId)!.controlState).toBe('running');
    expect(store.getRun(runId)!.stage).toBe('finalizing');
  });

  it('settles an in-flight implementation from a session completion callback', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const store = new AutopilotStore(db);
    const controller = buildController(db);
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const runId = controller.start(PROJECT, {}, ACTOR).run.id;

    let sessionOutcome: AutopilotSessionResult | null = null;
    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => fakeAdapters(),
      readSessionOutcome: () => sessionOutcome,
      readFinalizeOutcome: () => null,
      readDeployOutcome: () => null,
      readEvaluateOutcome: () => null,
    });

    await runtime.tick(); // plan -> implementing
    await runtime.tick(); // dispatch impl
    expect(store.getRun(runId)!.stage).toBe('implementing');

    sessionOutcome = { committed: true, commitSha: 'abc123' };
    await runtime.settleSession('sess-1');
    expect(store.getRun(runId)!.stage).toBe('finalizing');
  });

  it.each(['pending', 'retry', 'resume', 'resume-fails'])(
    'recovers a delayed merge without restarting a pushed session (%s)',
    async (recovery) => {
      const expired = recovery !== 'pending';
      const resume = recovery.startsWith('resume');
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      ensureAutopilotSchema(db);
      const store = new AutopilotStore(db);
      const controller = buildController(db);
      controller.putConfig(
        PROJECT,
        {
          enabled: true,
          ...READY,
          limits: { ...READY.limits, maxRetriesPerStage: resume ? 0 : 2 },
        },
        ACTOR,
      );
      const runId = controller.start(PROJECT, {}, ACTOR).run.id;
      const finalizeRun = {
        id: 'fin-1',
        project_id: PROJECT,
        status: 'pushed',
        reviewer_verdict: 'approved',
        pr_url: 'https://hub/git/demo-app/pulls/15',
        ended_at: Date.now() - (expired ? 60_000 : 0),
      };
      const pr = { status: 'open', merged_sha: null as string | null };
      const updateAutomation = vi.fn();
      const deps = {
        stmts: {
          getSession: { get: () => ({ id: 'sess-1' }) },
          getPushedFinalizeRunForSession: { get: () => finalizeRun },
          getFinalizeRun: { get: () => finalizeRun },
          getPullRequestByNumber: { get: () => pr },
          updateSessionFinalizeAutomation: { run: updateAutomation },
        },
        findProject: () => ({ id: PROJECT }),
      } as unknown as RouteDeps;
      const startRun = vi.fn();
      const ops = buildFinalizeOps(deps, startRun);
      const runtime = createAutopilotRuntime({
        db,
        buildController: () => buildController(db),
        buildAdapters: () => ({
          ...fakeAdapters(),
          finalize: { startFinalize: (input) => ops.startMergeAutomation(input) },
        }),
        readSessionOutcome: () => ({ committed: true, commitSha: 'implementation-sha' }),
        readFinalizeOutcome: (id) => readFinalizeOutcome(deps.stmts, id),
        readDeployOutcome: () => null,
        readEvaluateOutcome: () => null,
      });
      try {
        await runtime.tick(); // plan
        await runtime.tick(); // dispatch implementation
        await runtime.tick(); // reconcile implementation
        await runtime.tick(); // attach the pushed Finalize run
        await runtime.settleFinalize('fin-1'); // push callback arrives before merge
        expect(store.getRun(runId)!.stage).toBe('finalizing');
        expect(store.getRun(runId)!.controlState).toBe(resume ? 'paused' : 'running');
        expect(store.getCycle(runId, 1)!.testedCommitSha).toBeNull();
        const finalizeOps = store.listOperations(runId).filter((op) => op.kind === 'finalize');
        expect(finalizeOps).toHaveLength(1);
        expect(finalizeOps[0].status).toBe(expired ? 'failed' : 'in_flight');

        if (recovery === 'resume-fails') {
          await controller.resume(PROJECT, ACTOR);
          await runtime.tick();
          await runtime.tick();
          expect(store.getRun(runId)!.controlState).toBe('paused');
          expect(store.getRun(runId)!.pauseReason).toBe('stage_retries_exhausted');
          expect(
            store
              .listStages(store.getCycle(runId, 1)!.id)
              .filter((stage) => stage.stage === 'finalizing'),
          ).toMatchObject([
            { attempt: 1, status: 'failed' },
            { attempt: 2, status: 'failed' },
          ]);
          expect(startRun).not.toHaveBeenCalled();
          return;
        }

        pr.status = 'merged';
        pr.merged_sha = 'recorded-merge-sha';
        if (resume) {
          await controller.resume(PROJECT, ACTOR);
          expect(store.getCycle(runId, 1)).toMatchObject({
            status: 'active',
            outcome: null,
            documentation: null,
          });
        }
        if (expired) await runtime.tick(); // retry attaches the same pushed run
        await runtime.tick(); // reconcile merge on a later tick
        expect(store.getRun(runId)!.stage).toBe('deploying');
        expect(store.getCycle(runId, 1)!.testedCommitSha).toBe('recorded-merge-sha');
        expect(store.getCycle(runId, 1)!.deploymentId).toBeNull();
        expect(startRun).not.toHaveBeenCalled();
        expect(updateAutomation).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it('settles an in-flight Finalize run from a completion callback', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const store = new AutopilotStore(db);
    const controller = buildController(db);
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const runId = controller.start(PROJECT, {}, ACTOR).run.id;

    let sessionOutcome: AutopilotSessionResult | null = { committed: true };
    let finalizeOutcome: AutopilotFinalizeResult | null = null;
    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => fakeAdapters(),
      readSessionOutcome: () => sessionOutcome,
      readFinalizeOutcome: () => finalizeOutcome,
      readDeployOutcome: () => null,
      readEvaluateOutcome: () => null,
    });

    await runtime.tick(); // plan
    await runtime.tick(); // dispatch impl
    await runtime.tick(); // reconcile impl -> finalizing
    await runtime.tick(); // dispatch finalize
    expect(store.getCycle(runId, 1)!.finalizeRunId).toBe('fin-1');

    finalizeOutcome = { status: 'merged', mergedSha: 'deadbeef', reviewStatus: 'approved' };
    await runtime.settleFinalize('fin-1');
    expect(store.getCycle(runId, 1)!.testedCommitSha).toBe('deadbeef');
    expect(store.getRun(runId)!.stage).toBe('deploying');
  });

  it('settles an in-flight deployment from a completion callback', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const store = new AutopilotStore(db);
    const controller = buildController(db);
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const runId = controller.start(PROJECT, {}, ACTOR).run.id;

    let sessionOutcome: AutopilotSessionResult | null = { committed: true };
    let finalizeOutcome: AutopilotFinalizeResult | null = {
      status: 'merged',
      mergedSha: 'deadbeef',
      reviewStatus: 'approved',
    };
    let deployOutcome: AutopilotDeployResult | null = null;
    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => fakeAdapters(),
      readSessionOutcome: () => sessionOutcome,
      readFinalizeOutcome: () => finalizeOutcome,
      readDeployOutcome: () => deployOutcome,
      readEvaluateOutcome: () => null,
    });

    await runtime.tick(); // plan
    await runtime.tick(); // dispatch impl
    await runtime.tick(); // reconcile impl -> finalizing
    await runtime.tick(); // dispatch finalize
    await runtime.tick(); // reconcile finalize -> deploying
    await runtime.tick(); // dispatch deploy
    expect(store.getCycle(runId, 1)!.deploymentId).toBe('dep-1');

    deployOutcome = { status: 'success', deploymentId: 'dep-1', deployedSha: 'deadbeef' };
    await runtime.settleDeployment('dep-1');
    expect(store.getRun(runId)!.stage).toBe('verifying');
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();
  });

  it('recovers a succeeded deploy after a crash between settle and advance instead of launching another', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const store = new AutopilotStore(db);
    const controller = buildController(db);
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const runId = controller.start(PROJECT, {}, ACTOR).run.id;

    let deployCalls = 0;
    const adapters = fakeAdapters();
    adapters.deploy = {
      deployRevision: async () => {
        deployCalls += 1;
        return { deploymentId: `dep-${deployCalls}` };
      },
      rollback: async () => ({
        status: 'success' as const,
        deploymentId: 'dep-rb',
        deployedSha: 'verified',
      }),
    };

    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => adapters,
      readSessionOutcome: () => ({ committed: true }),
      readFinalizeOutcome: () => ({
        status: 'merged',
        mergedSha: 'deadbeef',
        reviewStatus: 'approved',
      }),
      readDeployOutcome: () => ({
        status: 'success',
        deploymentId: 'dep-1',
        deployedSha: 'deadbeef',
      }),
      readEvaluateOutcome: () => null,
    });

    await runtime.tick(); // plan
    await runtime.tick(); // dispatch impl
    await runtime.tick(); // reconcile impl -> finalizing
    await runtime.tick(); // dispatch finalize
    await runtime.tick(); // reconcile finalize -> deploying
    await runtime.tick(); // dispatch deploy
    expect(deployCalls).toBe(1);
    const depOp = store.listOperations(runId).find((op) => op.kind === 'deploy')!;
    expect(depOp.status).toBe('in_flight');

    // Crash: the operation is settled succeeded, but the run never left deploying.
    await controller.completeOperation({
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      outcome: 'succeeded',
      result: { deployedSha: 'deadbeef', deploymentId: 'dep-1' },
    });
    expect(store.getRun(runId)!.stage).toBe('deploying');
    expect(store.listOperations(runId).filter((op) => op.kind === 'deploy')).toHaveLength(1);

    await runtime.tick();
    expect(store.getRun(runId)!.stage).toBe('verifying');
    expect(store.listOperations(runId).filter((op) => op.kind === 'deploy')).toHaveLength(1);
    expect(deployCalls).toBe(1);
    expect(store.getRun(runId)!.lastVerifiedSha).toBeNull();
  });

  it('launches a new deploy when a repair merge is a different SHA than the last deploy', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const store = new AutopilotStore(db);
    const controller = buildController(db);
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    const runId = controller.start(PROJECT, {}, ACTOR).run.id;

    let deployCalls = 0;
    const adapters = fakeAdapters();
    adapters.deploy = {
      deployRevision: async () => {
        deployCalls += 1;
        return { deploymentId: `dep-${deployCalls}` };
      },
      rollback: async () => ({
        status: 'success' as const,
        deploymentId: 'dep-rb',
        deployedSha: 'verified',
      }),
    };

    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => adapters,
      readSessionOutcome: () => ({ committed: true }),
      readFinalizeOutcome: () => ({
        status: 'merged',
        mergedSha: 'deadbeef',
        reviewStatus: 'approved',
      }),
      readDeployOutcome: () => ({
        status: 'success',
        deploymentId: 'dep-1',
        deployedSha: 'deadbeef',
      }),
      readEvaluateOutcome: () => null,
    });

    await runtime.tick(); // plan
    await runtime.tick(); // dispatch impl
    await runtime.tick(); // reconcile impl -> finalizing
    await runtime.tick(); // dispatch finalize
    await runtime.tick(); // reconcile finalize -> deploying
    await runtime.tick(); // dispatch deploy 1
    await runtime.tick(); // settle deploy 1 -> verifying
    expect(deployCalls).toBe(1);
    expect(store.getRun(runId)!.stage).toBe('verifying');

    const cycle = store.getCycle(runId, 1)!;
    store.updateCycle(cycle.id, { testedCommitSha: 'cafebabeface' });
    store.updateRun(runId, { stage: 'deploying' });
    await runtime.tick();
    expect(deployCalls).toBe(2);
  });
});

describe('succeededDeployCoversCycleSha', () => {
  it('matches only a succeeded deploy of the cycle SHA', () => {
    expect(
      succeededDeployCoversCycleSha(
        { status: 'succeeded', result: { deployedSha: 'abc' } },
        'deadbeef',
      ),
    ).toBe(false);
    expect(
      succeededDeployCoversCycleSha(
        { status: 'succeeded', result: { deployedSha: 'deadbeef' } },
        'deadbeef',
      ),
    ).toBe(true);
    expect(
      succeededDeployCoversCycleSha(
        { status: 'in_flight', result: { deployedSha: 'deadbeef' } },
        'deadbeef',
      ),
    ).toBe(false);
  });
});
