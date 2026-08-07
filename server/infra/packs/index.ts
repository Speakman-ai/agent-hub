/**
 * The service pack registry.
 *
 * Adding a service is adding one entry here and one file next to this one. The
 * collector, the cost projection and the Metrics tab all read through this
 * registry, so a pack becomes collectable, priced and explained in the same
 * commit that declares it.
 */

import { EC2_PACK } from './ec2.js';
import { ECS_PACK } from './ecs.js';
import type { InfraPackMetric, InfraServicePack } from './types.js';

export * from './types.js';
export { EC2_PACK } from './ec2.js';
export { ECS_PACK, ECS_CONTAINER_INSIGHTS_FEATURE } from './ecs.js';

/** Service token → pack. */
export const INFRA_SERVICE_PACKS: Readonly<Record<string, InfraServicePack>> = Object.freeze({
  [EC2_PACK.service]: EC2_PACK,
  [ECS_PACK.service]: ECS_PACK,
});

/** The pack for a service, or `null` when the service has none yet. */
export function getInfraServicePack(service: string): InfraServicePack | null {
  return INFRA_SERVICE_PACKS[service] ?? null;
}

/** Every service token that has a pack, sorted. */
export function infraPackedServices(): string[] {
  return Object.keys(INFRA_SERVICE_PACKS).sort();
}

/**
 * A metric's series identity as one string, for logs and error messages.
 * Not a storage key — `infra_metric_store.ts` owns that.
 */
export function describeInfraPackMetric(metric: InfraPackMetric): string {
  // The dimension set is part of the identity, not decoration: `AWS/ECS`
  // `CPUUtilization` exists at `ClusterName` and at `ClusterName` +
  // `ServiceName`, and a log line naming only the metric and statistic cannot
  // tell an operator which of the two it is talking about.
  return `${metric.namespace}/${metric.metricName} (${metric.stat}) by ${metric.dimensions.join('+')}`;
}
