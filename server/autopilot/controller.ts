import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { AutopilotError } from './errors.js';
import { AutopilotStore, isUniqueConstraintError } from './store.js';
import type {
  AutopilotCancelFailure,
  AutopilotCancelRefs,
  AutopilotCancelSideEffects,
  AutopilotEvaluatorPolicy,
  AutopilotLimits,
  AutopilotOperationRecord,
  AutopilotProjectConfig,
  AutopilotProjectState,
  AutopilotRunRecord,
  AutopilotRunSnapshot,
  AutopilotStage,
  AutopilotTarget,
  AutopilotUsage,
} from './types.js';
import {
  DEFAULT_AUTOPILOT_EVALUATOR_POLICY,
  DEFAULT_AUTOPILOT_LIMITS,
  DEFAULT_AUTOPILOT_USAGE,
} from './types.js';
import { assertAutopilotContainment } from './containment.js';
import type {
  IssueAutopilotWorkerCredential,
  RevokeAutopilotWorkerCredential,
} from './worker-authority.js';

export interface AutopilotActor {
  userId: string | null;
}

export interface PutAutopilotConfigInput {
  enabled?: boolean;
  brief?: string | null;
  target?: Partial<AutopilotTarget> | null;
  limits?: Partial<AutopilotLimits> | null;
  evaluatorPolicy?: Partial<AutopilotEvaluatorPolicy> | null;
  credentialOwnerUserId?: string | null;
}

export interface StartAutopilotInput {
  brief?: string;
  target?: Partial<AutopilotTarget>;
  limits?: Partial<AutopilotLimits>;
  credentialOwnerUserId?: string;
}

export interface BeginOperationInput {
  projectId: string;
  kind: string;
  intent?: unknown;
  sessionId?: string | null;
  finalizeRunId?: string | null;
  deploymentId?: string | null;
  fencingGeneration?: number;
}

export interface CompleteOperationInput {
  operationId: string;
  fencingGeneration: number;
  outcome: 'succeeded' | 'failed' | 'ambiguous';
  result?: unknown;
}

export interface AutopilotControllerDeps {
  db: Database.Database;
  isServerEnabled: () => boolean;
  now?: () => Date;
  randomId?: () => string;
  holderId?: string;
  cancelSideEffects?: AutopilotCancelSideEffects;
  getDeployedRevision?: (targetId: string) => string | null;
  credentialOwnerExists?: (userId: string) => boolean;
  assertContainment?: () => void;
  issueWorkerCredential?: IssueAutopilotWorkerCredential;
  revokeWorkerCredential?: RevokeAutopilotWorkerCredential;
}

const BRIEF_MAX = 100_000;
const STAGE_TIMEOUT_MIN_MS = 1_000;
const WALL_TIME_MIN_MS = 1_000;
export const AUTOPILOT_DEADLINE_SWEEP_MS = 5_000;

function defaultNow(): Date {
  return new Date();
}

function iso(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function collectCancelRefs(ops: AutopilotOperationRecord[]): AutopilotCancelRefs {
  const sessionIds = new Set<string>();
  const finalizeRunIds = new Set<string>();
  const deploymentIds = new Set<string>();
  const operationIds: string[] = [];
  for (const op of ops) {
    operationIds.push(op.id);
    if (op.sessionId) sessionIds.add(op.sessionId);
    if (op.finalizeRunId) finalizeRunIds.add(op.finalizeRunId);
    if (op.deploymentId) deploymentIds.add(op.deploymentId);
  }
  return {
    sessionIds: [...sessionIds],
    finalizeRunIds: [...finalizeRunIds],
    deploymentIds: [...deploymentIds],
    operationIds,
  };
}

function asCancelFailures(result: AutopilotCancelFailure[] | void): AutopilotCancelFailure[] {
  return result ?? [];
}

function operationHasFailedRef(
  op: AutopilotOperationRecord,
  failures: AutopilotCancelFailure[],
): boolean {
  for (const failure of failures) {
    if (failure.kind === 'session' && op.sessionId === failure.id) return true;
    if (failure.kind === 'finalize' && op.finalizeRunId === failure.id) return true;
    if (failure.kind === 'deployment' && op.deploymentId === failure.id) return true;
  }
  return false;
}

function describeCancelFailures(failures: AutopilotCancelFailure[]): string {
  return failures.map((failure) => `${failure.kind}:${failure.id} (${failure.message})`).join('; ');
}

export function parseAutopilotLimits(raw: unknown): AutopilotLimits {
  if (raw == null) return { ...DEFAULT_AUTOPILOT_LIMITS };
  if (typeof raw !== 'object') {
    throw new AutopilotError('invalid_config', 'limits must be an object');
  }
  const input = raw as Partial<AutopilotLimits>;
  const cycleMode = input.cycleMode === 'finite' ? 'finite' : 'continuous';
  const maxWallTimeMs =
    typeof input.maxWallTimeMs === 'number'
      ? input.maxWallTimeMs
      : DEFAULT_AUTOPILOT_LIMITS.maxWallTimeMs;
  const maxStageTimeoutMs =
    typeof input.maxStageTimeoutMs === 'number'
      ? input.maxStageTimeoutMs
      : DEFAULT_AUTOPILOT_LIMITS.maxStageTimeoutMs;
  const maxRetriesPerStage =
    typeof input.maxRetriesPerStage === 'number'
      ? Math.floor(input.maxRetriesPerStage)
      : DEFAULT_AUTOPILOT_LIMITS.maxRetriesPerStage;
  let maxCycles: number | null =
    typeof input.maxCycles === 'number' ? Math.floor(input.maxCycles) : null;
  if (cycleMode === 'finite') {
    if (maxCycles == null || maxCycles < 1) {
      throw new AutopilotError('invalid_config', 'finite cycleMode requires maxCycles >= 1');
    }
  } else {
    maxCycles = null;
  }
  if (!Number.isFinite(maxWallTimeMs) || maxWallTimeMs < WALL_TIME_MIN_MS) {
    throw new AutopilotError(
      'invalid_config',
      'maxWallTimeMs must be a finite duration in milliseconds',
    );
  }
  if (!Number.isFinite(maxStageTimeoutMs) || maxStageTimeoutMs < STAGE_TIMEOUT_MIN_MS) {
    throw new AutopilotError(
      'invalid_config',
      'maxStageTimeoutMs must be a finite duration in milliseconds',
    );
  }
  if (!Number.isInteger(maxRetriesPerStage) || maxRetriesPerStage < 0 || maxRetriesPerStage > 2) {
    throw new AutopilotError('invalid_config', 'maxRetriesPerStage must be 0, 1, or 2');
  }
  let maxCostUsd: number | null =
    typeof input.maxCostUsd === 'number' ? input.maxCostUsd : DEFAULT_AUTOPILOT_LIMITS.maxCostUsd;
  if (maxCostUsd != null) {
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      throw new AutopilotError('invalid_config', 'maxCostUsd must be a positive number or null');
    }
  }
  return {
    cycleMode,
    maxCycles,
    maxWallTimeMs,
    maxStageTimeoutMs,
    maxRetriesPerStage,
    maxCostUsd,
  };
}

