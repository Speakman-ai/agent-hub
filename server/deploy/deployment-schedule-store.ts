/**
 * Store for per-environment DEPLOY SCHEDULES (multi-environment management — the
 * scheduling phase). DDL in `deployment-schedule-schema.ts`, prepared statements
 * in `db.ts`.
 *
 * Locked epic decision `deploy-scheduling`:
 *   Schedule = DB row `{environment, ref, cron, timezone, owner_user_id,
 *   enabled}`. Reuses the node-cron + owner + timezone pattern from
 *   crons/heartbeats; runs under the owner identity. Disabled = a retained
 *   temporary pause. Fires `trigger=schedule`, honoring the per-env concurrency
 *   lock.
 *
 * This module owns the STORE + CRUD only. The node-cron registration / firing
 * path is a sibling card that calls {@link listEnabledSchedules} to resolve which
 * schedules to register at boot and enqueue deployments on tick.
 */
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import { getStmts } from '../db.js';
import type { DeploymentEnvironmentScheduleRow } from '../types.js';

export const DEPLOY_SCHEDULE_REF_MAX_LENGTH = 255;
export const DEPLOY_SCHEDULE_CRON_MAX_LENGTH = 200;

export class DeployScheduleError extends Error {
  constructor(
    public reason: 'not_found' | 'duplicate' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DeployScheduleError';
  }
}

export interface CreateScheduleInput {
  projectId: string;
  environmentName: string;
  ref: string;
  cron: string;
  /** IANA timezone; null/undefined = server scheduler default. */
  timezone?: string | null;
  /** Identity the scheduled run spawns under; null = system-owned. */
  ownerUserId?: string | null;
  /** Defaults to true for a new schedule. */
  enabled?: boolean;
  /** Free-form metadata serialized to JSON. */
  meta?: unknown;
}

export interface UpdateScheduleInput {
  /** Omitted fields keep their current value (partial update). */
  ref?: string;
  cron?: string;
  /** `null` clears the timezone; `undefined` preserves it. */
  timezone?: string | null;
  enabled?: boolean;
  /** `null` clears meta; `undefined` preserves it. */
  meta?: unknown;
}

function normalizeRef(raw: string): string {
  const ref = raw.trim();
  if (!ref) {
    throw new DeployScheduleError('invalid', 'ref is required.');
  }
  if (ref.length > DEPLOY_SCHEDULE_REF_MAX_LENGTH) {
    throw new DeployScheduleError(
      'invalid',
      `ref must be ${DEPLOY_SCHEDULE_REF_MAX_LENGTH} characters or fewer.`,
    );
  }
  return ref;
}

