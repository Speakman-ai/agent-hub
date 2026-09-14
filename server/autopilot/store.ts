import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { ensureAutopilotSchema } from './schema.js';
import type {
  AutopilotControlState,
  AutopilotCycleRecord,
  AutopilotEventRecord,
  AutopilotLeaseRecord,
  AutopilotLimits,
  AutopilotOperationRecord,
  AutopilotProjectConfig,
  AutopilotRunRecord,
  AutopilotStage,
  AutopilotStageRecord,
  AutopilotTarget,
  AutopilotUsage,
  AutopilotEvaluatorPolicy,
  AutopilotWorkerAuthority,
} from './types.js';
import {
  AUTOPILOT_ACTIVE_STATES,
  DEFAULT_AUTOPILOT_EVALUATOR_POLICY,
  DEFAULT_AUTOPILOT_LIMITS,
  EMPTY_AUTOPILOT_WORKER_AUTHORITY,
} from './types.js';

type Db = Database.Database;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseLimits(raw: string | null | undefined): AutopilotLimits {
  const parsed = parseJson<Partial<AutopilotLimits>>(raw, {});
  return {
    cycleMode: parsed.cycleMode === 'finite' ? 'finite' : 'continuous',
    maxCycles:
      typeof parsed.maxCycles === 'number' && Number.isFinite(parsed.maxCycles)
        ? Math.floor(parsed.maxCycles)
        : null,
    maxWallTimeMs:
      typeof parsed.maxWallTimeMs === 'number' && Number.isFinite(parsed.maxWallTimeMs)
        ? parsed.maxWallTimeMs
        : DEFAULT_AUTOPILOT_LIMITS.maxWallTimeMs,
    maxStageTimeoutMs:
      typeof parsed.maxStageTimeoutMs === 'number' && Number.isFinite(parsed.maxStageTimeoutMs)
        ? parsed.maxStageTimeoutMs
        : DEFAULT_AUTOPILOT_LIMITS.maxStageTimeoutMs,
    maxRetriesPerStage:
      typeof parsed.maxRetriesPerStage === 'number' && Number.isFinite(parsed.maxRetriesPerStage)
        ? Math.floor(parsed.maxRetriesPerStage)
        : DEFAULT_AUTOPILOT_LIMITS.maxRetriesPerStage,
    maxCostUsd:
      typeof parsed.maxCostUsd === 'number' && Number.isFinite(parsed.maxCostUsd)
        ? parsed.maxCostUsd
        : null,
  };
}

function parseTarget(
  raw: string | null | undefined,
  targetId: string | null,
): AutopilotTarget | null {
  if (!targetId && (!raw || raw === '{}')) return null;
  const parsed = parseJson<Partial<AutopilotTarget>>(raw, {});
  const id = (parsed.targetId || targetId || '').trim();
  if (!id) return null;
  return {
    targetId: id,
    readinessProbeUrl: parsed.readinessProbeUrl ?? null,
    origin: parsed.origin ?? null,
  };
}

function parseUsage(raw: string | null | undefined): AutopilotUsage {
  const parsed = parseJson<Partial<AutopilotUsage>>(raw, {});
  return {
    wallTimeMs:
      typeof parsed.wallTimeMs === 'number' && Number.isFinite(parsed.wallTimeMs)
        ? parsed.wallTimeMs
        : 0,
    costUsd:
      typeof parsed.costUsd === 'number' && Number.isFinite(parsed.costUsd) ? parsed.costUsd : null,
    costAvailable: parsed.costAvailable === true,
  };
}

function parseEvaluatorPolicy(raw: string | null | undefined): AutopilotEvaluatorPolicy {
  const parsed = parseJson<Partial<AutopilotEvaluatorPolicy>>(raw, {});
  const version =
    typeof parsed.version === 'number' && Number.isInteger(parsed.version) && parsed.version >= 1
      ? parsed.version
      : DEFAULT_AUTOPILOT_EVALUATOR_POLICY.version;
  return { version };
}

