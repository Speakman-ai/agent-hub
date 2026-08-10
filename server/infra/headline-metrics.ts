/**
 * headline-metrics.ts — the two or three series per service that belong on a
 * dashboard, as opposed to the ~110 a service pack catalogs.
 *
 * A pack answers "what can be charted for this service". That is the right
 * question for a metric picker and the wrong one for an overview: an operator
 * opening Infrastructure wants to know whether the fleet is healthy, and
 * eleven EC2 series per instance is not an answer to that. This module is the
 * curated subset the fleet dashboard renders unprompted, so the common case
 * costs zero clicks.
 *
 * Refs declare only the *identity* of a series — namespace, metric name and the
 * exact dimension set. Statistic, metric type and the feature gate are resolved
 * from the pack at module load, deliberately rather than restated here: a
 * headline that names its own `stat` would be a second source of truth for what
 * the collector actually stored, and the first divergence would render an empty
 * chart with no way to tell it apart from a resource that stopped reporting. An
 * unresolvable ref throws on import, which turns a typo into a failed boot
 * instead of a silently missing tile.
 */

import { getInfraServicePack, type InfraMetricType, type InfraPackMetric } from './packs/index.js';

/**
 * How a value should be read, which decides how the client formats it.
 *
 * Not the same thing as {@link InfraMetricType}: that records what the number
 * *is* for aggregation purposes, this records what it *means* to a human.
 * `StatusCheckFailed` is a `flag` to the aggregator and a `count` on screen.
 */
export type InfraHeadlineUnit = 'percent' | 'bytes' | 'count' | 'seconds';

/** A declared headline series, before pack resolution. */
export interface InfraHeadlineMetricRef {
  service: string;
  namespace: string;
  metricName: string;
  /** Exact dimension-name set, matching the pack metric's own. */
  dimensions: readonly string[];
  /** Dashboard-width label. A tile is a few characters wide, not a sentence. */
  label: string;
  unit: InfraHeadlineUnit;
}

/** A headline series with everything the reader needs, resolved from the pack. */
export interface InfraHeadlineMetric extends InfraHeadlineMetricRef {
  stat: string;
  metricType: InfraMetricType;
  requiresFeature: string | null;
  /** The pack's operator-facing line, for the tile's tooltip. */
  description: string;
}

/**
 * Services the fleet dashboard covers.
 *
 * The three an operator names when asked what they want to see. The load
 * balancer, Lambda, NAT gateway and S3 packs all exist and are chartable
 * through the Metrics tab; they are absent here because a dashboard that shows
 * everything is the browser this is meant to replace. Adding one is adding refs
 * below and a token here.
 */
export const INFRA_FLEET_SERVICES: readonly string[] = Object.freeze(['ec2', 'ecs', 'rds']);

const EC2_INSTANCE = Object.freeze(['InstanceId']);
const ECS_CLUSTER = Object.freeze(['ClusterName']);
const ECS_SERVICE = Object.freeze(['ClusterName', 'ServiceName']);
const RDS_INSTANCE = Object.freeze(['DBInstanceIdentifier']);

/**
 * The declared headlines.
 *
 * ECS appears twice because a cluster row and a service row are different
 * resources measuring different things — `AWS/ECS` `CPUUtilization` exists at
 * both dimension sets and the two numbers are not comparable. The resolver
 * matches on the resource's own recorded dimensions, so a cluster tile never
 * renders a service's series.
 */
