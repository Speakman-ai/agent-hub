/**
 * Service quota headroom: the pure, IO-free half.
 *
 * The failure this catches is the one where every dashboard is green and you
 * still cannot launch anything — no alarm fires because nothing is *down*, the
 * account has simply run out of a quota. CloudWatch publishes usage counters in
 * the `AWS/Usage` namespace and Service Quotas publishes the limits; neither is
 * useful alone, and the join between them is what this module describes.
 *
 * Facts below verified against AWS documentation in August 2026:
 *
 *   - Usage metrics live in `AWS/Usage`, are collected at 1-minute resolution,
 *     and are published with the dimensions `Service`, `Class`, `Type` and
 *     `Resource`. The metric names AWS documents for the namespace are
 *     `CallCount`, `ResourceCount` and `ThrottleCount`.
 *     https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Usage-Metrics.html
 *   - The utilization expression AWS documents, verbatim, is
 *     `m1/SERVICE_QUOTA(m1)*100`, with the console walkthrough setting a static
 *     `Greater than 80` threshold on it. Both are reproduced here as constants
 *     rather than as literals at their call sites, so the number a reviewer
 *     checks against the AWS page is in exactly one place.
 *     https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Quotas-Visualize-Alarms.html
 *   - `ListServiceQuotas` is throttled at 10 requests/second and returns up to
 *     100 quotas per page; the per-quota `GetServiceQuota` is throttled at 5/s.
 *     Listing is therefore preferred on both axes — twice the rate limit and
 *     ~100x fewer calls — and this module never models a single-quota read.
 *     https://docs.aws.amazon.com/general/latest/gr/servicequotas.html
 *
 * ## Why the limit is resolved here rather than by CloudWatch
 *
 * `SERVICE_QUOTA()` is a CloudWatch *metric math* function. Our collector emits
 * `MetricStat`-only `MetricDataQuery` structures (see `metric-collector.ts`) —
 * an expression result carries no namespace, metric name or dimensions, and
 * `infra_metric_points` requires all three NOT NULL, so there is nowhere to put
 * one. AWS also does not mark `SERVICE_QUOTA` as supported cross-account, which
 * is precisely the shape a monitoring role has.
 *
 * So the expression is evaluated Hub-side with the *same* arithmetic:
 * `SERVICE_QUOTA(m1)` is the applied quota value that `ListServiceQuotas`
 * returned for the quota that owns `m1`. That is the same number CloudWatch
 * would substitute — the console's quota card reads it from Service Quotas too
 * — and it has the property the metric-math form does not: we can also report
 * absolute headroom (`limit - usage`), which a bare percentage cannot express.
 * {@link quotaUtilizationPercent} is the one function that does this, and it is
 * named after the documented expression so the two never drift apart silently.
 */

/**
 * AWS's documented metric-math expression for quota utilization, quoted
 * verbatim from the CloudWatch user guide. Kept as a string constant because
 * it is surfaced to operators in the UI and in the route description: an
 * operator diffing our number against the console needs to see that we claim
 * to be computing the same thing they would type into an alarm.
 */
export const QUOTA_UTILIZATION_EXPRESSION = 'm1/SERVICE_QUOTA(m1)*100';

/**
 * The threshold AWS's own walkthrough uses ("Whenever Expression1 is Greater
 * than 80"). Default rule only — an operator can raise or lower it per rule.
 */
export const DEFAULT_QUOTA_UTILIZATION_THRESHOLD = 80;

/** The CloudWatch namespace usage metrics are published under. */
export const QUOTA_USAGE_NAMESPACE = 'AWS/Usage';

/**
 * The four dimensions every `AWS/Usage` metric carries, sorted.
 *
 * Sorted because the pack invariant tests and `bindMetricDimensions` compare
 * dimension *sets*, and a stable order makes the pack declaration and the
 * per-resource `metric_dimensions_json` trivially diffable by eye.
 *
 * This set is fixed for the whole namespace, which is the reason quotas fit the
 * existing resource/pack/collector machinery at all: a pack metric must declare
 * one exact dimension-name set, and `AWS/Usage` genuinely has only one.
 */
export const QUOTA_USAGE_DIMENSIONS: readonly string[] = Object.freeze([
  'Class',
  'Resource',
  'Service',
  'Type',
]);

/**
 * Usage metric names documented for `AWS/Usage`.
 *
 * `ResourceCount` is a level (how many of a thing exist), while `CallCount` and
 * `ThrottleCount` are rates (how many happened in the period). That distinction
 * drives the statistic each one is collected on — see `packs/quota.ts`.
 */
export const QUOTA_USAGE_METRIC_NAMES: readonly string[] = Object.freeze([
  'CallCount',
  'ResourceCount',
  'ThrottleCount',
]);

/** `AWS/Usage` is published at 1-minute resolution. */
export const QUOTA_USAGE_PERIOD_SECONDS = 60;

