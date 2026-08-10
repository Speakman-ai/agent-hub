/**
 * Classifying an AWS resource's lifecycle state, shared by every surface that
 * renders one.
 *
 * `infra_resources.state` is stored verbatim from whichever describe call found
 * the resource (`inventory-sync.ts`), and AWS does not agree with itself about
 * how to spell "this is fine":
 *
 *   - EC2 `Instance.State.Name` → `running` (lowercase)
 *   - RDS `DBInstanceStatus` and NAT `NatGateway.State` → `available` (lowercase)
 *   - ELBv2 `LoadBalancer.State.Code` → `active` (lowercase)
 *   - **ECS `Cluster.status` / `Service.status` → `ACTIVE` (UPPERCASE)**
 *   - **Lambda `FunctionConfiguration.State` → `Active` (TitleCase)**
 *
 * So a predicate written as `state === 'running' || state === 'available'`
 * reports every healthy ECS cluster, ECS service, load balancer and Lambda as
 * abnormal, and one written as `=== 'active'` still misses ECS and Lambda on
 * casing alone. Comparison here is case-insensitive, matching
 * `INFRA_TERMINAL_RESOURCE_STATES` in `infra-schema.ts`, which already had to
 * solve the same problem for the collector.
 *
 * The third bucket is the load-bearing one. RDS publishes **no enum** for
 * `DBInstanceStatus` — the API reference only says "the current state of this
 * database" and links to a User Guide table that grows — so an unrecognised
 * value has to read as *unknown*, never as *broken*. A dashboard that flags
 * `storage-optimization` as a fault trains operators to ignore its warnings,
 * which costs more than the warning was ever worth.
 */

/** What a state means to an operator, which is all any UI here needs. */
export type InfraResourceHealth = 'healthy' | 'unhealthy' | 'unknown';

/**
 * States meaning "operating normally", lowercased.
 *
 * `active` covers ECS, ELBv2 and Lambda at once precisely because the compare
 * is case-insensitive. The RDS entries after the first three are states where
 * the instance is busy but still serving traffic — AWS documents `backing-up`,
 * `storage-optimization` and `storage-initialization` as online — and calling
 * a nightly backup window a fault would be a false alarm every single night.
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
 * Prefixes for the open-ended RDS families, where AWS enumerates several
 * variants of one condition (`incompatible-network`, `incompatible-parameters`,
 * `inaccessible-encryption-credentials-recoverable`, …) and adds more over
 * time. Matching the family keeps a newly-introduced variant classified.
 */
const UNHEALTHY_PREFIXES: readonly string[] = Object.freeze([
  'incompatible-',
  'inaccessible-encryption-credentials',
]);

/**
 * How a stored lifecycle state should read to an operator.
 *
 * `unknown` for a null/blank state as well as an unrecognised one: plenty of
 * rows legitimately carry no state at all (S3 buckets, ELBv2 target groups),
 * and absence of a lifecycle is not a fault.
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
