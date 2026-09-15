import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  PROJECT,
  ACTOR,
  MERGED,
  MERGED_SHA,
  ensureAutopilotSchema,
  createMemoryDocumentPort,
  parseCycleDocumentation,
  countingPorts,
  rebuild,
  reachDeploying,
  start,
  passingEvalReport,
  capturesFor,
  gatedRollbackPorts,
  gatedDocumentPort,
} from './acceptance-harness.js';

describe('autopilot acceptance — AC2 restart around each side effect', () => {
  // Each test reconstructs the controller + orchestrator over preserved state
  // (a real Hub restart) at a side-effect boundary and asserts the production
  // reconciliation neither duplicates the effect nor advances stale work.

  it('Implementation: restart while dispatched pauses ambiguous and rejects the stale completion', async () => {
    const p = countingPorts();
    const db = new Database(':memory:');
    const a = (() => {
      db.pragma('foreign_keys = ON');
      ensureAutopilotSchema(db);
      return rebuild(db, p, 'hub-a');
    })();
    start(a.controller);
    await a.orchestrator.runPlanning(PROJECT);
    const implOp = await a.orchestrator.dispatchImplementation(PROJECT);
    expect(p.counts.session).toBe(1);

    // Crash between dispatch and durable completion → restart.
    const b = rebuild(db, p, 'hub-b');
    const reconciled = await b.controller.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].run.pauseReason).toBe('ambiguous_restart');
    expect(p.counts.session).toBe(1); // reconciliation did not re-dispatch

    // The in-flight worker's late completion targets a superseded generation.
    const late = await b.orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    expect(late.advanced).toBe(false);
    const runId = b.store.getActiveRun(PROJECT)!.id;
    expect(b.store.getRun(runId)!.controlState).toBe('paused');
    expect(b.store.getRun(runId)!.stage).toBe('implementing');
    expect(p.counts.session).toBe(1);
  });

  it('Finalize: restart while dispatched pauses ambiguous; the stale merge result cannot advance', async () => {
    const p = countingPorts();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const a = rebuild(db, p, 'hub-a');
    start(a.controller);
    await a.orchestrator.runPlanning(PROJECT);
    const implOp = await a.orchestrator.dispatchImplementation(PROJECT);
    await a.orchestrator.reconcileImplementation(PROJECT, {
      operationId: implOp.id,
      fencingGeneration: implOp.fencingGeneration,
      result: { committed: true },
    });
    const finOp = await a.orchestrator.dispatchFinalize(PROJECT);
    expect(p.counts.finalize).toBe(1);

    // Crash between finalize dispatch and its durable completion → restart.
    const b = rebuild(db, p, 'hub-b');
    const reconciled = await b.controller.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].run.pauseReason).toBe('ambiguous_restart');
    expect(p.counts.finalize).toBe(1); // reconciliation did not re-finalize

    const runId = b.store.getActiveRun(PROJECT)!.id;
    const late = await b.orchestrator.reconcileFinalize(PROJECT, {
      operationId: finOp.id,
      fencingGeneration: finOp.fencingGeneration,
      result: MERGED,
    });
    expect(late.advanced).toBe(false);
    expect(b.store.getCycle(runId, 1)!.testedCommitSha).toBeNull();
    expect(b.store.getRun(runId)!.controlState).toBe('paused');
    expect(p.counts.finalize).toBe(1);
  });

  it('Deploy: restart while dispatched pauses ambiguous; the stale deploy result cannot advance', async () => {
    const p = countingPorts();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const a = rebuild(db, p, 'hub-a');
    await reachDeploying(a.orchestrator, a.controller);
    const depOp = await a.orchestrator.dispatchDeploy(PROJECT);
    const runId = a.store.getActiveRun(PROJECT)!.id;
    const deploymentId = a.store.getCycle(runId, 1)!.deploymentId!;
    expect(p.counts.deploy).toBe(1);

    // Crash between deploy dispatch and its durable completion → restart.
    const b = rebuild(db, p, 'hub-b');
    const reconciled = await b.controller.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].run.pauseReason).toBe('ambiguous_restart');
    expect(p.counts.deploy).toBe(1);

    const late = await b.orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'success', deploymentId, deployedSha: MERGED_SHA },
    });
    expect(late.advanced).toBe(false);
    expect(b.store.getRun(runId)!.controlState).toBe('paused');
    expect(b.store.getRun(runId)!.lastVerifiedSha).toBeNull();
    expect(p.counts.deploy).toBe(1);
  });

  it('Evaluate: restart while dispatched pauses ambiguous; the stale evaluation cannot promote', async () => {
    const p = countingPorts();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const a = rebuild(db, p, 'hub-a');
    await reachDeploying(a.orchestrator, a.controller);
    const depOp = await a.orchestrator.dispatchDeploy(PROJECT);
    const runId = a.store.getActiveRun(PROJECT)!.id;
    const deploymentId = a.store.getCycle(runId, 1)!.deploymentId!;
    await a.orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'success', deploymentId, deployedSha: MERGED_SHA },
    });
    const evalOp = await a.orchestrator.dispatchEvaluate(PROJECT);
    expect(p.counts.evaluate).toBe(1);

    // Crash between evaluate dispatch and its durable completion → restart.
    const b = rebuild(db, p, 'hub-b');
    const reconciled = await b.controller.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].run.pauseReason).toBe('ambiguous_restart');

    const report = passingEvalReport();
    const late = await b.orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: report,
      captures: capturesFor(evalOp.id, deploymentId, report),
    });
    expect(late.advanced).toBe(false);
    expect(b.store.getRun(runId)!.lastVerifiedSha).toBeNull();
    expect(b.store.getRun(runId)!.controlState).toBe('paused');
    expect(p.counts.evaluate).toBe(1);
  });

  it('Recovery: restart after a failed deploy rolled back does not roll back again', async () => {
    const p = countingPorts();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const a = rebuild(db, p, 'hub-a');
    await reachDeploying(a.orchestrator, a.controller);
    const runId = a.store.getActiveRun(PROJECT)!.id;
    a.store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
      updatedAt: a.store.getRun(runId)!.updatedAt,
    });
    const depOp = await a.orchestrator.dispatchDeploy(PROJECT);
    await a.orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'error', deploymentId: a.store.getCycle(runId, 1)!.deploymentId! },
    });
    expect(a.store.getRun(runId)!.controlState).toBe('paused');
    expect(p.counts.rollback).toBe(1);

    // Restart: reconciliation of a run already rolled-back-and-paused must not
    // re-run recovery.
    const b = rebuild(db, p, 'hub-b');
    await b.controller.reconcileAfterRestart();
    expect(b.store.getRun(runId)!.controlState).toBe('paused');
    expect(p.counts.rollback).toBe(1);
  });

  it('Documentation: restart mid-documenting persists the record once, without re-deploy or re-finalize', async () => {
    const p = countingPorts();
    const docs = createMemoryDocumentPort();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const a = rebuild(db, p, 'hub-a', docs);
    await reachDeploying(a.orchestrator, a.controller);
    // Drive to documenting WITHOUT completing it (deploy + verify, stop short).
    const depOp = await a.orchestrator.dispatchDeploy(PROJECT);
    const runId = a.store.getActiveRun(PROJECT)!.id;
    const deploymentId = a.store.getCycle(runId, 1)!.deploymentId!;
    await a.orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'success', deploymentId, deployedSha: MERGED_SHA },
    });
    const evalOp = await a.orchestrator.dispatchEvaluate(PROJECT);
    const report = passingEvalReport();
    await a.orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: report,
      captures: capturesFor(evalOp.id, deploymentId, report),
    });
    expect(a.store.getRun(runId)!.stage).toBe('documenting');
    expect(docs.pageWrites).toBe(0);

    // Restart mid-documenting; the fresh Hub finishes documentation exactly once.
    const b = rebuild(db, p, 'hub-b', docs);
    await b.controller.reconcileAfterRestart();
    if (b.store.getRun(runId)!.controlState !== 'running') {
      await b.controller.resume(PROJECT, ACTOR);
    }
    const done = await b.orchestrator.runDocumenting(PROJECT);
    expect(done.run.stage).toBe('selecting-next');
    expect(docs.pageWrites).toBe(1);
    expect(parseCycleDocumentation(b.store.getCycle(runId, 1)!.documentation)?.kind).toBe(
      'success',
    );
    // No side effect was replayed to reach documentation.
    expect(p.counts.deploy).toBe(1);
    expect(p.counts.finalize).toBe(1);
  });

  it('Recovery: a crash DURING rollback pauses ambiguous, bumps the fence, and does not re-run recovery', async () => {
    const p = gatedRollbackPorts();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const a = rebuild(db, p, 'hub-a');
    await reachDeploying(a.orchestrator, a.controller);
    const runId = a.store.getActiveRun(PROJECT)!.id;
    a.store.updateRun(runId, {
      lastVerifiedSha: 'verified-sha',
      lastDeploymentId: 'dep-lkg',
      updatedAt: a.store.getRun(runId)!.updatedAt,
    });
    const depOp = await a.orchestrator.dispatchDeploy(PROJECT);
    const genBefore = a.store.getRun(runId)!.fencingGeneration;

    // Start the failed-deploy reconcile; it enters rollback and blocks there —
    // the interruption point. The crashed attempt is abandoned; swallow the
    // stale error it throws if it ever unblocks.
    const abandoned = a.orchestrator
      .reconcileDeploy(PROJECT, {
        operationId: depOp.id,
        fencingGeneration: depOp.fencingGeneration,
        result: { status: 'error', deploymentId: a.store.getCycle(runId, 1)!.deploymentId! },
      })
      .catch(() => undefined);
    await p.gateEntered;
    // Rollback is in flight and the deploy op's durable completion is not recorded.
    expect(p.counts.rollback).toBe(1);
    expect(a.store.getOperation(depOp.id)!.status).toBe('in_flight');

    // Restart mid-rollback over the preserved state.
    const b = rebuild(db, p, 'hub-b');
    const reconciled = await b.controller.reconcileAfterRestart();
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].run.pauseReason).toBe('ambiguous_restart');
    expect(reconciled[0].run.fencingGeneration).toBeGreaterThan(genBefore);
    // Reconciliation did not re-run recovery.
    expect(p.counts.rollback).toBe(1);

    // Let the abandoned rollback finish late: its now-fenced completion cannot
    // advance the superseded generation — the ambiguous pause holds.
    p.openGate();
    await abandoned;
    expect(b.store.getRun(runId)!.controlState).toBe('paused');
    expect(b.store.getRun(runId)!.pauseReason).toBe('ambiguous_restart');
    expect(p.counts.rollback).toBe(1);
  });

  it('Documentation: a crash DURING the journal write pauses ambiguous and does not duplicate deploy/finalize', async () => {
    const ports = countingPorts();
    const gated = gatedDocumentPort();
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureAutopilotSchema(db);
    const a = rebuild(db, ports, 'hub-a', gated.doc);
    await reachDeploying(a.orchestrator, a.controller);
    const runId = a.store.getActiveRun(PROJECT)!.id;
    const depOp = await a.orchestrator.dispatchDeploy(PROJECT);
    const deploymentId = a.store.getCycle(runId, 1)!.deploymentId!;
    await a.orchestrator.reconcileDeploy(PROJECT, {
      operationId: depOp.id,
      fencingGeneration: depOp.fencingGeneration,
      result: { status: 'success', deploymentId, deployedSha: MERGED_SHA },
    });
    const evalOp = await a.orchestrator.dispatchEvaluate(PROJECT);
    const report = passingEvalReport();
    await a.orchestrator.reconcileEvaluate(PROJECT, {
      operationId: evalOp.id,
      fencingGeneration: evalOp.fencingGeneration,
      result: report,
      captures: capturesFor(evalOp.id, deploymentId, report),
    });
    expect(a.store.getRun(runId)!.stage).toBe('documenting');
    const genBefore = a.store.getRun(runId)!.fencingGeneration;

    // Start documentation; it enters the journal write and blocks — the
    // interruption point. The crashed attempt is abandoned mid-write.
    const abandoned = a.orchestrator.runDocumenting(PROJECT).catch(() => undefined);
    await gated.gateEntered;
    expect(gated.doc.pageWrites).toBe(0); // the underlying write has not happened

    // Restart mid-write over the preserved state.
    const b = rebuild(db, ports, 'hub-b', createMemoryDocumentPort());
    const reconciled = await b.controller.reconcileAfterRestart();
    // Designed behavior: the in-flight documenting op is ambiguous, so the run
    // pauses (rather than replaying documentation forward).
    expect(reconciled[0].run.controlState).toBe('paused');
    expect(reconciled[0].run.pauseReason).toBe('ambiguous_restart');
    expect(reconciled[0].run.fencingGeneration).toBeGreaterThan(genBefore);
    expect(gated.doc.pageWrites).toBe(0); // the abandoned attempt still wrote nothing
    // No deploy/finalize was replayed by reconciliation.
    expect(ports.counts.deploy).toBe(1);
    expect(ports.counts.finalize).toBe(1);

    // Let the abandoned write unblock late: its now-fenced documenting op cannot
    // advance the superseded generation — the ambiguous pause holds, and no
    // deploy/finalize was duplicated.
    gated.openGate();
    await abandoned;
    expect(b.store.getRun(runId)!.controlState).toBe('paused');
    expect(b.store.getRun(runId)!.pauseReason).toBe('ambiguous_restart');
    expect(b.store.getRun(runId)!.stage).toBe('documenting');
    expect(ports.counts.deploy).toBe(1);
    expect(ports.counts.finalize).toBe(1);
  });
});