export function parseAutopilotTarget(raw: unknown): AutopilotTarget | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') {
    throw new AutopilotError('invalid_config', 'target must be an object');
  }
  const input = raw as Partial<AutopilotTarget>;
  const targetId = typeof input.targetId === 'string' ? input.targetId.trim() : '';
  if (!targetId) {
    throw new AutopilotError('invalid_config', 'target.targetId is required');
  }
  return {
    targetId,
    readinessProbeUrl:
      typeof input.readinessProbeUrl === 'string' && input.readinessProbeUrl.trim()
        ? input.readinessProbeUrl.trim()
        : null,
    origin: typeof input.origin === 'string' && input.origin.trim() ? input.origin.trim() : null,
  };
}

function normalizeBrief(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AutopilotError('invalid_config', 'brief must be a string');
  }
  const brief = raw.trim();
  if (!brief) {
    throw new AutopilotError('invalid_config', 'brief is required');
  }
  if (brief.length > BRIEF_MAX) {
    throw new AutopilotError('invalid_config', `brief must be ${BRIEF_MAX} characters or fewer`);
  }
  return brief;
}

export function parseAutopilotEvaluatorPolicy(raw: unknown): AutopilotEvaluatorPolicy {
  if (raw == null) return { ...DEFAULT_AUTOPILOT_EVALUATOR_POLICY };
  if (typeof raw !== 'object') {
    throw new AutopilotError('invalid_config', 'evaluatorPolicy must be an object');
  }
  const input = raw as Partial<AutopilotEvaluatorPolicy>;
  const version =
    typeof input.version === 'number'
      ? Math.floor(input.version)
      : DEFAULT_AUTOPILOT_EVALUATOR_POLICY.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new AutopilotError('invalid_config', 'evaluatorPolicy.version must be an integer >= 1');
  }
  return { version };
}

function elapsedSince(startedAt: string, now: Date): number | null {
  const started = Date.parse(startedAt.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(started)) return null;
  return now.getTime() - started;
}

function isEnvelopeHaltReason(reason: string | null): boolean {
  if (!reason) return false;
  return (
    reason.includes('wall-time') ||
    reason.includes('cost envelope') ||
    reason.includes('stage timeout') ||
    reason.includes('finite cycle')
  );
}

export class AutopilotController {
  private readonly store: AutopilotStore;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly holderId: string;
  private readonly isServerEnabled: () => boolean;
  private readonly cancelSideEffects: AutopilotCancelSideEffects;
  private readonly getDeployedRevision?: (targetId: string) => string | null;
  private readonly credentialOwnerExists?: (userId: string) => boolean;
  private readonly assertContainment: () => void;
  private readonly issueWorkerCredential?: IssueAutopilotWorkerCredential;
  private readonly revokeWorkerCredential?: RevokeAutopilotWorkerCredential;

  constructor(deps: AutopilotControllerDeps) {
    this.store = new AutopilotStore(deps.db);
    this.now = deps.now ?? defaultNow;
    this.randomId = deps.randomId ?? randomUUID;
    this.holderId = deps.holderId ?? `hub:${process.pid}`;
    this.isServerEnabled = deps.isServerEnabled;
    this.cancelSideEffects = deps.cancelSideEffects ?? (async () => undefined);
    this.getDeployedRevision = deps.getDeployedRevision;
    this.credentialOwnerExists = deps.credentialOwnerExists;
    this.assertContainment = deps.assertContainment ?? assertAutopilotContainment;
    this.issueWorkerCredential = deps.issueWorkerCredential;
    this.revokeWorkerCredential = deps.revokeWorkerCredential;
  }

  private timestamp(): string {
    return iso(this.now());
  }

  private async invokeCancel(refs: AutopilotCancelRefs): Promise<AutopilotCancelFailure[]> {
    return asCancelFailures(await this.cancelSideEffects(refs));
  }

  private async confirmCancellations(ops: AutopilotOperationRecord[]): Promise<{
    confirmed: AutopilotOperationRecord[];
    unresolved: AutopilotOperationRecord[];
    failures: AutopilotCancelFailure[];
  }> {
    const failures = await this.invokeCancel(collectCancelRefs(ops));
    const unresolved = ops.filter((op) => operationHasFailedRef(op, failures));
    const confirmed = ops.filter((op) => !operationHasFailedRef(op, failures));
    return { confirmed, unresolved, failures };
  }

  private markOperationsCancelled(ops: AutopilotOperationRecord[], now: string): void {
    for (const op of ops) {
      this.store.updateOperation(op.id, { status: 'cancelled', updatedAt: now });
    }
  }

  private throwCancelFailed(
    runId: string,
    fencingGeneration: number,
    failures: AutopilotCancelFailure[],
  ): never {
    const now = this.timestamp();
    this.store.insertEvent({
      runId,
      type: 'cancel_failed',
      payload: { failures },
      fencingGeneration,
      createdAt: now,
    });
    throw new AutopilotError(
      'cancel_failed',
      `Autopilot side-effect cancellation failed: ${describeCancelFailures(failures)}`,
    );
  }

  private requireHeldLease(projectId: string, run: AutopilotRunRecord): void {
    const lease = this.store.getLease(projectId);
    if (!lease || lease.holderId !== this.holderId || lease.runId !== run.id) {
      throw new AutopilotError('stale_lease', 'Autopilot lease is held by another controller');
    }
    if (lease.fencingGeneration !== run.fencingGeneration) {
      throw new AutopilotError('stale_generation', 'Autopilot lease generation is stale');
    }
  }

  private bumpHeldGeneration(run: AutopilotRunRecord, now: string): number {
    this.requireHeldLease(run.projectId, run);
    const next = run.fencingGeneration + 1;
    const ok = this.store.bumpHeldLease({
      projectId: run.projectId,
      holderId: this.holderId,
      fromGeneration: run.fencingGeneration,
      toGeneration: next,
      leasedAt: now,
    });
    if (!ok) {
      throw new AutopilotError('stale_lease', 'Autopilot lease is held by another controller');
    }
    return next;
  }

  private fenceRestartLease(run: AutopilotRunRecord, now: string): number {
    const fencingGeneration = run.fencingGeneration + 1;
    this.store.takeOverLease({
      projectId: run.projectId,
      runId: run.id,
      fencingGeneration,
      holderId: this.holderId,
      leasedAt: now,
    });
    return fencingGeneration;
  }

