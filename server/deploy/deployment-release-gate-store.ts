/**
 * Store for per-environment RELEASE GATES (multi-environment management — the
 * release-gate phase). DDL in `deployment-release-gate-schema.ts`, prepared
 * statements in `db.ts`.
 *
 * A release gate is a ONE-SHOT automated deploy: it fires a single deployment
 * once its curated set of sessions AND/OR epics are all complete, then is
 * consumed (`status` flips `armed` → `fired`; an enqueue failure flips it to
 * `failed`). A gate remains until it is deleted or released.
 *
 * This module owns the STORE + CRUD only. The evaluation + firing sweep is the
 * sibling `release-gate-ticker.ts`, which reads {@link listActiveReleaseGates}
 * and calls the `markReleaseGate*` helpers.
 */
import { randomUUID } from 'node:crypto';
import { getStmts } from '../db.js';
import type { DeploymentEnvironmentReleaseGateRow } from '../types.js';

export const RELEASE_GATE_REF_MAX_LENGTH = 255;
/** Upper bound on how many sessions/epics a single gate can watch. */
export const RELEASE_GATE_MAX_SELECTIONS = 100;
/** Deploy ref used when the operator does not specify one. */
export const RELEASE_GATE_DEFAULT_REF = 'main';

export class DeployReleaseGateError extends Error {
  constructor(
    public reason: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DeployReleaseGateError';
  }
}

export interface CreateReleaseGateInput {
  projectId: string;
  environmentName: string;
  /** Deploy ref; defaults to {@link RELEASE_GATE_DEFAULT_REF} when omitted/blank. */
  ref?: string | null;
  /** Session ids that must be merged before the gate fires. */
  sessionIds?: string[];
  /** Epic ids that must be done before the gate fires. */
  epicIds?: string[];
  /** Identity the fired deployment spawns under; null = system-owned. */
  ownerUserId?: string | null;
  /** Defaults to true for a new gate. */
  enabled?: boolean;
  /** Free-form metadata serialized to JSON. */
  meta?: unknown;
}

export interface UpdateReleaseGateInput {
  /** Omitted fields keep their current value (partial update). */
  ref?: string | null;
  sessionIds?: string[];
  epicIds?: string[];
  enabled?: boolean;
  /** `null` clears meta; `undefined` preserves it. */
  meta?: unknown;
}

function normalizeRef(raw: string | null | undefined): string {
  const ref = (raw ?? '').trim() || RELEASE_GATE_DEFAULT_REF;
  if (ref.length > RELEASE_GATE_REF_MAX_LENGTH) {
    throw new DeployReleaseGateError(
      'invalid',
      `ref must be ${RELEASE_GATE_REF_MAX_LENGTH} characters or fewer.`,
    );
  }
  return ref;
}

