/**
 * Store for per-environment RUNTIME config (multi-environment management,
 * Phase 5). DDL in `deployment-env-config-schema.ts`, prepared statements in
 * `db.ts`.
 *
 * Locked epic decision `environments-config`:
 *   - `.agent-hub/deploy.yaml` (parsed by the UNCHANGED `deploy-config.ts`) is
 *     the source of truth for WHICH environments exist.
 *   - This store owns the operator-editable, no-commit-needed runtime config
 *     keyed by (project_id, environment_name): enable/disable at this phase; the
 *     triggers / scheduling / notification-routing phases add their own tables
 *     on top of the same key.
 *   - A config row whose environment is absent from the current deploy.yaml is
 *     surfaced as INACTIVE and NOT deployable (never silently deployed, never
 *     silently dropped). That resolution is {@link resolveEnvironmentConfigs}.
 *
 * A missing config row means "default" (enabled), so existing manual-deploy
 * behaviour is unchanged until an operator explicitly pauses an environment.
 */
import { randomUUID } from 'node:crypto';
import { getStmts } from '../db.js';
import type { DeploymentEnvironmentRuntimeConfigRow } from '../types.js';

export interface UpsertEnvironmentConfigInput {
  projectId: string;
  environmentName: string;
  /** Operator on/off switch. Defaults to true for a new row; preserved when omitted on update. */
  enabled?: boolean;
  /** Free-form metadata serialized to JSON. `null` clears it; omitted preserves it on update. */
  meta?: unknown;
}

/** True when the environment's automation is enabled (a missing row defaults to enabled). */
export function isEnvironmentEnabled(row: DeploymentEnvironmentRuntimeConfigRow | null): boolean {
  return row ? row.enabled === 1 : true;
}

export function getEnvironmentConfig(
  projectId: string,
  environmentName: string,
): DeploymentEnvironmentRuntimeConfigRow | null {
  return (
    (getStmts().getDeploymentEnvRuntimeConfig.get(projectId, environmentName.trim()) as
      | DeploymentEnvironmentRuntimeConfigRow
      | undefined) ?? null
  );
}

export function listEnvironmentConfigs(projectId: string): DeploymentEnvironmentRuntimeConfigRow[] {
  return getStmts().listDeploymentEnvRuntimeConfig.all(
    projectId,
  ) as DeploymentEnvironmentRuntimeConfigRow[];
}

/**
 * Create or update an environment's runtime config. Partial-update semantics:
 * fields omitted on an existing row keep their current value (so flipping
 * `enabled` never clobbers `meta`, and vice versa). A new row defaults to
 * enabled with no meta.
 */
export function upsertEnvironmentConfig(
  input: UpsertEnvironmentConfigInput,
): DeploymentEnvironmentRuntimeConfigRow {
  // Normalize the key ONCE at the write boundary so the stored row uses the same
  // trimmed name every read path (`getEnvironmentConfig`, `resolveEnvironmentConfigs`,
  // `isEnvironmentDeployable`) queries with. Writing a padded name verbatim would
  // strand the row: a trimmed lookup would miss it and a paused env could resolve
  // as deployable. This store is the boundary Phase 6/7/8 callers build on.
  const environmentName = input.environmentName.trim();
  // read → write → re-read. This is effectively atomic per process because
  // better-sqlite3 is SYNCHRONOUS: no `await` interleaves the three calls on the
  // event loop. If this store is ever moved to an async DB driver, wrap the body
  // in a transaction to preserve the partial-update read-modify-write invariant.
  const existing = getEnvironmentConfig(input.projectId, environmentName);
  const enabled = input.enabled ?? (existing ? existing.enabled === 1 : true);
  const meta =
    input.meta === undefined
      ? (existing?.meta ?? null)
      : input.meta === null
        ? null
        : JSON.stringify(input.meta);

  getStmts().upsertDeploymentEnvRuntimeConfig.run({
    id: existing?.id ?? randomUUID(),
    project_id: input.projectId,
    environment_name: environmentName,
    enabled: enabled ? 1 : 0,
    meta,
  });
  return getEnvironmentConfig(
    input.projectId,
    environmentName,
  ) as DeploymentEnvironmentRuntimeConfigRow;
}

/** Convenience: flip only the enable/disable switch, preserving meta. */
export function setEnvironmentEnabled(
  projectId: string,
  environmentName: string,
  enabled: boolean,
): DeploymentEnvironmentRuntimeConfigRow {
  return upsertEnvironmentConfig({ projectId, environmentName, enabled });
}

/** Delete an environment's runtime config row. Returns true if a row was removed. */
export function deleteEnvironmentConfig(projectId: string, environmentName: string): boolean {
  return (
    getStmts().deleteDeploymentEnvRuntimeConfig.run(projectId, environmentName.trim()).changes > 0
  );
}

/** A per-environment config resolved against the current deploy.yaml environment set. */
export interface ResolvedEnvironmentConfig {
  environmentName: string;
  /** Declared in the current deploy.yaml. Config for a removed environment is inactive. */
  active: boolean;
  /** Operator enable/disable (a missing config row defaults to enabled). */
  enabled: boolean;
  /** Deployable only when the environment is BOTH active (declared) AND enabled. */
  deployable: boolean;
  /** The stored config row, or null when the environment has no operator config yet. */
  config: DeploymentEnvironmentRuntimeConfigRow | null;
}

function normalizeNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map((n) => n.trim()).filter(Boolean))];
}

/**
 * Merge the config rows for a project with the environment names declared in the
 * current deploy.yaml (pass `config.environments.keys()` — this store never
 * calls the parser, keeping `deploy-config.ts` unchanged) into a resolved view:
 *
 *   - declared + config row   → active,   enabled per row,   deployable = enabled
 *   - declared + no config    → active,   enabled (default), deployable = true
 *   - config row + not declared → INACTIVE, enabled per row, deployable = FALSE
 *
 * Sorted by environment name. This is the single place the "absent from
 * deploy.yaml ⇒ inactive, not deployable" rule is applied.
 */
export function resolveEnvironmentConfigs(
  projectId: string,
  declaredEnvironmentNames: Iterable<string>,
): ResolvedEnvironmentConfig[] {
  const declared = new Set(normalizeNames(declaredEnvironmentNames));
  const rows = listEnvironmentConfigs(projectId);
  const byName = new Map(rows.map((r) => [r.environment_name, r]));

  const allNames = new Set<string>([...declared, ...byName.keys()]);
  const resolved: ResolvedEnvironmentConfig[] = [];
  for (const environmentName of allNames) {
    const config = byName.get(environmentName) ?? null;
    const active = declared.has(environmentName);
    const enabled = isEnvironmentEnabled(config);
    resolved.push({
      environmentName,
      active,
      enabled,
      deployable: active && enabled,
      config,
    });
  }
  resolved.sort((a, b) => a.environmentName.localeCompare(b.environmentName));
  return resolved;
}

/**
 * Whether a specific environment is deployable right now: declared in the
 * current deploy.yaml AND not paused by the operator. Absent-from-deploy.yaml is
 * never deployable regardless of any stale config row.
 */
export function isEnvironmentDeployable(
  projectId: string,
  environmentName: string,
  declaredEnvironmentNames: Iterable<string>,
): boolean {
  // Trim once so the declared-set membership check and the config-row lookup
  // agree on the key — a padded name must not match the declared set while
  // missing its stored config row (which would silently fall back to enabled).
  const name = environmentName.trim();
  const declared = new Set(normalizeNames(declaredEnvironmentNames));
  if (!declared.has(name)) return false;
  return isEnvironmentEnabled(getEnvironmentConfig(projectId, name));
}