  private markInFlightAmbiguous(runId: string, now: string): AutopilotOperationRecord[] {
    const inFlight = this.store.listInFlightOperations(runId);
    for (const op of inFlight) {
      this.store.updateOperation(op.id, { status: 'ambiguous', updatedAt: now });
    }
    return this.store.listCancellableOperations(runId);
  }

  /**
   * Enter pausing while in-flight work remains; only `paused` (resumable) once
   * nothing is still running. Ambiguous leftovers stay cancellable until resume
   * or stop reconciles them.
   */
  private parkRun(run: AutopilotRunRecord, now: string, reason: string): void {
    const current = this.store.getRun(run.id) ?? run;
    for (const op of this.store.listOpenOperations(current.id)) {
      if (op.status === 'pending') {
        this.store.updateOperation(op.id, { status: 'cancelled', updatedAt: now });
      }
    }
    const inFlight = this.store.listInFlightOperations(current.id);
    const controlState = inFlight.length > 0 ? 'pausing' : 'paused';
    this.store.updateRun(current.id, {
      controlState,
      pauseReason: reason,
      updatedAt: now,
    });
    this.store.insertEvent({
      runId: current.id,
      type: controlState === 'pausing' ? 'pause_drain' : 'paused',
      payload: { reason, inFlight: inFlight.map((op) => op.id) },
      fencingGeneration: current.fencingGeneration,
      createdAt: now,
    });
  }

  private requireServerEnabled(): void {
    if (!this.isServerEnabled()) {
      throw new AutopilotError(
        'server_disabled',
        'Experimental Autopilot is disabled by the server operator setting',
      );
    }
  }

  private requireNotDisabling(projectId: string): AutopilotProjectConfig {
    const config = this.store.getConfig(projectId);
    if (config.disabling) {
      throw new AutopilotError('conflict', 'Autopilot disable is in progress');
    }
    return config;
  }

  private requireProjectDispatchable(projectId: string): AutopilotProjectConfig {
    this.assertContainment();
    const config = this.requireNotDisabling(projectId);
    if (!config.enabled) {
      throw new AutopilotError('not_enabled', 'Autopilot is not enabled for this project');
    }
    return config;
  }

  private persistConfig(
    config: AutopilotProjectConfig,
    actor: AutopilotActor,
    patch?: Partial<{ enabled: boolean; disabling: boolean }>,
  ): void {
    this.store.upsertConfig({
      projectId: config.projectId,
      enabled: patch?.enabled ?? config.enabled,
      disabling: patch?.disabling ?? config.disabling,
      briefId: config.briefId,
      targetId: config.target?.targetId ?? null,
      targetJson: JSON.stringify(config.target ?? {}),
      limitsJson: JSON.stringify(config.limits ?? {}),
      evaluatorPolicyJson: JSON.stringify(
        config.evaluatorPolicy ?? DEFAULT_AUTOPILOT_EVALUATOR_POLICY,
      ),
      credentialOwnerUserId: config.credentialOwnerUserId,
      updatedAt: this.timestamp(),
      updatedBy: actor.userId,
    });
  }

  private finishDisable(projectId: string, actor: AutopilotActor): AutopilotProjectState {
    return this.store.transaction(() => {
      const current = this.store.getConfig(projectId);
      if (!current.disabling) {
        return this.getProjectState(projectId);
      }
      const active = this.store.getActiveRun(projectId);
      if (active && active.controlState !== 'stopped') {
        throw new AutopilotError(
          'conflict',
          'Autopilot disable cannot finish while a run is still active',
        );
      }
      this.persistConfig(current, actor, { enabled: false, disabling: false });
      return this.getProjectState(projectId);
    });
  }

