/**
 * Shared harness for the Autopilot acceptance suite (acceptance-*.test.ts).
 *
 * Provides the deterministic fakes, the production controller+orchestrator
 * wiring, the disposable browser-app fixture driver, restart reconstruction and
 * evidence assertions used by the per-criterion acceptance test files.
 *
 * Drives the PRODUCTION
 * controller + orchestrator with deterministic fake ports: no agent CLI, no
 * Finalize CI, no live deployment, no network. Every model/agent/deploy/browser
 * interaction is an in-memory or on-disk-fixture fake, so the global CLI-spawn
 * and network guards in server/test/setup.ts are never tripped.
 *
 * Coverage map (card acceptance criteria):
 *   AC1  unattended baseline + two evidence-backed improvement cycles, driven by
 *        a disposable app fixture whose OBSERVABLE behavior determines the
 *        deployment revision and the verification outcome (a cycle that never
 *        changed behavior cannot verify green).
 *   AC2  wrong SHA, failed deploy, failed recovery, duplicate delivery,
 *        cancellation during deployment, limits, no-improvement pause, and
 *        restart-around-each-side-effect reconciliation (no duplicate effects,
 *        no stale advance).
 *   AC3  cross-project denial, protected-policy denial, no Stop resurrection,
 *        and production-persisted documentation of a failed attempt with its
 *        available evidence.
 *   AC5  all model/network calls mocked; the harness constructs only in-memory
 *        or disposable on-disk fixtures.
 */