export const INFRA_HEADLINE_METRIC_REFS: readonly InfraHeadlineMetricRef[] = Object.freeze([
  // ── EC2 ───────────────────────────────────────────────────────────────────
  {
    service: 'ec2',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensions: EC2_INSTANCE,
    label: 'CPU',
    unit: 'percent',
  },
  {
    service: 'ec2',
    namespace: 'AWS/EC2',
    metricName: 'StatusCheckFailed',
    dimensions: EC2_INSTANCE,
    label: 'Status check',
    unit: 'count',
  },
  {
    service: 'ec2',
    namespace: 'AWS/EC2',
    metricName: 'NetworkIn',
    dimensions: EC2_INSTANCE,
    label: 'Net in',
    unit: 'bytes',
  },

  // ── ECS cluster ───────────────────────────────────────────────────────────
  {
    service: 'ecs',
    namespace: 'AWS/ECS',
    metricName: 'CPUReservation',
    dimensions: ECS_CLUSTER,
    label: 'CPU reserved',
    unit: 'percent',
  },
  {
    service: 'ecs',
    namespace: 'AWS/ECS',
    metricName: 'MemoryReservation',
    dimensions: ECS_CLUSTER,
    label: 'Mem reserved',
    unit: 'percent',
  },

  // ── ECS service ───────────────────────────────────────────────────────────
  {
    service: 'ecs',
    namespace: 'AWS/ECS',
    metricName: 'CPUUtilization',
    dimensions: ECS_SERVICE,
    label: 'CPU',
    unit: 'percent',
  },
  {
    service: 'ecs',
    namespace: 'AWS/ECS',
    metricName: 'MemoryUtilization',
    dimensions: ECS_SERVICE,
    label: 'Memory',
    unit: 'percent',
  },
  {
    // Container Insights, so it carries the pack's feature gate and is skipped
    // for a service in a cluster nobody enabled it on. Worth the conditional:
    // running task count is the one number that says whether the service is up.
    service: 'ecs',
    namespace: 'ECS/ContainerInsights',
    metricName: 'RunningTaskCount',
    dimensions: ECS_SERVICE,
    label: 'Tasks',
    unit: 'count',
  },

  // ── RDS ───────────────────────────────────────────────────────────────────
  {
    service: 'rds',
    namespace: 'AWS/RDS',
    metricName: 'CPUUtilization',
    dimensions: RDS_INSTANCE,
    label: 'CPU',
    unit: 'percent',
  },
  {
    service: 'rds',
    namespace: 'AWS/RDS',
    metricName: 'FreeableMemory',
    dimensions: RDS_INSTANCE,
    label: 'Free memory',
    unit: 'bytes',
  },
  {
    service: 'rds',
    namespace: 'AWS/RDS',
    metricName: 'DatabaseConnections',
    dimensions: RDS_INSTANCE,
    label: 'Connections',
    unit: 'count',
  },
]);

function sameDimensionSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const other = new Set(b);
  return a.every((name) => other.has(name));
}

function findPackMetric(ref: InfraHeadlineMetricRef): InfraPackMetric {
  const pack = getInfraServicePack(ref.service);
  if (!pack) {
    throw new Error(`headline metric references service '${ref.service}', which has no pack`);
  }
  const match = pack.metrics.find(
    (m) =>
      m.namespace === ref.namespace &&
      m.metricName === ref.metricName &&
      sameDimensionSet(m.dimensions, ref.dimensions),
  );
  if (!match) {
    throw new Error(
      `headline metric ${ref.namespace}/${ref.metricName} by ${ref.dimensions.join('+')} ` +
        `is not in the '${ref.service}' pack`,
    );
  }
  return match;
}

function resolve(ref: InfraHeadlineMetricRef): InfraHeadlineMetric {
  const packMetric = findPackMetric(ref);
  return Object.freeze({
    ...ref,
    stat: packMetric.stat,
    metricType: packMetric.metricType,
    requiresFeature: packMetric.requiresFeature,
    description: packMetric.description,
  });
}

/** Service token → its resolved headlines, in declaration order. */
const RESOLVED: Readonly<Record<string, readonly InfraHeadlineMetric[]>> = Object.freeze(
  INFRA_HEADLINE_METRIC_REFS.reduce<Record<string, InfraHeadlineMetric[]>>((acc, ref) => {
    (acc[ref.service] ??= []).push(resolve(ref));
    return acc;
  }, {}),
);

/** Every headline declared for a service, both dimension sets included. */
export function headlineMetricsForService(service: string): readonly InfraHeadlineMetric[] {
  return RESOLVED[service] ?? [];
}

/** Every resolved headline across every fleet service. Stable order. */
export function allHeadlineMetrics(): readonly InfraHeadlineMetric[] {
  return INFRA_FLEET_SERVICES.flatMap((service) => headlineMetricsForService(service));
}

/**
 * The headlines that apply to one concrete resource.
 *
 * Two filters, and both exist to keep a permanently empty tile off the board:
 *
 *   - **Dimension match.** The resource's own recorded dimension names decide
 *     which declaration it is. An ECS cluster gets the cluster-keyed pair; a
 *     service gets the service-keyed trio.
 *   - **Feature gate.** A Container Insights series on a cluster without it is
 *     not "no data yet", it is a series that will never exist, and the
 *     collector never asked CloudWatch for it either.
 *
 * `dimensionNames` empty (a row written before `metric_dimensions_json`
 * existed) falls back to the single-dimension declaration, matching what the
 * collector does for the same rows.
 */
export function headlineMetricsForResource(
  service: string,
  dimensionNames: readonly string[],
  features: Readonly<Record<string, boolean>> = {},
): readonly InfraHeadlineMetric[] {
  const declared = headlineMetricsForService(service);
  if (declared.length === 0) return [];

  const wanted =
    dimensionNames.length > 0
      ? declared.filter((m) => sameDimensionSet(m.dimensions, dimensionNames))
      : declared.filter((m) => m.dimensions.length === 1);

  return wanted.filter((m) => m.requiresFeature === null || features[m.requiresFeature] === true);
}