function parseWorkerAuthority(raw: string | null | undefined): AutopilotWorkerAuthority {
  const parsed = parseJson<Partial<AutopilotWorkerAuthority>>(raw, {});
  return {
    keyName: typeof parsed.keyName === 'string' && parsed.keyName.trim() ? parsed.keyName : null,
    keyId: typeof parsed.keyId === 'string' && parsed.keyId.trim() ? parsed.keyId : null,
  };
}

interface ConfigRow {
  project_id: string;
  enabled: number;
  disabling: number | null;
  brief_id: string | null;
  target_id: string | null;
  target_json: string;
  limits_json: string;
  evaluator_policy_json: string | null;
  credential_owner_user_id: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface BriefRow {
  id: string;
  project_id: string;
  revision: number;
  content: string;
  spec_json: string | null;
  created_at: string;
  created_by: string | null;
}

interface RunRow {
  id: string;
  project_id: string;
  control_state: AutopilotControlState;
  stage: AutopilotStage | null;
  fencing_generation: number;
  brief_id: string | null;
  brief_revision: number | null;
  cycle_number: number;
  pause_reason: string | null;
  failure_reason: string | null;
  last_verified_sha: string | null;
  last_deployment_id: string | null;
  credential_owner_user_id: string | null;
  target_id: string | null;
  limits_json: string;
  usage_json: string;
  worker_authority_json: string | null;
  started_by: string | null;
  started_at: string;
  stopped_at: string | null;
  updated_at: string;
}

interface CycleRow {
  id: string;
  run_id: string;
  cycle_number: number;
  brief_revision: number;
  spec_revision: number | null;
  card_id: string | null;
  session_id: string | null;
  tested_commit_sha: string | null;
  finalize_run_id: string | null;
  deployment_id: string | null;
  verification_json: string | null;
  documentation_json: string | null;
  selected_improvement: string | null;
  outcome: string | null;
  status: AutopilotCycleRecord['status'];
  created_at: string;
}

interface StageRow {
  id: string;
  cycle_id: string;
  stage: AutopilotStage;
  status: AutopilotStageRecord['status'];
  attempt: number;
  operation_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  result_json: string | null;
}

interface OperationRow {
  id: string;
  run_id: string;
  cycle_id: string | null;
  kind: string;
  status: AutopilotOperationRecord['status'];
  fencing_generation: number;
  intent_json: string;
  result_json: string | null;
  session_id: string | null;
  finalize_run_id: string | null;
  deployment_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  run_id: string;
  cycle_id: string | null;
  operation_id: string | null;
  type: string;
  payload_json: string;
  fencing_generation: number | null;
  created_at: string;
  seq: number;
}

interface LeaseRow {
  project_id: string;
  run_id: string;
  fencing_generation: number;
  holder_id: string;
  leased_at: string;
}

function mapRun(row: RunRow): AutopilotRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    controlState: row.control_state,
    stage: row.stage,
    fencingGeneration: row.fencing_generation,
    briefId: row.brief_id,
    briefRevision: row.brief_revision,
    cycleNumber: row.cycle_number,
    pauseReason: row.pause_reason,
    failureReason: row.failure_reason,
    lastVerifiedSha: row.last_verified_sha,
    lastDeploymentId: row.last_deployment_id,
    credentialOwnerUserId: row.credential_owner_user_id,
    targetId: row.target_id,
    limits: parseLimits(row.limits_json),
    usage: parseUsage(row.usage_json),
    workerAuthority: parseWorkerAuthority(row.worker_authority_json),
    startedBy: row.started_by,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    updatedAt: row.updated_at,
  };
}

