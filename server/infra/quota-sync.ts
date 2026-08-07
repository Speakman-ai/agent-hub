/**
 * Inventory discovery for service quotas: `ListServiceQuotas` → quota resources
 * plus the applied limits the headroom join needs.
 *
 * This is the inventory half of quota headroom. It runs on the hourly inventory
 * cadence rather than the 5-minute collector tick, because an applied quota
 * changes when someone requests an increase and AWS grants it — a timescale of
 * days, not minutes.
 *
 * ## Why listing, never per-quota reads
 *
 * `ListServiceQuotas` is throttled at 10 requests/second and returns up to 100
 * quotas per page; `GetServiceQuota` is throttled at 5/second and returns one.
 * Listing wins on both axes, and the gap is two orders of magnitude on the call
 * count. Nothing here ever calls `GetServiceQuota`.
 *
 * `QuotaAppliedAtLevel: 'ACCOUNT'` is passed explicitly rather than defaulted.
 * The default happens to be `ACCOUNT` today, but the parameter also accepts
 * `ALL`, and a resource-level quota keys on a context that `AWS/Usage`
 * dimensions do not carry — inventorying one would measure usage against a
 * limit that does not apply to it. Naming the level makes that a decision
 * rather than a default we inherited.
 *
 * ## What becomes a resource
 *
 * Only quotas carrying a usable `UsageMetric`. That field is absent for the
 * large majority of quotas and that is ordinary, not an error — see
 * `parseQuotaUsageMetric`. A quota with no usage metric has nothing in
 * CloudWatch to measure it, so inventorying it would produce a row that shows
 * no usage forever with nothing to explain why.
 */

