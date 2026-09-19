/**
 * Why is this empty? Metric missing, monitoring mode off, or collection broken.
 */

export type InfraPackMetricType = 'gauge' | 'counter' | 'flag' | 'balance' | 'latency';

export type InfraPackAvailability = 'either' | 'basic-only' | 'detailed-only';

export interface InfraPackMetricWire {
  namespace: string;
  metricName: string;
  /** The exact CloudWatch dimension-name set this series is keyed on. */
  dimensions: string[];
  /**
   * Extra dimension values when names alone do not identify the series.
   * S3 `NumberOfObjects` (`StorageType=AllStorageTypes`) is the usual case.
   */
  dimensionValues?: Record<string, string>;
  metricType: InfraPackMetricType;
  stat: string;
  validStatistics: string[];
  minPeriodSeconds: number;
  availability: InfraPackAvailability;
  appliesTo: { universal: boolean; condition: string };
  /** Provider feature key this metric needs, or `null` when it is unconditional. */
  requiresFeature: string | null;
  description: string;
}

export interface InfraPackFeatureWire {
  key: string;
  label: string;
  whenOff: string;
  costNote: string;
  docsUrl: string;
}

export interface InfraPackDimensionWire {
  name: string;
  detailedMonitoringOnly: boolean;
  description: string;
}

export interface InfraPackAbsentMetricWire {
  label: string;
  reason: string;
  remedy: string | null;
}

export interface InfraPackAlertRuleWire {
  name: string;
  description: string;
  namespace: string;
  metricName: string;
  stat: string;
  /** The dimension set of the series this rule evaluates, e.g. `['ClusterName']`. */
  dimensions: string[];
  periodS: number;
  threshold: number;
  comparisonOperator:
    | 'GreaterThanOrEqualToThreshold'
    | 'GreaterThanThreshold'
    | 'LessThanThreshold'
    | 'LessThanOrEqualToThreshold';
  evaluationPeriods: number;
  datapointsToAlarm: number;
  treatMissingData: 'missing' | 'notBreaching' | 'breaching' | 'ignore';
  severity: 'critical' | 'warning' | 'info';
  rationale: string;
}

export interface InfraServicePackWire {
  service: string;
  label: string;
  metrics: InfraPackMetricWire[];
  dimensions: InfraPackDimensionWire[];
  absentMetrics: InfraPackAbsentMetricWire[];
  features: InfraPackFeatureWire[];
  defaultAlertRules: InfraPackAlertRuleWire[];
}

/** A resource as far as the pack helpers care: its dimensions and its features. */
export interface InfraPackResource {
  service?: string | null;
  metricDimensions?: Record<string, unknown> | null;
  features?: Record<string, unknown> | null;
}

/** Anything with a series identity — a stored series or a metric declaration. */
export interface InfraSeriesIdentity {
  namespace: string;
  metricName: string;
  stat: string;
}

/** The pack for a service, or `null`. */
export function findServicePack(
  packs: readonly InfraServicePackWire[] | null | undefined,
  service: string | null | undefined,
): InfraServicePackWire | null {
  if (!packs || !service) return null;
  return packs.find((p) => p.service === service) ?? null;
}

/**
 * Pack for the current view. Resource wins; Alerts with exactly one pack uses
 * that pack; two+ packs and nothing selected → null.
 */
export function notesPackFor(
  packs: readonly InfraServicePackWire[] | null | undefined,
  resource: { service?: string | null } | null | undefined,
): InfraServicePackWire | null {
  const list = packs ?? [];
  const service = resource?.service ?? (list.length === 1 ? list[0].service : null) ?? null;
  return findServicePack(list, service);
}

/**
 * Declaration behind a stored series. Match full identity, not metric name
 * (same metric on two stats is two series).
 */
export function findPackMetric(
  pack: InfraServicePackWire | null | undefined,
  series: InfraSeriesIdentity | null | undefined,
  /**
   * Dimension names the stored series is keyed on. Same metric can exist on two
   * sets (ECS `CPUUtilization` cluster vs service).
   */
  dimensionNames?: readonly string[] | null,
): InfraPackMetricWire | null {
  if (!pack || !series) return null;
  const candidates = pack.metrics.filter(
    (m) =>
      m.namespace === series.namespace &&
      m.metricName === series.metricName &&
      m.stat === series.stat,
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || !dimensionNames) return candidates[0];
  return candidates.find((m) => sameDimensionSet(m.dimensions, dimensionNames)) ?? candidates[0];
}

/** Set equality over dimension names, order-independent. */
export function sameDimensionSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((name) => seen.has(name));
}

/** Strict `true` only. Absent/stale/`false` all read as off. */
export function resourceHasFeature(
  resource: InfraPackResource | null | undefined,
  feature: string,
): boolean {
  return resource?.features?.[feature] === true;
}

/** One "this is off, here is what it costs to turn on" notice for the UI. */
export interface InfraFeatureNotice {
  feature: InfraPackFeatureWire;
  /** Metrics in the pack that are not collected because the feature is off. */
  gatedMetricNames: string[];
}

/**
 * Features that are off, plus what they hide. Empty with no resource selected:
 * a feature is per cluster, not per project.
 */
export function featureNotices(
  pack: InfraServicePackWire | null | undefined,
  resource: InfraPackResource | null | undefined,
): InfraFeatureNotice[] {
  if (!pack || !resource) return [];
  const notices: InfraFeatureNotice[] = [];
  for (const feature of pack.features ?? []) {
    if (resourceHasFeature(resource, feature.key)) continue;
    const gated = pack.metrics.filter((m) => m.requiresFeature === feature.key);
    // A feature no metric in the pack depends on has nothing to explain.
    if (gated.length === 0) continue;
    notices.push({
      feature,
      gatedMetricNames: [...new Set(gated.map((m) => m.metricName))].sort(),
    });
  }
  return notices;
}

/** Caveats beside a metric. Empty when every resource publishes it. */
export function metricCaveats(metric: InfraPackMetricWire | null | undefined): string[] {
  if (!metric) return [];
  const out: string[] = [];
  if (!metric.appliesTo.universal && metric.appliesTo.condition) {
    out.push(metric.appliesTo.condition);
  }
  if (metric.availability === 'basic-only') {
    // Paying for detailed monitoring removes this series rather than sharpening it.
    out.push('Published under basic monitoring only. Detailed monitoring removes this metric.');
  } else if (metric.availability === 'detailed-only') {
    out.push('Published only when detailed monitoring is enabled on the resource.');
  }
  return out;
}

/**
 * How a rule reads in one line, e.g.
 * `Maximum >= 1 for 2 of 2 × 60s`.
 */
export function summarizeDefaultRule(rule: InfraPackAlertRuleWire): string {
  const op = COMPARISON_SYMBOLS[rule.comparisonOperator] ?? rule.comparisonOperator;
  const periods =
    rule.datapointsToAlarm === rule.evaluationPeriods
      ? `${rule.evaluationPeriods}`
      : `${rule.datapointsToAlarm} of ${rule.evaluationPeriods}`;
  return `${rule.stat} ${op} ${rule.threshold} for ${periods} × ${rule.periodS}s`;
}

const COMPARISON_SYMBOLS: Record<string, string> = {
  GreaterThanOrEqualToThreshold: '>=',
  GreaterThanThreshold: '>',
  LessThanThreshold: '<',
  LessThanOrEqualToThreshold: '<=',
};