function mapCycle(row: CycleRow): AutopilotCycleRecord {
  return {
    id: row.id,
    runId: row.run_id,
    cycleNumber: row.cycle_number,
    briefRevision: row.brief_revision,
    specRevision: row.spec_revision,
    cardId: row.card_id,
    sessionId: row.session_id,
    testedCommitSha: row.tested_commit_sha,
    finalizeRunId: row.finalize_run_id,
    deploymentId: row.deployment_id,
    verification: parseJson(row.verification_json, null),
    documentation: parseJson(row.documentation_json, null),
    selectedImprovement: row.selected_improvement,
    outcome: row.outcome,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapStage(row: StageRow): AutopilotStageRecord {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    stage: row.stage,
    status: row.status,
    attempt: row.attempt,
    operationId: row.operation_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    result: parseJson(row.result_json, null),
  };
}

function mapOperation(row: OperationRow): AutopilotOperationRecord {
  return {
    id: row.id,
    runId: row.run_id,
    cycleId: row.cycle_id,
    kind: row.kind,
    status: row.status,
    fencingGeneration: row.fencing_generation,
    intent: parseJson(row.intent_json, {}),
    result: parseJson(row.result_json, null),
    sessionId: row.session_id,
    finalizeRunId: row.finalize_run_id,
    deploymentId: row.deployment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): AutopilotEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    cycleId: row.cycle_id,
    operationId: row.operation_id,
    type: row.type,
    payload: parseJson(row.payload_json, {}),
    fencingGeneration: row.fencing_generation,
    createdAt: row.created_at,
    seq: row.seq,
  };
}

function mapLease(row: LeaseRow): AutopilotLeaseRecord {
  return {
    projectId: row.project_id,
    runId: row.run_id,
    fencingGeneration: row.fencing_generation,
    holderId: row.holder_id,
    leasedAt: row.leased_at,
  };
}

