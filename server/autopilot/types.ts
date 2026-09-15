export const AUTOPILOT_STAGES = [
  'planning',
  'implementing',
  'finalizing',
  'deploying',
  'verifying',
  'documenting',
  'selecting-next',
] as const;

export type AutopilotStage = (typeof AUTOPILOT_STAGES)[number];

export const AUTOPILOT_CONTROL_STATES = [
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'failed',
] as const;

export type AutopilotControlState = (typeof AUTOPILOT_CONTROL_STATES)[number];

export const AUTOPILOT_ACTIVE_STATES: readonly AutopilotControlState[] = [
  'running',
  'pausing',
  'paused',
  'stopping',
];

export type AutopilotCycleMode = 'continuous' | 'finite';

export interface AutopilotLimits {
  cycleMode: AutopilotCycleMode;
  maxCycles: number | null;
  maxWallTimeMs: number;
  maxStageTimeoutMs: number;
  maxRetriesPerStage: number;
  /** Null means no cost cap; wall-time still applies when cost is unavailable. */
  maxCostUsd: number | null;
}

export interface AutopilotEvaluatorPolicy {
  version: number;
}

export type AutopilotWorkerRole = 'implementer' | 'evaluator';

export interface AutopilotWorkerAuthority {
  keyName: string | null;
  keyId: string | null;
  evaluatorKeyName: string | null;
  evaluatorKeyId: string | null;
}

export interface AutopilotWorkerScope {
  projectId: string;
  runId: string;
  role: AutopilotWorkerRole;
}

export interface AutopilotTarget {
  targetId: string;
  readinessProbeUrl: string | null;
  origin: string | null;
}

export interface AutopilotUsage {
  wallTimeMs: number;
  costUsd: number | null;
  costAvailable: boolean;
}

export interface AutopilotProjectConfig {
  projectId: string;
  enabled: boolean;
  disabling: boolean;
  briefId: string | null;
  brief: string | null;
  briefRevision: number | null;
  target: AutopilotTarget | null;
  limits: AutopilotLimits | null;
  evaluatorPolicy: AutopilotEvaluatorPolicy;
  credentialOwnerUserId: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface AutopilotRunRecord {
  id: string;
  projectId: string;
  controlState: AutopilotControlState;
  stage: AutopilotStage | null;
  fencingGeneration: number;
  briefId: string | null;
  briefRevision: number | null;
  cycleNumber: number;
  pauseReason: string | null;
  failureReason: string | null;
  lastVerifiedSha: string | null;
  lastDeploymentId: string | null;
  credentialOwnerUserId: string | null;
  targetId: string | null;
  limits: AutopilotLimits;
  usage: AutopilotUsage;
  workerAuthority: AutopilotWorkerAuthority;
  startedBy: string | null;
  startedAt: string;
  stoppedAt: string | null;
  updatedAt: string;
}

export interface AutopilotCycleRecord {
  id: string;
  runId: string;
  cycleNumber: number;
  briefRevision: number;
  specRevision: number | null;
  cardId: string | null;
  sessionId: string | null;
  testedCommitSha: string | null;
  finalizeRunId: string | null;
  deploymentId: string | null;
  verification: unknown;
  documentation: unknown;
  selectedImprovement: string | null;
  outcome: string | null;
  status: 'active' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: string;
}

export interface AutopilotStageRecord {
  id: string;
  cycleId: string;
  stage: AutopilotStage;
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  operationId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown;
}

export interface AutopilotOperationRecord {
  id: string;
  runId: string;
  cycleId: string | null;
  kind: string;
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'cancelled' | 'ambiguous';
  fencingGeneration: number;
  intent: unknown;
  result: unknown;
  sessionId: string | null;
  finalizeRunId: string | null;
  deploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotEventRecord {
  id: string;
  runId: string;
  cycleId: string | null;
  operationId: string | null;
  type: string;
  payload: unknown;
  fencingGeneration: number | null;
  createdAt: string;
  seq: number;
}

export interface AutopilotLeaseRecord {
  projectId: string;
  runId: string;
  fencingGeneration: number;
  holderId: string;
  leasedAt: string;
}

export interface AutopilotCancelRefs {
  sessionIds: string[];
  finalizeRunIds: string[];
  deploymentIds: string[];
  operationIds: string[];
}

export type AutopilotCancelFailureKind = 'session' | 'finalize' | 'deployment';

export interface AutopilotCancelFailure {
  kind: AutopilotCancelFailureKind;
  id: string;
  message: string;
}

export type AutopilotCancelSideEffects = (
  refs: AutopilotCancelRefs,
) => AutopilotCancelFailure[] | void | Promise<AutopilotCancelFailure[] | void>;

export interface AutopilotRunSnapshot {
  run: AutopilotRunRecord;
  cycle: AutopilotCycleRecord | null;
  stages: AutopilotStageRecord[];
  operations: AutopilotOperationRecord[];
  events: AutopilotEventRecord[];
  lease: AutopilotLeaseRecord | null;
}

export interface AutopilotProjectState {
  serverEnabled: boolean;
  config: AutopilotProjectConfig;
  activeRun: AutopilotRunSnapshot | null;
}

export const DEFAULT_AUTOPILOT_LIMITS: AutopilotLimits = {
  cycleMode: 'continuous',
  maxCycles: null,
  maxWallTimeMs: 4 * 60 * 60 * 1000,
  maxStageTimeoutMs: 30 * 60 * 1000,
  maxRetriesPerStage: 2,
  maxCostUsd: null,
};

export const DEFAULT_AUTOPILOT_EVALUATOR_POLICY: AutopilotEvaluatorPolicy = {
  version: 1,
};

export const EMPTY_AUTOPILOT_WORKER_AUTHORITY: AutopilotWorkerAuthority = {
  keyName: null,
  keyId: null,
  evaluatorKeyName: null,
  evaluatorKeyId: null,
};

export const DEFAULT_AUTOPILOT_USAGE: AutopilotUsage = {
  wallTimeMs: 0,
  costUsd: null,
  costAvailable: false,
};
