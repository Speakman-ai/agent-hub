import { describe, it, expect } from 'vitest';
import {
  PROJECT,
  ACTOR,
  MERGED_SHA,
  harness,
  start,
  reachDeploying,
  fakeDeploy,
  criterion,
  passingEvalReport,
  capturesFor,
  createAutopilotController,
  createMemoryDocumentPort,
  parseCycleDocumentation,
  decideAutopilotWorkerRequest,
} from './acceptance-harness.js';

describe('autopilot acceptance — AC3 authorization and durable outcomes', () => {
  const SCOPE = { projectId: PROJECT, runId: 'run-1', role: 'implementer' as const };

  it('denies cross-project worker requests', () => {
    expect(
      decideAutopilotWorkerRequest(SCOPE, 'GET', '/api/projects/other-app/wiki/pages').ok,
    ).toBe(false);
  });

  it('denies protected brief/policy/limits/target and deployment writes', () => {
    for (const [method, apiPath] of [
      ['PUT', `/api/projects/${PROJECT}/autopilot/config`],
      ['POST', `/api/projects/${PROJECT}/autopilot/start`],
      ['POST', `/api/projects/${PROJECT}/autopilot/disable`],
    ] as const) {
      expect(decideAutopilotWorkerRequest(SCOPE, method, apiPath).ok).toBe(false);
    }
    expect(
      decideAutopilotWorkerRequest(
        SCOPE,
        'PATCH',
        `/api/projects/${PROJECT}/deploy/environments/prod`,
      ).ok,
    ).toBe(false);
    expect(
      decideAutopilotWorkerRequest(SCOPE, 'GET', `/api/projects/${PROJECT}/autopilot`).ok,
    ).toBe(true);
  });

  it('never resurrects a stopped run after restart', async () => {
    const { db, controller } = harness({ holderId: 'hub-a' });
    start(controller);
    await controller.beginOperation({ projectId: PROJECT, kind: 'implement', sessionId: 'sess-1' });
    await controller.stop(PROJECT, ACTOR);

    const afterStop = createAutopilotController({
      db,
      isServerEnabled: () => true,
      credentialOwnerExists: () => true,
      holderId: 'hub-c',
      assertContainment: () => undefined,
      issueWorkerCredential: ({ runId }: { runId: string }) => ({
        keyName: `autopilot:${PROJECT}:${runId}`,
        keyId: `key-${runId}`,
        token: `ahub_worker_${runId}`,
      }),
      revokeWorkerCredential: () => undefined,
    });
    const again = await afterStop.reconcileAfterRestart();
    expect(again).toHaveLength(0);
    expect(afterStop.getProjectState(PROJECT).activeRun).toBeNull();
  });

  it('persists documentation of a failed attempt with its available evidence (production path)', async () => {
    const docs = createMemoryDocumentPort();
    const { controller, orchestrator, store } = harness({
      document: docs,
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
      result: { status: 'error', deploymentId: 'dep-1', message: 'deploy step crashed' },
    });
    expect(store.getRun(runId)!.controlState).toBe('paused');

    // The orchestrator documents the terminal (paused) cycle through the
    // production afterFailedOperation path — not a hand-built record.
    const record = parseCycleDocumentation(store.getCycle(runId, 1)!.documentation);
    expect(record).toBeTruthy();
    expect(record!.kind === 'failure' || record!.kind === 'proposal').toBe(true);
    expect(record!.failedAttempts.length).toBeGreaterThan(0);
    expect(record!.failedAttempts.some((a) => a.reason.startsWith('deploy'))).toBe(true);
    // Correct cycle / revision association and the deployment it targeted.
    expect(record!.links.cardId).toBe('card-1');
    expect(record!.links.testedCommitSha).toBe(MERGED_SHA);
    expect(record!.links.deploymentId).toBeTruthy();
    expect(docs.pageWrites).toBeGreaterThan(0);
  });

  it('documents a rejected candidate (failed verification) with its captured evidence and revision', async () => {
    const docs = createMemoryDocumentPort();
    const { controller, orchestrator, store } = harness({ document: docs });
    // Retry budget 0 so a single failed verification is terminal (and documented).
    await reachDeploying(orchestrator, controller, { limits: { maxRetriesPerStage: 0 } });
    const runId = store.getActiveRun(PROJECT)!.id;
    const depOp = await orchestrator.dispatchDeploy(PROJECT);
    const deploymentId = store.getCycle(runId, 1)!.deploymentId!;
    await orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'success', deploymentId, deployedSha: MERGED_SHA },
    });
    const evalOp = await orchestrator.dispatchEvaluate(PROJECT);
    // Verification runs, but the improvement journey does not pass.
    const report = passingEvalReport({
      criteria: [
        criterion('baseline-1', 'todos are shown'),
        criterion('baseline-2', 'existing todos are shown'),
        {
          criterionId: 'cycle-1',
          passed: false,
          kind: 'browser_journey' as const,
          screenshotPath: '/tmp/eval/cycle-1.png',
          tracePath: '/tmp/eval/cycle-1.trace',
          observed: 'promised behavior did not run',
        },
        criterion('cycle-2', 'existing todos are shown'),
      ],
    });
    const res = await orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: report,
      captures: capturesFor(evalOp.id, deploymentId, report),
    });
    expect(res.advanced).toBe(false);

    const record = parseCycleDocumentation(store.getCycle(runId, 1)!.documentation);
    expect(record).toBeTruthy();
    // The rejected attempt is linked, and its captured verification evidence is retained.
    expect(record!.failedAttempts.some((a) => a.reason.startsWith('evaluate'))).toBe(true);
    expect(record!.evidence.some((e) => e.kind === 'screenshot')).toBe(true);
    expect(record!.links.testedCommitSha).toBe(MERGED_SHA);
    expect(record!.links.deploymentId).toBeTruthy();
    expect(docs.pageWrites).toBeGreaterThan(0);
  });
});
