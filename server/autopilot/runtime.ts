import type Database from 'better-sqlite3';
import type { AutopilotController } from './controller.js';
import { AutopilotStore } from './store.js';
import { isAutopilotError } from './errors.js';
import {
  createAutopilotOrchestrator,
  type AutopilotOrchestrator,
  type AutopilotBoardPort,
  type AutopilotDeployPort,
  type AutopilotDeployResult,
  type AutopilotFinalizePort,
  type AutopilotFinalizeResult,
  type AutopilotPlannerPort,
  type AutopilotSessionPort,
  type AutopilotSessionResult,
} from './orchestrator.js';
import type { AutopilotRunRecord } from './types.js';

/**
 * The concrete adapter set the runtime uses to reach real subsystems. Built
 * per run so each adapter can close over the run's scoped worker identity.
 */
export interface AutopilotAdapters {
  planner: AutopilotPlannerPort;
  board: AutopilotBoardPort;
  session: AutopilotSessionPort;
  finalize: AutopilotFinalizePort;
  deploy: AutopilotDeployPort;
}

export interface AutopilotRuntimeDeps {
  db: Database.Database;
  /** Build a fresh controller (with real deps) for a tick. */
  buildController: () => AutopilotController;
  /** Build the concrete adapters for a specific run. */
  buildAdapters: (run: AutopilotRunRecord) => AutopilotAdapters;
  /**
   * Read the outcome of a dispatched implementation session. Return null while
   * the session is still running (the runtime re-checks on the next tick).
   */
  readSessionOutcome: (sessionId: string) => AutopilotSessionResult | null;
  /**
   * Read the outcome of a started Finalize run. Return null while the run is
   * still in progress.
   */
  readFinalizeOutcome: (finalizeRunId: string) => AutopilotFinalizeResult | null;
  /**
   * Read the outcome of a started deployment. Return null while the deploy is
   * still in progress (pending/running).
   */
  readDeployOutcome: (deploymentId: string) => AutopilotDeployResult | null;
  log?: (message: string, err?: unknown) => void;
}

/**
 * Runtime driver for Experimental Project Autopilot. Owned by the Hub process
 * and pumped by the same interval that runs the controller's deadline sweep,
 * it advances every active run's plan → implement → finalize spine by
 * constructing the orchestrator with concrete adapters and either dispatching
 * the current stage's work or reconciling a dispatched operation's real
 * outcome. It only touches runs whose project has Autopilot enabled and whose
 * server operator gate is on (both enforced by the controller it builds), so
 * with the feature disabled by default this driver is a no-op.
 */
export class AutopilotRuntime {
  private readonly db: Database.Database;
  private readonly buildController: () => AutopilotController;
  private readonly buildAdapters: (run: AutopilotRunRecord) => AutopilotAdapters;
  private readonly readSessionOutcome: (sessionId: string) => AutopilotSessionResult | null;
  private readonly readFinalizeOutcome: (finalizeRunId: string) => AutopilotFinalizeResult | null;
  private readonly readDeployOutcome: (deploymentId: string) => AutopilotDeployResult | null;
  private readonly log: (message: string, err?: unknown) => void;

  constructor(deps: AutopilotRuntimeDeps) {
    this.db = deps.db;
    this.buildController = deps.buildController;
    this.buildAdapters = deps.buildAdapters;
    this.readSessionOutcome = deps.readSessionOutcome;
    this.readFinalizeOutcome = deps.readFinalizeOutcome;
    this.readDeployOutcome = deps.readDeployOutcome;
    this.log =
      deps.log ??
      ((message, err) =>
        console.error(`[autopilot] ${message}`, err instanceof Error ? err.message : (err ?? '')));
  }

  /** Advance every active running run by one step. Never throws. */
  async tick(): Promise<void> {
    const store = new AutopilotStore(this.db);
    for (const run of store.listActiveRuns()) {
      if (run.controlState !== 'running') continue;
      try {
        await this.driveRun(run);
      } catch (err) {
        // A superseded/stale step is expected under concurrency; only surface
        // genuine failures.
        if (!this.isBenign(err)) {
          this.log(`drive run ${run.id} (${run.stage})`, err);
        }
      }
    }
  }