import Database from 'better-sqlite3';
import { expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
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
import type { AutopilotEvaluationReport, AutopilotExecutionCapture } from './evaluate.js';
import { AutopilotStore } from './store.js';
import { ensureAutopilotSchema } from './schema.js';
import {
  createMemoryDocumentPort,
  parseCycleDocumentation,
  type AutopilotDocumentPort,
} from './document.js';
import type { AutopilotSelectedImprovement } from './select.js';
import type { AutopilotCancelRefs, AutopilotLimits } from './types.js';
import { decideAutopilotWorkerRequest } from './worker-authority.js';
import {
  commitNoop,
  deployApp,
  headSha,
  implementFeature,
  opForAction,
  runBrowserJourney,
  type TodoOp,
} from './fixtures/observable-app.js';

export const PROJECT = 'acceptance-app';
export const ACTOR = { userId: 'user-1' };
export const MERGED_SHA = 'deadbeefcafe';

export const READY = {
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

export const SPEC: AutopilotBaselineSpec = {
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

export const IMPROVEMENTS: AutopilotSelectedImprovement[] = [
  {
    id: 'complete-todo',
    kind: 'unmet-goal',
    action: 'complete a todo',
    expectedResult: 'it is marked done in the list',
    expectedBenefit: 'Users can complete todos from the list.',
    rationale: 'Unmet brief goal',
  },
  {
    id: 'edit-todo',
    kind: 'unmet-goal',
    action: 'edit a todo title',
    expectedResult: 'the list shows the new title',
    expectedBenefit: 'Users can rename todos.',
    rationale: 'Unmet brief goal',
  },
];

export function fakePlanner(
  improvements: AutopilotSelectedImprovement[] = IMPROVEMENTS,
): AutopilotPlannerPort {
  let i = 0;
  return {
    expandBrief: async () => SPEC,
    proposeImprovements: async () => {
      const next = improvements[i] ?? null;
      if (next) i += 1;
      return {
        candidates: next ? [next] : [],
        selected: next,
        outcome: next ? 'selected' : 'no-benefit',
        reason: next ? undefined : 'no remaining in-scope improvement with a falsifiable benefit',
      };
    },
  };
}

export function noBenefitPlanner(): AutopilotPlannerPort {
  return {
    expandBrief: async () => SPEC,
    proposeImprovements: async () => ({
      candidates: [],
      selected: null,
      outcome: 'no-benefit',
      reason: 'no measured benefit remains',
    }),
  };
}

export function fakeBoard(): AutopilotBoardPort {
  let improvementSeq = 1;
  return {
    createBaselineBoard: async () => ({
      epicId: 'epic-1',
      primaryCardId: 'card-1',
      cards: [
        { cardId: 'card-1', title: 'baseline API', phase: 1, blockedBy: [] },
        { cardId: 'card-2', title: 'list page', phase: 1, blockedBy: ['card-1'] },
      ],
    }),
    validatePhaseOrder: async () => ({ ok: true }),
    priorPhaseComplete: async () => ({ ok: true }),
    createImprovementBoard: async ({ improvement }) => {
      const n = improvementSeq;
      improvementSeq += 1;
      return {
        epicId: 'epic-1',
        primaryCardId: `card-improve-${n}`,
        cards: [
          {
            cardId: `card-improve-${n}`,
            title: improvement.action,
            phase: n + 1,
            blockedBy: ['card-1'],
          },
        ],
      };
    },
  };
}

export const fakeSession = (sessionId = 'sess-1'): AutopilotSessionPort => ({
  dispatchImplementation: async () => ({ sessionId }),
});
export const fakeFinalize = (finalizeRunId = 'fin-1'): AutopilotFinalizePort => ({
  startFinalize: async () => ({ finalizeRunId }),
});
export const fakeEvaluate = (sessionId = 'eval-1'): AutopilotEvaluatePort => ({
  dispatchEvaluation: async () => ({ sessionId }),
});

export function fakeDeploy(opts?: { rollback?: AutopilotDeployResult }): AutopilotDeployPort {
  return {
    deployRevision: async () => ({ deploymentId: 'dep-1' }),
    rollback: async () =>
      opts?.rollback ?? {
        status: 'success',
        deploymentId: 'dep-rollback',
        deployedSha: 'verified-sha',
      },
  };
}

export const MERGED: AutopilotFinalizeResult = {
  status: 'merged',
  mergedSha: MERGED_SHA,
  reviewStatus: 'approved',
};

export function passingEvalReport(
  overrides: Partial<AutopilotEvaluationReport> = {},
): AutopilotEvaluationReport {
  const at = overrides.capturedAt || new Date().toISOString();
  return {
    expectedSha: MERGED_SHA,
    observedSha: MERGED_SHA,
    origin: 'http://127.0.0.1:4310',
    healthCheck: { url: 'http://127.0.0.1:4310/health', ok: true },
    capturedAt: at,
    criteria: [
      criterion('baseline-1', 'todos are shown'),
      criterion('baseline-2', 'existing todos are shown'),
      criterion('cycle-1', 'todos are shown'),
      criterion('cycle-2', 'existing todos are shown'),
    ],
    ...overrides,
  };
}

export function criterion(id: string, observed: string) {
  return {
    criterionId: id,
    passed: true,
    kind: 'browser_journey' as const,
    screenshotPath: `/tmp/eval/${id}.png`,
    tracePath: `/tmp/eval/${id}.trace`,
    observed,
  };
}

export function capturesFor(
  operationId: string,
  deploymentId: string,
  report: AutopilotEvaluationReport,
): AutopilotExecutionCapture[] {
  const capturedAt = report.capturedAt || new Date().toISOString();
  const mtimeMs = Date.parse(capturedAt) || Date.now();
  return report.criteria.flatMap((ev): AutopilotExecutionCapture[] => {
    if (!ev.screenshotPath && !ev.tracePath) return [];
    return [
      {
        captureId: `cap-${ev.criterionId}`,
        criterionId: ev.criterionId,
        kind: 'browser_journey' as const,
        capturedAt,
        operationId,
        deploymentId,
        expectedSha: report.expectedSha,
        origin: 'http://127.0.0.1:4310',
        screenshot: ev.screenshotPath ? { path: ev.screenshotPath, mtimeMs } : null,
        trace: ev.tracePath ? { path: ev.tracePath, mtimeMs } : null,
        api: null,
      },
    ];
  });
}

export function passingEvalCaptures(
  operationId: string,
  report: AutopilotEvaluationReport = passingEvalReport(),
): AutopilotExecutionCapture[] {
  return capturesFor(operationId, 'dep-1', report);
}

export function harness(opts?: {
  holderId?: string;
  planner?: AutopilotPlannerPort;
  board?: AutopilotBoardPort;
  session?: AutopilotSessionPort;
  finalize?: AutopilotFinalizePort;
  deploy?: AutopilotDeployPort;
  evaluate?: AutopilotEvaluatePort;
  document?: AutopilotDocumentPort;
  db?: Database.Database;
  now?: () => Date;
  getDeployedRevision?: () => string | null;
  cancelSideEffects?: (refs: AutopilotCancelRefs) => void;
}) {
  const db = opts?.db ?? new Database(':memory:');
  db.pragma('foreign_keys = ON');
  ensureAutopilotSchema(db);
  const controller = createAutopilotController({
    db,
    credentialOwnerExists: () => true,
    holderId: opts?.holderId ?? 'hub-a',
    now: opts?.now,
    assertContainment: () => undefined,
    issueWorkerCredential: ({ projectId, runId }: { projectId: string; runId: string }) => ({
      keyName: `autopilot:${projectId}:${runId}`,
      keyId: `key-${runId}`,
      token: `ahub_worker_${runId}`,
    }),
    revokeWorkerCredential: () => undefined,
    getDeployedRevision: opts?.getDeployedRevision ?? (() => MERGED_SHA),
    cancelSideEffects: opts?.cancelSideEffects,
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
    document: opts?.document,
    artifactExists: () => ({ exists: true, mtimeMs: Date.now(), journeyTrace: true }),
    readEvidenceFile: (filePath: string) =>
      filePath.endsWith('.png')
        ? { body: Buffer.from('PNG'), contentType: 'image/png' }
        : { body: Buffer.from('{"actions":[]}'), contentType: 'application/json' },
  });
  return { db, controller, orchestrator, store: new AutopilotStore(db) };
}

export type Orchestrator = ReturnType<typeof createAutopilotOrchestrator>;
export type Controller = ReturnType<typeof createAutopilotController>;

export function start(controller: Controller, overlay?: { limits?: Partial<AutopilotLimits> }) {
  controller.putConfig(
    PROJECT,
    { enabled: true, ...READY, limits: { ...READY.limits, ...(overlay?.limits ?? {}) } },
    ACTOR,
  );
  return controller.start(PROJECT, {}, ACTOR);
}

export async function reachDeploying(
  o: Orchestrator,
  c: Controller,
  overlay?: { limits?: Partial<AutopilotLimits> },
) {
  start(c, overlay);
  await o.runPlanning(PROJECT);
  const implOp = await o.dispatchImplementation(PROJECT);
  await o.reconcileImplementation(PROJECT, {
    operationId: implOp.id,
    fencingGeneration: implOp.fencingGeneration,
    result: { committed: true, commitSha: 'abc123' },
  });
  const finOp = await o.dispatchFinalize(PROJECT);
  await o.reconcileFinalize(PROJECT, {
    operationId: finOp.id,
    fencingGeneration: finOp.fencingGeneration,
    result: MERGED,
  });
}

/** Drives deploying -> documenting (deploy the merged SHA, verify it, document). */
export async function completeDeployEvalDoc(o: Orchestrator) {
  const depOp = await o.dispatchDeploy(PROJECT);
  await o.reconcileDeploy(PROJECT, {
    operationId: depOp.id,
    fencingGeneration: depOp.fencingGeneration,
    result: { status: 'success', deploymentId: 'dep-1', deployedSha: MERGED_SHA },
  });
  const evalOp = await o.dispatchEvaluate(PROJECT);
  const report = passingEvalReport();
  await o.reconcileEvaluate(PROJECT, {
    operationId: evalOp.id,
    fencingGeneration: evalOp.fencingGeneration,
    result: report,
    captures: passingEvalCaptures(evalOp.id, report),
  });
  return o.runDocumenting(PROJECT);
}

// ── Fixture-backed helpers (AC1) ──────────────────────────────────────────

export interface PinnedCriterion {
  id: string;
  action: string;
  source: string;
}

export function pinnedCriteria(
  store: AutopilotStore,
  runId: string,
  cycleNumber: number,
): PinnedCriterion[] {
  const v = store.getCycle(runId, cycleNumber)!.verification as {
    pinned?: { criteria?: PinnedCriterion[] };
  } | null;
  return v?.pinned?.criteria ?? [];
}

/**
 * Build a verification report by ACTUALLY RUNNING each pinned journey against
 * the deployed app. A criterion passes only when its todo operation genuinely
 * works on the deployed copy — an absent OR present-but-broken operation fails.
 */
export async function reportFromDeployedApp(
  pinned: PinnedCriterion[],
  deployDir: string,
  sha: string,
): Promise<AutopilotEvaluationReport> {
  const criteria = [];
  for (const c of pinned) {
    const op = opForAction(c.action);
    const passed = runBrowserJourney(deployDir, op);
    criteria.push({
      criterionId: c.id,
      passed,
      kind: 'browser_journey' as const,
      screenshotPath: `/tmp/eval/${c.id}.png`,
      tracePath: `/tmp/eval/${c.id}.trace`,
      observed: passed ? `ran ${op} against deployed app` : `${op} failed on deployed app`,
    });
  }
  return {
    expectedSha: sha,
    observedSha: sha,
    origin: 'http://127.0.0.1:4310',
    healthCheck: { url: 'http://127.0.0.1:4310/health', ok: true },
    capturedAt: new Date().toISOString(),
    criteria,
  };
}

/**
 * Runs one full cycle against the disposable app fixture. The deployment
 * revision is the fixture's real commit SHA, and the verification outcome is
 * derived by executing the deployed app's todo operations. Returns the evaluate
 * reconcile result so callers can assert promotion (or rejection).
 *
 * opts.op:      the todo operation this cycle implements (undefined for baseline).
 * opts.quality: 'ok' (default) implements it working; 'broken' ships it present
 *               but non-functional; 'absent' commits a no-op that never adds it.
 */
export async function runFixtureCycle(
  o: Orchestrator,
  store: AutopilotStore,
  ctx: {
    appDir: string;
    deployDir: string;
    runId: string;
    cycleNumber: number;
    deployed: { sha: string };
  },
  opts: { op?: TodoOp; quality?: 'ok' | 'broken' | 'absent' } = {},
) {
  const quality = opts.quality ?? 'ok';
  let sha: string;
  if (opts.op && quality !== 'absent') {
    sha = implementFeature(ctx.appDir, opts.op, { quality });
  } else if (opts.op) {
    // A genuine no-op improvement: commits without implementing the operation.
    sha = commitNoop(ctx.appDir, `skip ${opts.op}`);
  } else {
    sha = headSha(ctx.appDir);
  }
  const implOp = await o.dispatchImplementation(PROJECT);
  await o.reconcileImplementation(PROJECT, {
    operationId: implOp.id,
    fencingGeneration: implOp.fencingGeneration,
    result: { committed: true, commitSha: sha },
  });
  const finOp = await o.dispatchFinalize(PROJECT);
  await o.reconcileFinalize(PROJECT, {
    operationId: finOp.id,
    fencingGeneration: finOp.fencingGeneration,
    result: { status: 'merged', mergedSha: sha, reviewStatus: 'approved' },
  });

  // Deploy: publish the merged SHA to the isolated deployment origin. The live
  // revision the Hub observes at the target is now this SHA.
  const depOp = await o.dispatchDeploy(PROJECT);
  deployApp(ctx.appDir, ctx.deployDir);
  ctx.deployed.sha = sha;
  const deploymentId = store.getCycle(ctx.runId, ctx.cycleNumber)!.deploymentId ?? 'dep-1';
  const depResult = await o.reconcileDeploy(PROJECT, {
    operationId: depOp.id,
    fencingGeneration: depOp.fencingGeneration,
    result: { status: 'success', deploymentId, deployedSha: sha },
  });
  if (!depResult.advanced) return { advanced: false as const, sha, promoted: false };

  // Verify: RUN the pinned journeys against the deployed app.
  const evalOp = await o.dispatchEvaluate(PROJECT);
  const report = await reportFromDeployedApp(
    pinnedCriteria(store, ctx.runId, ctx.cycleNumber),
    ctx.deployDir,
    sha,
  );
  const evalResult = await o.reconcileEvaluate(PROJECT, {
    operationId: evalOp.id,
    fencingGeneration: evalOp.fencingGeneration,
    result: report,
    captures: capturesFor(evalOp.id, deploymentId, report),
  });
  return { advanced: evalResult.advanced, sha, promoted: evalResult.advanced };
}

// ── Instrumented ports for restart / no-duplication proofs (AC2) ──────────

export function countingPorts() {
  const counts = { session: 0, finalize: 0, deploy: 0, evaluate: 0, rollback: 0 };
  const session: AutopilotSessionPort = {
    dispatchImplementation: async () => {
      counts.session += 1;
      return { sessionId: `sess-${counts.session}` };
    },
  };
  const finalize: AutopilotFinalizePort = {
    startFinalize: async () => {
      counts.finalize += 1;
      return { finalizeRunId: `fin-${counts.finalize}` };
    },
  };
  const evaluate: AutopilotEvaluatePort = {
    dispatchEvaluation: async () => {
      counts.evaluate += 1;
      return { sessionId: `eval-${counts.evaluate}` };
    },
  };
  const deploy: AutopilotDeployPort = {
    deployRevision: async () => {
      counts.deploy += 1;
      return { deploymentId: `dep-${counts.deploy}` };
    },
    rollback: async ({ priorSha, priorDeploymentId }) => {
      counts.rollback += 1;
      return { status: 'success', deploymentId: priorDeploymentId, deployedSha: priorSha };
    },
  };
  return { counts, session, finalize, evaluate, deploy };
}

/**
 * Reconstruct a fresh controller + orchestrator over the SAME on-disk/in-memory
 * SQLite state — the production restart path. New Hub process, new lease holder,
 * same durable rows and the same (still-counting) side-effect ports.
 */
export function rebuild(
  db: Database.Database,
  ports: ReturnType<typeof countingPorts>,
  holderId: string,
  document?: AutopilotDocumentPort,
) {
  const controller = createAutopilotController({
    db,
    credentialOwnerExists: () => true,
    holderId,
    assertContainment: () => undefined,
    issueWorkerCredential: ({ projectId, runId }: { projectId: string; runId: string }) => ({
      keyName: `autopilot:${projectId}:${runId}`,
      keyId: `key-${runId}`,
      token: `ahub_worker_${runId}`,
    }),
    revokeWorkerCredential: () => undefined,
    getDeployedRevision: () => MERGED_SHA,
  });
  const orchestrator = createAutopilotOrchestrator({
    controller,
    db,
    planner: fakePlanner(),
    board: fakeBoard(),
    session: ports.session,
    finalize: ports.finalize,
    deploy: ports.deploy,
    evaluate: ports.evaluate,
    document,
    artifactExists: () => ({ exists: true, mtimeMs: Date.now(), journeyTrace: true }),
    readEvidenceFile: (filePath: string) =>
      filePath.endsWith('.png')
        ? { body: Buffer.from('PNG'), contentType: 'image/png' }
        : { body: Buffer.from('{"actions":[]}'), contentType: 'application/json' },
  });
  return { controller, orchestrator, store: new AutopilotStore(db) };
}

/**
 * A one-shot gate: `enter()` resolves `entered` (the side effect has started and
 * is now blocked); `open()` resolves `release` (let it finish). Leaving the gate
 * unopened models a process that crashed mid-side-effect, abandoning the promise.
 */
export function makeGate() {
  let enterResolve: () => void = () => undefined;
  let openResolve: () => void = () => undefined;
  const entered = new Promise<void>((r) => (enterResolve = r));
  const release = new Promise<void>((r) => (openResolve = r));
  return { entered, release, enter: () => enterResolve(), open: () => openResolve() };
}

/**
 * Counting ports whose `rollback` blocks on a gate — so a test can interrupt the
 * Hub WHILE recovery is in flight (the deploy operation is still in-flight and
 * its durable completion has not been recorded).
 */
export function gatedRollbackPorts() {
  const ports = countingPorts();
  const gate = makeGate();
  const deploy: AutopilotDeployPort = {
    deployRevision: ports.deploy.deployRevision,
    rollback: async ({ priorSha, priorDeploymentId }) => {
      ports.counts.rollback += 1;
      gate.enter();
      await gate.release;
      return { status: 'success', deploymentId: priorDeploymentId, deployedSha: priorSha };
    },
  };
  return { ...ports, deploy, gateEntered: gate.entered, openGate: () => gate.open() };
}

/**
 * A memory document port whose `writePages` blocks on a gate — so a test can
 * interrupt the Hub WHILE the journal write is in flight (the documenting
 * operation is still in-flight; the underlying write has not been recorded).
 */
export function gatedDocumentPort() {
  const doc = createMemoryDocumentPort();
  const gate = makeGate();
  const original = doc.writePages;
  doc.writePages = async (input) => {
    gate.enter();
    await gate.release;
    return original(input);
  };
  return { doc, gateEntered: gate.entered, openGate: () => gate.open() };
}

const dirs: string[] = [];
export function cleanupTmpDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Assert the cycle produced a durable success record linked to evidence and to
 * the exact revision it verified.
 */
export function assertVerifiedDocumentation(
  store: AutopilotStore,
  runId: string,
  cycleNumber: number,
  sha: string,
) {
  const record = parseCycleDocumentation(store.getCycle(runId, cycleNumber)!.documentation);
  expect(record?.kind).toBe('success');
  // Revision association: the record links the exact SHA this cycle verified.
  expect(record?.links.testedCommitSha).toBe(sha);
  expect(record?.links.cardId).toBeTruthy();
  expect(record?.links.deploymentId).toBeTruthy();
  // Available evidence references resolve to captured artifacts.
  expect(record?.evidence.some((e) => e.kind === 'screenshot' && e.artifactId)).toBe(true);
  expect(record?.evidence.some((e) => e.kind === 'trace' && e.artifactId)).toBe(true);
  return record!;
}

// Re-export the production symbols the per-criterion test files call directly,
// so each acceptance-*.test.ts imports everything from this one harness module.
export {
  createAutopilotController,
  createMemoryDocumentPort,
  parseCycleDocumentation,
  decideAutopilotWorkerRequest,
  ensureAutopilotSchema,
};
export { runBrowserJourney, seedObservableApp } from './fixtures/observable-app.js';