import type { ListServiceQuotasCommandOutput, ServiceQuota } from '@aws-sdk/client-service-quotas';
import { ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';

import { infraResourceKey } from './infra-db.js';
import { quotaUsageFeatureKey } from './packs/quota.js';
import {
  QUOTA_INTEGRATED_SERVICE_CODES,
  QUOTA_SERVICE_TOKEN,
  isCollectableQuotaUsageMetric,
  parseQuotaUsageMetric,
  type QuotaUsageMetric,
} from './quota-catalog.js';
import {
  pruneInfraServiceQuotas,
  upsertInfraServiceQuotas,
  type InfraServiceQuotaInput,
} from './quota-store.js';

/**
 * Maximum `MaxResults` the API documents for `ListServiceQuotas` (valid range
 * 1-100). Asking for the maximum minimises pages against a 10 RPS limit.
 */
export const QUOTA_PAGE_SIZE = 100;

/** The narrow client shape the describer needs, so tests inject a plain object. */
export interface ServiceQuotasDescribeClient {
  send(command: ListServiceQuotasCommand): Promise<ListServiceQuotasCommandOutput>;
}

/** The scope columns quota discovery reads. */
export interface QuotaScope {
  project_id: string;
  profile_name: string;
  account_id: string | null;
  region: string;
  service: string;
}

/** A quota resource, shaped for the inventory upsert. */
export interface DiscoveredQuotaResource {
  accountId: string;
  resourceId: string;
  name: string | null;
  tagsJson: string | null;
  environment: string | null;
  state: string | null;
  metricDimensions: Record<string, string>;
  features: Record<string, boolean>;
}

/** What one quota contributes: an inventory row and a stored limit. */
export interface MappedQuota {
  resource: DiscoveredQuotaResource;
  quota: InfraServiceQuotaInput;
}

/** Why a quota was not inventoried, for the sweep's counters. */
export type QuotaRejection = 'no-usage-metric' | 'unsupported-usage-metric' | 'unidentifiable';

/**
 * Resource id for a quota: `<ServiceCode>/<QuotaCode>`.
 *
 * Both halves are required for uniqueness. Quota codes are only unique within a
 * service — `L-1216C47A` names one thing under `ec2` and something unrelated
 * under `dynamodb` — so keying on the code alone would collide two different
 * quotas into one row and merge their series into one chart.
 */
export function quotaResourceId(serviceCode: string, quotaCode: string): string {
  return `${serviceCode}/${quotaCode}`;
}

/** Account id from a quota ARN (`arn:aws:servicequotas:<region>:<account>:…`). */
function accountIdFromQuotaArn(arn: string | null | undefined): string | null {
  if (typeof arn !== 'string') return null;
  const parts = arn.split(':');
  // arn : partition : service : region : account-id : resource
  if (parts.length < 6 || parts[0] !== 'arn') return null;
  const account = parts[4];
  return account && account.trim() !== '' ? account.trim() : null;
}

/**
 * Turn one `ServiceQuota` into an inventory row plus a stored limit, or explain
 * why it cannot become one.
 *
 * Pure: no DB, no AWS, no clock. The `syncedAt` stamp is applied by the caller
 * so a whole sweep shares one timestamp (see {@link upsertInfraServiceQuotas}).
 *
 * The three rejections are deliberately distinct rather than one falsy return,
 * because they mean very different things to an operator:
 *
 *   - `no-usage-metric` is the *common, expected* case and must never be
 *     surfaced as a problem. Most quotas simply are not measurable.
 *   - `unsupported-usage-metric` means AWS published a usage metric in a shape
 *     this pack cannot query. That is rare and worth counting, because it is
 *     the signal that AWS extended the namespace and we have not caught up.
 *   - `unidentifiable` means no account id could be resolved, so the row could
 *     not be keyed at all. That is a configuration problem (the scope has never
 *     had `sts:GetCallerIdentity` run against it).
 */
export function mapServiceQuota(
  quota: ServiceQuota,
  scope: Pick<QuotaScope, 'project_id' | 'account_id' | 'region'>,
): MappedQuota | QuotaRejection {
  const usageMetric: QuotaUsageMetric | null = parseQuotaUsageMetric(quota.UsageMetric);
  if (!usageMetric) return 'no-usage-metric';
  if (!isCollectableQuotaUsageMetric(usageMetric)) return 'unsupported-usage-metric';

  const serviceCode = quota.ServiceCode?.trim();
  const quotaCode = quota.QuotaCode?.trim();
  if (!serviceCode || !quotaCode) return 'unidentifiable';

  const accountId = accountIdFromQuotaArn(quota.QuotaArn) ?? scope.account_id;
  if (!accountId) return 'unidentifiable';

  const resourceId = quotaResourceId(serviceCode, quotaCode);
  const resourceKey = infraResourceKey({
    projectId: scope.project_id,
    accountId,
    region: scope.region,
    service: QUOTA_SERVICE_TOKEN,
    resourceId,
  });

  const quotaName = quota.QuotaName?.trim() || resourceId;

  return {
    resource: {
      accountId,
      resourceId,
      name: quotaName,
      // Service Quotas exposes no tags on a quota, so there is nothing to
      // filter on. A scope tag filter therefore matches no quota, which is the
      // honest outcome rather than a silent match-all.
      tagsJson: null,
      environment: null,
      // A quota has no lifecycle state. Recording one would invite the
      // collector's terminal-state check to act on a value that means nothing.
      state: null,
      metricDimensions: { ...usageMetric.dimensions },
      // The gate that stops all three usage metrics binding to every quota and
      // billing two GetMetricData entries that could only return nothing.
      features: { [quotaUsageFeatureKey(usageMetric.metricName)]: true },
    },
    quota: {
      resourceKey,
      projectId: scope.project_id,
      accountId,
      region: scope.region,
      serviceCode,
      quotaCode,
      quotaName,
      // Nullable on purpose: AWS documents that for some quotas only the
      // default value is available. Unknown must stay distinct from zero, or
      // utilization reads as 0% — "plenty of headroom" — when we know nothing.
      value: typeof quota.Value === 'number' && Number.isFinite(quota.Value) ? quota.Value : null,
      unit: quota.Unit?.trim() || null,
      adjustable: quota.Adjustable === true,
      globalQuota: quota.GlobalQuota === true,
      usageMetric,
    },
  };
}

/** Counters a quota sweep reports, beyond the shared upserted/skipped pair. */
export interface QuotaSweepCounters {
  /** Service codes queried. */
  servicesQueried: number;
  /** Service codes whose listing failed and contributed nothing. */
  servicesFailed: number;
  /** Quotas seen with no usage metric — the expected majority. */
  withoutUsageMetric: number;
  /** Quotas whose usage metric this pack cannot query. */
  unsupportedUsageMetric: number;
}

export interface QuotaDiscovery {
  resources: DiscoveredQuotaResource[];
  skipped: number;
  counters: QuotaSweepCounters;
}

/** Page through `ListServiceQuotas` for one service code. */
async function listQuotasForService(
  client: ServiceQuotasDescribeClient,
  serviceCode: string,
  maxPages: number,
): Promise<{ quotas: ServiceQuota[]; truncated: boolean }> {
  const quotas: ServiceQuota[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const out = await client.send(
      new ListServiceQuotasCommand({
        ServiceCode: serviceCode,
        MaxResults: QUOTA_PAGE_SIZE,
        // Explicit rather than defaulted; see the module header.
        QuotaAppliedAtLevel: 'ACCOUNT',
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    quotas.push(...(out.Quotas ?? []));
    nextToken = out.NextToken ?? undefined;
    pages += 1;
  } while (nextToken && pages < maxPages);

  return { quotas, truncated: Boolean(nextToken) };
}

export interface DescribeQuotaScopeOptions {
  /** Service codes to sweep. Defaults to the documented integration list. */
  serviceCodes?: readonly string[];
  maxPagesPerService: number;
  /** Sweep timestamp; one value for the whole sweep so the prune is safe. */
  nowMs: number;
  /** Injected so the caller decides how a warning is surfaced. */
  warn?: (message: string) => void;
  /** Injected so the caller decides how the sweep summary is surfaced. */
  info?: (message: string) => void;
}

/**
 * Discover every measurable quota in one scope, and persist their limits.
 *
 * Writing the limits here rather than in the caller keeps the two halves of a
 * quota — the inventory row and its applied value — produced by the same pass
 * over the same response. Splitting them would let a sweep write resources whose
 * limits are from the previous hour, and the utilization those produce would be
 * wrong in a way nothing downstream could detect.
 *
 * A service code that fails to list contributes nothing and does not abort the
 * sweep. Service Quotas answers an unknown `ServiceCode` with
 * `NoSuchResourceException`, and a code AWS renames must not take the other
 * thirteen down with it.
 */
export async function describeQuotaScope(
  client: ServiceQuotasDescribeClient,
  scope: QuotaScope,
  opts: DescribeQuotaScopeOptions,
): Promise<QuotaDiscovery> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const info = opts.info ?? ((m: string) => console.log(m));
  const serviceCodes = opts.serviceCodes ?? QUOTA_INTEGRATED_SERVICE_CODES;
  const scopeLabel = `${scope.project_id}/${scope.profile_name}/${scope.region}/${scope.service}`;

  const resources: DiscoveredQuotaResource[] = [];
  const quotaRows: InfraServiceQuotaInput[] = [];
  const counters: QuotaSweepCounters = {
    servicesQueried: 0,
    servicesFailed: 0,
    withoutUsageMetric: 0,
    unsupportedUsageMetric: 0,
  };
  let skipped = 0;
  // Guards against two service codes mapping to the same quota, which would
  // otherwise upsert twice in one transaction and double-count the inventory.
  const seen = new Set<string>();

  for (const serviceCode of serviceCodes) {
    counters.servicesQueried += 1;
    let listed: { quotas: ServiceQuota[]; truncated: boolean };
    try {
      listed = await listQuotasForService(client, serviceCode, opts.maxPagesPerService);
    } catch (err) {
      counters.servicesFailed += 1;
      warn(
        `[infra-inventory-sync] ${scopeLabel}: ListServiceQuotas for '${serviceCode}' failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    if (listed.truncated) {
      warn(
        `[infra-inventory-sync] ${scopeLabel}: stopped paginating quotas for '${serviceCode}' at the ${opts.maxPagesPerService}-page cap; inventory may be incomplete`,
      );
    }

    for (const quota of listed.quotas) {
      const mapped = mapServiceQuota(quota, scope);
      if (mapped === 'no-usage-metric') {
        // The expected majority. Counted, never warned about.
        counters.withoutUsageMetric += 1;
        continue;
      }
      if (mapped === 'unsupported-usage-metric') {
        counters.unsupportedUsageMetric += 1;
        continue;
      }
      if (mapped === 'unidentifiable') {
        // Could not be keyed, which is the one case that is genuinely lost
        // data rather than a quota that is simply not measurable.
        skipped += 1;
        continue;
      }
      if (seen.has(mapped.quota.resourceKey)) continue;
      seen.add(mapped.quota.resourceKey);
      resources.push(mapped.resource);
      quotaRows.push(mapped.quota);
    }
  }

  if (quotaRows.length > 0) {
    upsertInfraServiceQuotas(quotaRows, opts.nowMs);
  }
  // Prune only when at least one service listed successfully. A sweep in which
  // every call failed knows nothing about what still exists, and pruning on it
  // would delete every limit in the region on a transient outage — leaving the
  // panel showing "unknown" for quotas that are fine.
  if (counters.servicesFailed < counters.servicesQueried) {
    const accountId = resources[0]?.accountId ?? scope.account_id;
    if (accountId) {
      pruneInfraServiceQuotas(scope.project_id, accountId, scope.region, opts.nowMs);
    }
  }

  // One line per scope per sweep, because the first question this feature
  // provokes is "why are only 8 quotas listed when the account has hundreds?".
  // The answer — most quotas publish no usage metric at all — is invisible
  // without it, and an operator who cannot see it reasonably concludes the
  // sweep is broken. Logged at info rather than warn: a large
  // `withoutUsageMetric` count is the expected steady state, not a fault.
  info(
    `[infra-inventory-sync] ${scopeLabel}: ${resources.length} measurable quota(s) from ` +
      `${counters.servicesQueried - counters.servicesFailed}/${counters.servicesQueried} service(s); ` +
      `${counters.withoutUsageMetric} quota(s) publish no usage metric` +
      (counters.unsupportedUsageMetric > 0
        ? `, ${counters.unsupportedUsageMetric} publish one this build cannot query`
        : ''),
  );

  return { resources, skipped, counters };
}
