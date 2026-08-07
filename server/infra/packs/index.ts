/**
 * The service pack registry.
 *
 * Adding a service is adding one entry here and one file next to this one. The
 * collector, the cost projection and the Metrics tab all read through this
 * registry, so a pack becomes collectable, priced and explained in the same
 * commit that declares it.
 */

import { ALB_PACK } from './alb.js';
import { EC2_PACK } from './ec2.js';
import { ECS_PACK } from './ecs.js';
import { LAMBDA_PACK } from './lambda.js';
import { NATGW_PACK } from './natgw.js';
import { NLB_PACK } from './nlb.js';
import { RDS_PACK } from './rds.js';
import { S3_PACK } from './s3.js';
import type { InfraPackMetric, InfraServicePack } from './types.js';

export * from './types.js';
export { ALB_PACK } from './alb.js';
export { EC2_PACK } from './ec2.js';
export { ECS_PACK, ECS_CONTAINER_INSIGHTS_FEATURE } from './ecs.js';
export { LAMBDA_PACK } from './lambda.js';
export { NATGW_PACK } from './natgw.js';
export { NLB_PACK } from './nlb.js';
export { RDS_PACK } from './rds.js';
export { S3_PACK, S3_REQUEST_METRICS_FEATURE, S3_ALL_STORAGE_TYPES } from './s3.js';

/**
 * Service token → pack.
 *
 * ALB and NLB are two services rather than one `elbv2` because CloudWatch treats
 * them as two: different namespaces, and a `LoadBalancer` dimension whose *name*
 * is identical on both. A single token would make the collector request every
 * `AWS/ApplicationELB` metric against each Network Load Balancer and vice versa,
 * and every one of those is a billed `GetMetricData` entry returning an empty
 * series.
 */
export const INFRA_SERVICE_PACKS: Readonly<Record<string, InfraServicePack>> = Object.freeze({
  [EC2_PACK.service]: EC2_PACK,
  [ECS_PACK.service]: ECS_PACK,
  [ALB_PACK.service]: ALB_PACK,
  [NLB_PACK.service]: NLB_PACK,
  [NATGW_PACK.service]: NATGW_PACK,
  [S3_PACK.service]: S3_PACK,
  [RDS_PACK.service]: RDS_PACK,
  [LAMBDA_PACK.service]: LAMBDA_PACK,
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
