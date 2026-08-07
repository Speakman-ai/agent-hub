/**
 * The derived quota utilization series: AWS's `m1/SERVICE_QUOTA(m1)*100`,
 * evaluated Hub-side.
 *
 * CloudWatch expresses quota utilization as a metric-math expression, where
 * `SERVICE_QUOTA(m1)` substitutes the applied quota for the metric `m1`
 * measures. We compute the same quotient with the same inputs, taking the
 * applied quota from `ListServiceQuotas` instead of from the math function.
 *
 * Two reasons it is not a metric-math query, both in `packs/quota.ts`'s
 * `absentMetrics`: our collector emits `MetricStat`-only queries because an
 * expression result carries no namespace, metric name or dimensions and
 * `infra_metric_points` requires all three; and AWS does not document
 * `SERVICE_QUOTA` as supported cross-account, which is the shape a monitoring
 * role has.
 *
 * ## Why this is a stored series rather than a computed-on-read number
 *
 * The headroom panel could divide at read time, and `listInfraQuotaHeadroom`
 * does exactly that for the current value. But a *series* buys two things a
 * read-time division cannot:
 *
 *   - The alert evaluator gets CloudWatch-parity M-of-N evaluation, missing-data
 *     treatment and state-transition semantics for free. The default "above 80%"
 *     rule is an ordinary rule over an ordinary series, with no special-casing
 *     anywhere in the alert path.
 *   - Utilization is chartable over time, which is the question an operator
 *     actually asks — not "am I at 82% right now" but "how fast did I get here".
 *
 * The cost is one extra stored point per collected usage point. That is
 * bounded by the quota population, which is a few dozen rows rather than the
 * thousands a resource-bearing service produces.
 */

import type { InfraMetricPointInput } from './infra-metric-store.js';
import {
  QUOTA_DERIVED_NAMESPACE,
  QUOTA_UTILIZATION_METRIC_NAME,
  QUOTA_UTILIZATION_STAT,
} from './packs/quota.js';
import { QUOTA_USAGE_NAMESPACE, quotaUtilizationPercent } from './quota-catalog.js';
import { getInfraServiceQuota } from './quota-store.js';

/**
 * Resolve the applied quota behind a quota resource, or null when unknown.
 *
 * Injected so the collector's tests never need a database, and so a caller can
 * batch or cache the lookup. The default reads `infra_service_quotas`.
 */
export type QuotaLimitLookup = (resourceKey: string) => number | null;

/** DB-backed default lookup. */
export const defaultQuotaLimitLookup: QuotaLimitLookup = (resourceKey) =>
  getInfraServiceQuota(resourceKey)?.value ?? null;

/**
 * Derive utilization points from freshly collected usage points.
 *
 * Only `AWS/Usage` points are considered; every other namespace passes through
 * untouched (this returns *only* the derived points, never the input).
 *
 * A point whose quota has no known applied value yields nothing at all rather
 * than a zero or a placeholder. Writing a point would assert we measured a
 * utilization we did not, and the alert rule's `treatMissingData: 'missing'`
 * relies on the gap being a real gap: an invented value would resolve an alarm
 * that should have stayed INSUFFICIENT_DATA.
 *
 * `ThrottleCount` is deliberately excluded even though it is an `AWS/Usage`
 * metric. It counts calls AWS *rejected*, so dividing it by the quota is not a
 * utilization of anything — the quota is already being enforced, and a
 * "0.3% utilized" reading computed from throttles would be actively
 * misleading. Throttling has its own default rule on the raw counter.
 */
export function deriveQuotaUtilizationPoints(
  points: readonly InfraMetricPointInput[],
  lookupLimit: QuotaLimitLookup,
): InfraMetricPointInput[] {
  const derived: InfraMetricPointInput[] = [];
  // One lookup per resource per batch rather than per point: a 15-minute
  // window at a 60s period is 15 points for the same quota.
  const limits = new Map<string, number | null>();

  for (const point of points) {
    if (point.namespace !== QUOTA_USAGE_NAMESPACE) continue;
    if (point.metricName === 'ThrottleCount') continue;

    let limit = limits.get(point.resourceKey);
    if (limit === undefined) {
      limit = lookupLimit(point.resourceKey);
      limits.set(point.resourceKey, limit);
    }

    const utilization = quotaUtilizationPercent(point.value, limit);
    if (utilization === null) continue;

    derived.push({
      projectId: point.projectId,
      resourceKey: point.resourceKey,
      namespace: QUOTA_DERIVED_NAMESPACE,
      metricName: QUOTA_UTILIZATION_METRIC_NAME,
      // Same dimension set as the usage point it came from, so the series is
      // keyed exactly as the pack declares and the alert runner resolves it
      // without ambiguity.
      dimensions: point.dimensions,
      stat: QUOTA_UTILIZATION_STAT,
      periodSeconds: point.periodSeconds,
      tsMs: point.tsMs,
      value: utilization,
    });
  }

  return derived;
}