  private snapshot(runId: string): AutopilotRunSnapshot {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new AutopilotError('not_found', 'Autopilot run not found');
    }
    const cycle = run.cycleNumber > 0 ? this.store.getCycle(runId, run.cycleNumber) : null;
    const stages = cycle ? this.store.listStages(cycle.id) : [];
    return {
      run,
      cycle,
      stages,
      operations: this.store.listOperations(runId),
      events: this.store.listEvents(runId),
      lease: this.store.getLease(run.projectId),
    };
  }

  getProjectState(projectId: string): AutopilotProjectState {
    const config = this.store.getConfig(projectId);
    const active = this.store.getActiveRun(projectId);
    return {
      serverEnabled: this.isServerEnabled(),
      config,
      activeRun: active ? this.snapshot(active.id) : null,
    };
  }

  getRun(projectId: string, runId: string): AutopilotRunSnapshot {
    const snap = this.snapshot(runId);
    if (snap.run.projectId !== projectId) {
      throw new AutopilotError('not_found', 'Autopilot run not found');
    }
    return snap;
  }

  putConfig(
    projectId: string,
    input: PutAutopilotConfigInput,
    actor: AutopilotActor,
  ): AutopilotProjectConfig {
    this.requireServerEnabled();
    this.requireNotDisabling(projectId);
    const existing = this.store.getConfig(projectId);
    const enabled = input.enabled ?? existing.enabled;
    let briefId = existing.briefId;
    let pendingBrief: {
      id: string;
      projectId: string;
      revision: number;
      content: string;
      specJson: null;
      createdAt: string;
      createdBy: string | null;
    } | null = null;
    if (input.brief !== undefined && input.brief !== null && input.brief.trim() !== '') {
      const content = normalizeBrief(input.brief);
      if (content !== existing.brief) {
        briefId = this.randomId();
        pendingBrief = {
          id: briefId,
          projectId,
          revision: this.store.nextBriefRevision(projectId),
          content,
          specJson: null,
          createdAt: this.timestamp(),
          createdBy: actor.userId,
        };
      }
    } else if (input.brief === '') {
      throw new AutopilotError('invalid_config', 'brief is required');
    }

    const target =
      input.target === undefined
        ? existing.target
        : input.target === null
          ? null
          : parseAutopilotTarget({ ...(existing.target ?? {}), ...input.target });
    const limits =
      input.limits === undefined
        ? existing.limits
        : parseAutopilotLimits({
            ...(existing.limits ?? DEFAULT_AUTOPILOT_LIMITS),
            ...input.limits,
          });
    const evaluatorPolicy =
      input.evaluatorPolicy === undefined
        ? existing.evaluatorPolicy
        : parseAutopilotEvaluatorPolicy({
            ...(existing.evaluatorPolicy ?? DEFAULT_AUTOPILOT_EVALUATOR_POLICY),
            ...input.evaluatorPolicy,
          });
    const credentialOwnerUserId =
      input.credentialOwnerUserId === undefined
        ? existing.credentialOwnerUserId
        : input.credentialOwnerUserId && input.credentialOwnerUserId.trim()
          ? input.credentialOwnerUserId.trim()
          : null;

    if (enabled) {
      this.assertReadyToEnable({
        briefId,
        target,
        limits,
        credentialOwnerUserId,
      });
    }

    const updatedAt = this.timestamp();
    this.store.transaction(() => {
      if (this.store.getConfig(projectId).disabling) {
        throw new AutopilotError('conflict', 'Autopilot disable is in progress');
      }
      if (pendingBrief) {
        this.store.insertBrief(pendingBrief);
      }
      this.store.upsertConfig({
        projectId,
        enabled,
        disabling: false,
        briefId,
        targetId: target?.targetId ?? null,
        targetJson: JSON.stringify(target ?? {}),
        limitsJson: JSON.stringify(limits ?? {}),
        evaluatorPolicyJson: JSON.stringify(evaluatorPolicy ?? DEFAULT_AUTOPILOT_EVALUATOR_POLICY),
        credentialOwnerUserId,
        updatedAt,
        updatedBy: actor.userId,
      });
    });
    return this.store.getConfig(projectId);
  }

  private assertReadyToEnable(parts: {
    briefId: string | null;
    target: AutopilotTarget | null;
    limits: AutopilotLimits | null;
    credentialOwnerUserId: string | null;
  }): void {
    if (!parts.briefId) {
      throw new AutopilotError('invalid_config', 'brief is required before enabling Autopilot');
    }
    if (!parts.target?.targetId) {
      throw new AutopilotError('invalid_config', 'a local deployment target is required');
    }
    if (!parts.limits) {
      throw new AutopilotError('invalid_config', 'resource limits are required');
    }
    parseAutopilotLimits(parts.limits);
    if (!parts.credentialOwnerUserId) {
      throw new AutopilotError('invalid_config', 'credentialOwnerUserId is required');
    }
  }

  start(
    projectId: string,
    input: StartAutopilotInput,
    actor: AutopilotActor,
  ): AutopilotRunSnapshot {
    this.requireServerEnabled();
    this.requireNotDisabling(projectId);
    this.assertContainment();
    if (!this.issueWorkerCredential) {
      throw new AutopilotError(
        'authority_denied',
        'Autopilot cannot start without scoped worker credentials',
      );
    }
    if (this.store.getActiveRun(projectId)) {
      throw new AutopilotError(
        'already_active',
        'This project already has an active Autopilot run',
      );
    }

    const now = this.timestamp();
    const runId = this.randomId();
    const cycleId = this.randomId();
    const stageId = this.randomId();
    const operationId = this.randomId();
    const fencingGeneration = 1;
    const stage: AutopilotStage = 'planning';
    const hasOverlays = Boolean(
      input.brief || input.target || input.limits || input.credentialOwnerUserId,
    );
    let issuedKey: { projectId: string; runId: string; ownerUserId: string } | null = null;

    try {
      this.store.transaction(() => {
        if (hasOverlays) {
          this.putConfig(
            projectId,
            {
              enabled: true,
              brief: input.brief,
              target: input.target,
              limits: input.limits,
              credentialOwnerUserId: input.credentialOwnerUserId,
            },
            actor,
          );
        }
        const config = this.store.getConfig(projectId);
        if (config.disabling) {
          throw new AutopilotError('conflict', 'Autopilot disable is in progress');
        }
        if (!config.enabled) {
          throw new AutopilotError('not_enabled', 'Autopilot is not enabled for this project');
        }
        this.assertReadyToEnable({
          briefId: config.briefId,
          target: config.target,
          limits: config.limits,
          credentialOwnerUserId: config.credentialOwnerUserId,
        });
        if (this.credentialOwnerExists && config.credentialOwnerUserId) {
          if (!this.credentialOwnerExists(config.credentialOwnerUserId)) {
            throw new AutopilotError('invalid_config', 'credential owner does not exist');
          }
        }
        if (this.store.getActiveRun(projectId)) {
          throw new AutopilotError(
            'already_active',
            'This project already has an active Autopilot run',
          );
        }
        const limits = config.limits ?? DEFAULT_AUTOPILOT_LIMITS;
        const ownerUserId = config.credentialOwnerUserId!;
        const issued = this.issueWorkerCredential!({
          projectId,
          runId,
          ownerUserId,
        });
        issuedKey = { projectId, runId, ownerUserId };
        this.store.insertRun({
          id: runId,
          projectId,
          controlState: 'running',
          stage,
          fencingGeneration,
          briefId: config.briefId,
          briefRevision: config.briefRevision,
          cycleNumber: 1,
          credentialOwnerUserId: config.credentialOwnerUserId,
          targetId: config.target?.targetId ?? null,
          limitsJson: JSON.stringify(limits),
          usageJson: JSON.stringify(DEFAULT_AUTOPILOT_USAGE),
          workerAuthorityJson: JSON.stringify({ keyName: issued.keyName, keyId: issued.keyId }),
          startedBy: actor.userId,
          startedAt: now,
          updatedAt: now,
        });
        this.store.insertLease({
          projectId,
          runId,
          fencingGeneration,
          holderId: this.holderId,
          leasedAt: now,
        });
        this.store.insertCycle({
          id: cycleId,
          runId,
          cycleNumber: 1,
          briefRevision: config.briefRevision ?? 1,
          createdAt: now,
        });
        this.store.insertOperation({
          id: operationId,
          runId,
          cycleId,
          kind: 'plan-baseline',
          status: 'pending',
          fencingGeneration,
          intentJson: JSON.stringify({ stage, cycleNumber: 1 }),
          sessionId: null,
          finalizeRunId: null,
          deploymentId: null,
          createdAt: now,
        });
        this.store.insertStage({
          id: stageId,
          cycleId,
          stage,
          status: 'pending',
          attempt: 1,
          operationId,
          startedAt: now,
        });
        this.store.insertEvent({
          runId,
          cycleId,
          operationId,
          type: 'run_started',
          payload: { stage, briefRevision: config.briefRevision, workerKeyName: issued.keyName },
          fencingGeneration,
          createdAt: now,
        });
      });
    } catch (err) {
      if (issuedKey) {
        try {
          this.revokeWorkerCredential?.(issuedKey);
        } catch {
          /* best-effort */
        }
      }
      if (err instanceof AutopilotError && err.code === 'already_active') {
        throw err;
      }
      if (isUniqueConstraintError(err)) {
        throw new AutopilotError(
          'already_active',
          'This project already has an active Autopilot run',
        );
      }
      throw err;
    }

    return this.snapshot(runId);
  }

  pause(projectId: string, _actor: AutopilotActor): AutopilotRunSnapshot {
    this.requireServerEnabled();
    const run = this.store.getActiveRun(projectId);
    if (!run) {
      throw new AutopilotError('no_active_run', 'No active Autopilot run to pause');
    }
    if (run.controlState === 'stopped') {
      throw new AutopilotError('run_stopped', 'Stopped Autopilot runs cannot be paused');
    }
    if (run.controlState === 'paused' || run.controlState === 'pausing') {
      return this.snapshot(run.id);
    }
    if (run.controlState === 'stopping') {
      throw new AutopilotError('conflict', 'Autopilot run is stopping');
    }

    this.requireHeldLease(projectId, run);
    const now = this.timestamp();
    const inFlight = this.store.listInFlightOperations(run.id);
    this.parkRun(run, now, inFlight.length > 0 ? 'drain' : 'operator_pause');
    return this.snapshot(run.id);
  }

  async resume(projectId: string, _actor: AutopilotActor): Promise<AutopilotRunSnapshot> {
    this.requireServerEnabled();
    this.requireProjectDispatchable(projectId);
    const config = this.store.getConfig(projectId);
    const run = this.store.getActiveRun(projectId);
    if (!run) {
      throw new AutopilotError('no_active_run', 'No Autopilot run to resume');
    }
    if (run.controlState === 'stopped') {
      throw new AutopilotError('run_stopped', 'Stopped Autopilot runs cannot be resumed');
    }
    if (run.controlState === 'stopping') {
      throw new AutopilotError('conflict', 'Autopilot run is stopping');
    }
    if (run.controlState !== 'paused') {
      throw new AutopilotError('not_paused', 'Only a paused Autopilot run can be resumed');
    }

    this.requireHeldLease(projectId, run);
    const reason = this.revalidationFailure(run, config);
    if (reason) {
      const now = this.timestamp();
      this.store.updateRun(run.id, {
        pauseReason: reason,
        updatedAt: now,
      });
      this.store.insertEvent({
        runId: run.id,
        type: 'resume_rejected',
        payload: { reason },
        fencingGeneration: run.fencingGeneration,
        createdAt: now,
      });
      throw new AutopilotError('resume_revalidation_failed', reason);
    }

    const leftover = this.store.listCancellableOperations(run.id);
    if (leftover.length > 0) {
      const now = this.timestamp();
      const { confirmed, failures } = await this.confirmCancellations(leftover);
      this.markOperationsCancelled(confirmed, now);
      if (failures.length > 0) {
        this.store.updateRun(run.id, {
          pauseReason: 'side_effect_cancellation_failed',
          updatedAt: now,
        });
        this.throwCancelFailed(run.id, run.fencingGeneration, failures);
      }
      this.store.insertEvent({
        runId: run.id,
        type: 'outstanding_work_reconciled',
        payload: { operationIds: leftover.map((op) => op.id) },
        fencingGeneration: run.fencingGeneration,
        createdAt: now,
      });
    }

    const now = this.timestamp();
    const fencingGeneration = this.store.transaction(() => {
      const latestConfig = this.requireProjectDispatchable(projectId);
      const current = this.store.getRun(run.id);
      if (!current) {
        throw new AutopilotError('not_found', 'Autopilot run not found');
      }
      if (current.controlState === 'stopped') {
        throw new AutopilotError('run_stopped', 'Stopped Autopilot runs cannot be resumed');
      }
      if (current.controlState === 'stopping') {
        throw new AutopilotError('conflict', 'Autopilot run is stopping');
      }
      if (current.controlState !== 'paused') {
        throw new AutopilotError('not_paused', 'Only a paused Autopilot run can be resumed');
      }
      const next = this.bumpHeldGeneration(current, now);
      this.store.updateRun(current.id, {
        controlState: 'running',
        pauseReason: null,
        fencingGeneration: next,
        credentialOwnerUserId: latestConfig.credentialOwnerUserId ?? current.credentialOwnerUserId,
        updatedAt: now,
      });
      return next;
    });
    this.store.insertEvent({
      runId: run.id,
      type: 'resumed',
      payload: {},
      fencingGeneration,
      createdAt: now,
    });
    return this.snapshot(run.id);
  }

  private revalidationFailure(
    run: AutopilotRunRecord,
    config: AutopilotProjectConfig,
  ): string | null {
    const resumeOwner = config.credentialOwnerUserId ?? run.credentialOwnerUserId;
    if (!resumeOwner) return 'credential owner is required';
    if (this.credentialOwnerExists && !this.credentialOwnerExists(resumeOwner)) {
      return 'credential owner is no longer valid';
    }
    const envelope = this.envelopeFailure(run);
    if (envelope) return envelope;
    if (this.store.listInFlightOperations(run.id).length > 0) {
      return 'outstanding in-flight operations must drain or be stopped before resume';
    }
    if (run.lastVerifiedSha && run.targetId) {
      if (!this.getDeployedRevision) {
        return 'deployed revision could not be verified';
      }
      const deployed = this.getDeployedRevision(run.targetId);
      if (!deployed) {
        return 'deployed revision is unavailable';
      }
      if (deployed !== run.lastVerifiedSha) {
        return 'deployed revision does not match the last verified SHA';
      }
    }
    return null;
  }

  private envelopeFailure(run: AutopilotRunRecord): string | null {
    const elapsed = elapsedSince(run.startedAt, this.now());
    const wallTimeMs = elapsed != null && elapsed > 0 ? elapsed : run.usage.wallTimeMs;
    if (wallTimeMs >= run.limits.maxWallTimeMs) {
      return 'run wall-time envelope is exhausted';
    }
    if (run.limits.cycleMode === 'finite' && run.limits.maxCycles != null) {
      if (run.cycleNumber > run.limits.maxCycles) {
        return 'finite cycle envelope is exhausted';
      }
    }
    if (run.limits.maxCostUsd != null) {
      if (!run.usage.costAvailable || run.usage.costUsd == null) {
        return null;
      }
      if (run.usage.costUsd >= run.limits.maxCostUsd) {
        return 'run cost envelope is exhausted';
      }
    }
    return null;
  }

  private writeUsage(run: AutopilotRunRecord, usage: AutopilotUsage): AutopilotUsage {
    this.store.updateRun(run.id, {
      usageJson: JSON.stringify(usage),
      updatedAt: this.timestamp(),
    });
    return usage;
  }

  private refreshWallTime(run: AutopilotRunRecord): AutopilotUsage {
    const elapsed = elapsedSince(run.startedAt, this.now()) ?? run.usage.wallTimeMs;
    return this.writeUsage(run, {
      wallTimeMs: elapsed > 0 ? elapsed : run.usage.wallTimeMs,
      costUsd: run.usage.costUsd,
      costAvailable: run.usage.costAvailable,
    });
  }

  private addOperationCost(run: AutopilotRunRecord, delta: number): AutopilotUsage {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new AutopilotError(
        'invalid_config',
        'operation costUsd must be a non-negative finite number',
      );
    }
    const wall = this.refreshWallTime(run);
    const latest = this.store.getRun(run.id) ?? { ...run, usage: wall };
    const current = latest.usage.costUsd ?? 0;
    return this.writeUsage(latest, {
      wallTimeMs: latest.usage.wallTimeMs,
      costUsd: current + delta,
      costAvailable: true,
    });
  }

  private reportCumulativeCost(run: AutopilotRunRecord, total: number): AutopilotUsage {
    if (!Number.isFinite(total) || total < 0) {
      throw new AutopilotError(
        'invalid_config',
        'reported costUsd must be a non-negative finite number',
      );
    }
    const wall = this.refreshWallTime(run);
    const latest = this.store.getRun(run.id) ?? { ...run, usage: wall };
    return this.writeUsage(latest, {
      wallTimeMs: latest.usage.wallTimeMs,
      costUsd: total,
      costAvailable: true,
    });
  }

  private async haltForEnvelope(run: AutopilotRunRecord, reason: string): Promise<never> {
    await this.expireRun(run, reason);
    throw new AutopilotError('envelope_exhausted', reason);
  }

  /**
   * Pause a run for an envelope/timeout breach and cancel outstanding
   * sessions/Finalize/deploy work. Bumps the fencing generation so a hung
   * worker cannot complete after the deadline.
   */
  private async expireRun(run: AutopilotRunRecord, reason: string): Promise<AutopilotRunSnapshot> {
    const now = this.timestamp();
    const fencingGeneration = this.store.transaction(() => {
      const next = this.bumpHeldGeneration(run, now);
      this.store.updateRun(run.id, {
        fencingGeneration: next,
        updatedAt: now,
      });
      return next;
    });
    const current = this.store.getRun(run.id);
    if (!current) throw new AutopilotError('not_found', 'Autopilot run not found');
    const cancellable = this.store.listCancellableOperations(current.id);
    this.parkRun(current, now, reason);
    const { confirmed, failures } = await this.confirmCancellations(cancellable);
    const cancelledAt = this.timestamp();
    this.markOperationsCancelled(confirmed, cancelledAt);
    if (failures.length > 0) {
      this.throwCancelFailed(current.id, fencingGeneration, failures);
    }
    const after = this.store.getRun(current.id);
    if (after && this.store.listInFlightOperations(after.id).length === 0) {
      this.store.updateRun(after.id, { controlState: 'paused', updatedAt: cancelledAt });
    }
    return this.snapshot(current.id);
  }

  async enforceDeadlines(): Promise<AutopilotRunSnapshot[]> {
    const snapshots: AutopilotRunSnapshot[] = [];
    for (const run of this.store.listActiveRuns()) {
      if (run.controlState === 'stopped' || run.controlState === 'stopping') continue;
      try {
        this.requireHeldLease(run.projectId, run);
      } catch {
        continue;
      }
      this.refreshWallTime(run);
      const latest = this.store.getRun(run.id) ?? run;
      const reason = this.envelopeFailure(latest) ?? this.stageTimeoutFailure(latest);
      const leftover = this.store.listCancellableOperations(latest.id);
      const parkedEnvelope =
        leftover.length > 0 &&
        Boolean(latest.pauseReason) &&
        (latest.controlState === 'pausing' || latest.controlState === 'paused') &&
        isEnvelopeHaltReason(latest.pauseReason);
      if (latest.controlState === 'running' && reason) {
        snapshots.push(await this.expireRun(latest, reason));
      } else if (parkedEnvelope && latest.pauseReason) {
        snapshots.push(await this.expireRun(latest, latest.pauseReason));
      }
    }
    return snapshots;
  }

  private stageTimeoutFailure(run: AutopilotRunRecord): string | null {
    const cycle = this.store.getCycle(run.id, run.cycleNumber);
    if (cycle) {
      const open = this.store.getOpenStage(cycle.id);
      if (open?.startedAt && (open.status === 'in_progress' || open.status === 'pending')) {
        const elapsed = elapsedSince(open.startedAt, this.now());
        if (elapsed != null && elapsed >= run.limits.maxStageTimeoutMs) {
          return 'stage timeout envelope is exhausted';
        }
      }
    }
    for (const op of this.store.listInFlightOperations(run.id)) {
      const elapsed = elapsedSince(op.createdAt, this.now());
      if (elapsed != null && elapsed >= run.limits.maxStageTimeoutMs) {
        return 'stage timeout envelope is exhausted';
      }
    }
    return null;
  }

  async stop(projectId: string, _actor: AutopilotActor): Promise<AutopilotRunSnapshot> {
    const run = this.store.getActiveRun(projectId) ?? this.store.getLatestRun(projectId);
    if (!run) {
      this.requireServerEnabled();
      throw new AutopilotError('no_active_run', 'No Autopilot run to stop');
    }
    if (run.controlState === 'stopped') {
      return this.snapshot(run.id);
    }

    this.requireHeldLease(projectId, run);
    const now = this.timestamp();
    const cancellable = this.store.listCancellableOperations(run.id);
    const fencingGeneration = this.store.transaction(() => {
      const next = this.bumpHeldGeneration(run, now);
      this.store.updateRun(run.id, {
        controlState: 'stopping',
        fencingGeneration: next,
        pauseReason: null,
        updatedAt: now,
      });
      return next;
    });
    this.store.insertEvent({
      runId: run.id,
      type: 'stop_requested',
      payload: { inFlight: cancellable.map((op) => op.id) },
      fencingGeneration,
      createdAt: now,
    });

    const refs = collectCancelRefs(cancellable);
    const { confirmed, failures } = await this.confirmCancellations(cancellable);
    if (failures.length > 0) {
      this.markOperationsCancelled(confirmed, this.timestamp());
      this.throwCancelFailed(run.id, fencingGeneration, failures);
    }

    return this.finishStop(run.id, fencingGeneration, refs);
  }

  private finishStop(
    runId: string,
    fencingGeneration: number,
    refs: AutopilotCancelRefs,
  ): AutopilotRunSnapshot {
    const current = this.store.getRun(runId);
    if (!current || current.fencingGeneration !== fencingGeneration) {
      if (!current) throw new AutopilotError('not_found', 'Autopilot run not found');
      return this.snapshot(runId);
    }
    if (current.controlState === 'stopped') {
      return this.snapshot(runId);
    }
    const now = this.timestamp();
    for (const op of this.store.listCancellableOperations(runId)) {
      this.store.updateOperation(op.id, {
        status: 'cancelled',
        updatedAt: now,
      });
    }
    this.store.updateRun(runId, {
      controlState: 'stopped',
      stoppedAt: now,
      updatedAt: now,
    });
    const stopped = this.store.getRun(runId);
    if (stopped?.workerAuthority.keyName) {
      try {
        this.revokeWorkerCredential?.({
          projectId: stopped.projectId,
          runId: stopped.id,
          ownerUserId: stopped.credentialOwnerUserId,
        });
      } catch {
        /* best-effort: stop still settles */
      }
    }
    this.store.insertEvent({
      runId,
      type: 'stopped',
      payload: { cancelledOperations: refs.operationIds },
      fencingGeneration,
      createdAt: now,
    });
    return this.snapshot(runId);
  }

  async disable(projectId: string, actor: AutopilotActor): Promise<AutopilotProjectState> {
    this.store.transaction(() => {
      const existing = this.store.getConfig(projectId);
      this.persistConfig(existing, actor, { disabling: true });
    });
    const active = this.store.getActiveRun(projectId);
    if (active && active.controlState !== 'stopped') {
      this.requireHeldLease(projectId, active);
      await this.stop(projectId, actor);
    }
    return this.finishDisable(projectId, actor);
  }

  async beginOperation(input: BeginOperationInput): Promise<AutopilotOperationRecord> {
    this.requireServerEnabled();
    this.requireProjectDispatchable(input.projectId);
    const run = this.store.getActiveRun(input.projectId);
    if (!run) {
      throw new AutopilotError('no_active_run', 'No active Autopilot run');
    }
    if (run.controlState !== 'running') {
      throw new AutopilotError(
        'conflict',
        `Cannot start an operation while run is ${run.controlState}`,
      );
    }
    this.requireHeldLease(input.projectId, run);
    if (input.fencingGeneration != null && input.fencingGeneration !== run.fencingGeneration) {
      throw new AutopilotError('stale_generation', 'Operation fencing generation is stale');
    }
    this.refreshWallTime(run);
    const latest = this.store.getRun(run.id) ?? run;
    const envelope = this.envelopeFailure(latest) ?? this.stageTimeoutFailure(latest);
    if (envelope) {
      await this.haltForEnvelope(latest, envelope);
    }
    const now = this.timestamp();
    const id = this.randomId();
    const cycle = this.store.getCycle(run.id, run.cycleNumber);
    if (this.store.countActiveCycles(run.id) > 1) {
      throw new AutopilotError('conflict', 'Only one Autopilot cycle may run at a time');
    }
    this.store.insertOperation({
      id,
      runId: run.id,
      cycleId: cycle?.id ?? null,
      kind: input.kind,
      status: 'in_flight',
      fencingGeneration: run.fencingGeneration,
      intentJson: JSON.stringify(input.intent ?? {}),
      sessionId: input.sessionId ?? null,
      finalizeRunId: input.finalizeRunId ?? null,
      deploymentId: input.deploymentId ?? null,
      createdAt: now,
    });
    if (cycle) {
      const open = this.store.getOpenStage(cycle.id);
      if (open) {
        const linked = open.operationId ? this.store.getOperation(open.operationId) : null;
        const linkedSettled =
          !linked ||
          linked.status === 'failed' ||
          linked.status === 'cancelled' ||
          linked.status === 'succeeded';
        if (!open.operationId || linkedSettled) {
          this.store.updateStage(open.id, {
            status: 'in_progress',
            operationId: id,
            startedAt: open.startedAt ?? now,
          });
        }
      }
    }
    this.store.insertEvent({
      runId: run.id,
      cycleId: cycle?.id ?? null,
      operationId: id,
      type: 'operation_started',
      payload: { kind: input.kind },
      fencingGeneration: run.fencingGeneration,
      createdAt: now,
    });
    const op = this.store.getOperation(id);
    if (!op) throw new AutopilotError('not_found', 'Operation not found after insert');
    return op;
  }

  async completeOperation(input: CompleteOperationInput): Promise<AutopilotOperationRecord> {
    const op = this.store.getOperation(input.operationId);
    if (!op) {
      throw new AutopilotError('not_found', 'Operation not found');
    }
    const run = this.store.getRun(op.runId);
    if (!run) {
      throw new AutopilotError('not_found', 'Autopilot run not found');
    }
    if (run.controlState === 'stopped' || run.controlState === 'stopping') {
      throw new AutopilotError(
        'stale_generation',
        'Late callback cannot advance a stopped generation',
      );
    }
    if (
      input.fencingGeneration !== run.fencingGeneration ||
      op.fencingGeneration !== run.fencingGeneration
    ) {
      throw new AutopilotError('stale_generation', 'Operation fencing generation is stale');
    }
    if (op.status !== 'pending' && op.status !== 'in_flight') {
      throw new AutopilotError('conflict', 'Operation already settled');
    }

    const now = this.timestamp();
    const resultCostRaw =
      input.result &&
      typeof input.result === 'object' &&
      'costUsd' in (input.result as object) &&
      (input.result as { costUsd?: unknown }).costUsd !== undefined
        ? (input.result as { costUsd: unknown }).costUsd
        : undefined;
    if (resultCostRaw !== undefined) {
      if (typeof resultCostRaw !== 'number') {
        throw new AutopilotError(
          'invalid_config',
          'operation costUsd must be a non-negative finite number',
        );
      }
      this.addOperationCost(run, resultCostRaw);
    } else {
      this.refreshWallTime(run);
    }
    this.store.updateOperation(op.id, {
      status: input.outcome,
      resultJson: JSON.stringify(input.result ?? {}),
      updatedAt: now,
    });
    this.store.insertEvent({
      runId: run.id,
      cycleId: op.cycleId,
      operationId: op.id,
      type: 'operation_completed',
      payload: { outcome: input.outcome },
      fencingGeneration: run.fencingGeneration,
      createdAt: now,
    });

    if (input.outcome === 'failed') {
      await this.recordStageFailure(run, op.id, now, input.result);
    } else if (input.outcome === 'succeeded') {
      const stage = this.store.getStageByOperationId(op.id);
      if (stage) {
        this.store.updateStage(stage.id, {
          status: 'succeeded',
          completedAt: now,
          resultJson: JSON.stringify(input.result ?? {}),
        });
      }
    }

    if (input.outcome === 'ambiguous') {
      this.parkRun(run, now, 'ambiguous_operation_outcome');
    } else if (run.controlState === 'pausing') {
      if (this.store.listInFlightOperations(run.id).length === 0) {
        this.parkRun(
          run,
          now,
          run.pauseReason === 'ambiguous_operation_outcome'
            ? 'ambiguous_operation_outcome'
            : 'operator_pause',
        );
      }
    }

    const afterCost = this.store.getRun(run.id) ?? run;
    const envelope = this.envelopeFailure(afterCost);
    if (envelope && afterCost.controlState === 'running') {
      await this.expireRun(afterCost, envelope);
    }

    const updated = this.store.getOperation(op.id);
    if (!updated) throw new AutopilotError('not_found', 'Operation not found');
    return updated;
  }

  private async recordStageFailure(
    run: AutopilotRunRecord,
    operationId: string,
    now: string,
    result: unknown,
  ): Promise<void> {
    const stage = this.store.getStageByOperationId(operationId);
    if (!stage) return;
    this.store.updateStage(stage.id, {
      status: 'failed',
      completedAt: now,
      resultJson: JSON.stringify(result ?? {}),
    });
    const canRetry = stage.attempt <= run.limits.maxRetriesPerStage;
    if (!canRetry) {
      await this.expireRun(run, 'stage_retries_exhausted');
      this.store.insertEvent({
        runId: run.id,
        cycleId: stage.cycleId,
        operationId,
        type: 'stage_retries_exhausted',
        payload: { stage: stage.stage, attempt: stage.attempt },
        fencingGeneration: run.fencingGeneration,
        createdAt: now,
      });
      return;
    }
    const cycle = this.store.getCycle(run.id, run.cycleNumber);
    if (!cycle) return;
    this.store.insertStage({
      id: this.randomId(),
      cycleId: cycle.id,
      stage: stage.stage,
      status: 'pending',
      attempt: stage.attempt + 1,
      operationId: null,
      startedAt: null,
    });
    this.store.insertEvent({
      runId: run.id,
      cycleId: cycle.id,
      operationId,
      type: 'stage_retry_scheduled',
      payload: { stage: stage.stage, nextAttempt: stage.attempt + 1 },
      fencingGeneration: run.fencingGeneration,
      createdAt: now,
    });
  }

  async openNextCycle(projectId: string): Promise<AutopilotRunSnapshot> {
    this.requireServerEnabled();
    this.requireProjectDispatchable(projectId);
    const run = this.store.getActiveRun(projectId);
    if (!run) {
      throw new AutopilotError('no_active_run', 'No active Autopilot run');
    }
    if (run.controlState !== 'running') {
      throw new AutopilotError('conflict', `Cannot open a cycle while run is ${run.controlState}`);
    }
    this.requireHeldLease(projectId, run);
    const current = this.store.getCycle(run.id, run.cycleNumber);
    if (current && current.status === 'active') {
      throw new AutopilotError('conflict', 'Only one Autopilot cycle may run at a time');
    }
    if (run.limits.cycleMode === 'finite' && run.limits.maxCycles != null) {
      if (run.cycleNumber >= run.limits.maxCycles) {
        await this.haltForEnvelope(run, 'finite cycle envelope is exhausted');
      }
    }
    const now = this.timestamp();
    const nextNumber = run.cycleNumber + 1;
    const cycleId = this.randomId();
    this.store.insertCycle({
      id: cycleId,
      runId: run.id,
      cycleNumber: nextNumber,
      briefRevision: run.briefRevision ?? 1,
      createdAt: now,
    });
    this.store.updateRun(run.id, { cycleNumber: nextNumber, updatedAt: now });
    this.store.insertEvent({
      runId: run.id,
      cycleId,
      type: 'cycle_opened',
      payload: { cycleNumber: nextNumber },
      fencingGeneration: run.fencingGeneration,
      createdAt: now,
    });
    return this.snapshot(run.id);
  }

  async recordUsage(
    projectId: string,
    input: { costUsd?: number | null },
  ): Promise<AutopilotUsage> {
    const run = this.store.getActiveRun(projectId);
    if (!run) {
      throw new AutopilotError('no_active_run', 'No active Autopilot run');
    }
    const usage =
      input.costUsd === undefined || input.costUsd === null
        ? this.refreshWallTime(run)
        : this.reportCumulativeCost(run, input.costUsd);
    const latest = this.store.getRun(run.id) ?? { ...run, usage };
    const envelope = this.envelopeFailure(latest);
    if (envelope) {
      await this.haltForEnvelope(latest, envelope);
    }
    return usage;
  }

  async reconcileAfterRestart(): Promise<AutopilotRunSnapshot[]> {
    const now = this.timestamp();
    const snapshots: AutopilotRunSnapshot[] = [];
    for (const run of this.store.listActiveRuns()) {
      if (run.controlState === 'stopped') continue;
      const fencingGeneration = this.store.transaction(() => {
        const next = this.fenceRestartLease(run, now);
        this.store.updateRun(run.id, { fencingGeneration: next, updatedAt: now });
        return next;
      });

      if (run.controlState === 'stopping') {
        const cancellable = this.store.listCancellableOperations(run.id);
        this.store.insertEvent({
          runId: run.id,
          type: 'restart_reconcile',
          payload: { action: 'finish_stop' },
          fencingGeneration,
          createdAt: now,
        });
        const { confirmed, failures } = await this.confirmCancellations(cancellable);
        if (failures.length > 0) {
          this.markOperationsCancelled(confirmed, now);
          this.store.insertEvent({
            runId: run.id,
            type: 'cancel_failed',
            payload: { failures },
            fencingGeneration,
            createdAt: now,
          });
          snapshots.push(this.snapshot(run.id));
          continue;
        }
        snapshots.push(this.finishStop(run.id, fencingGeneration, collectCancelRefs(cancellable)));
        continue;
      }

      const inFlight = this.store.listInFlightOperations(run.id);
      if (run.controlState === 'running' && inFlight.length > 0) {
        const cancellable = this.markInFlightAmbiguous(run.id, now);
        this.parkRun(run, now, 'ambiguous_restart');
        this.store.insertEvent({
          runId: run.id,
          type: 'restart_reconcile',
          payload: { action: 'pause_ambiguous', operations: inFlight.map((op) => op.id) },
          fencingGeneration,
          createdAt: now,
        });
        await this.invokeCancel(collectCancelRefs(cancellable));
        snapshots.push(this.snapshot(run.id));
        continue;
      }

      if (run.controlState === 'pausing') {
        const cancellable = this.markInFlightAmbiguous(run.id, now);
        this.parkRun(run, now, 'operator_pause');
        this.store.insertEvent({
          runId: run.id,
          type: 'restart_reconcile',
          payload: { action: 'pause_drain_aborted' },
          fencingGeneration,
          createdAt: now,
        });
        await this.invokeCancel(collectCancelRefs(cancellable));
        snapshots.push(this.snapshot(run.id));
        continue;
      }

      this.store.insertEvent({
        runId: run.id,
        type: 'restart_reconcile',
        payload: { action: 'lease_refreshed', controlState: run.controlState },
        fencingGeneration,
        createdAt: now,
      });
      snapshots.push(this.snapshot(run.id));
    }
    for (const projectId of this.store.listDisablingProjectIds()) {
      if (!this.store.getActiveRun(projectId)) {
        this.finishDisable(projectId, { userId: null });
      }
    }
    return snapshots;
  }
}

export function createAutopilotController(deps: AutopilotControllerDeps): AutopilotController {
  return new AutopilotController(deps);
}