/**
 * The scope-allowlist token and `infra_resources.service` value for a quota.
 *
 * Quotas are inventoried as resources so they inherit scoping, retention,
 * charting and alert evaluation without a parallel implementation of any of
 * them. A quota is a genuinely account+region-scoped "resource" whose metric
 * dimensions happen to come from Service Quotas instead of a describe call.
 */
export const QUOTA_SERVICE_TOKEN = 'quota';

/**
 * Service codes whose quotas AWS documents as integrating with CloudWatch usage
 * metrics, as listed in the "Visualizing your service quotas" guide (August
 * 2026). Codes are the `ServiceCode` values `ListServiceQuotas` expects, which
 * are frequently *not* the obvious abbreviation — CloudWatch is `monitoring`,
 * CloudWatch Logs is `logs`, Location Service is `geo`.
 *
 * ## This list is a hint, not a gate
 *
 * It exists to bound the sync: without it we would have to call `ListServices`
 * and then `ListServiceQuotas` for ~400 services, which is minutes of paginated
 * calls against a 10 RPS limit to discover that ~17 of them have anything to
 * say. The authoritative test is always whether a returned quota carries a
 * `UsageMetric` ({@link parseQuotaUsageMetric}), never membership here.
 *
 * Two consequences follow, and both are deliberate:
 *
 *   - AWS adding a service to the integration does not silently break us; it
 *     just goes unqueried until this list is updated. Adding a code that turns
 *     out to have no usage metrics costs one wasted call and yields nothing.
 *   - A code that AWS renames or retires must not abort the whole sync. Service
 *     Quotas answers an unknown `ServiceCode` with `NoSuchResourceException`,
 *     so the sync treats a per-service failure as "this service contributed no
 *     quotas" and carries on. See `quota-sync.ts`.
 */
export const QUOTA_INTEGRATED_SERVICE_CODES: readonly string[] = Object.freeze([
  'chime',
  'cloudhsm',
  'dynamodb',
  'ec2',
  'ecr',
  'fargate',
  'firehose',
  'fis',
  'geo',
  'ivs',
  'kms',
  'logs',
  'monitoring',
  'robomaker',
]);

/**
 * A `ServiceQuota.UsageMetric` that survived validation.
 *
 * Note what is absent: any usage *value*. See {@link parseQuotaUsageMetric}.
 */
export interface QuotaUsageMetric {
  namespace: string;
  metricName: string;
  /** Dimension name → value, exactly as Service Quotas reported them. */
  dimensions: Readonly<Record<string, string>>;
  /**
   * `MetricStatisticRecommendation` when AWS supplied one. AWS recommends the
   * statistic per quota (`Maximum` for resource counts, `Sum` for call counts),
   * and it is not inferable from the metric name alone, so a missing
   * recommendation is reported as `null` rather than guessed at here.
   */
  statisticRecommendation: string | null;
}

/** The raw shape Service Quotas returns; every field is optional on the wire. */
export interface RawQuotaUsageMetric {
  MetricNamespace?: string | null;
  MetricName?: string | null;
  MetricDimensions?: Record<string, string | null | undefined> | null;
  MetricStatisticRecommendation?: string | null;
}

/**
 * Normalize a `ServiceQuota.UsageMetric`, or `null` when the quota has none.
 *
 * ## `UsageMetric` is a pointer with no value, and it is usually absent
 *
 * Two things about this field trip people up, and both are load-bearing here.
 *
 * First, it is a *pointer*: it names the CloudWatch metric that measures usage
 * of the quota. It does not carry the usage. Reading `UsageMetric` tells you
 * where to look, and you still have to call CloudWatch to find out the number.
 * A caller that treats a present `UsageMetric` as "we know current usage" is
 * wrong, which is why the return type has no value field to misread.
 *
 * Second, `null` is the *common* case, not an error. Only around 17 AWS
 * services publish usage metrics at all, and even within those, most individual
 * quotas have no `UsageMetric` — the field is absent for the large majority of
 * rows any real `ListServiceQuotas` sweep returns. So a `null` here is an
 * ordinary "this quota is not measurable", never something to log as a fault or
 * retry. Callers filter on it; nothing warns about it.
 *
 * Beyond absence, we reject partially-populated pointers: a namespace or metric
 * name that is missing or blank, or an empty dimension set. Such a pointer
 * cannot be turned into a `GetMetricData` query, and keeping it would produce a
 * quota row that permanently shows no usage with no explanation. Dimension
 * values that are null or blank are dropped individually, because a dimension
 * with an empty value does not match anything in CloudWatch.
 */
export function parseQuotaUsageMetric(
  usageMetric: RawQuotaUsageMetric | null | undefined,
): QuotaUsageMetric | null {
  if (!usageMetric) return null;

  const namespace = trimmedOrNull(usageMetric.MetricNamespace);
  const metricName = trimmedOrNull(usageMetric.MetricName);
  if (!namespace || !metricName) return null;

  const dimensions: Record<string, string> = {};
  for (const [name, value] of Object.entries(usageMetric.MetricDimensions ?? {})) {
    const key = trimmedOrNull(name);
    const val = trimmedOrNull(value);
    if (key && val) dimensions[key] = val;
  }
  // A usage metric with no usable dimensions cannot be queried: `AWS/Usage`
  // publishes nothing at the bare namespace/name pair.
  if (Object.keys(dimensions).length === 0) return null;

  return {
    namespace,
    metricName,
    dimensions: Object.freeze(sortKeys(dimensions)),
    statisticRecommendation: trimmedOrNull(usageMetric.MetricStatisticRecommendation),
  };
}

