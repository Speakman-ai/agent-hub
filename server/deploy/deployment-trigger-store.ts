/**
 * Store for per-environment DEPLOY TRIGGERS (multi-environment management — the
 * triggers phase). DDL in `deployment-trigger-schema.ts`, prepared statements in
 * `db.ts`.
 *
 * Locked epic decision `deploy-triggers`:
 *   Trigger = DB row `{environment, event(push|merge), branch pattern, enabled}`.
 *   Evaluated in the same `onPush` (smart-HTTP) + native-PR `afterMerge` hooks
 *   the security-audit push scan uses. A matching branch update enqueues a
 *   deployment (trigger=push) for the mapped environment, honoring the per-env
 *   concurrency lock; failures logged/swallowed. No deploy.yaml trigger block.
 *
 * This module owns the STORE + CRUD only. The hook path is a sibling card that
 * calls {@link findMatchingTriggers} to resolve which environments a branch
 * update should deploy.
 */
import { randomUUID } from 'node:crypto';
import { getStmts } from '../db.js';
import type { DeploymentEnvironmentTriggerRow } from '../types.js';

export type DeployTriggerEvent = 'push' | 'merge';

export const DEPLOY_TRIGGER_EVENTS: readonly DeployTriggerEvent[] = ['push', 'merge'];
export const DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH = 200;

export class DeployTriggerError extends Error {
  constructor(
    public reason: 'not_found' | 'duplicate' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DeployTriggerError';
  }
}

export interface CreateTriggerInput {
  projectId: string;
  environmentName: string;
  event: DeployTriggerEvent;
  branchPattern: string;
  /** Defaults to true for a new trigger. */
  enabled?: boolean;
  /** Free-form metadata serialized to JSON. */
  meta?: unknown;
}

export interface UpdateTriggerInput {
  /** Omitted fields keep their current value (partial update). */
  event?: DeployTriggerEvent;
  branchPattern?: string;
  enabled?: boolean;
  /** `null` clears meta; `undefined` preserves it. */
  meta?: unknown;
}

function normalizeBranchPattern(raw: string): string {
  const pattern = raw.trim();
  if (!pattern) {
    throw new DeployTriggerError('invalid', 'branchPattern is required.');
  }
  if (pattern.length > DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH) {
    throw new DeployTriggerError(
      'invalid',
      `branchPattern must be ${DEPLOY_TRIGGER_BRANCH_PATTERN_MAX_LENGTH} characters or fewer.`,
    );
  }
  return pattern;
}

function normalizeEvent(raw: string): DeployTriggerEvent {
  if (raw !== 'push' && raw !== 'merge') {
    throw new DeployTriggerError(
      'invalid',
      `event must be one of: ${DEPLOY_TRIGGER_EVENTS.join(', ')}.`,
    );
  }
  return raw;
}

function serializeMeta(meta: unknown): string | null {
  if (meta === undefined || meta === null) return null;
  return JSON.stringify(meta);
}

/**
 * Match a branch name against a trigger's glob pattern. Semantics:
 *   - `*`  matches any run of characters WITHIN a path segment (no `/`).
 *   - `**` matches any run of characters ACROSS segments (including `/`).
 *   - all other characters are literal (regex specials are escaped).
 * The match is anchored (full-string). Both sides are trimmed; an empty pattern
 * or empty branch never matches. A leading `refs/heads/` on the branch is
 * stripped so callers can pass either the ref or the short branch name.
 */
