/**
 * Deployment Module store — query helpers over the deployments / deployment_steps
 * / deployment_environments / deployment_approvals tables (DDL in
 * `deployment-schema.ts`, prepared statements in `db.ts`).
 *
 * This is the data layer the later phases build on:
 *   - Phase 3 orchestrator: create a deployment, register its steps, acquire the
 *     per-environment lock, stream step state, then record the live ref + release
 *     the lock on success.
 *   - Phase 4 approval gate: park `awaiting_approval`, record approvals.
 *   - Phase 5 REST: list/get history, trigger, cancel, approve, rollback.
 *
 * All functions go through the shared `getStmts()` registry, so they operate on
 * the per-org main DB the rest of the app uses.
 */
import { randomUUID } from 'crypto';
import { getStmts } from '../db.js';
import type {
  DeploymentRow,
  DeploymentStepRow,
  DeploymentEnvironmentRow,
  DeploymentApprovalRow,
} from '../types.js';

export type DeploymentStatus = DeploymentRow['status'];
export type DeploymentStepStatus = DeploymentStepRow['status'];

export interface CreateDeploymentInput {
  projectId: string;
  environment: string;
  ref: string;
  /** Trigger source. Known v1 values: 'manual' | 'push' | 'rollback'. */
  trigger?: string;
  /** User id that triggered the deploy; omit for system/push-driven runs. */
  triggeredBy?: string | null;
  /** For rollback: the historical deployment whose ref this run re-runs. */
  sourceDeploymentId?: string | null;
  /** Initial status; defaults to 'pending'. */
  status?: DeploymentStatus;
  /** Free-form metadata serialized to JSON. */
  meta?: unknown;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (offset == null || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/** Create a new deploy run. Returns the inserted row. */
export function createDeployment(input: CreateDeploymentInput): DeploymentRow {
  const id = randomUUID();
  getStmts().insertDeployment.run({
    id,
    project_id: input.projectId,
    environment: input.environment,
    ref: input.ref,
    status: input.status ?? 'pending',
    trigger: input.trigger ?? 'manual',
    triggered_by: input.triggeredBy ?? null,
    source_deployment_id: input.sourceDeploymentId ?? null,
    runner_job_id: null,
    meta: input.meta == null ? null : JSON.stringify(input.meta),
  });
  return getDeployment(id) as DeploymentRow;
}

export function getDeployment(id: string): DeploymentRow | null {
  return (getStmts().getDeployment.get(id) as DeploymentRow | undefined) ?? null;
}

export function listDeployments(projectId: string, opts: ListOptions = {}): DeploymentRow[] {
  return getStmts().listDeploymentsByProject.all(
    projectId,
    clampLimit(opts.limit),
    clampOffset(opts.offset),
  ) as DeploymentRow[];
}

export function listDeploymentsForEnvironment(
  projectId: string,
  environment: string,
  opts: ListOptions = {},
): DeploymentRow[] {
  return getStmts().listDeploymentsByEnvironment.all(
    projectId,
    environment,
    clampLimit(opts.limit),
    clampOffset(opts.offset),
  ) as DeploymentRow[];
}

/**
 * Transition a deployment to `status`. `started_at` is stamped the first time the
 * deployment enters 'running' (when its steps actually begin) — NOT when a gated
 * deploy parks at 'awaiting_approval', so a deploy parked for approval doesn't
 * accrue bogus run duration. `completed_at` is stamped on a terminal state.
 * Returns the updated row, or null if no row matched. `error` is only meaningful
 * for status='error'.
 */
export function updateDeploymentStatus(
  id: string,
  status: DeploymentStatus,
  opts: { error?: string | null } = {},
): DeploymentRow | null {
  getStmts().updateDeploymentStatus.run({ id, status, error: opts.error ?? null });
  return getDeployment(id);
}

export function setDeploymentRunnerJob(id: string, runnerJobId: string): DeploymentRow | null {
  getStmts().setDeploymentRunnerJob.run(runnerJobId, id);
  return getDeployment(id);
}

export interface AddDeploymentStepInput {
  deploymentId: string;
  name: string;
  stepOrder: number;
  status?: DeploymentStepStatus;
}

/** Register a step row for a deployment (mirrors the deploy.yaml step list). */
export function addDeploymentStep(input: AddDeploymentStepInput): DeploymentStepRow {
  const id = randomUUID();
  getStmts().insertDeploymentStep.run(
    id,
    input.deploymentId,
    input.name,
    input.stepOrder,
    input.status ?? 'pending',
  );
  return getStmts().getDeploymentStep.get(id) as DeploymentStepRow;
}

export function listDeploymentSteps(deploymentId: string): DeploymentStepRow[] {
  return getStmts().listDeploymentSteps.all(deploymentId) as DeploymentStepRow[];
}

export function updateDeploymentStepStatus(
  id: string,
  status: DeploymentStepStatus,
  opts: { exitCode?: number | null; error?: string | null } = {},
): DeploymentStepRow | null {
  getStmts().updateDeploymentStepStatus.run({
    id,
    status,
    exit_code: opts.exitCode ?? null,
    error: opts.error ?? null,
  });
  return (getStmts().getDeploymentStep.get(id) as DeploymentStepRow | undefined) ?? null;
}

/**
 * Ensure a `deployment_environments` row exists for (project, name) and return
 * it. Idempotent — a pre-existing row keeps its live-ref / lock columns.
 */
export function ensureDeploymentEnvironment(
  projectId: string,
  name: string,
): DeploymentEnvironmentRow {
  getStmts().upsertDeploymentEnvironment.run(randomUUID(), projectId, name);
  return getDeploymentEnvironment(projectId, name) as DeploymentEnvironmentRow;
}

export function getDeploymentEnvironment(
  projectId: string,
  name: string,
): DeploymentEnvironmentRow | null {
  return (
    (getStmts().getDeploymentEnvironment.get(projectId, name) as
      | DeploymentEnvironmentRow
      | undefined) ?? null
  );
}

export function listDeploymentEnvironments(projectId: string): DeploymentEnvironmentRow[] {
  return getStmts().listDeploymentEnvironments.all(projectId) as DeploymentEnvironmentRow[];
}

/**
 * Try to acquire the per-environment concurrency lock for `deploymentId`. The
 * environment row must already exist (call `ensureDeploymentEnvironment` first).
 * Returns true if the lock was acquired, false if another deploy holds it (the
 * caller rejects the trigger 409). Atomic: the UPDATE only matches when
 * `active_deployment_id IS NULL`.
 */
export function acquireEnvironmentLock(
  projectId: string,
  name: string,
  deploymentId: string,
): boolean {
  const res = getStmts().acquireDeploymentEnvironmentLock.run({
    project_id: projectId,
    name,
    deployment_id: deploymentId,
  });
  return res.changes > 0;
}

/**
 * Release the lock, but only if `deploymentId` currently holds it. Returns true
 * if released. A stale releaser (a deploy that already lost the lock) is a no-op.
 */
export function releaseEnvironmentLock(
  projectId: string,
  name: string,
  deploymentId: string,
): boolean {
  const res = getStmts().releaseDeploymentEnvironmentLock.run({
    project_id: projectId,
    name,
    deployment_id: deploymentId,
  });
  return res.changes > 0;
}

/** Record the ref now live in an environment (called on a successful deploy). */
export function setEnvironmentCurrentRef(
  projectId: string,
  name: string,
  ref: string,
  deploymentId: string,
): DeploymentEnvironmentRow | null {
  getStmts().setDeploymentEnvironmentCurrentRef.run({
    project_id: projectId,
    name,
    current_ref: ref,
    current_deployment_id: deploymentId,
  });
  return getDeploymentEnvironment(projectId, name);
}

export interface RecordApprovalInput {
  deploymentId: string;
  approverUserId: string;
  /** Org role held at approval time (Owner / Admin). */
  approverRole: string;
  decision?: 'approved' | 'rejected';
  note?: string | null;
}

/** Record an approval/rejection decision for a gated deployment. */
export function recordDeploymentApproval(input: RecordApprovalInput): DeploymentApprovalRow {
  const id = randomUUID();
  getStmts().insertDeploymentApproval.run(
    id,
    input.deploymentId,
    input.approverUserId,
    input.approverRole,
    input.decision ?? 'approved',
    input.note ?? null,
  );
  return getStmts()
    .listDeploymentApprovals.all(input.deploymentId)
    .find((r) => (r as DeploymentApprovalRow).id === id) as DeploymentApprovalRow;
}

export function listDeploymentApprovals(deploymentId: string): DeploymentApprovalRow[] {
  return getStmts().listDeploymentApprovals.all(deploymentId) as DeploymentApprovalRow[];
}
