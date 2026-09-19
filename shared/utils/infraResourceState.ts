/**
 * AWS resource lifecycle health. Compare case-insensitively (`running` /
 * `available` / `ACTIVE` / `Active`). Unrecognised values are unknown, never
 * unhealthy (RDS has no closed enum).
 */

/** What a state means to an operator, which is all any UI here needs. */
export type InfraResourceHealth = 'healthy' | 'unhealthy' | 'unknown';

/**
 * Healthy states, lowercased. `backing-up` / `storage-optimization` /
 * `storage-initialization` still serve traffic.
 */
const HEALTHY_STATES: ReadonlySet<string> = new Set([
  'running',
  'available',
  'active',
  'backing-up',
  'storage-optimization',
  'storage-initialization',
]);

/**
 * States meaning "not serving, or serving degraded", lowercased.
 *
 * Enumerated rather than inferred as "not healthy", so a state nobody has
 * classified yet lands in `unknown`. `active_impaired` is here on AWS's own
 * description: an ELBv2 in it routes traffic but cannot scale, which is worth
 * surfacing even though the word "active" is in it — and it is also why the
 * healthy check is an exact-set membership rather than a substring test.
 */
const UNHEALTHY_STATES: ReadonlySet<string> = new Set([
  // EC2
  'stopped',
  'stopping',
  'shutting-down',
  'terminated',
  // ECS ('INACTIVE' is ECS's "deleted"), Lambda
  'inactive',
  'draining',
  'deactivating',
  'deactivated',
  // ELBv2
  'active_impaired',
  // NAT gateway, generic
  'deleting',
  'deleted',
  'failed',
  // RDS
  'restore-error',
  'upgrade-failed',
  'storage-full',
  'insufficient-capacity',
]);

/**
 * RDS open-ended families (`incompatible-*`, `inaccessible-encryption-credentials*`).
 */
const UNHEALTHY_PREFIXES: readonly string[] = Object.freeze([
  'incompatible-',
  'inaccessible-encryption-credentials',
]);

/**
 * Operator-facing health. Null/blank/`unknown` is not a fault (S3 buckets, etc.).
 */
export function infraResourceHealth(state: string | null | undefined): InfraResourceHealth {
  const normalized = state?.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (HEALTHY_STATES.has(normalized)) return 'healthy';
  if (UNHEALTHY_STATES.has(normalized)) return 'unhealthy';
  if (UNHEALTHY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 'unhealthy';
  return 'unknown';
}

/** True only for states positively known to be fine. */
export function isInfraResourceHealthy(state: string | null | undefined): boolean {
  return infraResourceHealth(state) === 'healthy';
}