function normalizeCron(raw: string): string {
  const expr = raw.trim();
  if (!expr) {
    throw new DeployScheduleError('invalid', 'cron is required.');
  }
  if (expr.length > DEPLOY_SCHEDULE_CRON_MAX_LENGTH) {
    throw new DeployScheduleError(
      'invalid',
      `cron must be ${DEPLOY_SCHEDULE_CRON_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (!cron.validate(expr)) {
    throw new DeployScheduleError('invalid', 'cron must be a valid cron expression.');
  }
  return expr;
}

/** IANA timezone validation mirrors `normalizeCronTimezone` in the crons route. */
function normalizeTimezone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    throw new DeployScheduleError('invalid', 'timezone must be a valid IANA timezone.');
  }
}

function normalizeOwner(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function serializeMeta(meta: unknown): string | null {
  if (meta === undefined || meta === null) return null;
  return JSON.stringify(meta);
}

export function getSchedule(
  projectId: string,
  scheduleId: string,
): DeploymentEnvironmentScheduleRow | null {
  return (
    (getStmts().getDeploymentEnvSchedule.get(projectId, scheduleId) as
      | DeploymentEnvironmentScheduleRow
      | undefined) ?? null
  );
}

export function listSchedulesForProject(projectId: string): DeploymentEnvironmentScheduleRow[] {
  return getStmts().listDeploymentEnvSchedulesForProject.all(
    projectId,
  ) as DeploymentEnvironmentScheduleRow[];
}

export function listSchedulesForEnvironment(
  projectId: string,
  environmentName: string,
): DeploymentEnvironmentScheduleRow[] {
  return getStmts().listDeploymentEnvSchedulesForEnvironment.all(
    projectId,
    environmentName.trim(),
  ) as DeploymentEnvironmentScheduleRow[];
}

/**
 * Every enabled schedule across all projects. The node-cron registration path
 * (sibling card) reads this at boot to register tasks; it does NOT consult
 * deploy.yaml, so a schedule for a removed environment is returned here and
 * filtered by the caller before enqueuing.
 */
export function listEnabledSchedules(): DeploymentEnvironmentScheduleRow[] {
  return getStmts().listEnabledDeploymentEnvSchedules.all() as DeploymentEnvironmentScheduleRow[];
}

export function createSchedule(input: CreateScheduleInput): DeploymentEnvironmentScheduleRow {
  const environmentName = input.environmentName.trim();
  if (!environmentName) {
    throw new DeployScheduleError('invalid', 'environmentName is required.');
  }
  const ref = normalizeRef(input.ref);
  const cronExpr = normalizeCron(input.cron);
  const timezone = normalizeTimezone(input.timezone);
  const ownerUserId = normalizeOwner(input.ownerUserId);
  const id = randomUUID();
  try {
    getStmts().insertDeploymentEnvSchedule.run({
      id,
      project_id: input.projectId,
      environment_name: environmentName,
      ref,
      cron: cronExpr,
      timezone,
      owner_user_id: ownerUserId,
      enabled: input.enabled === false ? 0 : 1,
      meta: serializeMeta(input.meta),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new DeployScheduleError(
        'duplicate',
        `A schedule for ref "${ref}" with cron "${cronExpr}" already exists on this environment.`,
      );
    }
    throw err;
  }
  return getSchedule(input.projectId, id) as DeploymentEnvironmentScheduleRow;
}

/**
 * Partial update of a schedule scoped by (project, id). Omitted fields keep their
 * current value, so flipping `enabled` never clobbers the cron and vice versa.
 * `owner_user_id` is not editable — a schedule stays with its creator's identity.
 * Returns null when the schedule does not exist. Throws `duplicate` when the edit
 * collides with another schedule's (ref, cron).
 *
 * read → write → re-read is effectively atomic per process: better-sqlite3 is
 * synchronous, so no `await` interleaves the calls on the event loop.
 */
export function updateSchedule(
  projectId: string,
  scheduleId: string,
  input: UpdateScheduleInput,
): DeploymentEnvironmentScheduleRow | null {
  const current = getSchedule(projectId, scheduleId);
  if (!current) return null;

  const ref = input.ref === undefined ? current.ref : normalizeRef(input.ref);
  const cronExpr = input.cron === undefined ? current.cron : normalizeCron(input.cron);
  const timezone =
    input.timezone === undefined ? current.timezone : normalizeTimezone(input.timezone);
  const enabled = input.enabled === undefined ? current.enabled === 1 : input.enabled === true;
  const meta =
    input.meta === undefined
      ? current.meta
      : input.meta === null
        ? null
        : JSON.stringify(input.meta);

  try {
    getStmts().updateDeploymentEnvSchedule.run({
      id: scheduleId,
      project_id: projectId,
      ref,
      cron: cronExpr,
      timezone,
      enabled: enabled ? 1 : 0,
      meta,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new DeployScheduleError(
        'duplicate',
        `A schedule for ref "${ref}" with cron "${cronExpr}" already exists on this environment.`,
      );
    }
    throw err;
  }
  return getSchedule(projectId, scheduleId);
}

/** Delete a schedule scoped by (project, id). Returns true if a row was removed. */
export function deleteSchedule(projectId: string, scheduleId: string): boolean {
  return getStmts().deleteDeploymentEnvSchedule.run(projectId, scheduleId).changes > 0;
}
