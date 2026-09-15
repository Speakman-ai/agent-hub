import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAutopilotController } from './controller.js';
import { AutopilotError } from './errors.js';
import { ensureAutopilotSchema } from './schema.js';
import { AutopilotStore } from './store.js';
import { writeCycleVerification } from './evaluate.js';
import type { AutopilotCancelRefs, AutopilotCancelSideEffects } from './types.js';
import type { AutopilotLocalTargetLookup } from './local-target.js';
import type {
  IssueAutopilotWorkerCredential,
  RevokeAutopilotWorkerCredential,
} from './worker-authority.js';

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

const passContainment = { assertContainment: () => undefined };

function freshController(opts?: {
  serverEnabled?: boolean;
  cancelSideEffects?: AutopilotCancelSideEffects;
  getDeployedRevision?: (projectId: string, targetId: string) => string | null;
  validateLocalTarget?: AutopilotLocalTargetLookup;
  credentialOwnerExists?: (userId: string) => boolean;
  holderId?: string;
  now?: () => Date;
  assertContainment?: () => void;
  issueWorkerCredential?: IssueAutopilotWorkerCredential;
  revokeWorkerCredential?: RevokeAutopilotWorkerCredential;
}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureAutopilotSchema(db);
  const stubs = stubWorkerCreds();
  const controller = createAutopilotController({
    db,
    isServerEnabled: () => opts?.serverEnabled !== false,
    cancelSideEffects: opts?.cancelSideEffects,
    getDeployedRevision: opts?.getDeployedRevision,
    validateLocalTarget: opts?.validateLocalTarget,
    credentialOwnerExists: opts?.credentialOwnerExists ?? (() => true),
    holderId: opts?.holderId ?? 'hub-a',
    now: opts?.now,
    assertContainment: opts?.assertContainment ?? stubs.assertContainment,
    issueWorkerCredential: opts?.issueWorkerCredential ?? stubs.issueWorkerCredential,
    revokeWorkerCredential: opts?.revokeWorkerCredential ?? stubs.revokeWorkerCredential,
  });
  return { db, controller };
}

async function startReady(controller: ReturnType<typeof createAutopilotController>) {
  controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
  return controller.start(PROJECT, {}, ACTOR);
}