export interface UpsertConfigInput {
  projectId: string;
  enabled: boolean;
  disabling: boolean;
  briefId: string | null;
  targetId: string | null;
  targetJson: string;
  limitsJson: string;
  evaluatorPolicyJson: string;
  credentialOwnerUserId: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface InsertRunInput {
  id: string;
  projectId: string;
  controlState: AutopilotControlState;
  stage: AutopilotStage | null;
  fencingGeneration: number;
  briefId: string | null;
  briefRevision: number | null;
  cycleNumber: number;
  credentialOwnerUserId: string | null;
  targetId: string | null;
  limitsJson: string;
  usageJson: string;
  workerAuthorityJson?: string;
  startedBy: string | null;
  startedAt: string;
  updatedAt: string;
}

export class AutopilotStore {
  constructor(private readonly db: Db) {
    ensureAutopilotSchema(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getConfig(projectId: string): AutopilotProjectConfig {
    const row = this.db
      .prepare(`SELECT * FROM autopilot_project_config WHERE project_id = ?`)
      .get(projectId) as ConfigRow | undefined;
    if (!row) {
      return {
        projectId,
        enabled: false,
        disabling: false,
        briefId: null,
        brief: null,
        briefRevision: null,
        target: null,
        limits: null,
        evaluatorPolicy: { ...DEFAULT_AUTOPILOT_EVALUATOR_POLICY },
        credentialOwnerUserId: null,
        updatedAt: '',
        updatedBy: null,
      };
    }
    const brief = row.brief_id ? this.getBrief(row.brief_id) : null;
    return {
      projectId: row.project_id,
      enabled: row.enabled === 1,
      disabling: row.disabling === 1,
      briefId: row.brief_id,
      brief: brief?.content ?? null,
      briefRevision: brief?.revision ?? null,
      target: parseTarget(row.target_json, row.target_id),
      limits: parseLimits(row.limits_json),
      evaluatorPolicy: parseEvaluatorPolicy(row.evaluator_policy_json),
      credentialOwnerUserId: row.credential_owner_user_id,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  upsertConfig(input: UpsertConfigInput): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_project_config (
           project_id, enabled, disabling, brief_id, target_id, target_json, limits_json,
           evaluator_policy_json, credential_owner_user_id, updated_at, updated_by
         ) VALUES (@projectId, @enabled, @disabling, @briefId, @targetId, @targetJson, @limitsJson,
           @evaluatorPolicyJson, @credentialOwnerUserId, @updatedAt, @updatedBy)
         ON CONFLICT(project_id) DO UPDATE SET
           enabled = excluded.enabled,
           disabling = excluded.disabling,
           brief_id = excluded.brief_id,
           target_id = excluded.target_id,
           target_json = excluded.target_json,
           limits_json = excluded.limits_json,
           evaluator_policy_json = excluded.evaluator_policy_json,
           credential_owner_user_id = excluded.credential_owner_user_id,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run({
        projectId: input.projectId,
        enabled: input.enabled ? 1 : 0,
        disabling: input.disabling ? 1 : 0,
        briefId: input.briefId,
        targetId: input.targetId,
        targetJson: input.targetJson,
        limitsJson: input.limitsJson,
        evaluatorPolicyJson: input.evaluatorPolicyJson,
        credentialOwnerUserId: input.credentialOwnerUserId,
        updatedAt: input.updatedAt,
        updatedBy: input.updatedBy,
      });
  }

  listDisablingProjectIds(): string[] {
    return (
      this.db
        .prepare(`SELECT project_id FROM autopilot_project_config WHERE disabling = 1`)
        .all() as { project_id: string }[]
    ).map((row) => row.project_id);
  }

  getBrief(id: string): BriefRow | undefined {
    return this.db.prepare(`SELECT * FROM autopilot_briefs WHERE id = ?`).get(id) as
      | BriefRow
      | undefined;
  }

  nextBriefRevision(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(revision), 0) AS max_rev FROM autopilot_briefs WHERE project_id = ?`,
      )
      .get(projectId) as { max_rev: number };
    return (row?.max_rev ?? 0) + 1;
  }

  insertBrief(input: {
    id: string;
    projectId: string;
    revision: number;
    content: string;
    specJson: string | null;
    createdAt: string;
    createdBy: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_briefs (
           id, project_id, revision, content, spec_json, created_at, created_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.revision,
        input.content,
        input.specJson,
        input.createdAt,
        input.createdBy,
      );
  }

  getActiveRun(projectId: string): AutopilotRunRecord | null {
    const placeholders = AUTOPILOT_ACTIVE_STATES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT * FROM autopilot_runs WHERE project_id = ? AND control_state IN (${placeholders})
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(projectId, ...AUTOPILOT_ACTIVE_STATES) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listActiveRuns(): AutopilotRunRecord[] {
    const placeholders = AUTOPILOT_ACTIVE_STATES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM autopilot_runs WHERE control_state IN (${placeholders}) ORDER BY started_at ASC`,
      )
      .all(...AUTOPILOT_ACTIVE_STATES) as RunRow[];
    return rows.map(mapRun);
  }

  getRun(runId: string): AutopilotRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM autopilot_runs WHERE id = ?`).get(runId) as
      | RunRow
      | undefined;
    return row ? mapRun(row) : null;
  }

  getLatestRun(projectId: string): AutopilotRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autopilot_runs WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  insertRun(input: InsertRunInput): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_runs (
           id, project_id, control_state, stage, fencing_generation, brief_id, brief_revision,
           cycle_number, credential_owner_user_id, target_id, limits_json, usage_json,
           worker_authority_json, started_by, started_at, updated_at
         ) VALUES (
           @id, @projectId, @controlState, @stage, @fencingGeneration, @briefId, @briefRevision,
           @cycleNumber, @credentialOwnerUserId, @targetId, @limitsJson, @usageJson,
           @workerAuthorityJson, @startedBy, @startedAt, @updatedAt
         )`,
      )
      .run({
        ...input,
        workerAuthorityJson:
          input.workerAuthorityJson ?? JSON.stringify(EMPTY_AUTOPILOT_WORKER_AUTHORITY),
      });
  }

