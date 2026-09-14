import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { createAutopilotController } from './controller.js';
import { createAutopilotRuntime, type AutopilotAdapters } from './runtime.js';
import { AutopilotStore } from './store.js';
import { ensureAutopilotSchema } from './schema.js';
import type { AutopilotFinalizeResult, AutopilotSessionResult } from './orchestrator.js';

const PROJECT = 'demo-app';
const ACTOR = { userId: 'user-1' };

const READY = {
  brief: 'Build a disposable todo API with a browser-testable list page.',
  target: { targetId: 'local-preview' },
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
    },
    session: {
      dispatchImplementation: async () => ({ sessionId: 'sess-1' }),
    },
    finalize: {
      startFinalize: async () => ({ finalizeRunId: 'fin-1' }),
    },
  };
}

function buildController(db: Database.Database) {
  return createAutopilotController({
    db,
    isServerEnabled: () => true,
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

    const runtime = createAutopilotRuntime({
      db,
      buildController: () => buildController(db),
      buildAdapters: () => fakeAdapters(),
      readSessionOutcome: () => sessionOutcome,
      readFinalizeOutcome: () => finalizeOutcome,
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

    // Finalize merged -> tick 7 records the tested SHA.
    finalizeOutcome = { status: 'merged', mergedSha: 'deadbeef', reviewStatus: 'approved' };
    await runtime.tick();
    expect(store.getCycle(runId, 1)!.testedCommitSha).toBe('deadbeef');
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
    });

    await runtime.tick(); // plan -> implementing
    await runtime.tick(); // dispatch impl
    expect(store.getRun(runId)!.stage).toBe('implementing');

    sessionOutcome = { committed: true, commitSha: 'abc123' };
    await runtime.settleSession('sess-1');
    expect(store.getRun(runId)!.stage).toBe('finalizing');
  });

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
    });

    await runtime.tick(); // plan
    await runtime.tick(); // dispatch impl
    await runtime.tick(); // reconcile impl -> finalizing
    await runtime.tick(); // dispatch finalize
    expect(store.getCycle(runId, 1)!.finalizeRunId).toBe('fin-1');

    finalizeOutcome = { status: 'merged', mergedSha: 'deadbeef', reviewStatus: 'approved' };
    await runtime.settleFinalize('fin-1');
    expect(store.getCycle(runId, 1)!.testedCommitSha).toBe('deadbeef');
  });
});
