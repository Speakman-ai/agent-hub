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
  dimension: string;
  metricType: InfraPackMetricType;
  stat: string;
  validStatistics: string[];
  minPeriodSeconds: number;
  availability: InfraPackAvailability;
  appliesTo: { universal: boolean; condition: string };
  description: string;
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
  defaultAlertRules: InfraPackAlertRuleWire[];
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
): InfraPackMetricWire | null {
  if (!pack || !series) return null;
  return (
    pack.metrics.find(
      (m) =>
        m.namespace === series.namespace &&
        m.metricName === series.metricName &&
        m.stat === series.stat,
    ) ?? null
  );
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