  updateRun(
    runId: string,
    patch: Partial<{
      controlState: AutopilotControlState;
      stage: AutopilotStage | null;
      fencingGeneration: number;
      cycleNumber: number;
      pauseReason: string | null;
      failureReason: string | null;
      lastVerifiedSha: string | null;
      lastDeploymentId: string | null;
      credentialOwnerUserId: string | null;
      usageJson: string;
      workerAuthorityJson: string;
      stoppedAt: string | null;
      updatedAt: string;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { runId };
    const map: Record<string, string> = {
      controlState: 'control_state',
      stage: 'stage',
      fencingGeneration: 'fencing_generation',
      cycleNumber: 'cycle_number',
      pauseReason: 'pause_reason',
      failureReason: 'failure_reason',
      lastVerifiedSha: 'last_verified_sha',
      lastDeploymentId: 'last_deployment_id',
      credentialOwnerUserId: 'credential_owner_user_id',
      usageJson: 'usage_json',
      workerAuthorityJson: 'worker_authority_json',
      stoppedAt: 'stopped_at',
      updatedAt: 'updated_at',
    };
    for (const [key, col] of Object.entries(map)) {
      if (key in patch) {
        sets.push(`${col} = @${key}`);
        params[key] = (patch as Record<string, unknown>)[key];
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE autopilot_runs SET ${sets.join(', ')} WHERE id = @runId`).run(params);
  }

  insertLease(input: AutopilotLeaseRecord): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_leases (project_id, run_id, fencing_generation, holder_id, leased_at)
         VALUES (@projectId, @runId, @fencingGeneration, @holderId, @leasedAt)
         ON CONFLICT(project_id) DO UPDATE SET
           run_id = excluded.run_id,
           fencing_generation = excluded.fencing_generation,
           holder_id = excluded.holder_id,
           leased_at = excluded.leased_at`,
      )
      .run(input);
  }

  /**
   * Restart fencing: steal the project lease regardless of previous holder.
   */
  takeOverLease(input: AutopilotLeaseRecord): boolean {
    const updated = this.db
      .prepare(
        `UPDATE autopilot_leases
         SET run_id = @runId,
             fencing_generation = @fencingGeneration,
             holder_id = @holderId,
             leased_at = @leasedAt
         WHERE project_id = @projectId`,
      )
      .run(input);
    if (updated.changes > 0) return true;
    this.insertLease(input);
    return true;
  }

  /**
   * Bump generation only if this holder already owns the lease at `fromGeneration`.
   */
  bumpHeldLease(input: {
    projectId: string;
    holderId: string;
    fromGeneration: number;
    toGeneration: number;
    leasedAt: string;
  }): boolean {
    const updated = this.db
      .prepare(
        `UPDATE autopilot_leases
         SET fencing_generation = @toGeneration, leased_at = @leasedAt
         WHERE project_id = @projectId
           AND holder_id = @holderId
           AND fencing_generation = @fromGeneration`,
      )
      .run(input);
    return updated.changes > 0;
  }

  getLease(projectId: string): AutopilotLeaseRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM autopilot_leases WHERE project_id = ?`)
      .get(projectId) as LeaseRow | undefined;
    return row ? mapLease(row) : null;
  }

  insertCycle(input: {
    id: string;
    runId: string;
    cycleNumber: number;
    briefRevision: number;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_cycles (id, run_id, cycle_number, brief_revision, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.runId, input.cycleNumber, input.briefRevision, input.createdAt);
  }

  getCycle(runId: string, cycleNumber: number): AutopilotCycleRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM autopilot_cycles WHERE run_id = ? AND cycle_number = ?`)
      .get(runId, cycleNumber) as CycleRow | undefined;
    return row ? mapCycle(row) : null;
  }

  getCycleById(id: string): AutopilotCycleRecord | null {
    const row = this.db.prepare(`SELECT * FROM autopilot_cycles WHERE id = ?`).get(id) as
      | CycleRow
      | undefined;
    return row ? mapCycle(row) : null;
  }

