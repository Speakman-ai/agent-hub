/**
 * Store for per-environment NOTIFICATION ROUTING (multi-environment management —
 * the notification-routing phase). DDL in
 * `deployment-notification-routing-schema.ts`, prepared statements in `db.ts`.
 *
 * Locked epic decision `notification-routing`:
 *   Per-(project, environment) config selects which release notification types
 *   (`ticket_release`, `release_digest`) fire when a deployment to that
 *   environment succeeds, and (via the resolved defaults) which recipient set is
 *   used. Production defaults to reporter + digest; non-prod sends nothing until
 *   enabled. Idempotency keys already carry `deployment_id`, so per-env routing
 *   never double-sends.
 *
 * A missing config row means "default": the default is derived from the
 * environment NAME (prod → both types on, non-prod → both off) rather than
 * persisted, so the existing prod-only notification behaviour is unchanged until
 * an operator explicitly opts a specific environment in or out. That resolution
 * is {@link resolveNotificationRouting} — the single place the "prod default =
 * reporter + digest, non-prod = nothing" rule lives, consumed by the release
 * notification enqueue path.
 */
import { randomUUID } from 'node:crypto';
import { getStmts } from '../db.js';
import type { DeploymentEnvironmentNotificationRoutingRow } from '../types.js';

export interface UpsertNotificationRoutingInput {
  projectId: string;
  environmentName: string;
  /** Fire the ticket_release (reporter) notification. Preserved when omitted on update. */
  ticketReleaseEnabled?: boolean;
  /** Fire the release_digest notification. Preserved when omitted on update. */
  releaseDigestEnabled?: boolean;
  /** Free-form metadata serialized to JSON. `null` clears it; omitted preserves it on update. */
  meta?: unknown;
}

/** A per-environment notification routing decision resolved against the env-name defaults. */
export interface ResolvedNotificationRouting {
  environmentName: string;
  /** True when the environment name is prod/production (drives the default routing). */
  isProduction: boolean;
  /** Whether the ticket_release (reporter) notification fires. */
  ticketReleaseEnabled: boolean;
  /** Whether the release_digest notification fires. */
  releaseDigestEnabled: boolean;
  /** True when no config row exists and the env-name default is in effect. */
  isDefault: boolean;
  /** The stored config row, or null when the environment has no operator routing yet. */
  config: DeploymentEnvironmentNotificationRoutingRow | null;
}

/** Whether an environment name is production (prod/production, case-insensitive). */
export function isProductionEnvironmentName(environmentName: string): boolean {
  const normalized = environmentName.trim().toLowerCase();
  return normalized === 'prod' || normalized === 'production';
}

export function getNotificationRouting(
  projectId: string,
  environmentName: string,
): DeploymentEnvironmentNotificationRoutingRow | null {
  return (
    (getStmts().getDeploymentEnvNotificationRouting.get(projectId, environmentName.trim()) as
      | DeploymentEnvironmentNotificationRoutingRow
      | undefined) ?? null
  );
}

export function listNotificationRouting(
  projectId: string,
): DeploymentEnvironmentNotificationRoutingRow[] {
  return getStmts().listDeploymentEnvNotificationRouting.all(
    projectId,
  ) as DeploymentEnvironmentNotificationRoutingRow[];
}

/**
 * Create or update an environment's notification routing. Partial-update
 * semantics: fields omitted on an existing row keep their current value (so
 * flipping `ticketReleaseEnabled` never clobbers `releaseDigestEnabled` or
 * `meta`, and vice versa). A NEW row seeds its per-type switches from the
 * env-name default (prod → both on, non-prod → both off) so an operator can
 * flip a single type without silently disabling the other on a prod env.
 */
export function upsertNotificationRouting(
  input: UpsertNotificationRoutingInput,
): DeploymentEnvironmentNotificationRoutingRow {
  // Normalize the key ONCE at the write boundary so every read path queries with
  // the same trimmed name (see the sibling env-config store for the rationale).
  const environmentName = input.environmentName.trim();
  // read → write → re-read. Effectively atomic per process: better-sqlite3 is
  // synchronous, so no `await` interleaves the three calls on the event loop.
  const existing = getNotificationRouting(input.projectId, environmentName);
  const isProd = isProductionEnvironmentName(environmentName);
  const ticketReleaseEnabled =
    input.ticketReleaseEnabled ?? (existing ? existing.ticket_release_enabled === 1 : isProd);
  const releaseDigestEnabled =
    input.releaseDigestEnabled ?? (existing ? existing.release_digest_enabled === 1 : isProd);
  const meta =
    input.meta === undefined
      ? (existing?.meta ?? null)
      : input.meta === null
        ? null
        : JSON.stringify(input.meta);

  getStmts().upsertDeploymentEnvNotificationRouting.run({
    id: existing?.id ?? randomUUID(),
    project_id: input.projectId,
    environment_name: environmentName,
    ticket_release_enabled: ticketReleaseEnabled ? 1 : 0,
    release_digest_enabled: releaseDigestEnabled ? 1 : 0,
    meta,
  });
  return getNotificationRouting(
    input.projectId,
    environmentName,
  ) as DeploymentEnvironmentNotificationRoutingRow;
}

/** Delete an environment's notification routing row. Returns true if a row was removed. */
export function deleteNotificationRouting(projectId: string, environmentName: string): boolean {
  return (
    getStmts().deleteDeploymentEnvNotificationRouting.run(projectId, environmentName.trim())
      .changes > 0
  );
}

/**
 * Resolve which release notification types fire for a successful deployment to an
 * environment. A stored row wins; otherwise the default is derived from the
 * environment NAME:
 *
 *   - prod / production → ticket_release + release_digest both fire (unchanged
 *     from the pre-routing behaviour).
 *   - any other name    → nothing fires until an operator enables it.
 *
 * This is the single place that rule is applied; the release notification
 * enqueue path calls it instead of hard-coding a prod-only gate.
 */
export function resolveNotificationRouting(
  projectId: string,
  environmentName: string,
): ResolvedNotificationRouting {
  const name = environmentName.trim();
  const isProduction = isProductionEnvironmentName(name);
  const config = getNotificationRouting(projectId, name);
  if (config) {
    return {
      environmentName: name,
      isProduction,
      ticketReleaseEnabled: config.ticket_release_enabled === 1,
      releaseDigestEnabled: config.release_digest_enabled === 1,
      isDefault: false,
      config,
    };
  }
  return {
    environmentName: name,
    isProduction,
    ticketReleaseEnabled: isProduction,
    releaseDigestEnabled: isProduction,
    isDefault: true,
    config: null,
  };
}