describe('autopilot controller', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('refuses start when the server operator setting is off', () => {
    const { controller } = freshController({ serverEnabled: false });
    expect(() => controller.start(PROJECT, READY, ACTOR)).toThrow(AutopilotError);
    try {
      controller.start(PROJECT, READY, ACTOR);
    } catch (err) {
      expect((err as AutopilotError).code).toBe('server_disabled');
    }
  });

  it('rejects a duplicate start for the same project', async () => {
    const { controller } = freshController();
    await startReady(controller);
    expect(() => controller.start(PROJECT, {}, ACTOR)).toThrow(/already has an active/);
    try {
      controller.start(PROJECT, {}, ACTOR);
    } catch (err) {
      expect((err as AutopilotError).code).toBe('already_active');
      expect((err as AutopilotError).httpStatus).toBe(409);
    }
  });

  it('revokes the implementer credential when evaluator issuance fails', () => {
    const issued: Array<{ projectId: string; runId: string; ownerUserId: string; role?: string }> =
      [];
    const revoked: Array<{ projectId: string; runId: string; ownerUserId?: string | null }> = [];
    const { controller } = freshController({
      issueWorkerCredential: (input) => {
        issued.push({
          projectId: input.projectId,
          runId: input.runId,
          ownerUserId: input.ownerUserId,
          role: input.role,
        });
        if (input.role === 'evaluator') {
          throw new Error('evaluator mint failed');
        }
        return {
          keyName: `autopilot:${input.projectId}:${input.runId}`,
          keyId: `key-${input.runId}`,
          token: `ahub_worker_${input.runId}`,
        };
      },
      revokeWorkerCredential: (input) => {
        revoked.push(input);
      },
    });
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    expect(() => controller.start(PROJECT, {}, ACTOR)).toThrow(/evaluator mint failed/);
    expect(issued).toHaveLength(2);
    expect(issued[0]?.role).toBeUndefined();
    expect(issued[1]?.role).toBe('evaluator');
    expect(revoked).toEqual([
      {
        projectId: PROJECT,
        runId: issued[0]?.runId,
        ownerUserId: 'user-1',
      },
    ]);
    expect(controller.getProjectState(PROJECT).activeRun).toBeNull();
  });

  it('does not persist overlay settings from a rejected duplicate start', async () => {
    const { controller } = freshController();
    await startReady(controller);
    const before = controller.getProjectState(PROJECT);
    const runBefore = before.activeRun!.run;

    expect(() =>
      controller.start(
        PROJECT,
        {
          brief: 'A different brief that must not replace the original one.',
          target: { targetId: 'other-target' },
          limits: {
            cycleMode: 'finite',
            maxCycles: 1,
            maxWallTimeMs: 5_000,
            maxStageTimeoutMs: 2_000,
            maxRetriesPerStage: 0,
          },
          credentialOwnerUserId: 'intruder',
        },
        ACTOR,
      ),
    ).toThrow(AutopilotError);

    const after = controller.getProjectState(PROJECT);
    expect(after.config.brief).toBe(before.config.brief);
    expect(after.config.briefRevision).toBe(before.config.briefRevision);
    expect(after.config.target?.targetId).toBe(before.config.target?.targetId);
    expect(after.config.limits).toEqual(before.config.limits);
    expect(after.config.credentialOwnerUserId).toBe('user-1');
    expect(after.activeRun?.run.id).toBe(runBefore.id);
    expect(after.activeRun?.run.credentialOwnerUserId).toBe(runBefore.credentialOwnerUserId);
    expect(after.activeRun?.run.targetId).toBe(runBefore.targetId);
    expect(after.activeRun?.run.briefRevision).toBe(runBefore.briefRevision);
  });

  it('refuses to enable without a loopback origin and readiness probe', () => {
    const { controller } = freshController();
    expect(() =>
      controller.putConfig(
        PROJECT,
        {
          enabled: true,
          brief: READY.brief,
          target: { targetId: 'local-preview' },
          limits: READY.limits,
          credentialOwnerUserId: 'user-1',
        },
        ACTOR,
      ),
    ).toThrow(/target\.origin is required/);
  });

  it('refuses to enable when the declared environment points elsewhere', () => {
    const { controller } = freshController({
      validateLocalTarget: {
        getDeclaredEnvironment: () => ({
          origin: 'http://127.0.0.1:9999',
          readinessProbeUrl: 'http://127.0.0.1:9999/health',
          currentRef: null,
          currentDeploymentId: null,
        }),
      },
    });
    expect(() => controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR)).toThrow(
      /points at http:\/\/127\.0\.0\.1:9999/,
    );
  });

  it('parks without retry when a failed operation carries haltReason', async () => {
    const { controller } = freshController();
    const started = await startReady(controller);
    const op = started.operations[0];
    await controller.completeOperation({
      operationId: op.id,
      fencingGeneration: op.fencingGeneration,
      outcome: 'failed',
      haltReason: 'rollback failed',
      result: { error: 'rollback failed' },
    });
    const snap = controller.getProjectState(PROJECT).activeRun!;
    expect(snap.run.id).toBe(started.run.id);
    expect(snap.run.controlState).toBe('paused');
    expect(snap.run.pauseReason).toBe('rollback failed');
    expect(snap.operations.find((row) => row.id === op.id)?.status).toBe('failed');
    expect(
      snap.operations.filter((row) => row.status === 'pending' || row.status === 'in_flight'),
    ).toHaveLength(0);
  });

  it('rolls back start overlays when the credential owner is invalid', () => {
    const { controller } = freshController({
      credentialOwnerExists: (userId) => userId === 'user-1',
    });
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);

    expect(() => controller.start(PROJECT, { credentialOwnerUserId: 'intruder' }, ACTOR)).toThrow(
      /does not exist/,
    );

    const after = controller.getProjectState(PROJECT);
    expect(after.config.credentialOwnerUserId).toBe('user-1');
    expect(after.activeRun).toBeNull();
  });

  it('persists stop before cancellation and ignores late callbacks', async () => {
    let sawStopping = false;
    let cancelStarted = false;
    const { controller } = freshController({
      cancelSideEffects: async () => {
        cancelStarted = true;
        const state = controller.getProjectState(PROJECT);
        expect(state.activeRun?.run.controlState).toBe('stopping');
        sawStopping = true;
      },
    });
    const started = await startReady(controller);
    const op = await controller.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-1',
      finalizeRunId: 'fin-1',
    });
    const genAtStart = started.run.fencingGeneration;

    const stopped = await controller.stop(PROJECT, ACTOR);
    expect(cancelStarted).toBe(true);
    expect(sawStopping).toBe(true);
    expect(stopped.run.controlState).toBe('stopped');
    expect(stopped.run.fencingGeneration).toBeGreaterThan(genAtStart);

    await expect(
      controller.completeOperation({
        operationId: op.id,
        fencingGeneration: genAtStart,
        outcome: 'succeeded',
        result: { sha: 'abc' },
      }),
    ).rejects.toThrow(/Late callback|stale/i);

    const after = controller.getRun(PROJECT, stopped.run.id);
    expect(after.run.controlState).toBe('stopped');
    expect(after.operations.find((row) => row.id === op.id)?.status).toBe('cancelled');
  });

  it('does not let a stale fencing generation advance a superseded run', async () => {
    const { controller } = freshController();
    await startReady(controller);
    controller.pause(PROJECT, ACTOR);
    const paused = controller.getProjectState(PROJECT).activeRun!;
    await expect(
      controller.beginOperation({ projectId: PROJECT, kind: 'x' }),
    ).rejects.toMatchObject({
      code: 'conflict',
    });

    await controller.resume(PROJECT, ACTOR);
    const live = await controller.beginOperation({ projectId: PROJECT, kind: 'implement' });
    await expect(
      controller.completeOperation({
        operationId: live.id,
        fencingGeneration: paused.run.fencingGeneration,
        outcome: 'succeeded',
      }),
    ).rejects.toThrow(AutopilotError);
    const still = controller.getProjectState(PROJECT).activeRun!;
    expect(still.operations.find((row) => row.id === live.id)?.status).toBe('in_flight');
  });

  it('pauses in-flight work as ambiguous after restart and never resurrects stopped runs', async () => {
    const { db, controller } = freshController({ holderId: 'hub-a' });
    await startReady(controller);
    await controller.beginOperation({ projectId: PROJECT, kind: 'implement', sessionId: 'sess-1' });

    const restarted = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-b',
      credentialOwnerExists: () => true,
      ...passContainment,
    });
    const reconciled = await restarted.reconcileAfterRestart();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].run.pauseReason).toBe('ambiguous_restart');
    expect(reconciled[0].lease?.holderId).toBe('hub-b');
    expect(reconciled[0].operations.every((op) => op.status !== 'in_flight')).toBe(true);

    const staleGen = reconciled[0].run.fencingGeneration - 1;
    const op = reconciled[0].operations[0];
    await expect(
      restarted.completeOperation({
        operationId: op.id,
        fencingGeneration: staleGen,
        outcome: 'succeeded',
      }),
    ).rejects.toThrow(/stale/i);

    await restarted.stop(PROJECT, ACTOR);
    const afterStop = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-c',
      ...passContainment,
    });
    const again = await afterStop.reconcileAfterRestart();
    expect(again).toHaveLength(0);
    expect(afterStop.getProjectState(PROJECT).activeRun).toBeNull();
    expect(afterStop.getRun(PROJECT, reconciled[0].run.id).run.controlState).toBe('stopped');
  });

  it('serializes overlapping stop calls without resurrecting the run', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let cancelCount = 0;
    const { controller } = freshController({
      cancelSideEffects: async () => {
        cancelCount += 1;
        if (cancelCount === 1) await firstHold;
      },
    });
    await startReady(controller);
    await controller.beginOperation({ projectId: PROJECT, kind: 'deploy', deploymentId: 'dep-1' });

    const first = controller.stop(PROJECT, ACTOR);
    await Promise.resolve();
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('stopping');
    const second = controller.stop(PROJECT, ACTOR);
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a.run.controlState).toBe('stopped');
    expect(b.run.controlState).toBe('stopped');
    expect(a.run.id).toBe(b.run.id);
    expect(cancelCount).toBeGreaterThanOrEqual(1);
  });

  it('drains on pause, stops on disable, and revalidates on resume', async () => {
    const { controller } = freshController({
      getDeployedRevision: () => 'sha-other',
    });
    const started = await startReady(controller);
    const op = await controller.beginOperation({ projectId: PROJECT, kind: 'implement' });
    const pausing = controller.pause(PROJECT, ACTOR);
    expect(pausing.run.controlState).toBe('pausing');

    await controller.completeOperation({
      operationId: op.id,
      fencingGeneration: started.run.fencingGeneration,
      outcome: 'succeeded',
    });
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('paused');

    await controller.resume(PROJECT, ACTOR);
    const live = controller.getProjectState(PROJECT).activeRun!;
    expect(live.run.controlState).toBe('running');
    expect(live.run.fencingGeneration).toBeGreaterThan(started.run.fencingGeneration);

    const disabled = await controller.disable(PROJECT, ACTOR);
    expect(disabled.config.enabled).toBe(false);
    expect(disabled.activeRun?.run.controlState ?? 'stopped').toBe('stopped');
    await expect(controller.resume(PROJECT, ACTOR)).rejects.toThrow(AutopilotError);
  });

  it('refuses resume when the deployed revision does not match last verified SHA', async () => {
    const { db, controller } = freshController({
      getDeployedRevision: () => 'sha-live',
    });
    await startReady(controller);
    const run = controller.getProjectState(PROJECT).activeRun!.run;
    db.prepare(`UPDATE autopilot_runs SET last_verified_sha = 'sha-good' WHERE id = ?`).run(run.id);
    controller.pause(PROJECT, ACTOR);
    await expect(controller.resume(PROJECT, ACTOR)).rejects.toThrow(/deployed revision/);
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('paused');
  });

  it('refuses resume when the declared environment now points elsewhere', async () => {
    let envOrigin = READY.target.origin;
    const { controller } = freshController({
      validateLocalTarget: {
        getDeclaredEnvironment: () => ({
          origin: envOrigin,
          readinessProbeUrl: `${envOrigin}/health`,
          currentRef: null,
          currentDeploymentId: null,
        }),
      },
    });
    await startReady(controller);
    controller.pause(PROJECT, ACTOR);
    envOrigin = 'http://127.0.0.1:9999';
    await expect(controller.resume(PROJECT, ACTOR)).rejects.toThrow(
      /points at http:\/\/127\.0\.0\.1:9999/,
    );
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('paused');
  });

  it('does not let a superseded controller dispatch work after another hub takes the lease', async () => {
    const { db, controller: hubA } = freshController({ holderId: 'hub-a' });
    await startReady(hubA);
    const hubB = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-b',
      credentialOwnerExists: () => true,
      ...passContainment,
    });
    const reconciled = await hubB.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('running');
    expect(reconciled[0].lease?.holderId).toBe('hub-b');

    try {
      await hubA.beginOperation({ projectId: PROJECT, kind: 'implement' });
      throw new Error('expected stale_lease');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('stale_lease');
    }

    hubB.pause(PROJECT, ACTOR);
    const resumed = await hubB.resume(PROJECT, ACTOR);
    expect(resumed.run.controlState).toBe('running');
    expect(resumed.lease?.holderId).toBe('hub-b');

    try {
      await hubA.beginOperation({ projectId: PROJECT, kind: 'implement' });
      throw new Error('expected stale_lease');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('stale_lease');
    }

    const op = await hubB.beginOperation({ projectId: PROJECT, kind: 'implement' });
    expect(op.status).toBe('in_flight');
  });

  it('cancels restart-ambiguous session and deployment refs when stop runs after restart', async () => {
    const cancels: AutopilotCancelRefs[] = [];
    const { db, controller: hubA } = freshController({ holderId: 'hub-a' });
    await startReady(hubA);
    await hubA.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-live',
      deploymentId: 'dep-live',
    });

    const hubB = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-b',
      credentialOwnerExists: () => true,
      ...passContainment,
      cancelSideEffects: (refs) => {
        cancels.push({
          sessionIds: [...refs.sessionIds],
          finalizeRunIds: [...refs.finalizeRunIds],
          deploymentIds: [...refs.deploymentIds],
          operationIds: [...refs.operationIds],
        });
      },
    });
    const reconciled = await hubB.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].operations.every((op) => op.status !== 'in_flight')).toBe(true);
    expect(
      reconciled[0].operations.some(
        (op) => op.status === 'ambiguous' && op.sessionId === 'sess-live',
      ),
    ).toBe(true);

    const stopped = await hubB.stop(PROJECT, ACTOR);
    expect(stopped.run.controlState).toBe('stopped');
    expect(stopped.operations.find((op) => op.sessionId === 'sess-live')?.status).toBe('cancelled');
    const stopCancel = cancels.at(-1);
    expect(stopCancel?.sessionIds).toContain('sess-live');
    expect(stopCancel?.deploymentIds).toContain('dep-live');
  });

  it('does not leave in-flight operations after a pausing restart, then allows resume', async () => {
    const { db, controller: hubA } = freshController({ holderId: 'hub-a' });
    await startReady(hubA);
    await hubA.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-drain',
    });
    const pausing = hubA.pause(PROJECT, ACTOR);
    expect(pausing.run.controlState).toBe('pausing');
    expect(pausing.operations.some((op) => op.status === 'in_flight')).toBe(true);

    const hubB = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-b',
      credentialOwnerExists: () => true,
      ...passContainment,
    });
    const reconciled = await hubB.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].operations.every((op) => op.status !== 'in_flight')).toBe(true);

    const resumed = await hubB.resume(PROJECT, ACTOR);
    expect(resumed.run.controlState).toBe('running');
    expect(resumed.operations.every((op) => op.status !== 'in_flight')).toBe(true);
    expect(
      resumed.operations
        .filter((op) => op.sessionId === 'sess-drain')
        .every((op) => op.status === 'cancelled'),
    ).toBe(true);
  });

  it('refuses resume when the deployed revision lookup returns null', async () => {
    const { db, controller } = freshController({
      getDeployedRevision: () => null,
    });
    await startReady(controller);
    const run = controller.getProjectState(PROJECT).activeRun!.run;
    db.prepare(`UPDATE autopilot_runs SET last_verified_sha = 'sha-good' WHERE id = ?`).run(run.id);
    controller.pause(PROJECT, ACTOR);
    await expect(controller.resume(PROJECT, ACTOR)).rejects.toThrow(/unavailable/);
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('paused');
    expect(controller.getProjectState(PROJECT).activeRun?.run.pauseReason).toMatch(/unavailable/);
  });

  it('does not resume while a sibling operation is still in flight after an ambiguous outcome', async () => {
    const { controller } = freshController();
    const started = await startReady(controller);
    const first = await controller.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-a',
    });
    const second = await controller.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-b',
    });

    await controller.completeOperation({
      operationId: first.id,
      fencingGeneration: started.run.fencingGeneration,
      outcome: 'ambiguous',
    });
    const parked = controller.getProjectState(PROJECT).activeRun!;
    expect(parked.run.controlState).toBe('pausing');
    expect(parked.operations.find((op) => op.id === second.id)?.status).toBe('in_flight');
    const genWhileDraining = parked.run.fencingGeneration;

    await expect(controller.resume(PROJECT, ACTOR)).rejects.toMatchObject({
      code: 'not_paused',
    });
    const stillDraining = controller.getProjectState(PROJECT).activeRun!;
    expect(stillDraining.run.controlState).toBe('pausing');
    expect(stillDraining.run.fencingGeneration).toBe(genWhileDraining);
    expect(stillDraining.operations.find((op) => op.id === second.id)?.status).toBe('in_flight');

    await controller.completeOperation({
      operationId: second.id,
      fencingGeneration: started.run.fencingGeneration,
      outcome: 'succeeded',
    });
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('paused');

    const resumed = await controller.resume(PROJECT, ACTOR);
    expect(resumed.run.controlState).toBe('running');
    expect(resumed.operations.find((op) => op.id === first.id)?.status).toBe('cancelled');
    expect(resumed.operations.find((op) => op.id === second.id)?.status).toBe('succeeded');
  });

  it('refuses resume when a paused run still has in-flight operations', async () => {
    const { db, controller } = freshController();
    const started = await startReady(controller);
    const op = await controller.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-stuck',
    });
    controller.pause(PROJECT, ACTOR);
    db.prepare(`UPDATE autopilot_runs SET control_state = 'paused' WHERE id = ?`).run(
      started.run.id,
    );

    await expect(controller.resume(PROJECT, ACTOR)).rejects.toThrow(/in-flight/);
    const after = controller.getProjectState(PROJECT).activeRun!;
    expect(after.run.controlState).toBe('paused');
    expect(after.operations.find((row) => row.id === op.id)?.status).toBe('in_flight');
  });

  it('does not settle stop when side-effect cancellation fails, then settles on retry', async () => {
    let failCancel = true;
    const { controller } = freshController({
      cancelSideEffects: () =>
        failCancel
          ? [{ kind: 'deployment', id: 'dep-1', message: 'deploy backend unavailable' }]
          : [],
    });
    await startReady(controller);
    const op = await controller.beginOperation({
      projectId: PROJECT,
      kind: 'deploy',
      deploymentId: 'dep-1',
    });

    await expect(controller.stop(PROJECT, ACTOR)).rejects.toMatchObject({
      code: 'cancel_failed',
    });
    const failed = controller.getProjectState(PROJECT).activeRun!;
    expect(failed.run.controlState).toBe('stopping');
    expect(failed.operations.find((row) => row.id === op.id)?.status).toBe('in_flight');

    failCancel = false;
    const stopped = await controller.stop(PROJECT, ACTOR);
    expect(stopped.run.controlState).toBe('stopped');
    expect(stopped.operations.find((row) => row.id === op.id)?.status).toBe('cancelled');
    expect(controller.getProjectState(PROJECT).activeRun).toBeNull();
  });

  it('does not disable project config when stop cannot cancel side effects', async () => {
    const { controller } = freshController({
      cancelSideEffects: () => [
        { kind: 'deployment', id: 'dep-1', message: 'deploy backend unavailable' },
      ],
    });
    await startReady(controller);
    await controller.beginOperation({
      projectId: PROJECT,
      kind: 'deploy',
      deploymentId: 'dep-1',
    });

    await expect(controller.disable(PROJECT, ACTOR)).rejects.toMatchObject({
      code: 'cancel_failed',
    });
    const state = controller.getProjectState(PROJECT);
    expect(state.config.enabled).toBe(true);
    expect(state.config.disabling).toBe(true);
    expect(state.activeRun?.run.controlState).toBe('stopping');
    expect(() => controller.start(PROJECT, {}, ACTOR)).toThrow(/disable is in progress/);
  });

  it('does not disable over a replacement run started while disable awaits cancellation', async () => {
    let releaseDisable: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseDisable = resolve;
    });
    let cancelCount = 0;
    const { controller } = freshController({
      cancelSideEffects: async () => {
        cancelCount += 1;
        if (cancelCount === 1) await hold;
      },
    });
    const first = await startReady(controller);
    await controller.beginOperation({
      projectId: PROJECT,
      kind: 'deploy',
      deploymentId: 'dep-1',
    });

    const disableP = controller.disable(PROJECT, ACTOR);
    await Promise.resolve();
    expect(controller.getProjectState(PROJECT).config.disabling).toBe(true);
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('stopping');

    const stopped = await controller.stop(PROJECT, ACTOR);
    expect(stopped.run.id).toBe(first.run.id);
    expect(stopped.run.controlState).toBe('stopped');
    expect(controller.getProjectState(PROJECT).activeRun).toBeNull();

    expect(() => controller.start(PROJECT, {}, ACTOR)).toThrow(AutopilotError);
    try {
      controller.start(PROJECT, {}, ACTOR);
    } catch (err) {
      expect((err as AutopilotError).code).toBe('conflict');
    }

    releaseDisable();
    const disabled = await disableP;
    expect(disabled.config.enabled).toBe(false);
    expect(disabled.config.disabling).toBe(false);
    expect(disabled.activeRun).toBeNull();
    await expect(
      controller.beginOperation({ projectId: PROJECT, kind: 'implement' }),
    ).rejects.toThrow(/not enabled/i);
  });

  it('refuses beginOperation when project opt-in is off even if a run row is still running', async () => {
    const { db, controller } = freshController();
    await startReady(controller);
    db.prepare(`UPDATE autopilot_project_config SET enabled = 0 WHERE project_id = ?`).run(PROJECT);
    await expect(
      controller.beginOperation({ projectId: PROJECT, kind: 'implement' }),
    ).rejects.toThrow(AutopilotError);
    try {
      await controller.beginOperation({ projectId: PROJECT, kind: 'implement' });
    } catch (err) {
      expect((err as AutopilotError).code).toBe('not_enabled');
    }
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('running');
  });

  it('does not resume when leftover cancellation fails', async () => {
    let failCancel = false;
    const { db, controller: hubA } = freshController({ holderId: 'hub-a' });
    await startReady(hubA);
    await hubA.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-live',
    });
    const hubB = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-b',
      credentialOwnerExists: () => true,
      ...passContainment,
      cancelSideEffects: () =>
        failCancel ? [{ kind: 'session', id: 'sess-live', message: 'session still running' }] : [],
    });
    const reconciled = await hubB.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');
    const ambiguous = reconciled[0].operations.find((op) => op.sessionId === 'sess-live');
    expect(ambiguous?.status).toBe('ambiguous');

    failCancel = true;
    await expect(hubB.resume(PROJECT, ACTOR)).rejects.toMatchObject({ code: 'cancel_failed' });
    const still = hubB.getProjectState(PROJECT).activeRun!;
    expect(still.run.controlState).toBe('paused');
    expect(still.operations.find((op) => op.id === ambiguous?.id)?.status).toBe('ambiguous');

    failCancel = false;
    const resumed = await hubB.resume(PROJECT, ACTOR);
    expect(resumed.run.controlState).toBe('running');
    expect(resumed.operations.find((op) => op.id === ambiguous?.id)?.status).toBe('cancelled');
  });

  it('migrates the run credential owner on resume when config and run owners differ', async () => {
    const valid = new Set(['user-a']);
    const { controller } = freshController({
      credentialOwnerExists: (userId) => valid.has(userId),
    });
    controller.putConfig(
      PROJECT,
      { enabled: true, ...READY, credentialOwnerUserId: 'user-a' },
      ACTOR,
    );
    const started = controller.start(PROJECT, {}, ACTOR);
    expect(started.run.credentialOwnerUserId).toBe('user-a');
    controller.pause(PROJECT, ACTOR);

    valid.add('user-b');
    controller.putConfig(PROJECT, { credentialOwnerUserId: 'user-b' }, ACTOR);
    valid.delete('user-a');

    const resumed = await controller.resume(PROJECT, ACTOR);
    expect(resumed.run.controlState).toBe('running');
    expect(resumed.run.credentialOwnerUserId).toBe('user-b');
  });

  it('refuses resume when the persisted run owner is invalid and config was not changed', async () => {
    const valid = new Set(['user-a']);
    const { controller } = freshController({
      credentialOwnerExists: (userId) => valid.has(userId),
    });
    controller.putConfig(
      PROJECT,
      { enabled: true, ...READY, credentialOwnerUserId: 'user-a' },
      ACTOR,
    );
    controller.start(PROJECT, {}, ACTOR);
    controller.pause(PROJECT, ACTOR);
    valid.delete('user-a');

    await expect(controller.resume(PROJECT, ACTOR)).rejects.toThrow(/no longer valid/);
    const paused = controller.getProjectState(PROJECT).activeRun!;
    expect(paused.run.controlState).toBe('paused');
    expect(paused.run.credentialOwnerUserId).toBe('user-a');
  });

  it('stops an existing run and rejects late callbacks after the server feature flag is turned off', async () => {
    const { db, controller } = freshController({ holderId: 'hub-a' });
    const started = await startReady(controller);
    const op = await controller.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-1',
    });
    const gated = createAutopilotController({
      db,
      isServerEnabled: () => false,
      holderId: 'hub-a',
      credentialOwnerExists: () => true,
    });
    try {
      await gated.beginOperation({ projectId: PROJECT, kind: 'extra' });
      throw new Error('expected server_disabled');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('server_disabled');
    }

    const stopped = await gated.stop(PROJECT, ACTOR);
    expect(stopped.run.controlState).toBe('stopped');
    expect(stopped.run.fencingGeneration).toBeGreaterThan(started.run.fencingGeneration);
    await expect(
      gated.completeOperation({
        operationId: op.id,
        fencingGeneration: started.run.fencingGeneration,
        outcome: 'succeeded',
      }),
    ).rejects.toThrow(/Late callback|stale/i);
    expect(gated.getRun(PROJECT, stopped.run.id).run.controlState).toBe('stopped');
    expect(gated.getProjectState(PROJECT).activeRun).toBeNull();

    const disabled = await gated.disable(PROJECT, ACTOR);
    expect(disabled.config.enabled).toBe(false);
  });

  it('keeps the server operator gate independent of local-mode authentication bypass', () => {
    const { controller } = freshController({ serverEnabled: false });
    expect(controller.getProjectState(PROJECT).serverEnabled).toBe(false);
    try {
      controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
      throw new Error('expected server_disabled');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('server_disabled');
    }
  });

  it('blocks start when required containment cannot be enforced', () => {
    const { controller } = freshController({
      assertContainment: () => {
        throw new AutopilotError(
          'containment_unavailable',
          'Autopilot cannot start: managed project runtime isolation is required',
        );
      },
    });
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    try {
      controller.start(PROJECT, {}, ACTOR);
      throw new Error('expected containment_unavailable');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('containment_unavailable');
    }
    expect(controller.getProjectState(PROJECT).activeRun).toBeNull();
  });

  it('blocks beginOperation when required containment cannot be enforced', async () => {
    let allow = true;
    const { controller } = freshController({
      assertContainment: () => {
        if (!allow) {
          throw new AutopilotError(
            'containment_unavailable',
            'Autopilot cannot start: arbitrary host mounts are not allowed',
          );
        }
      },
    });
    controller.putConfig(PROJECT, { enabled: true, ...READY }, ACTOR);
    await startReady(controller);
    allow = false;
    await expect(
      controller.beginOperation({ projectId: PROJECT, kind: 'implement' }),
    ).rejects.toMatchObject({ code: 'containment_unavailable' });
  });

  it('issues scoped worker authority on start and reports missing cost honestly', async () => {
    const { controller } = freshController();
    const started = await startReady(controller);
    expect(started.run.workerAuthority.keyName).toBe(`autopilot:${PROJECT}:${started.run.id}`);
    expect(started.run.usage.costAvailable).toBe(false);
    expect(started.run.usage.costUsd).toBeNull();
    expect(controller.getProjectState(PROJECT).config.evaluatorPolicy).toEqual({ version: 1 });
  });

  it('pauses when the wall-time envelope is exhausted', async () => {
    const startAt = new Date('2026-09-14T12:00:00.000Z');
    let now = startAt;
    const { controller } = freshController({
      now: () => now,
    });
    controller.putConfig(
      PROJECT,
      {
        enabled: true,
        ...READY,
        limits: { ...READY.limits, maxWallTimeMs: 5_000 },
      },
      ACTOR,
    );
    controller.start(PROJECT, {}, ACTOR);
    now = new Date(startAt.getTime() + 6_000);
    try {
      await controller.beginOperation({ projectId: PROJECT, kind: 'implement' });
      throw new Error('expected envelope_exhausted');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('envelope_exhausted');
    }
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('paused');
    expect(controller.getProjectState(PROJECT).activeRun?.run.pauseReason).toMatch(/wall-time/);
  });

  it('pauses when reported cost exhausts the envelope and ignores missing cost', async () => {
    const { controller } = freshController();
    controller.putConfig(
      PROJECT,
      {
        enabled: true,
        ...READY,
        limits: { ...READY.limits, maxCostUsd: 1 },
      },
      ACTOR,
    );
    const started = controller.start(PROJECT, {}, ACTOR);
    const usage = await controller.recordUsage(PROJECT, {});
    expect(usage.costAvailable).toBe(false);
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('running');

    await controller.completeOperation({
      operationId: started.operations[0].id,
      fencingGeneration: started.run.fencingGeneration,
      outcome: 'succeeded',
      result: { costUsd: 1.5 },
    });
    expect(controller.getProjectState(PROJECT).activeRun?.run.pauseReason).toMatch(/cost envelope/);
    expect(controller.getProjectState(PROJECT).activeRun?.run.usage.costUsd).toBe(1.5);
  });

  it('accumulates operation costs across completions and rejects negative costs', async () => {
    const { controller } = freshController();
    controller.putConfig(
      PROJECT,
      {
        enabled: true,
        ...READY,
        limits: { ...READY.limits, maxCostUsd: 1 },
      },
      ACTOR,
    );
    const started = controller.start(PROJECT, {}, ACTOR);
    await controller.completeOperation({
      operationId: started.operations[0].id,
      fencingGeneration: started.run.fencingGeneration,
      outcome: 'succeeded',
      result: { costUsd: 0.75 },
    });
    expect(controller.getProjectState(PROJECT).activeRun?.run.usage.costUsd).toBe(0.75);
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('running');

    const second = await controller.beginOperation({ projectId: PROJECT, kind: 'implement' });
    try {
      await controller.completeOperation({
        operationId: second.id,
        fencingGeneration: started.run.fencingGeneration,
        outcome: 'succeeded',
        result: { costUsd: -0.1 },
      });
      throw new Error('expected invalid_config');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('invalid_config');
    }
    expect(controller.getProjectState(PROJECT).activeRun?.run.usage.costUsd).toBe(0.75);

    await controller.completeOperation({
      operationId: second.id,
      fencingGeneration: started.run.fencingGeneration,
      outcome: 'succeeded',
      result: { costUsd: 0.75 },
    });
    const after = controller.getProjectState(PROJECT).activeRun!;
    expect(after.run.usage.costUsd).toBe(1.5);
    expect(after.run.controlState).toBe('paused');
    expect(after.run.pauseReason).toMatch(/cost envelope/);
  });

  it('cancels hung work when expiry is detected before the periodic sweep', async () => {
    const cancelled: { refs: AutopilotCancelRefs | null } = { refs: null };
    const startAt = new Date('2026-09-14T12:00:00.000Z');
    let now = startAt;
    const { controller } = freshController({
      now: () => now,
      cancelSideEffects: (refs) => {
        cancelled.refs = refs;
      },
    });
    controller.putConfig(
      PROJECT,
      {
        enabled: true,
        ...READY,
        limits: { ...READY.limits, maxStageTimeoutMs: 2_000 },
      },
      ACTOR,
    );
    controller.start(PROJECT, {}, ACTOR);
    const op = await controller.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-hang',
    });
    now = new Date(startAt.getTime() + 3_000);
    await expect(
      controller.beginOperation({ projectId: PROJECT, kind: 'implement' }),
    ).rejects.toMatchObject({ code: 'envelope_exhausted' });
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('paused');
    expect(controller.getProjectState(PROJECT).activeRun?.run.pauseReason).toMatch(/stage timeout/);
    expect(cancelled.refs?.sessionIds).toContain('sess-hang');
    expect(
      controller.getProjectState(PROJECT).activeRun?.operations.find((row) => row.id === op.id)
        ?.status,
    ).toBe('cancelled');
    await expect(
      controller.completeOperation({
        operationId: op.id,
        fencingGeneration: op.fencingGeneration,
        outcome: 'succeeded',
      }),
    ).rejects.toThrow(/stale/i);
  });

  it('retries a failed stage twice then pauses', async () => {
    const { controller } = freshController();
    const started = await startReady(controller);
    const fail = async (operationId: string, gen: number) =>
      controller.completeOperation({
        operationId,
        fencingGeneration: gen,
        outcome: 'failed',
        result: { error: 'boom' },
      });

    await fail(started.operations[0].id, started.run.fencingGeneration);
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('running');

    const second = await controller.beginOperation({ projectId: PROJECT, kind: 'plan-baseline' });
    await fail(second.id, started.run.fencingGeneration);
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('running');

    const third = await controller.beginOperation({ projectId: PROJECT, kind: 'plan-baseline' });
    await fail(third.id, started.run.fencingGeneration);
    const after = controller.getProjectState(PROJECT).activeRun!;
    expect(after.run.controlState).toBe('paused');
    expect(after.run.pauseReason).toBe('stage_retries_exhausted');
    expect(after.stages.filter((row) => row.stage === 'planning')).toHaveLength(3);
  });

  it('refuses a second cycle while one is still active', async () => {
    const { db, controller } = freshController();
    const started = await startReady(controller);
    try {
      await controller.openNextCycle(PROJECT);
      throw new Error('expected conflict');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('conflict');
    }
    db.prepare(`UPDATE autopilot_cycles SET status = 'succeeded' WHERE run_id = ?`).run(
      started.run.id,
    );
    const next = await controller.openNextCycle(PROJECT);
    expect(next.run.cycleNumber).toBe(2);
    expect(next.cycle?.cycleNumber).toBe(2);
    expect(next.cycle?.status).toBe('active');
  });

  it('rejects last-known-good promotion without a passing recorded judgement', async () => {
    const { db, controller } = freshController();
    const started = await startReady(controller);
    const store = new AutopilotStore(db);
    const cycle = store.getCycle(started.run.id, 1)!;
    store.updateRun(started.run.id, { stage: 'verifying', updatedAt: new Date().toISOString() });
    store.updateCycle(cycle.id, {
      testedCommitSha: 'deadbeefcafe',
      deploymentId: 'dep-1',
    });

    expect(() =>
      controller.promoteLastKnownGood(PROJECT, { sha: 'deadbeefcafe', deploymentId: 'dep-1' }),
    ).toThrow(/passing evaluation bound to this SHA and deployment/);
    expect(store.getRun(started.run.id)!.lastVerifiedSha).toBeNull();

    store.updateCycle(cycle.id, {
      verificationJson: writeCycleVerification(null, {
        judgement: {
          ok: false,
          reason: 'health_only',
          detail: 'HTTP health is not sufficient',
          recover: false,
        },
      }),
    });
    expect(() =>
      controller.promoteLastKnownGood(PROJECT, { sha: 'deadbeefcafe', deploymentId: 'dep-1' }),
    ).toThrow(/passing evaluation bound to this SHA and deployment/);
    expect(store.getRun(started.run.id)!.lastVerifiedSha).toBeNull();
  });
});