  private isBenign(err: unknown): boolean {
    return (
      isAutopilotError(err) &&
      (err.code === 'conflict' ||
        err.code === 'stale_generation' ||
        err.code === 'stale_lease' ||
        err.code === 'no_active_run')
    );
  }

  private async driveRun(run: AutopilotRunRecord): Promise<void> {
    const orchestrator = this.orchestratorFor(run);
    switch (run.stage) {
      case 'planning':
        await orchestrator.runPlanning(run.projectId);
        return;
      case 'implementing':
        await this.driveImplementing(orchestrator, run);
        return;
      case 'finalizing':
        await this.driveFinalizing(orchestrator, run);
        return;
      case 'deploying':
        await this.driveDeploying(orchestrator, run);
        return;
      default:
        // verifying / documenting / selecting-next are owned by later cards.
        return;
    }
  }

  /**
   * Session/Finalize completion callback: if this session belongs to an
   * in-flight implement operation and an outcome is now observable, settle
   * it immediately instead of waiting for the next ticker pulse.
   */
  async settleSession(sessionId: string): Promise<void> {
    try {
      const store = new AutopilotStore(this.db);
      const op = store.getOperationBySessionId(sessionId);
      if (!op || op.kind !== 'implement' || op.status !== 'in_flight') return;
      const run = store.getRun(op.runId);
      if (!run || run.controlState !== 'running') return;
      const outcome = this.readSessionOutcome(sessionId);
      if (!outcome) return;
      const orchestrator = this.orchestratorFor(run);
      await orchestrator.reconcileImplementation(run.projectId, {
        operationId: op.id,
        fencingGeneration: op.fencingGeneration,
        result: outcome,
      });
    } catch (err) {
      if (!this.isBenign(err)) this.log(`settle session ${sessionId}`, err);
    }
  }

  /**
   * Finalize completion callback: if this Finalize run belongs to an
   * in-flight finalize operation and an outcome is now observable, settle it.
   */
  async settleFinalize(finalizeRunId: string): Promise<void> {
    try {
      const store = new AutopilotStore(this.db);
      const op = store.getOperationByFinalizeRunId(finalizeRunId);
      if (!op || op.kind !== 'finalize' || op.status !== 'in_flight') return;
      const run = store.getRun(op.runId);
      if (!run || run.controlState !== 'running') return;
      const outcome = this.readFinalizeOutcome(finalizeRunId);
      if (!outcome) return;
      const orchestrator = this.orchestratorFor(run);
      await orchestrator.reconcileFinalize(run.projectId, {
        operationId: op.id,
        fencingGeneration: op.fencingGeneration,
        result: outcome,
      });
    } catch (err) {
      if (!this.isBenign(err)) this.log(`settle finalize ${finalizeRunId}`, err);
    }
  }

  /**
   * Deployment completion callback: if this deployment belongs to an
   * in-flight deploy operation and an outcome is now observable, settle it.
   */
  async settleDeployment(deploymentId: string): Promise<void> {
    try {
      const store = new AutopilotStore(this.db);
      const op = store.getOperationByDeploymentId(deploymentId);
      if (!op || op.kind !== 'deploy' || op.status !== 'in_flight') return;
      const run = store.getRun(op.runId);
      if (!run || run.controlState !== 'running') return;
      const outcome = this.readDeployOutcome(deploymentId);
      if (!outcome) return;
      const orchestrator = this.orchestratorFor(run);
      await orchestrator.reconcileDeploy(run.projectId, {
        operationId: op.id,
        fencingGeneration: op.fencingGeneration,
        result: outcome,
      });
    } catch (err) {
      if (!this.isBenign(err)) this.log(`settle deployment ${deploymentId}`, err);
    }
  }

  private orchestratorFor(run: AutopilotRunRecord): AutopilotOrchestrator {
    return createAutopilotOrchestrator({
      controller: this.buildController(),
      db: this.db,
      ...this.buildAdapters(run),
    });
  }