export function branchMatchesPattern(pattern: string, branch: string): boolean {
  const p = pattern.trim();
  let b = branch.trim();
  if (!p || !b) return false;
  if (b.startsWith('refs/heads/')) b = b.slice('refs/heads/'.length);

  let regex = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        regex += '.*';
        i++;
      } else {
        regex += '[^/]*';
      }
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${regex}$`).test(b);
}

export function getTrigger(
  projectId: string,
  triggerId: string,
): DeploymentEnvironmentTriggerRow | null {
  return (
    (getStmts().getDeploymentEnvTrigger.get(projectId, triggerId) as
      | DeploymentEnvironmentTriggerRow
      | undefined) ?? null
  );
}

export function listTriggersForProject(projectId: string): DeploymentEnvironmentTriggerRow[] {
  return getStmts().listDeploymentEnvTriggersForProject.all(
    projectId,
  ) as DeploymentEnvironmentTriggerRow[];
}

export function listTriggersForEnvironment(
  projectId: string,
  environmentName: string,
): DeploymentEnvironmentTriggerRow[] {
  return getStmts().listDeploymentEnvTriggersForEnvironment.all(
    projectId,
    environmentName.trim(),
  ) as DeploymentEnvironmentTriggerRow[];
}

export function createTrigger(input: CreateTriggerInput): DeploymentEnvironmentTriggerRow {
  const environmentName = input.environmentName.trim();
  if (!environmentName) {
    throw new DeployTriggerError('invalid', 'environmentName is required.');
  }
  const event = normalizeEvent(input.event);
  const branchPattern = normalizeBranchPattern(input.branchPattern);
  const id = randomUUID();
  try {
    getStmts().insertDeploymentEnvTrigger.run({
      id,
      project_id: input.projectId,
      environment_name: environmentName,
      event,
      branch_pattern: branchPattern,
      enabled: input.enabled === false ? 0 : 1,
      meta: serializeMeta(input.meta),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new DeployTriggerError(
        'duplicate',
        `A ${event} trigger for branch pattern "${branchPattern}" already exists on this environment.`,
      );
    }
    throw err;
  }
  return getTrigger(input.projectId, id) as DeploymentEnvironmentTriggerRow;
}

/**
 * Partial update of a trigger scoped by (project, id). Omitted fields keep their
 * current value, so flipping `enabled` never clobbers the pattern and vice
 * versa. Returns null when the trigger does not exist. Throws `duplicate` when
 * the edit collides with another trigger's (event, pattern).
 *
 * read → write → re-read is effectively atomic per process: better-sqlite3 is
 * synchronous, so no `await` interleaves the calls on the event loop.
 */
export function updateTrigger(
  projectId: string,
  triggerId: string,
  input: UpdateTriggerInput,
): DeploymentEnvironmentTriggerRow | null {
  const current = getTrigger(projectId, triggerId);
  if (!current) return null;

  const event = input.event === undefined ? current.event : normalizeEvent(input.event);
  const branchPattern =
    input.branchPattern === undefined
      ? current.branch_pattern
      : normalizeBranchPattern(input.branchPattern);
  const enabled = input.enabled === undefined ? current.enabled === 1 : input.enabled === true;
  const meta =
    input.meta === undefined
      ? current.meta
      : input.meta === null
        ? null
        : JSON.stringify(input.meta);

  try {
    getStmts().updateDeploymentEnvTrigger.run({
      id: triggerId,
      project_id: projectId,
      event,
      branch_pattern: branchPattern,
      enabled: enabled ? 1 : 0,
      meta,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new DeployTriggerError(
        'duplicate',
        `A ${event} trigger for branch pattern "${branchPattern}" already exists on this environment.`,
      );
    }
    throw err;
  }
  return getTrigger(projectId, triggerId);
}

/** Delete a trigger scoped by (project, id). Returns true if a row was removed. */
export function deleteTrigger(projectId: string, triggerId: string): boolean {
  return getStmts().deleteDeploymentEnvTrigger.run(projectId, triggerId).changes > 0;
}

/**
 * Resolve which enabled triggers a branch update fires for a git event. Returns
 * the matching trigger rows (any environment); the hook path maps these to
 * environments and enqueues deployments, honoring the per-env concurrency lock
 * and the deploy.yaml deployability resolution. Purely reads the store — it does
 * NOT consult deploy.yaml, so a trigger for a removed environment is returned
 * here and filtered by the caller.
 */
export function findMatchingTriggers(
  projectId: string,
  event: DeployTriggerEvent,
  branch: string,
): DeploymentEnvironmentTriggerRow[] {
  const rows = getStmts().listEnabledDeploymentEnvTriggersForEvent.all(
    projectId,
    event,
  ) as DeploymentEnvironmentTriggerRow[];
  return rows.filter((row) => branchMatchesPattern(row.branch_pattern, branch));
}
