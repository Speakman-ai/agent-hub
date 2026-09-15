import { describe, it, expect } from 'vitest';
import type { AutopilotCancelRefs } from './types.js';
import {
  PROJECT,
  ACTOR,
  MERGED,
  MERGED_SHA,
  harness,
  start,
  reachDeploying,
  completeDeployEvalDoc,
  fakeDeploy,
  noBenefitPlanner,
} from './acceptance-harness.js';

describe('autopilot acceptance — AC2 failure and recovery', () => {
  it('does not advance and pauses when the live SHA does not match the merged revision', async () => {
    const { controller, orchestrator, store } = harness();
    await reachDeploying(orchestrator, controller);
    const depOp = await orchestrator.dispatchDeploy(PROJECT);
    const res = await orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'success', deploymentId: 'dep-1', deployedSha: 'wrong-sha' },
    });
    expect(res.advanced).toBe(false);
    const run = store.getActiveRun(PROJECT)!;
    expect(run.controlState).toBe('paused');
    expect(run.lastVerifiedSha).toBeNull();
  });

  it('rolls back to the last verified artifact on a failed deployment', async () => {
    const { controller, orchestrator, store } = harness({
      deploy: fakeDeploy({
        rollback: { status: 'success', deploymentId: 'dep-lkg', deployedSha: 'verified-sha' },
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
      result: { status: 'error', deploymentId: 'dep-1', message: 'step failed' },
    });
    const run = store.getRun(runId)!;
    expect(run.controlState).toBe('paused');
    expect(run.pauseReason).toMatch(/recovered last-known-good/);
    expect(run.lastVerifiedSha).toBe('verified-sha');
  });

  it('pauses when recovery rollback does not restore the last verified SHA (failed recovery)', async () => {
    const { controller, orchestrator, store } = harness({
      deploy: fakeDeploy({
        rollback: { status: 'success', deploymentId: 'dep-bad', deployedSha: 'not-the-lkg' },
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
  });

  it('is idempotent when a finalize completion is delivered twice', async () => {
    const { controller, orchestrator, store } = harness();
    start(controller);
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
    const second = await orchestrator.reconcileFinalize(PROJECT, {
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      result: MERGED,
    });
    expect(first.advanced).toBe(true);
    expect(second.advanced).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(store.getCycle(store.getActiveRun(PROJECT)!.id, 1)!.testedCommitSha).toBe(MERGED_SHA);
  });

  it('cancels the in-flight deployment when Stop runs during deploying', async () => {
    const cancels: AutopilotCancelRefs[] = [];
    const { controller, orchestrator, store } = harness({
      cancelSideEffects: (refs) => {
        cancels.push({
          sessionIds: [...refs.sessionIds],
          finalizeRunIds: [...refs.finalizeRunIds],
          deploymentIds: [...refs.deploymentIds],
          operationIds: [...refs.operationIds],
        });
      },
    });
    await reachDeploying(orchestrator, controller);
    const depOp = await orchestrator.dispatchDeploy(PROJECT);
    expect(store.getCycle(store.getActiveRun(PROJECT)!.id, 1)!.deploymentId).toBe('dep-1');

    const stopped = await controller.stop(PROJECT, ACTOR);
    expect(stopped.run.controlState).toBe('stopped');
    expect(stopped.operations.find((op) => op.id === depOp.id)?.status).toBe('cancelled');
    expect(cancels.at(-1)?.deploymentIds).toContain('dep-1');
  });

  it('pauses when the wall-time envelope is exhausted (limits)', async () => {
    const startAt = new Date('2026-09-14T12:00:00.000Z');
    let now = startAt;
    const { controller, store } = harness({ now: () => now });
    start(controller, { limits: { maxWallTimeMs: 5_000 } });
    now = new Date(startAt.getTime() + 6_000);
    await expect(
      controller.beginOperation({ projectId: PROJECT, kind: 'implement' }),
    ).rejects.toMatchObject({ code: 'envelope_exhausted' });
    const run = store.getActiveRun(PROJECT)!;
    expect(run.controlState).toBe('paused');
    expect(run.pauseReason).toMatch(/wall-time/i);
  });

  it('pauses after three consecutive no-benefit proposals (no-improvement pause)', async () => {
    const { controller, orchestrator, store } = harness({ planner: noBenefitPlanner() });
    await reachDeploying(orchestrator, controller);
    await completeDeployEvalDoc(orchestrator);
    const runId = store.getActiveRun(PROJECT)!.id;
    await orchestrator.runSelectingNext(PROJECT);
    await orchestrator.runSelectingNext(PROJECT);
    const paused = await orchestrator.runSelectingNext(PROJECT);
    expect(paused.run.controlState).toBe('paused');
    expect(paused.run.pauseReason).toMatch(/three consecutive rejected\/no-benefit/);
    expect(store.getCycle(runId, 2)).toBeNull();
  });
});