  private async driveImplementing(
    orchestrator: AutopilotOrchestrator,
    run: AutopilotRunRecord,
  ): Promise<void> {
    const store = new AutopilotStore(this.db);
    const cycle = store.getCycle(run.id, run.cycleNumber);
    if (!cycle) return;
    const inFlight = store
      .listInFlightOperations(run.id)
      .find((op) => op.kind === 'implement' && op.cycleId === cycle.id);
    if (!inFlight) {
      await orchestrator.dispatchImplementation(run.projectId);
      return;
    }
    if (!inFlight.sessionId) return; // reserved but launch not yet recorded
    const outcome = this.readSessionOutcome(inFlight.sessionId);
    if (!outcome) return; // still running
    await orchestrator.reconcileImplementation(run.projectId, {
      operationId: inFlight.id,
      fencingGeneration: inFlight.fencingGeneration,
      result: outcome,
    });
  }

  private async driveFinalizing(
    orchestrator: AutopilotOrchestrator,
    run: AutopilotRunRecord,
  ): Promise<void> {
    const store = new AutopilotStore(this.db);
    const cycle = store.getCycle(run.id, run.cycleNumber);
    if (!cycle) return;
    const inFlight = store
      .listInFlightOperations(run.id)
      .find((op) => op.kind === 'finalize' && op.cycleId === cycle.id);
    if (!inFlight) {
      await orchestrator.dispatchFinalize(run.projectId);
      return;
    }
    if (!inFlight.finalizeRunId) return;
    const outcome = this.readFinalizeOutcome(inFlight.finalizeRunId);
    if (!outcome) return;
    await orchestrator.reconcileFinalize(run.projectId, {
      operationId: inFlight.id,
      fencingGeneration: inFlight.fencingGeneration,
      result: outcome,
    });
  }

  private async driveDeploying(
    orchestrator: AutopilotOrchestrator,
    run: AutopilotRunRecord,
  ): Promise<void> {
    const store = new AutopilotStore(this.db);
    const cycle = store.getCycle(run.id, run.cycleNumber);
    if (!cycle) return;
    const cycleDeploys = store
      .listOperations(run.id)
      .filter((op) => op.kind === 'deploy' && op.cycleId === cycle.id);
    const inFlight = cycleDeploys.find(
      (op) => op.status === 'in_flight' || op.status === 'pending',
    );
    // A crash after completeOperation but before advanceAfterDeploy leaves the
    // run in deploying with a succeeded op and no in-flight row. Reconcile
    // that settled op (idempotent advance) instead of launching a new deploy.
    const succeeded = [...cycleDeploys].reverse().find((op) => op.status === 'succeeded');
    if (succeeded && !inFlight) {
      await orchestrator.reconcileDeploy(run.projectId, {
        operationId: succeeded.id,
        fencingGeneration: succeeded.fencingGeneration,
        result: deployResultFromSettled(succeeded),
      });
      return;
    }
    if (!inFlight) {
      await orchestrator.dispatchDeploy(run.projectId);
      return;
    }
    if (!inFlight.deploymentId) return;
    const outcome = this.readDeployOutcome(inFlight.deploymentId);
    if (!outcome) return;
    await orchestrator.reconcileDeploy(run.projectId, {
      operationId: inFlight.id,
      fencingGeneration: inFlight.fencingGeneration,
      result: outcome,
    });
  }
}

function deployResultFromSettled(op: {
  deploymentId: string | null;
  result: unknown;
}): AutopilotDeployResult {
  const result = (op.result ?? {}) as { deployedSha?: unknown; deploymentId?: unknown };
  const deployedSha = typeof result.deployedSha === 'string' ? result.deployedSha : undefined;
  const deploymentId =
    op.deploymentId ?? (typeof result.deploymentId === 'string' ? result.deploymentId : '');
  return { status: 'success', deploymentId, deployedSha };
}

export function createAutopilotRuntime(deps: AutopilotRuntimeDeps): AutopilotRuntime {
  return new AutopilotRuntime(deps);
}