/**
 * Is this usage metric one the collector can actually query through the quota
 * service pack?
 *
 * The pack declares `AWS/Usage` metrics keyed on the exact four-dimension set,
 * and `bindMetricDimensions` rejects anything else — so a quota pointing at a
 * different namespace, an undeclared metric name, or a different dimension set
 * would be inventoried and then never collected, showing an operator a row that
 * silently never fills in.
 *
 * Rather than let that happen, the sync uses this predicate to decide what
 * becomes a resource. Quotas that fail it are counted and reported, not
 * silently dropped, so "AWS published a usage metric we do not understand" is
 * visible rather than indistinguishable from "no usage metric".
 */
export function isCollectableQuotaUsageMetric(metric: QuotaUsageMetric): boolean {
  if (metric.namespace !== QUOTA_USAGE_NAMESPACE) return false;
  if (!QUOTA_USAGE_METRIC_NAMES.includes(metric.metricName)) return false;
  const names = Object.keys(metric.dimensions).sort();
  return (
    names.length === QUOTA_USAGE_DIMENSIONS.length &&
    names.every((name, i) => name === QUOTA_USAGE_DIMENSIONS[i])
  );
}

/**
 * Utilization percentage: AWS's `m1/SERVICE_QUOTA(m1)*100` with the quota value
 * substituted for `SERVICE_QUOTA(m1)`.
 *
 * Returns `null` — not `0`, and not `Infinity` — whenever the ratio is not
 * defined. A quota whose limit is zero, absent or unknown genuinely has no
 * utilization, and `0` would render as "plenty of headroom", which is the exact
 * opposite of the truth and the most dangerous value we could return. A `null`
 * renders as "unknown", and the panel says so.
 *
 * A negative limit is rejected for the same reason: it is not a quota, it is a
 * garbled response, and dividing by it produces a confidently-signed nonsense
 * percentage.
 *
 * The result is deliberately *not* clamped to 100. Usage above an applied quota
 * is a real, observable state — quota decreases apply immediately while
 * existing resources keep running, and rate quotas are enforced with burst
 * allowances — and a headroom panel that silently reports 100% when the true
 * answer is 140% has hidden the one reading the operator most needs.
 */
export function quotaUtilizationPercent(
  usage: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (typeof usage !== 'number' || !Number.isFinite(usage)) return null;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return null;
  if (limit <= 0) return null;
  return (usage / limit) * 100;
}

/**
 * Absolute remaining headroom (`limit - usage`), or `null` when undefined.
 *
 * This is the number the percentage cannot give you, and often the one that
 * decides an action: "82% of 40" leaves 7 more, "82% of 5,000" leaves 900.
 *
 * Floored at zero, unlike {@link quotaUtilizationPercent}, because negative
 * remaining headroom is not a meaningful quantity to display — "you can create
 * -12 more" is noise. Over-quota is legible in the percentage, which is exactly
 * why that function does not clamp.
 */
export function quotaHeadroom(
  usage: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (typeof usage !== 'number' || !Number.isFinite(usage)) return null;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return null;
  if (limit <= 0) return null;
  return Math.max(0, limit - usage);
}

/**
 * Severity band for a utilization percentage.
 *
 * `unknown` is its own band rather than folding into `ok`, so a quota we cannot
 * measure never counts toward "everything is fine". The panel sorts by band and
 * an operator can see at a glance that three quotas are unmeasured.
 */
export type QuotaHeadroomBand = 'unknown' | 'ok' | 'warning' | 'critical';

/** At or above this, a quota is `critical` rather than `warning`. */
export const QUOTA_CRITICAL_UTILIZATION_THRESHOLD = 100;

/**
 * Band a utilization reading.
 *
 * The warning edge is {@link DEFAULT_QUOTA_UTILIZATION_THRESHOLD}, so the
 * colour an operator sees and the point the default alert rule fires are the
 * same number by construction. AWS's walkthrough alarms on *Greater than* 80,
 * and this matches that boundary exactly: 80.0 is still `ok`.
 */
export function quotaHeadroomBand(utilizationPercent: number | null): QuotaHeadroomBand {
  if (utilizationPercent === null || !Number.isFinite(utilizationPercent)) return 'unknown';
  if (utilizationPercent >= QUOTA_CRITICAL_UTILIZATION_THRESHOLD) return 'critical';
  if (utilizationPercent > DEFAULT_QUOTA_UTILIZATION_THRESHOLD) return 'warning';
  return 'ok';
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}
