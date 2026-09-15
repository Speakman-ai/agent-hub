import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import {
  PROJECT,
  harness,
  start,
  runFixtureCycle,
  assertVerifiedDocumentation,
  tmp,
  cleanupTmpDirs,
  seedObservableApp,
  runBrowserJourney,
  createMemoryDocumentPort,
} from './acceptance-harness.js';

afterEach(cleanupTmpDirs);

describe('autopilot acceptance — AC1 unattended cycles (disposable app fixture)', () => {
  it('runs a baseline plus two improvement cycles whose verification EXECUTES the deployed app', async () => {
    const workspace = tmp('autopilot-acc-app-');
    const appDir = path.join(workspace, 'app');
    const deployDir = path.join(workspace, 'deployed');
    const baselineSha = seedObservableApp(appDir);
    // The live revision the Hub observes at the target, updated on each deploy.
    const deployed = { sha: baselineSha };

    const docs = createMemoryDocumentPort();
    const { controller, orchestrator, store } = harness({
      document: docs,
      getDeployedRevision: () => deployed.sha,
    });

    start(controller);
    await orchestrator.runPlanning(PROJECT);
    const runId = store.getActiveRun(PROJECT)!.id;

    // Baseline cycle: the fixture already runs add + list; complete/edit do not.
    const baseline = await runFixtureCycle(orchestrator, store, {
      appDir,
      deployDir,
      runId,
      cycleNumber: 1,
      deployed,
    });
    expect(baseline.promoted).toBe(true);
    await orchestrator.runDocumenting(PROJECT);
    assertVerifiedDocumentation(store, runId, 1, baseline.sha);
    expect(runBrowserJourney(deployDir, 'add')).toBe(true);
    expect(runBrowserJourney(deployDir, 'list')).toBe(true);
    expect(runBrowserJourney(deployDir, 'complete')).toBe(false);

    // Improvement 1: implements a working "complete"; the deployed app now does it.
    const c2 = await orchestrator.runSelectingNext(PROJECT);
    expect(c2.run.cycleNumber).toBe(2);
    expect(store.getCycle(runId, 2)!.selectedImprovement).toContain('complete a todo');
    const imp1 = await runFixtureCycle(
      orchestrator,
      store,
      { appDir, deployDir, runId, cycleNumber: 2, deployed },
      { op: 'complete' },
    );
    expect(imp1.promoted).toBe(true);
    await orchestrator.runDocumenting(PROJECT);
    assertVerifiedDocumentation(store, runId, 2, imp1.sha);
    expect(runBrowserJourney(deployDir, 'complete')).toBe(true);
    expect(store.getRun(runId)!.lastVerifiedSha).toBe(imp1.sha);

    // Improvement 2: implements a working "edit" on top.
    const c3 = await orchestrator.runSelectingNext(PROJECT);
    expect(c3.run.cycleNumber).toBe(3);
    expect(store.getCycle(runId, 3)!.selectedImprovement).toContain('edit a todo title');
    const imp2 = await runFixtureCycle(
      orchestrator,
      store,
      { appDir, deployDir, runId, cycleNumber: 3, deployed },
      { op: 'edit' },
    );
    expect(imp2.promoted).toBe(true);
    await orchestrator.runDocumenting(PROJECT);
    assertVerifiedDocumentation(store, runId, 3, imp2.sha);
    // The deployed app now genuinely runs all four operations.
    for (const op of ['add', 'list', 'complete', 'edit'] as const) {
      expect(runBrowserJourney(deployDir, op)).toBe(true);
    }

    // Three revisions landed with distinct real SHAs and no human approval.
    expect(new Set([baseline.sha, imp1.sha, imp2.sha]).size).toBe(3);
    expect(store.getCycle(runId, 1)!.status).toBe('succeeded');
    expect(store.getCycle(runId, 2)!.status).toBe('succeeded');
    expect(store.getRun(runId)!.lastVerifiedSha).toBe(imp2.sha);
    expect(docs.pageWrites).toBe(3);
  });

  it('does not verify green when the promised operation is ABSENT from the deployed app', async () => {
    const workspace = tmp('autopilot-acc-absent-');
    const appDir = path.join(workspace, 'app');
    const deployDir = path.join(workspace, 'deployed');
    const baselineSha = seedObservableApp(appDir);
    const deployed = { sha: baselineSha };

    const { controller, orchestrator, store } = harness({
      getDeployedRevision: () => deployed.sha,
    });
    start(controller);
    await orchestrator.runPlanning(PROJECT);
    const runId = store.getActiveRun(PROJECT)!.id;
    const baseline = await runFixtureCycle(orchestrator, store, {
      appDir,
      deployDir,
      runId,
      cycleNumber: 1,
      deployed,
    });
    await orchestrator.runDocumenting(PROJECT);
    await orchestrator.runSelectingNext(PROJECT);

    // The "improvement" commits but never implements complete; the running app
    // still cannot complete a todo, so the pinned cycle journey fails.
    const noop = await runFixtureCycle(
      orchestrator,
      store,
      { appDir, deployDir, runId, cycleNumber: 2, deployed },
      { op: 'complete', quality: 'absent' },
    );
    expect(noop.promoted).toBe(false);
    expect(runBrowserJourney(deployDir, 'complete')).toBe(false);
    // The last verified revision stays at the baseline candidate, not the no-op.
    expect(store.getRun(runId)!.lastVerifiedSha).toBe(baseline.sha);
  });

  it('does not verify green when the operation is present but BROKEN despite shipping', async () => {
    const workspace = tmp('autopilot-acc-broken-');
    const appDir = path.join(workspace, 'app');
    const deployDir = path.join(workspace, 'deployed');
    const baselineSha = seedObservableApp(appDir);
    const deployed = { sha: baselineSha };

    const { controller, orchestrator, store } = harness({
      getDeployedRevision: () => deployed.sha,
    });
    start(controller);
    await orchestrator.runPlanning(PROJECT);
    const runId = store.getActiveRun(PROJECT)!.id;
    const baseline = await runFixtureCycle(orchestrator, store, {
      appDir,
      deployDir,
      runId,
      cycleNumber: 1,
      deployed,
    });
    await orchestrator.runDocumenting(PROJECT);
    await orchestrator.runSelectingNext(PROJECT);

    // The improvement SHIPS a complete() method, but it is a no-op that never
    // marks the todo done. A marker-based check would be fooled; executing the
    // journey against the deployed app catches it.
    const broken = await runFixtureCycle(
      orchestrator,
      store,
      { appDir, deployDir, runId, cycleNumber: 2, deployed },
      { op: 'complete', quality: 'broken' },
    );
    // list still works, so the app is not simply crashing — the complete journey
    // specifically fails because the operation is broken.
    expect(runBrowserJourney(deployDir, 'list')).toBe(true);
    expect(runBrowserJourney(deployDir, 'complete')).toBe(false);
    expect(broken.promoted).toBe(false);
    expect(store.getRun(runId)!.lastVerifiedSha).toBe(baseline.sha);
  });
});