  listCycles(runId: string): AutopilotCycleRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM autopilot_cycles WHERE run_id = ? ORDER BY cycle_number ASC`)
      .all(runId) as CycleRow[];
    return rows.map(mapCycle);
  }

  insertStage(input: {
    id: string;
    cycleId: string;
    stage: AutopilotStage;
    status: AutopilotStageRecord['status'];
    attempt: number;
    operationId: string | null;
    startedAt: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_stages (
           id, cycle_id, stage, status, attempt, operation_id, started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.cycleId,
        input.stage,
        input.status,
        input.attempt,
        input.operationId,
        input.startedAt,
      );
  }

  listStages(cycleId: string): AutopilotStageRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM autopilot_stages WHERE cycle_id = ? ORDER BY attempt ASC`)
      .all(cycleId) as StageRow[];
    return rows.map(mapStage);
  }

  getStageByOperationId(operationId: string): AutopilotStageRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM autopilot_stages WHERE operation_id = ?`)
      .get(operationId) as StageRow | undefined;
    return row ? mapStage(row) : null;
  }

  getOpenStage(cycleId: string): AutopilotStageRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autopilot_stages
         WHERE cycle_id = ? AND status IN ('pending', 'in_progress')
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(cycleId) as StageRow | undefined;
    return row ? mapStage(row) : null;
  }

  countStageAttempts(cycleId: string, stage: AutopilotStage): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM autopilot_stages WHERE cycle_id = ? AND stage = ?`)
      .get(cycleId, stage) as { n: number };
    return row?.n ?? 0;
  }

  updateStage(
    id: string,
    patch: Partial<{
      status: AutopilotStageRecord['status'];
      operationId: string | null;
      startedAt: string | null;
      completedAt: string | null;
      resultJson: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const map: Record<string, string> = {
      status: 'status',
      operationId: 'operation_id',
      startedAt: 'started_at',
      completedAt: 'completed_at',
      resultJson: 'result_json',
    };
    for (const [key, col] of Object.entries(map)) {
      if (key in patch) {
        sets.push(`${col} = @${key}`);
        params[key] = (patch as Record<string, unknown>)[key];
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE autopilot_stages SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  updateCycle(
    id: string,
    patch: Partial<{
      status: AutopilotCycleRecord['status'];
      outcome: string | null;
      specRevision: number | null;
      cardId: string | null;
      sessionId: string | null;
      testedCommitSha: string | null;
      finalizeRunId: string | null;
      deploymentId: string | null;
      verificationJson: string | null;
      documentationJson: string | null;
      selectedImprovement: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const map: Record<string, string> = {
      status: 'status',
      outcome: 'outcome',
      specRevision: 'spec_revision',
      cardId: 'card_id',
      sessionId: 'session_id',
      testedCommitSha: 'tested_commit_sha',
      finalizeRunId: 'finalize_run_id',
      deploymentId: 'deployment_id',
      verificationJson: 'verification_json',
      documentationJson: 'documentation_json',
      selectedImprovement: 'selected_improvement',
    };
    for (const [key, col] of Object.entries(map)) {
      if (key in patch) {
        sets.push(`${col} = @${key}`);
        params[key] = (patch as Record<string, unknown>)[key];
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE autopilot_cycles SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  /** Persist the planner's expanded baseline spec onto the brief revision. */
  updateBriefSpec(briefId: string, specJson: string): void {
    this.db
      .prepare(`UPDATE autopilot_briefs SET spec_json = ? WHERE id = ?`)
      .run(specJson, briefId);
  }

  countActiveCycles(runId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM autopilot_cycles WHERE run_id = ? AND status = 'active'`)
      .get(runId) as { n: number };
    return row?.n ?? 0;
  }

  insertOperation(input: {
    id: string;
    runId: string;
    cycleId: string | null;
    kind: string;
    status: AutopilotOperationRecord['status'];
    fencingGeneration: number;
    intentJson: string;
    sessionId: string | null;
    finalizeRunId: string | null;
    deploymentId: string | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_operations (
           id, run_id, cycle_id, kind, status, fencing_generation, intent_json,
           session_id, finalize_run_id, deployment_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        input.cycleId,
        input.kind,
        input.status,
        input.fencingGeneration,
        input.intentJson,
        input.sessionId,
        input.finalizeRunId,
        input.deploymentId,
        input.createdAt,
        input.createdAt,
      );
  }

  getOperation(id: string): AutopilotOperationRecord | null {
    const row = this.db.prepare(`SELECT * FROM autopilot_operations WHERE id = ?`).get(id) as
      | OperationRow
      | undefined;
    return row ? mapOperation(row) : null;
  }

  /**
   * Atomically claim a still-pending operation for the given generation
   * (pending -> in_flight). Returns true only for the caller that won the
   * transition, so concurrent claimers cannot both proceed.
   */
  claimPendingOperation(id: string, fencingGeneration: number, now: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE autopilot_operations SET status = 'in_flight', updated_at = ?
         WHERE id = ? AND status = 'pending' AND fencing_generation = ?`,
      )
      .run(now, id, fencingGeneration);
    return res.changes > 0;
  }

  /**
   * Atomically claim a still-pending stage (pending -> in_progress) and link it
   * to `operationId`. Returns true only for the winning caller.
   */
  claimPendingStage(id: string, operationId: string, now: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE autopilot_stages
         SET status = 'in_progress', operation_id = ?, started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'pending'`,
      )
      .run(operationId, now, id);
    return res.changes > 0;
  }

  updateOperation(
    id: string,
    patch: Partial<{
      status: AutopilotOperationRecord['status'];
      resultJson: string | null;
      sessionId: string | null;
      finalizeRunId: string | null;
      deploymentId: string | null;
      updatedAt: string;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const map: Record<string, string> = {
      status: 'status',
      resultJson: 'result_json',
      sessionId: 'session_id',
      finalizeRunId: 'finalize_run_id',
      deploymentId: 'deployment_id',
      updatedAt: 'updated_at',
    };
    for (const [key, col] of Object.entries(map)) {
      if (key in patch) {
        sets.push(`${col} = @${key}`);
        params[key] = (patch as Record<string, unknown>)[key];
      }
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE autopilot_operations SET ${sets.join(', ')} WHERE id = @id`)
      .run(params);
  }

  listOperations(runId: string): AutopilotOperationRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM autopilot_operations WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as OperationRow[];
    return rows.map(mapOperation);
  }

  listInFlightOperations(runId: string): AutopilotOperationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM autopilot_operations
         WHERE run_id = ? AND status = 'in_flight'
         ORDER BY created_at ASC`,
      )
      .all(runId) as OperationRow[];
    return rows.map(mapOperation);
  }

  /** Most recent operation launched for this session, if any. */
  getOperationBySessionId(sessionId: string): AutopilotOperationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autopilot_operations
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(sessionId) as OperationRow | undefined;
    return row ? mapOperation(row) : null;
  }

  /** Most recent operation that started this Finalize run, if any. */
  getOperationByFinalizeRunId(finalizeRunId: string): AutopilotOperationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autopilot_operations
         WHERE finalize_run_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(finalizeRunId) as OperationRow | undefined;
    return row ? mapOperation(row) : null;
  }

  /** Most recent operation that started this deployment, if any. */
  getOperationByDeploymentId(deploymentId: string): AutopilotOperationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM autopilot_operations
         WHERE deployment_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(deploymentId) as OperationRow | undefined;
    return row ? mapOperation(row) : null;
  }

  listOpenOperations(runId: string): AutopilotOperationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM autopilot_operations
         WHERE run_id = ? AND status IN ('pending', 'in_flight')
         ORDER BY created_at ASC`,
      )
      .all(runId) as OperationRow[];
    return rows.map(mapOperation);
  }

  listCancellableOperations(runId: string): AutopilotOperationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM autopilot_operations
         WHERE run_id = ? AND status IN ('pending', 'in_flight', 'ambiguous')
         ORDER BY created_at ASC`,
      )
      .all(runId) as OperationRow[];
    return rows.map(mapOperation);
  }

  insertEvent(input: {
    id?: string;
    runId: string;
    cycleId?: string | null;
    operationId?: string | null;
    type: string;
    payload?: unknown;
    fencingGeneration?: number | null;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO autopilot_events (
           id, run_id, cycle_id, operation_id, type, payload_json, fencing_generation, created_at, seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM autopilot_events))`,
      )
      .run(
        input.id ?? randomUUID(),
        input.runId,
        input.cycleId ?? null,
        input.operationId ?? null,
        input.type,
        JSON.stringify(input.payload ?? {}),
        input.fencingGeneration ?? null,
        input.createdAt,
      );
  }

  listEvents(runId: string, limit = 50): AutopilotEventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM autopilot_events WHERE run_id = ? ORDER BY seq DESC LIMIT ?`)
      .all(runId, limit) as EventRow[];
    return rows.map(mapEvent).reverse();
  }
}

export function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT';
}