/** Trim, drop blanks, de-duplicate (order-preserving), and bound the count. */
function normalizeIdList(raw: string[] | undefined, label: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new DeployReleaseGateError('invalid', `${label} must be an array of ids.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new DeployReleaseGateError('invalid', `${label} must contain only string ids.`);
    }
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > RELEASE_GATE_MAX_SELECTIONS) {
    throw new DeployReleaseGateError(
      'invalid',
      `${label} may not exceed ${RELEASE_GATE_MAX_SELECTIONS} entries.`,
    );
  }
  return out;
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

/** Parse a gate row's `session_ids` JSON column into a string array. */
export function parseGateSessionIds(row: DeploymentEnvironmentReleaseGateRow): string[] {
  return parseIdColumn(row.session_ids);
}

/** Parse a gate row's `epic_ids` JSON column into a string array. */
export function parseGateEpicIds(row: DeploymentEnvironmentReleaseGateRow): string[] {
  return parseIdColumn(row.epic_ids);
}

function parseIdColumn(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function getReleaseGate(
  projectId: string,
  gateId: string,
): DeploymentEnvironmentReleaseGateRow | null {
  return (
    (getStmts().getDeploymentEnvReleaseGate.get(projectId, gateId) as
      | DeploymentEnvironmentReleaseGateRow
      | undefined) ?? null
  );
}

export function listReleaseGatesForProject(
  projectId: string,
): DeploymentEnvironmentReleaseGateRow[] {
  return getStmts().listDeploymentEnvReleaseGatesForProject.all(
    projectId,
  ) as DeploymentEnvironmentReleaseGateRow[];
}

export function listReleaseGatesForEnvironment(
  projectId: string,
  environmentName: string,
): DeploymentEnvironmentReleaseGateRow[] {
  return getStmts().listDeploymentEnvReleaseGatesForEnvironment.all(
    projectId,
    environmentName.trim(),
  ) as DeploymentEnvironmentReleaseGateRow[];
}

/**
 * Every armed + enabled gate across all projects. The evaluation sweep (sibling
 * card) reads this each tick; it does NOT consult deploy.yaml, so a gate for a
 * removed environment is returned here and filtered by the caller before
 * enqueuing.
 */
export function listActiveReleaseGates(): DeploymentEnvironmentReleaseGateRow[] {
  return getStmts().listActiveDeploymentEnvReleaseGates.all() as DeploymentEnvironmentReleaseGateRow[];
}

export function createReleaseGate(
  input: CreateReleaseGateInput,
): DeploymentEnvironmentReleaseGateRow {
  const environmentName = input.environmentName.trim();
  if (!environmentName) {
    throw new DeployReleaseGateError('invalid', 'environmentName is required.');
  }
  const ref = normalizeRef(input.ref);
  const sessionIds = normalizeIdList(input.sessionIds, 'sessionIds');
  const epicIds = normalizeIdList(input.epicIds, 'epicIds');
  if (sessionIds.length === 0 && epicIds.length === 0) {
    throw new DeployReleaseGateError(
      'invalid',
      'A release gate must watch at least one session or epic.',
    );
  }
  const ownerUserId = normalizeOwner(input.ownerUserId);
  const id = randomUUID();
  getStmts().insertDeploymentEnvReleaseGate.run({
    id,
    project_id: input.projectId,
    environment_name: environmentName,
    ref,
    session_ids: JSON.stringify(sessionIds),
    epic_ids: JSON.stringify(epicIds),
    owner_user_id: ownerUserId,
    status: 'armed',
    enabled: input.enabled === false ? 0 : 1,
    meta: serializeMeta(input.meta),
  });
  return getReleaseGate(input.projectId, id) as DeploymentEnvironmentReleaseGateRow;
}

/**
 * Partial update of a gate scoped by (project, id). Omitted fields keep their
 * current value. `status`, `owner_user_id`, and the terminal columns are NOT
 * editable here — a fired/failed gate is terminal (retry by delete + recreate).
 * Returns null when the gate does not exist. Throws `invalid` when the edit
 * would leave the gate watching nothing.
 */
export function updateReleaseGate(
  projectId: string,
  gateId: string,
  input: UpdateReleaseGateInput,
): DeploymentEnvironmentReleaseGateRow | null {
  const current = getReleaseGate(projectId, gateId);
  if (!current) return null;

  const ref = input.ref === undefined ? current.ref : normalizeRef(input.ref);
  const sessionIds =
    input.sessionIds === undefined
      ? parseGateSessionIds(current)
      : normalizeIdList(input.sessionIds, 'sessionIds');
  const epicIds =
    input.epicIds === undefined
      ? parseGateEpicIds(current)
      : normalizeIdList(input.epicIds, 'epicIds');
  if (sessionIds.length === 0 && epicIds.length === 0) {
    throw new DeployReleaseGateError(
      'invalid',
      'A release gate must watch at least one session or epic.',
    );
  }
  const enabled = input.enabled === undefined ? current.enabled === 1 : input.enabled === true;
  const meta =
    input.meta === undefined
      ? current.meta
      : input.meta === null
        ? null
        : JSON.stringify(input.meta);

  getStmts().updateDeploymentEnvReleaseGate.run({
    id: gateId,
    project_id: projectId,
    ref,
    session_ids: JSON.stringify(sessionIds),
    epic_ids: JSON.stringify(epicIds),
    enabled: enabled ? 1 : 0,
    meta,
  });
  return getReleaseGate(projectId, gateId);
}

/**
 * Flip an armed gate to `fired` with the deployment it enqueued. The `status =
 * 'armed'` guard in the statement makes this a compare-and-set: a gate already
 * resolved by a concurrent/overlapping tick is not clobbered. Returns true when
 * this call performed the transition.
 */
export function markReleaseGateFired(
  projectId: string,
  gateId: string,
  deploymentId: string,
): boolean {
  return (
    getStmts().markDeploymentEnvReleaseGateFired.run({
      id: gateId,
      project_id: projectId,
      fired_deployment_id: deploymentId,
    }).changes > 0
  );
}

/** Flip an armed gate to `failed` with the enqueue error. Compare-and-set (see above). */
export function markReleaseGateFailed(projectId: string, gateId: string, error: string): boolean {
  return (
    getStmts().markDeploymentEnvReleaseGateFailed.run({
      id: gateId,
      project_id: projectId,
      last_error: error.slice(0, 2000),
    }).changes > 0
  );
}

/** Delete a gate scoped by (project, id). Returns true if a row was removed. */
export function deleteReleaseGate(projectId: string, gateId: string): boolean {
  return getStmts().deleteDeploymentEnvReleaseGate.run(projectId, gateId).changes > 0;
}
