/**
 * Service metric pack helpers shared by the web Infrastructure module and the
 * mobile Infrastructure screen.
 *
 * The pack catalog answers a question a chart cannot: *why is this empty?* An
 * empty series has three quite different causes — the metric does not exist for
 * this instance type, the metric requires a monitoring mode that is not
 * enabled, or collection is broken — and they look identical on screen. The
 * server ships the declarations; these helpers turn them into the one or two
 * lines each surface renders.
 *
 * Framework-free on purpose: web renders the same strings into `<p>` elements
 * and mobile into `<Text>`, and the strings themselves must not diverge.
 */

export type InfraPackMetricType = 'gauge' | 'counter' | 'flag' | 'balance';

export type InfraPackAvailability = 'either' | 'basic-only' | 'detailed-only';

export interface InfraPackMetricWire {
  namespace: string;
  metricName: string;
  /** The exact CloudWatch dimension-name set this series is keyed on. */
  dimensions: string[];
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
 * Which service's declarations annotate the current view.
 *
 * The charted resource decides it when there is one. The Alerts tab never has a
 * resource selected, so it falls back to the only pack when exactly one is
 * declared — which is the shape of every deployment until a second service
 * ships. With two or more and nothing selected there is no honest answer, so it
 * returns null rather than presenting one service's caveats as the project's.
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
 * The declaration behind a stored series.
 *
 * Matched on the full series identity rather than the metric name alone,
 * because the same metric collected on two statistics is two series and only
 * one of them is the one the pack declares.
 */
export function findPackMetric(
  pack: InfraServicePackWire | null | undefined,
  series: InfraSeriesIdentity | null | undefined,
  /**
   * The dimension names the stored series is keyed on, when the caller knows
   * them. A pack may declare the same metric on two dimension sets — `AWS/ECS`
   * `CPUUtilization` is one number for a cluster and a different one for a
   * service — and without this the first declaration wins and the chart is
   * annotated with the wrong caveats.
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

/**
 * Whether a resource has a provider feature turned on.
 *
 * Strict `true`, so an absent flag, a stale row from before the flag existed,
 * and an explicit `false` all read as off. That matches the collector, which
 * refuses to spend money on a feature it cannot confirm.
 */
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
 * The features that are off for a resource, with what each of them is hiding.
 *
 * This is the answer to the question an empty Metrics tab raises and cannot
 * answer for itself. Decision INFRA-COST: "The UI states plainly which panels
 * are empty because a paid AWS feature is off, rather than rendering a broken
 * chart." A gated metric is never requested for a resource without the feature,
 * so those series do not merely look empty — they genuinely do not exist, and
 * the only honest thing to render is the reason and the price.
 *
 * Returns an empty array with no resource selected: a feature is a property of
 * a cluster, not of a project, so "Container Insights is off" is a claim there
 * is nothing to base without knowing which resource is being asked about.
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

/**
 * Short caveats to show beside a metric, most surprising first.
 *
 * Returns an empty array for a metric that every resource publishes under
 * either monitoring mode — which is most of them, so the common case renders
 * nothing rather than reassurance nobody reads.
 */
export function metricCaveats(metric: InfraPackMetricWire | null | undefined): string[] {
  if (!metric) return [];
  const out: string[] = [];
  if (!metric.appliesTo.universal && metric.appliesTo.condition) {
    out.push(metric.appliesTo.condition);
  }
  if (metric.availability === 'basic-only') {
    // The counter-intuitive one: paying for detailed monitoring removes this
    // series rather than sharpening it.
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
