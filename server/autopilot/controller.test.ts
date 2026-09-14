import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAutopilotController } from './controller.js';
import { AutopilotError } from './errors.js';
import { ensureAutopilotSchema } from './schema.js';
import type { AutopilotCancelRefs, AutopilotCancelSideEffects } from './types.js';

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

function freshController(opts?: {
  serverEnabled?: boolean;
  cancelSideEffects?: AutopilotCancelSideEffects;
  getDeployedRevision?: (targetId: string) => string | null;
  credentialOwnerExists?: (userId: string) => boolean;
  holderId?: string;
  now?: () => Date;
}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureAutopilotSchema(db);
  const controller = createAutopilotController({
    db,
    isServerEnabled: () => opts?.serverEnabled !== false,
    cancelSideEffects: opts?.cancelSideEffects,
    getDeployedRevision: opts?.getDeployedRevision,
    credentialOwnerExists: opts?.credentialOwnerExists ?? (() => true),
    holderId: opts?.holderId ?? 'hub-a',
    now: opts?.now,
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
    const op = controller.beginOperation({
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

    expect(() =>
      controller.completeOperation({
        operationId: op.id,
        fencingGeneration: genAtStart,
        outcome: 'succeeded',
        result: { sha: 'abc' },
      }),
    ).toThrow(/Late callback|stale/i);

    const after = controller.getRun(PROJECT, stopped.run.id);
    expect(after.run.controlState).toBe('stopped');
    expect(after.operations.find((row) => row.id === op.id)?.status).toBe('cancelled');
  });

  it('does not let a stale fencing generation advance a superseded run', async () => {
    const { controller } = freshController();
    await startReady(controller);
    controller.pause(PROJECT, ACTOR);
    const paused = controller.getProjectState(PROJECT).activeRun!;
    const op = (() => {
      try {
        return controller.beginOperation({ projectId: PROJECT, kind: 'x' });
      } catch (err) {
        expect((err as AutopilotError).code).toBe('conflict');
        return null;
      }
    })();
    expect(op).toBeNull();

    await controller.resume(PROJECT, ACTOR);
    const live = controller.beginOperation({ projectId: PROJECT, kind: 'implement' });
    expect(() =>
      controller.completeOperation({
        operationId: live.id,
        fencingGeneration: paused.run.fencingGeneration,
        outcome: 'succeeded',
      }),
    ).toThrow(AutopilotError);
    const still = controller.getProjectState(PROJECT).activeRun!;
    expect(still.operations.find((row) => row.id === live.id)?.status).toBe('in_flight');
  });

  it('pauses in-flight work as ambiguous after restart and never resurrects stopped runs', async () => {
    const { db, controller } = freshController({ holderId: 'hub-a' });
    await startReady(controller);
    controller.beginOperation({ projectId: PROJECT, kind: 'implement', sessionId: 'sess-1' });

    const restarted = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-b',
      credentialOwnerExists: () => true,
    });
    const reconciled = await restarted.reconcileAfterRestart();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].run.pauseReason).toBe('ambiguous_restart');
    expect(reconciled[0].lease?.holderId).toBe('hub-b');
    expect(reconciled[0].operations.every((op) => op.status !== 'in_flight')).toBe(true);

    const staleGen = reconciled[0].run.fencingGeneration - 1;
    const op = reconciled[0].operations[0];
    expect(() =>
      restarted.completeOperation({
        operationId: op.id,
        fencingGeneration: staleGen,
        outcome: 'succeeded',
      }),
    ).toThrow(/stale/i);

    await restarted.stop(PROJECT, ACTOR);
    const afterStop = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-c',
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
    controller.beginOperation({ projectId: PROJECT, kind: 'deploy', deploymentId: 'dep-1' });

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
    const op = controller.beginOperation({ projectId: PROJECT, kind: 'implement' });
    const pausing = controller.pause(PROJECT, ACTOR);
    expect(pausing.run.controlState).toBe('pausing');

    controller.completeOperation({
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

  it('does not let a superseded controller dispatch work after another hub takes the lease', async () => {
    const { db, controller: hubA } = freshController({ holderId: 'hub-a' });
    await startReady(hubA);
    const hubB = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-b',
      credentialOwnerExists: () => true,
    });
    const reconciled = await hubB.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('running');
    expect(reconciled[0].lease?.holderId).toBe('hub-b');

    try {
      hubA.beginOperation({ projectId: PROJECT, kind: 'implement' });
      throw new Error('expected stale_lease');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('stale_lease');
    }

    hubB.pause(PROJECT, ACTOR);
    const resumed = await hubB.resume(PROJECT, ACTOR);
    expect(resumed.run.controlState).toBe('running');
    expect(resumed.lease?.holderId).toBe('hub-b');

    try {
      hubA.beginOperation({ projectId: PROJECT, kind: 'implement' });
      throw new Error('expected stale_lease');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('stale_lease');
    }

    const op = hubB.beginOperation({ projectId: PROJECT, kind: 'implement' });
    expect(op.status).toBe('in_flight');
  });

  it('cancels restart-ambiguous session and deployment refs when stop runs after restart', async () => {
    const cancels: AutopilotCancelRefs[] = [];
    const { db, controller: hubA } = freshController({ holderId: 'hub-a' });
    await startReady(hubA);
    hubA.beginOperation({
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
    hubA.beginOperation({
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
    const first = controller.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-a',
    });
    const second = controller.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-b',
    });

    controller.completeOperation({
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

    controller.completeOperation({
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
    const op = controller.beginOperation({
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
    const op = controller.beginOperation({
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
    controller.beginOperation({
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
    controller.beginOperation({
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
    expect(() => controller.beginOperation({ projectId: PROJECT, kind: 'implement' })).toThrow(
      /not enabled/i,
    );
  });

  it('refuses beginOperation when project opt-in is off even if a run row is still running', async () => {
    const { db, controller } = freshController();
    await startReady(controller);
    db.prepare(`UPDATE autopilot_project_config SET enabled = 0 WHERE project_id = ?`).run(PROJECT);
    expect(() => controller.beginOperation({ projectId: PROJECT, kind: 'implement' })).toThrow(
      AutopilotError,
    );
    try {
      controller.beginOperation({ projectId: PROJECT, kind: 'implement' });
    } catch (err) {
      expect((err as AutopilotError).code).toBe('not_enabled');
    }
    expect(controller.getProjectState(PROJECT).activeRun?.run.controlState).toBe('running');
  });

  it('does not resume when leftover cancellation fails', async () => {
    let failCancel = false;
    const { db, controller: hubA } = freshController({ holderId: 'hub-a' });
    await startReady(hubA);
    hubA.beginOperation({
      projectId: PROJECT,
      kind: 'implement',
      sessionId: 'sess-live',
    });
    const hubB = createAutopilotController({
      db,
      isServerEnabled: () => true,
      holderId: 'hub-b',
      credentialOwnerExists: () => true,
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
    const op = controller.beginOperation({
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
      gated.beginOperation({ projectId: PROJECT, kind: 'extra' });
      throw new Error('expected server_disabled');
    } catch (err) {
      expect((err as AutopilotError).code).toBe('server_disabled');
    }

    const stopped = await gated.stop(PROJECT, ACTOR);
    expect(stopped.run.controlState).toBe('stopped');
    expect(stopped.run.fencingGeneration).toBeGreaterThan(started.run.fencingGeneration);
    expect(() =>
      gated.completeOperation({
        operationId: op.id,
        fencingGeneration: started.run.fencingGeneration,
        outcome: 'succeeded',
      }),
    ).toThrow(/Late callback|stale/i);
    expect(gated.getRun(PROJECT, stopped.run.id).run.controlState).toBe('stopped');
    expect(gated.getProjectState(PROJECT).activeRun).toBeNull();

    const disabled = await gated.disable(PROJECT, ACTOR);
    expect(disabled.config.enabled).toBe(false);
  });
});