describe('autopilot config optimistic concurrency', () => {
  it('increments the revision on each successful write', () => {
    const { controller } = freshController();
    expect(controller.putConfig(PROJECT, { brief: 'first' }, ACTOR).revision).toBe(1);
    expect(controller.putConfig(PROJECT, { brief: 'second' }, ACTOR).revision).toBe(2);
  });

  it('rejects a stale write and preserves the newer config under reversed ordering', () => {
    const { controller } = freshController();
    // Base config at revision 1; both later edits are built from this revision.
    const base = controller.putConfig(PROJECT, { ...READY, enabled: true }, ACTOR);
    expect(base.revision).toBe(1);

    // "Save #2" (the newer intent) reaches the server first and succeeds.
    const save2 = controller.putConfig(
      PROJECT,
      { brief: 'newer brief', expectedRevision: base.revision },
      ACTOR,
    );
    expect(save2.revision).toBe(2);
    expect(save2.brief).toBe('newer brief');

    // "Save #1" (the older intent) arrives afterwards carrying the now-stale
    // base revision — it must be rejected, not silently overwrite the newer one.
    let code: string | undefined;
    let status: number | undefined;
    try {
      controller.putConfig(
        PROJECT,
        { brief: 'older brief', expectedRevision: base.revision },
        ACTOR,
      );
    } catch (err) {
      code = (err as AutopilotError).code;
      status = (err as AutopilotError).httpStatus;
    }
    expect(code).toBe('conflict');
    expect(status).toBe(409);

    // Final persisted configuration is the newer write; the stale one never landed.
    const final = controller.getProjectState(PROJECT).config;
    expect(final.brief).toBe('newer brief');
    expect(final.revision).toBe(2);
  });

  it('permits an unconditional write when no expectedRevision is supplied', () => {
    const { controller } = freshController();
    controller.putConfig(PROJECT, { brief: 'a' }, ACTOR);
    const c = controller.putConfig(PROJECT, { brief: 'b' }, ACTOR);
    expect(c.brief).toBe('b');
    expect(c.revision).toBe(2);
  });
});
