/**
 * Resource inventory sync — the describe-API sweep that fills `infra_resources`.
 *
 * Why this exists at all (decision INFRA-COLLECT): CloudWatch `ListMetrics`
 * omits any metric with no datapoint in the past two weeks, so it enumerates
 * *reporting* resources and can never be an inventory of *existing* ones. A
 * stopped instance, a freshly launched one, or anything on a service whose
 * metrics are opt-in would simply not be there. Inventory therefore comes from
 * the per-service describe APIs, is persisted here, and the metric collector
 * reads its query list from this table instead of paginating ListMetrics
 * (25 TPS, the tightest limit in the discovery path) on the hot path.
 *
 * This is a separate, slower cron from metric collection on purpose: inventory
 * moves at the pace of launches and terminations, metrics at the pace of the
 * collector. Hourly by default, 5-minutely for the collector.
 *
 * Three invariants worth stating because they are easy to "simplify" away:
 *
 *   - **Nothing is polled without a scope row.** The sweep reads
 *     `infra_scopes` and only ever describes what an operator explicitly
 *     allowlisted (decision INFRA-SCOPE). Auto-discovering an account is how a
 *     monitoring tool produces a surprise AWS bill in someone else's account.
 *   - **Rows are never deleted.** A resource that disappears from AWS ages out
 *     via a stale `last_seen`; deleting it would yank the subject out from
 *     under a chart mid-render.
 *   - **One bad scope never aborts the tick.** Failures are per-scope, logged
 *     and swallowed, so an expired role in one region cannot starve every other
 *     region of inventory.
 *
 * Adding a service is adding a describer and a branch in {@link syncScope}.
 * EC2 and ECS are implemented; ECS is the one that shows what the shape has to
 * support in general, because a single scope there produces two *kinds* of row
 * (clusters and services) keyed on different CloudWatch dimension sets.
 */

import {
  DescribeInstancesCommand,
  DescribeNatGatewaysCommand,
  type DescribeNatGatewaysCommandOutput,
  type DescribeInstancesCommandOutput,
  type Filter,
  type Instance,
  type NatGateway,
} from '@aws-sdk/client-ec2';
import {
  DescribeClustersCommand,
  DescribeServicesCommand,
  ListAccountSettingsCommand,
  ListClustersCommand,
  ListServicesCommand,
  type Cluster,
  type DescribeClustersCommandOutput,
  type DescribeServicesCommandOutput,
  type ListAccountSettingsCommandOutput,
  type ListClustersCommandOutput,
  type ListServicesCommandOutput,
  type Service as EcsService,
} from '@aws-sdk/client-ecs';
import {
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  type DescribeLoadBalancersCommandOutput,
  type DescribeTagsCommandOutput,
  type DescribeTargetGroupsCommandOutput,
  type LoadBalancer,
  type TargetGroup,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { getInfraDb, isInfraDbInitialized, infraResourceKey } from './infra-db.js';
import { getProjectEc2Client, getProjectEcsClient, getProjectElbV2Client } from './aws-clients.js';
import {
  compileInfraTagFilter,
  isEmptyInfraTagFilter,
  matchesInfraTagFilter,
  parseInfraTagFilter,
} from './tag-filter.js';
import { ECS_CONTAINER_INSIGHTS_FEATURE } from './packs/index.js';

/**
 * Hourly, at a fixed off-the-hour minute.
 *
 * Not `0 * * * *`: the top of the hour is where every other hourly job in the
 * process already lands, and this tick opens AWS connections and writes a
 * transaction per scope. Offsetting it keeps that work off the same event-loop
 * boundary. `estimateIntervalSeconds` reads this as 3600s, which is above the
 * fast-cadence threshold, so no jitter is added on top.
 */
export const INFRA_INVENTORY_SYNC_CRON = '17 * * * *';

/** Service tokens this sweep knows how to describe. */
const EC2_SERVICE = 'ec2';
const ECS_SERVICE = 'ecs';
const ALB_SERVICE = 'alb';
const NLB_SERVICE = 'nlb';
const NATGW_SERVICE = 'natgw';
export const INFRA_SYNCABLE_SERVICES: readonly string[] = Object.freeze([
  EC2_SERVICE,
  ECS_SERVICE,
  ALB_SERVICE,
  NLB_SERVICE,
  NATGW_SERVICE,
]);

/**
 * Scope service token → the `Type` value ELBv2 reports for it.
 *
 * ELBv2 has one `DescribeLoadBalancers` API returning every load balancer type,
 * so both scopes issue the same call and partition on this. That is also why
 * `alb` and `nlb` are separate scope services rather than one `elbv2`: they are
 * separate CloudWatch namespaces whose `LoadBalancer` dimension has the same
 * *name*, so a merged token would query each namespace against the other's
 * resources and be billed for the empty result.
 *
 * `gateway` (Gateway Load Balancer) is deliberately unmapped — it is a third
 * documented `Type` with its own namespace and no pack here.
 */
const ELB_TYPE_BY_SERVICE: Readonly<Record<string, string>> = Object.freeze({
  [ALB_SERVICE]: 'application',
  [NLB_SERVICE]: 'network',
});

/** `DescribeTags` "can specify up to 20 resources in a single call". */
const ELB_DESCRIBE_TAGS_BATCH = 20;

/** `PageSize` on both ELBv2 describe calls: "Maximum value of 400". */
const ELB_PAGE_SIZE = 400;

/** `DescribeNatGateways` `MaxResults`: "Maximum value of 1000". */
const NATGW_PAGE_SIZE = 1000;

/** `ListClusters` and `ListServices` both cap a page at 100. */
const ECS_LIST_PAGE_SIZE = 100;
/** `DescribeClusters` takes up to 100 names per call. */
const ECS_DESCRIBE_CLUSTERS_BATCH = 100;
/**
 * `DescribeServices` hard-caps at 10 per call — "You may specify up to 10
 * services to describe in a single operation." Enumerating 200 services is 2
 * `ListServices` calls and 20 `DescribeServices` calls, which is why inventory
 * is an hourly sweep rather than something the collector does on its hot path.
 */
const ECS_DESCRIBE_SERVICES_BATCH = 10;

/**
 * Page cap for a single scope's `DescribeInstances` pagination.
 *
 * At the API's 1,000-results-per-page maximum this is 100,000 instances in one
 * region, far past any plausible scope. It exists so a malformed or looping
 * `NextToken` cannot spin a tick forever holding a client open.
 */
export const MAX_PAGES_PER_SCOPE = 100;

/** The subset of an `infra_scopes` row this sweep needs. */
export interface InfraScopeRow {
  id: string;
  project_id: string;
  profile_name: string;
  account_id: string | null;
  region: string;
  service: string;
  tag_filter_json: string | null;
}

/** Just enough of an `EC2Client` for the instance and NAT gateway walks. */
export interface Ec2DescribeClient {
  send(command: DescribeInstancesCommand): Promise<DescribeInstancesCommandOutput>;
  send(command: DescribeNatGatewaysCommand): Promise<DescribeNatGatewaysCommandOutput>;
}

/** Just enough of an `ElasticLoadBalancingV2Client` for the three-call walk. */
export interface ElbDescribeClient {
  send(command: DescribeLoadBalancersCommand): Promise<DescribeLoadBalancersCommandOutput>;
  send(command: DescribeTargetGroupsCommand): Promise<DescribeTargetGroupsCommandOutput>;
  send(command: DescribeTagsCommand): Promise<DescribeTagsCommandOutput>;
}

/** Just enough of an `ECSClient` for the four-call inventory walk. */
export interface EcsDescribeClient {
  send(command: ListClustersCommand): Promise<ListClustersCommandOutput>;
  send(command: DescribeClustersCommand): Promise<DescribeClustersCommandOutput>;
  send(command: ListServicesCommand): Promise<ListServicesCommandOutput>;
  send(command: DescribeServicesCommand): Promise<DescribeServicesCommandOutput>;
  send(command: ListAccountSettingsCommand): Promise<ListAccountSettingsCommandOutput>;
}

export interface InfraInventorySyncOptions {
  /** Injected clock so tests can assert on `first_seen` / `last_seen`. */
  nowMs?: number;
  /** Test seam: build the EC2 client for a scope. */
  ec2ClientFactory?: (scope: InfraScopeRow) => Ec2DescribeClient;
  /** Test seam: build the ECS client for a scope. */
  ecsClientFactory?: (scope: InfraScopeRow) => EcsDescribeClient;
  /** Test seam: build the ELBv2 client for a scope. */
  elbClientFactory?: (scope: InfraScopeRow) => ElbDescribeClient;
}

export interface InfraInventorySyncResult {
  /** Enabled scope rows this sweep considered. */
  scopes: number;
  /** Scopes that completed without throwing. */
  synced: number;
  /** Scopes that failed; their errors were logged and swallowed. */
  failed: number;
  /** Resource rows inserted or refreshed. */
  upserted: number;
  /**
   * Resources skipped because no account id could be determined for them, so no
   * `resource_key` could be derived. Counted rather than silently dropped —
   * a non-zero value here means inventory is incomplete.
   */
  skipped: number;
}

/**
 * A per-scope failure. The message is what lands in the log line, so it names
 * the scope rather than just the underlying AWS error.
 */
function describeScope(scope: InfraScopeRow): string {
  return `${scope.project_id}/${scope.profile_name}/${scope.region}/${scope.service}`;
}

/**
 * Translate a scope's tag filter into EC2 `Filter` structures.
 *
 * Server-side filtering is the point: pushing the predicate into
 * `DescribeInstances` means AWS returns only in-scope instances instead of us
 * paginating the whole region and discarding most of it.
 *
 * The format and its failure behaviour live in `tag-filter.ts`, because the
 * metric collector has to re-apply the *same* filter to the stored rows — this
 * sweep's server-side filter is not the last word, since inventory rows outlive
 * a narrowed filter. One parser means the two cannot drift.
 */
export function buildEc2TagFilters(tagFilterJson: string | null): Filter[] {
  return parseInfraTagFilter(tagFilterJson).map((clause) => ({
    Name: `tag:${clause.key}`,
    Values: clause.values,
  }));
}

/** Look up a tag case-insensitively; AWS tag keys are case-sensitive, operators are not. */
function tagValue(tags: Array<{ Key?: string; Value?: string }>, wanted: string): string | null {
  const lowered = wanted.toLowerCase();
  for (const tag of tags) {
    if ((tag.Key ?? '').toLowerCase() === lowered) return tag.Value ?? null;
  }
  return null;
}

/** A resource row ready to upsert, normalised out of a provider-specific shape. */
interface DiscoveredResource {
  accountId: string;
  resourceId: string;
  name: string | null;
  tagsJson: string | null;
  environment: string | null;
  state: string | null;
  /**
   * CloudWatch dimension map for this resource. The collector matches it
   * against each pack metric's declared dimension set, so this is what decides
   * an ECS cluster row gets the cluster-level queries and a service row the
   * service-level ones.
   */
  metricDimensions: Record<string, string>;
  /** Detected provider feature flags. Empty for services with no gated metrics. */
  features: Record<string, boolean>;
}

function toDiscoveredResource(
  instance: Instance,
  ownerId: string | undefined,
  scope: InfraScopeRow,
): DiscoveredResource | null {
  const resourceId = instance.InstanceId;
  if (!resourceId) return null;

  // The reservation's OwnerId is the authoritative account for the instances it
  // contains, and it comes back free with the describe call. The scope's own
  // account_id is only a fallback, since it stays NULL until something has run
  // sts:GetCallerIdentity for that profile.
  const accountId = ownerId || scope.account_id;
  if (!accountId) return null;

  const tags = instance.Tags ?? [];
  return {
    accountId,
    resourceId,
    name: tagValue(tags, 'Name'),
    tagsJson: tags.length > 0 ? JSON.stringify(tags) : null,
    // The join key to logs and deployments, which all carry an `environment`
    // label already. Conventional tag, absent for most resources, and optional
    // in the schema — so an unlabelled instance is simply unjoined, not broken.
    environment: tagValue(tags, 'Environment'),
    state: instance.State?.Name ?? null,
    metricDimensions: { InstanceId: resourceId },
    // EC2 detailed monitoring would belong here — `instance.Monitoring.State`
    // reports it — but no EC2 pack metric is gated on it, so recording it would
    // be a flag nothing reads.
    features: {},
  };
}

/**
 * Describe every in-scope EC2 instance, following pagination.
 *
 * Terminated instances are kept rather than filtered out. AWS keeps them
 * visible for roughly an hour after termination, and recording the real
 * `state` is more useful than pretending the resource vanished — the row ages
 * out on `last_seen` once AWS stops returning it.
 */
async function describeEc2Scope(
  client: Ec2DescribeClient,
  scope: InfraScopeRow,
): Promise<{ resources: DiscoveredResource[]; skipped: number }> {
  const filters = buildEc2TagFilters(scope.tag_filter_json);
  const resources: DiscoveredResource[] = [];
  let skipped = 0;
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const out = await client.send(
      new DescribeInstancesCommand({
        ...(filters.length > 0 ? { Filters: filters } : {}),
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    for (const reservation of out.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        const resource = toDiscoveredResource(instance, reservation.OwnerId, scope);
        if (resource) resources.push(resource);
        else skipped += 1;
      }
    }
    nextToken = out.NextToken ?? undefined;
    pages += 1;
  } while (nextToken && pages < MAX_PAGES_PER_SCOPE);

  if (nextToken) {
    console.warn(
      `[infra-inventory-sync] ${describeScope(scope)}: stopped at the ${MAX_PAGES_PER_SCOPE}-page cap; inventory may be incomplete`,
    );
  }
  return { resources, skipped };
}

// ─── ECS ────────────────────────────────────────────────────────────────────

/**
 * The account id out of an ECS ARN.
 *
 * `arn:aws:ecs:eu-west-1:123456789012:cluster/prod` — field 4. ECS has no
 * equivalent of the reservation `OwnerId` that EC2 hands back, so the ARN is
 * the authoritative source and it costs nothing extra. Returns `null` on
 * anything that is not an ARN, and the caller falls back to the scope's own
 * `account_id` exactly as the EC2 path does.
 */
export function accountIdFromArn(arn: string | undefined): string | null {
  if (!arn) return null;
  const parts = arn.split(':');
  return parts.length >= 6 && parts[0] === 'arn' && parts[4] ? parts[4] : null;
}

/** The name out of an ECS ARN (`…:cluster/prod` → `prod`, `…:service/prod/api` → `api`). */
function nameFromArn(arn: string | undefined): string | null {
  if (!arn) return null;
  const tail = arn.split('/').pop();
  return tail && tail !== arn ? tail : null;
}

/** ECS tags arrive as `[{key,value}]` — lowercase, unlike EC2's `[{Key,Value}]`. */
function normalizeEcsTags(
  tags: Array<{ key?: string; value?: string }> | undefined,
): Array<{ Key: string; Value: string }> {
  return (tags ?? [])
    .filter((t): t is { key: string; value?: string } => typeof t.key === 'string')
    .map((t) => ({ Key: t.key, Value: t.value ?? '' }));
}

/**
 * The `containerInsights` values AWS documents as turning the feature **on**.
 *
 * Both, not just `enabled`: `enhanced` is a superset that adds per-task and
 * per-container series on top of everything `enabled` publishes, so a cluster
 * paying for the richer mode has every metric this pack collects. Treating it
 * as off would skip the whole `ECS/ContainerInsights` namespace for exactly the
 * accounts paying the most for it.
 *
 * `disabled` is the documented third value and the account-level default.
 */
export const ECS_CONTAINER_INSIGHTS_ON_VALUES: readonly string[] = Object.freeze([
  'enabled',
  'enhanced',
]);

/**
 * Whether a `containerInsights` setting value means the feature is on.
 *
 * An allowlist rather than `!== 'disabled'`, and the difference is which way it
 * fails on a value neither we nor the caller recognises.
 *
 * `!== 'disabled'` fails **open**: an unrecognised value — a fourth mode AWS
 * adds later, a malformed response, a typo in a hand-edited fixture — reads as
 * on, and the collector spends real money issuing `GetMetricData` for a
 * namespace that may publish nothing. Decision INFRA-COST is explicit that
 * spend must never be implicit, and this module already treats an unrecorded
 * feature as off for the same reason.
 *
 * The allowlist fails **closed**: an unrecognised value reads as off, which
 * costs nothing and is *visible* — the Metrics tab says Container Insights is
 * off for the cluster and names what it would cost to enable. A wrong answer
 * the operator can see beats a silent charge. The caller logs the value so a
 * genuine AWS addition is diagnosable rather than a mystery.
 */
export function isContainerInsightsOnValue(value: string | null | undefined): boolean {
  return (
    typeof value === 'string' && ECS_CONTAINER_INSIGHTS_ON_VALUES.includes(value.toLowerCase())
  );
}

/**
 * Whether a cluster has Container Insights on.
 *
 * An absent setting is not "off". AWS returns `settings: []` for a cluster that
 * was never configured explicitly, and such a cluster inherits the account-level
 * `containerInsights` setting — so the caller resolves that once per sweep and
 * passes it in as `accountDefault`.
 */
export function clusterHasContainerInsights(
  cluster: Pick<Cluster, 'settings'>,
  accountDefault: string | null,
): boolean {
  const setting = (cluster.settings ?? []).find((s) => s.name === ECS_CONTAINER_INSIGHTS_FEATURE);
  const value = setting?.value ?? accountDefault;
  if (value != null && value !== '' && !isContainerInsightsOnValue(value)) {
    // 'disabled' is expected and silent; anything else means AWS is reporting a
    // value this build does not know, and the consequence is that a paid
    // feature reads as off. Say so rather than letting the charts look broken.
    if (value.toLowerCase() !== 'disabled') {
      console.warn(
        `[infra-inventory-sync] unrecognised containerInsights value '${value}'; ` +
          `treating Container Insights as off. Known values: ` +
          `${[...ECS_CONTAINER_INSIGHTS_ON_VALUES, 'disabled'].join(', ')}`,
      );
    }
    return false;
  }
  return isContainerInsightsOnValue(value);
}

/**
 * The account-wide `containerInsights` default, or `null` when it cannot be read.
 *
 * `effectiveSettings: true` asks AWS to resolve the value that actually applies
 * rather than only what was explicitly set. A failure here is swallowed and
 * treated as unknown: `ListAccountSettings` is a separate IAM action from the
 * describe calls, and a deployment whose role omits it should still get an
 * inventory — the clusters that set the value explicitly (most of them) are
 * unaffected, and the rest fall back to "off", which under-collects rather than
 * bills for a namespace that may not exist.
 */
async function resolveAccountContainerInsights(
  client: EcsDescribeClient,
  scope: InfraScopeRow,
): Promise<string | null> {
  try {
    const out = await client.send(
      new ListAccountSettingsCommand({
        name: ECS_CONTAINER_INSIGHTS_FEATURE,
        effectiveSettings: true,
      }),
    );
    const setting = (out.settings ?? []).find((s) => s.name === ECS_CONTAINER_INSIGHTS_FEATURE);
    return setting?.value ?? null;
  } catch (err) {
    console.warn(
      `[infra-inventory-sync] ${describeScope(scope)}: could not read the account containerInsights default —`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Every cluster ARN in the region, following `nextToken`. */
async function listEcsClusterArns(
  client: EcsDescribeClient,
  scope: InfraScopeRow,
): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const out = await client.send(
      new ListClustersCommand({
        maxResults: ECS_LIST_PAGE_SIZE,
        ...(nextToken ? { nextToken } : {}),
      }),
    );
    arns.push(...(out.clusterArns ?? []));
    nextToken = out.nextToken ?? undefined;
    pages += 1;
  } while (nextToken && pages < MAX_PAGES_PER_SCOPE);
  if (nextToken) {
    console.warn(
      `[infra-inventory-sync] ${describeScope(scope)}: stopped listing clusters at the ${MAX_PAGES_PER_SCOPE}-page cap; inventory may be incomplete`,
    );
  }
  return arns;
}

/** Every service ARN in one cluster, following `nextToken`. */
async function listEcsServiceArns(
  client: EcsDescribeClient,
  scope: InfraScopeRow,
  clusterArn: string,
): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    const out = await client.send(
      new ListServicesCommand({
        cluster: clusterArn,
        // Explicit, because `ListServices` defaults to **10** results per page
        // where every other ECS list defaults to 100. Omitting it would turn a
        // 200-service cluster into 20 round trips instead of 2.
        maxResults: ECS_LIST_PAGE_SIZE,
        ...(nextToken ? { nextToken } : {}),
      }),
    );
    arns.push(...(out.serviceArns ?? []));
    nextToken = out.nextToken ?? undefined;
    pages += 1;
  } while (nextToken && pages < MAX_PAGES_PER_SCOPE);
  if (nextToken) {
    console.warn(
      `[infra-inventory-sync] ${describeScope(scope)}: stopped listing services in ${clusterArn} at the ${MAX_PAGES_PER_SCOPE}-page cap`,
    );
  }
  return arns;
}

/** Split a list into fixed-size batches for the batch-describe APIs. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toClusterResource(
  cluster: Cluster,
  scope: InfraScopeRow,
  accountDefault: string | null,
): DiscoveredResource | null {
  const clusterName = cluster.clusterName ?? nameFromArn(cluster.clusterArn);
  if (!clusterName) return null;
  const accountId = accountIdFromArn(cluster.clusterArn) ?? scope.account_id;
  if (!accountId) return null;

  const tags = normalizeEcsTags(cluster.tags);
  return {
    accountId,
    resourceId: clusterName,
    name: clusterName,
    tagsJson: tags.length > 0 ? JSON.stringify(tags) : null,
    environment: tagValue(tags, 'Environment'),
    // ACTIVE / PROVISIONING / DEPROVISIONING / FAILED / INACTIVE.
    state: cluster.status ?? null,
    metricDimensions: { ClusterName: clusterName },
    features: {
      [ECS_CONTAINER_INSIGHTS_FEATURE]: clusterHasContainerInsights(cluster, accountDefault),
    },
  };
}

function toServiceResource(
  service: EcsService,
  clusterName: string,
  containerInsights: boolean,
  scope: InfraScopeRow,
): DiscoveredResource | null {
  const serviceName = service.serviceName ?? nameFromArn(service.serviceArn);
  if (!serviceName) return null;
  const accountId = accountIdFromArn(service.serviceArn) ?? scope.account_id;
  if (!accountId) return null;

  const tags = normalizeEcsTags(service.tags);
  return {
    accountId,
    // `cluster/service`, because a service name is unique only within its
    // cluster and `resource_id` has to be unique per (project, account, region,
    // service token). It also reads correctly in the inventory browser, where
    // "api" on its own would be ambiguous across clusters.
    resourceId: `${clusterName}/${serviceName}`,
    name: serviceName,
    tagsJson: tags.length > 0 ? JSON.stringify(tags) : null,
    environment: tagValue(tags, 'Environment'),
    // ACTIVE / DRAINING / INACTIVE. INACTIVE is ECS's "deleted", and the
    // collector treats it as terminal.
    state: service.status ?? null,
    metricDimensions: { ClusterName: clusterName, ServiceName: serviceName },
    // A service inherits the setting from its cluster: Container Insights is a
    // cluster-level switch, and the paid service-level series exist or not with
    // it. Copied onto the row so the collector never has to join to the cluster
    // while planning queries.
    features: { [ECS_CONTAINER_INSIGHTS_FEATURE]: containerInsights },
  };
}

/**
 * Walk one ECS scope: clusters, then the services in each cluster.
 *
 * Four APIs, in the order decision INFRA-COLLECT requires (describe-first,
 * never `ListMetrics`): `ListClusters` → `DescribeClusters` → `ListServices` →
 * `DescribeServices`. `DescribeClusters` is asked for `SETTINGS` as well as
 * `TAGS`, because the Container Insights setting it returns is what decides
 * whether the paid `ECS/ContainerInsights` metrics are collected at all.
 *
 * Unlike EC2, the tag filter cannot be pushed into the API — neither
 * `ListServices` nor `DescribeServices` takes one — so it is applied here after
 * the describe. The same parser the collector re-applies at query time is used,
 * so a malformed filter throws and fails the scope rather than silently
 * widening it to the whole region.
 */
async function describeEcsScope(
  client: EcsDescribeClient,
  scope: InfraScopeRow,
): Promise<{ resources: DiscoveredResource[]; skipped: number }> {
  const tagFilter = compileInfraTagFilter(scope.tag_filter_json);
  const filtered = !isEmptyInfraTagFilter(tagFilter);
  const accountDefault = await resolveAccountContainerInsights(client, scope);

  const resources: DiscoveredResource[] = [];
  let skipped = 0;

  const clusterArns = await listEcsClusterArns(client, scope);
  for (const batch of chunk(clusterArns, ECS_DESCRIBE_CLUSTERS_BATCH)) {
    const out = await client.send(
      new DescribeClustersCommand({ clusters: batch, include: ['SETTINGS', 'TAGS'] }),
    );
    for (const cluster of out.clusters ?? []) {
      const row = toClusterResource(cluster, scope, accountDefault);
      if (!row) {
        skipped += 1;
        continue;
      }
      const containerInsights = row.features[ECS_CONTAINER_INSIGHTS_FEATURE] === true;
      // The cluster itself is filtered like any other resource, but its
      // services are still enumerated: an operator who tagged their services
      // and not their clusters would otherwise get nothing at all.
      if (!filtered || matchesInfraTagFilter(row.tagsJson, tagFilter)) resources.push(row);

      const clusterName = row.resourceId;
      const serviceArns = await listEcsServiceArns(
        client,
        scope,
        cluster.clusterArn ?? clusterName,
      );
      for (const serviceBatch of chunk(serviceArns, ECS_DESCRIBE_SERVICES_BATCH)) {
        const described = await client.send(
          new DescribeServicesCommand({
            cluster: cluster.clusterArn ?? clusterName,
            services: serviceBatch,
            include: ['TAGS'],
          }),
        );
        for (const service of described.services ?? []) {
          const serviceRow = toServiceResource(service, clusterName, containerInsights, scope);
          if (!serviceRow) {
            skipped += 1;
            continue;
          }
          if (filtered && !matchesInfraTagFilter(serviceRow.tagsJson, tagFilter)) continue;
          resources.push(serviceRow);
        }
      }
    }
  }

  return { resources, skipped };
}

// ─── Elastic Load Balancing v2 (ALB + NLB) ──────────────────────────────────

/**
 * The CloudWatch `LoadBalancer` dimension value out of a load balancer ARN.
 *
 * AWS: "Specify the load balancer as follows: `app/load-balancer-name/
 * 1234567890123456` (the final portion of the load balancer ARN)." That final
 * portion is everything after `loadbalancer/`, and it keeps the `app/` or `net/`
 * discriminator — which is the only thing in the dimension *value* that says
 * which namespace the series belongs to, since the dimension *name* is
 * `LoadBalancer` on both services.
 */
export function loadBalancerDimensionValue(arn: string | undefined): string | null {
  if (!arn) return null;
  const marker = ':loadbalancer/';
  const at = arn.indexOf(marker);
  if (at < 0) return null;
  const tail = arn.slice(at + marker.length);
  return tail.length > 0 ? tail : null;
}

/**
 * The CloudWatch `TargetGroup` dimension value out of a target group ARN.
 *
 * AWS: "Specify the target group as follows: `targetgroup/target-group-name/
 * 1234567890123456` (the final portion of the target group ARN)." Note the
 * literal `targetgroup/` prefix is part of the value, unlike an ECS name.
 */
export function targetGroupDimensionValue(arn: string | undefined): string | null {
  if (!arn) return null;
  const marker = ':targetgroup/';
  const at = arn.indexOf(marker);
  if (at < 0) return null;
  const tail = arn.slice(at + marker.length);
  return tail.length > 0 ? `targetgroup/${tail}` : null;
}

/** Every load balancer in the region, following ELBv2's `Marker` pagination. */
async function listLoadBalancers(
  client: ElbDescribeClient,
  scope: InfraScopeRow,
): Promise<LoadBalancer[]> {
  const out: LoadBalancer[] = [];
  // ELBv2 pages on `Marker`/`NextMarker`, not the `NextToken` that EC2 and ECS
  // use. Same loop shape, different field names — worth stating because the two
  // sit side by side in this file.
  let marker: string | undefined;
  let pages = 0;
  do {
    const page = await client.send(
      new DescribeLoadBalancersCommand({
        PageSize: ELB_PAGE_SIZE,
        ...(marker ? { Marker: marker } : {}),
      }),
    );
    out.push(...(page.LoadBalancers ?? []));
    marker = page.NextMarker ?? undefined;
    pages += 1;
  } while (marker && pages < MAX_PAGES_PER_SCOPE);
  if (marker) {
    console.warn(
      `[infra-inventory-sync] ${describeScope(scope)}: stopped listing load balancers at the ${MAX_PAGES_PER_SCOPE}-page cap; inventory may be incomplete`,
    );
  }
  return out;
}

/**
 * Every target group in the region, following `Marker` pagination.
 *
 * Deliberately unfiltered rather than one `DescribeTargetGroups` call per load
 * balancer: the API takes a single optional `LoadBalancerArn`, so filtering
 * would be N calls for N load balancers where one paginated walk answers for
 * all of them. The caller discards target groups whose parent is out of scope.
 */
async function listTargetGroups(
  client: ElbDescribeClient,
  scope: InfraScopeRow,
): Promise<TargetGroup[]> {
  const out: TargetGroup[] = [];
  let marker: string | undefined;
  let pages = 0;
  do {
    const page = await client.send(
      new DescribeTargetGroupsCommand({
        PageSize: ELB_PAGE_SIZE,
        ...(marker ? { Marker: marker } : {}),
      }),
    );
    out.push(...(page.TargetGroups ?? []));
    marker = page.NextMarker ?? undefined;
    pages += 1;
  } while (marker && pages < MAX_PAGES_PER_SCOPE);
  if (marker) {
    console.warn(
      `[infra-inventory-sync] ${describeScope(scope)}: stopped listing target groups at the ${MAX_PAGES_PER_SCOPE}-page cap`,
    );
  }
  return out;
}

/** The error `name` / `Code` off an AWS SDK error, whichever it carries. */
function awsErrorName(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const e = err as { name?: string; Code?: string };
  return e.name ?? e.Code ?? '';
}

/**
 * Whether a `DescribeTags` failure is the documented "one ARN in the batch is
 * gone" race.
 *
 * `DescribeTags` is all-or-nothing, so a single load balancer or target group
 * deleted between the describe walk and this call fails the whole batch of 20
 * with `LoadBalancerNotFound` / `TargetGroupNotFound`. The SDK suffixes modelled
 * exceptions with `Exception`, and the wire code does not, so the match is on
 * the shared substring rather than an exact name list.
 */
export function isElbTagNotFoundError(err: unknown): boolean {
  return /NotFound/i.test(awsErrorName(err));
}

/**
 * Whether an AWS error is a permissions failure.
 *
 * Checked by name rather than status alone because AWS is not consistent about
 * the status: `UnauthorizedOperation` from EC2 arrives as a 403, but several
 * services return `AccessDeniedException` on a 400.
 */
export function isAwsAuthorizationError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 403) {
    return true;
  }
  return /AccessDenied|Unauthorized|AuthFailure|Forbidden/i.test(awsErrorName(err));
}

/**
 * Tags for a batch of ELBv2 ARNs, as `arn → [{Key,Value}]`.
 *
 * ELBv2 is the one service here whose describe response carries no tags at all,
 * so this is a mandatory second call rather than an enrichment — and that is
 * what makes its failure mode dangerous rather than cosmetic. A scope with a
 * tag filter matches resources *against these tags*, so a tag call that quietly
 * returns nothing does not merely drop names: it drops **every resource in the
 * scope** while the sweep reports success. An empty Resources tab and a green
 * sync is the worst combination this module can produce.
 *
 * So exactly one failure degrades, and everything else fails the scope:
 *
 *   - **A not-found race degrades.** One ARN deleted between the describe and
 *     this call is expected, self-correcting, and costs that batch its tags.
 *     Failing the region's whole inventory over it would be the wrong trade.
 *   - **Anything else throws**, including `AccessDenied`. That is the live
 *     upgrade hazard: `elasticloadbalancing:DescribeTags` was added to the
 *     published policy after the load balancer packs shipped, so a role created
 *     against the older document has the describe grants and not this one.
 *     Degrading there would present a silently empty — or silently unfiltered —
 *     inventory indefinitely. A failed scope is counted, logged with the action
 *     to grant, retried on the next hourly tick, and confined to this scope;
 *     every other service and region still syncs.
 */
/**
 * Re-throw a `DescribeTags` failure the caller decided not to absorb.
 *
 * Shared by the batch call and the per-ARN retry so both surface an
 * `AccessDenied` the same way — the retry path is exactly where a permissions
 * failure would otherwise be mistaken for more of the deletion race.
 */
function throwElbTagError(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err);
  if (isAwsAuthorizationError(err)) {
    throw new Error(
      `elasticloadbalancing:DescribeTags was denied. ELBv2 describe responses carry no tags, so without it every load balancer and target group loses its name and any tag filter on this scope would match nothing. Grant the action to the monitoring role — see docs/guides/aws-monitoring-iam. (${detail})`,
    );
  }
  throw new Error(`could not read ELBv2 tags: ${detail}`);
}

/** One `DescribeTags` call, writing what it returns into `byArn`. */
async function describeTagsInto(
  client: ElbDescribeClient,
  byArn: Map<string, Array<{ Key: string; Value: string }>>,
  arns: string[],
): Promise<void> {
  const out = await client.send(new DescribeTagsCommand({ ResourceArns: arns }));
  for (const description of out.TagDescriptions ?? []) {
    if (!description.ResourceArn) continue;
    byArn.set(
      description.ResourceArn,
      (description.Tags ?? [])
        .filter((t): t is { Key: string; Value?: string } => typeof t.Key === 'string')
        .map((t) => ({ Key: t.Key, Value: t.Value ?? '' })),
    );
  }
}

async function fetchElbTags(
  client: ElbDescribeClient,
  scope: InfraScopeRow,
  arns: string[],
): Promise<Map<string, Array<{ Key: string; Value: string }>>> {
  const byArn = new Map<string, Array<{ Key: string; Value: string }>>();
  for (const batch of chunk(arns, ELB_DESCRIBE_TAGS_BATCH)) {
    try {
      await describeTagsInto(client, byArn, batch);
      continue;
    } catch (err) {
      if (!isElbTagNotFoundError(err)) throwElbTagError(err);
      // Fall through to the per-ARN recovery below.
    }

    // The deletion race, and the reason it cannot simply be absorbed: the batch
    // is all-or-nothing, so one deleted ARN costs the other nineteen their
    // tags — and on a tag-filtered scope a resource with no tags does not match,
    // so nineteen live load balancers would silently vanish from the inventory
    // until a later sweep happened to batch them differently. Re-asking one ARN
    // at a time isolates the casualty. It costs at most `ELB_DESCRIBE_TAGS_BATCH`
    // extra calls, only for a batch that actually raced, on an hourly sweep.
    if (batch.length === 1) {
      console.warn(
        `[infra-inventory-sync] ${describeScope(scope)}: ${batch[0]} disappeared before its tags could be read`,
      );
      continue;
    }

    let lost = 0;
    for (const arn of batch) {
      try {
        await describeTagsInto(client, byArn, [arn]);
      } catch (err) {
        // Still not found on its own: this is the resource that was actually
        // deleted. Anything else on the retry is a real failure and is thrown,
        // so a permissions error cannot hide inside the race handling.
        if (!isElbTagNotFoundError(err)) throwElbTagError(err);
        lost += 1;
      }
    }
    console.warn(
      `[infra-inventory-sync] ${describeScope(scope)}: ${lost} of ${batch.length} resource(s) disappeared before their tags could be read; recovered tags for the rest`,
    );
  }
  return byArn;
}

/** One load balancer row, keyed on the CloudWatch `LoadBalancer` dimension. */
function toLoadBalancerResource(
  lb: LoadBalancer,
  tags: Array<{ Key: string; Value: string }>,
  scope: InfraScopeRow,
): DiscoveredResource | null {
  const dimension = loadBalancerDimensionValue(lb.LoadBalancerArn);
  if (!dimension) return null;
  const accountId = accountIdFromArn(lb.LoadBalancerArn) ?? scope.account_id;
  if (!accountId) return null;

  return {
    accountId,
    // The dimension value, not the bare name: it is unique within the account
    // and region (the name is not, across load balancer types) and it is the
    // identity CloudWatch itself uses.
    resourceId: dimension,
    name: lb.LoadBalancerName ?? dimension,
    tagsJson: tags.length > 0 ? JSON.stringify(tags) : null,
    environment: tagValue(tags, 'Environment'),
    // active / provisioning / active_impaired / failed.
    state: lb.State?.Code ?? null,
    metricDimensions: { LoadBalancer: dimension },
    features: {},
  };
}

/**
 * One target group row, keyed on `LoadBalancer` + `TargetGroup`.
 *
 * These rows are not optional decoration: AWS publishes `HealthyHostCount` and
 * `UnHealthyHostCount` only at this dimension pair, so without a target-group
 * row the host-count metrics and all four host-count default rules in both
 * load balancer packs have nothing to collect against.
 */
function toTargetGroupResource(
  tg: TargetGroup,
  loadBalancerDimension: string,
  tags: Array<{ Key: string; Value: string }>,
  scope: InfraScopeRow,
): DiscoveredResource | null {
  const dimension = targetGroupDimensionValue(tg.TargetGroupArn);
  if (!dimension) return null;
  const accountId = accountIdFromArn(tg.TargetGroupArn) ?? scope.account_id;
  if (!accountId) return null;

  return {
    accountId,
    // Prefixed with the load balancer so the inventory browser reads correctly
    // and so the row cannot collide with the same target group reachable from
    // another scope. The dimension values themselves stay unprefixed.
    resourceId: `${loadBalancerDimension}/${dimension}`,
    name: tg.TargetGroupName ?? dimension,
    tagsJson: tags.length > 0 ? JSON.stringify(tags) : null,
    environment: tagValue(tags, 'Environment'),
    // A target group has no lifecycle state of its own in the describe
    // response; its health is the metric, not an attribute.
    state: null,
    metricDimensions: { LoadBalancer: loadBalancerDimension, TargetGroup: dimension },
    features: {},
  };
}

/**
 * Describe one ALB or NLB scope: load balancers of the scope's type, plus the
 * target groups attached to them.
 *
 * Three calls per scope regardless of size — one paginated walk each for load
 * balancers and target groups, then batched `DescribeTags`.
 *
 * The tag filter is applied client-side because no ELBv2 describe API accepts
 * one, and it is applied to load balancers and target groups independently: an
 * operator who tagged their load balancers but not their target groups would
 * otherwise lose the host-count rows, which are the only reason target groups
 * are collected at all.
 */
async function describeElbScope(
  client: ElbDescribeClient,
  scope: InfraScopeRow,
): Promise<{ resources: DiscoveredResource[]; skipped: number }> {
  const wantedType = ELB_TYPE_BY_SERVICE[scope.service];
  if (!wantedType) throw new Error(`no ELBv2 type mapped for service '${scope.service}'`);

  const tagFilter = compileInfraTagFilter(scope.tag_filter_json);
  const filtered = !isEmptyInfraTagFilter(tagFilter);

  const loadBalancers = (await listLoadBalancers(client, scope)).filter(
    (lb) => lb.Type === wantedType,
  );
  if (loadBalancers.length === 0) return { resources: [], skipped: 0 };

  // A target group belongs to at most one load balancer — AWS documents
  // `LoadBalancerArns` as "you can use each target group with only one load
  // balancer", backed by a non-adjustable quota of 1. The array shape is
  // handled rather than trusted, but an unattached target group (0 entries)
  // publishes no host counts and is dropped.
  const inScope = new Map<string, string>();
  for (const lb of loadBalancers) {
    const dimension = loadBalancerDimensionValue(lb.LoadBalancerArn);
    if (dimension && lb.LoadBalancerArn) inScope.set(lb.LoadBalancerArn, dimension);
  }
  const targetGroups = (await listTargetGroups(client, scope)).filter((tg) =>
    (tg.LoadBalancerArns ?? []).some((arn) => inScope.has(arn)),
  );

  const tags = await fetchElbTags(client, scope, [
    ...loadBalancers.map((lb) => lb.LoadBalancerArn).filter((a): a is string => Boolean(a)),
    ...targetGroups.map((tg) => tg.TargetGroupArn).filter((a): a is string => Boolean(a)),
  ]);

  const resources: DiscoveredResource[] = [];
  let skipped = 0;

  for (const lb of loadBalancers) {
    const row = toLoadBalancerResource(lb, tags.get(lb.LoadBalancerArn ?? '') ?? [], scope);
    if (!row) {
      skipped += 1;
      continue;
    }
    if (!filtered || matchesInfraTagFilter(row.tagsJson, tagFilter)) resources.push(row);
  }

  for (const tg of targetGroups) {
    const parentArn = (tg.LoadBalancerArns ?? []).find((arn) => inScope.has(arn));
    const parent = parentArn ? inScope.get(parentArn) : undefined;
    if (!parent) {
      skipped += 1;
      continue;
    }
    const row = toTargetGroupResource(tg, parent, tags.get(tg.TargetGroupArn ?? '') ?? [], scope);
    if (!row) {
      skipped += 1;
      continue;
    }
    if (filtered && !matchesInfraTagFilter(row.tagsJson, tagFilter)) continue;
    resources.push(row);
  }

  return { resources, skipped };
}

// ─── NAT Gateway ────────────────────────────────────────────────────────────

/**
 * AWS's two `availabilityMode` values, and the one this pack can collect.
 *
 * "Indicates whether this is a zonal (single-AZ) or regional (multi-AZ) NAT
 * gateway." A zonal gateway publishes at `NatGatewayId` alone; a regional one
 * publishes at `NatGatewayId` **together with** `AvailabilityZone`, which is a
 * different CloudWatch series and one the pack does not declare yet.
 */
const NATGW_MODE_REGIONAL = 'regional';

/**
 * The distinct Availability Zones a NAT gateway is currently serving.
 *
 * There is no top-level `AvailabilityZone` on the describe response; it hangs
 * off each `NatGatewayAddresses` entry ("The Availability Zone where this
 * Elastic IP address (EIP) is being used to handle outbound NAT traffic"). For a
 * regional gateway that set is also dynamic, since AWS expands and contracts its
 * AZ coverage.
 */
function natGatewayZones(gateway: NatGateway): string[] {
  const zones = new Set<string>();
  for (const address of gateway.NatGatewayAddresses ?? []) {
    if (address.AvailabilityZone) zones.add(address.AvailabilityZone);
  }
  return [...zones].sort();
}

/**
 * One NAT gateway row.
 *
 * The dimension map is the whole point of the branch here. A **zonal** gateway
 * gets `{ NatGatewayId }`, which is exactly what every pack metric declares, so
 * it collects. A **regional** gateway gets `{ NatGatewayId, AvailabilityZone }`,
 * a two-name set that matches no declared metric, so `bindMetricDimensions`
 * refuses it and the collector issues no query for it at all.
 *
 * That refusal is deliberate and is the cheaper of the two failures. Writing
 * `{ NatGatewayId }` for a regional gateway would look right and bill a
 * `GetMetricData` entry per metric per tick, forever, for a series AWS does not
 * publish at that dimension — and the resulting empty charts would be
 * indistinguishable from broken collection. Leaving the map off entirely is
 * worse still: `resolveResourceDimensions` would synthesise `{ NatGatewayId }`
 * from the service's unambiguous single dimension and bill for it anyway.
 *
 * So a regional gateway is inventoried, visible, and silent — and the pack's
 * "Regional NAT gateway metrics" absent-metric note explains the empty tab.
 * When a later card declares the regional dimension set, these rows begin
 * collecting with no change here.
 */
function toNatGatewayResource(
  gateway: NatGateway,
  zone: string | null,
  scope: InfraScopeRow,
): DiscoveredResource | null {
  const natGatewayId = gateway.NatGatewayId;
  if (!natGatewayId) return null;
  // NAT gateways carry no ARN in the describe response and no owner id, so the
  // scope's account is the only source. It stays NULL until something has run
  // sts:GetCallerIdentity for the profile, and a row with no account has no
  // derivable resource_key.
  const accountId = scope.account_id;
  if (!accountId) return null;

  const tags = (gateway.Tags ?? [])
    .filter((t): t is { Key: string; Value?: string } => typeof t.Key === 'string')
    .map((t) => ({ Key: t.Key, Value: t.Value ?? '' }));

  return {
    accountId,
    // Regional gateways get one row per Availability Zone, because CloudWatch
    // publishes one series per zone and a single row can hold only one
    // dimension map. The suffix keeps `resource_id` unique per (project,
    // account, region, service).
    resourceId: zone ? `${natGatewayId}@${zone}` : natGatewayId,
    name: tagValue(tags, 'Name') ?? natGatewayId,
    tagsJson: tags.length > 0 ? JSON.stringify(tags) : null,
    environment: tagValue(tags, 'Environment'),
    // pending / failed / available / deleting / deleted.
    state: gateway.State ?? null,
    metricDimensions: zone
      ? { NatGatewayId: natGatewayId, AvailabilityZone: zone }
      : { NatGatewayId: natGatewayId },
    features: {},
  };
}

/**
 * Describe every in-scope NAT gateway, following pagination.
 *
 * Unlike ELBv2, EC2 returns tags inline and accepts a server-side `tag:<key>`
 * filter, so the scope's filter is pushed into the API rather than applied
 * afterwards — the same trade the EC2 instance walk makes.
 */
async function describeNatGatewayScope(
  client: Ec2DescribeClient,
  scope: InfraScopeRow,
): Promise<{ resources: DiscoveredResource[]; skipped: number }> {
  const filters = buildEc2TagFilters(scope.tag_filter_json);
  const resources: DiscoveredResource[] = [];
  let skipped = 0;
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const out = await client.send(
      new DescribeNatGatewaysCommand({
        MaxResults: NATGW_PAGE_SIZE,
        ...(filters.length > 0 ? { Filter: filters } : {}),
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    for (const gateway of out.NatGateways ?? []) {
      // An absent availabilityMode reads as zonal: the field postdates the
      // regional feature, so every gateway that predates it is zonal, and zonal
      // is also the arm that collects. Guessing "regional" for an unknown value
      // would silently stop collecting a gateway that works.
      const regional =
        typeof gateway.AvailabilityMode === 'string' &&
        gateway.AvailabilityMode.toLowerCase() === NATGW_MODE_REGIONAL;
      const zones = regional ? natGatewayZones(gateway) : [];

      if (regional && zones.length === 0) {
        // A regional gateway with no resolvable zone has no dimension map we
        // can write that is both honest and non-billing, so it is counted
        // rather than guessed at.
        skipped += 1;
        continue;
      }

      const rows = regional
        ? zones.map((zone) => toNatGatewayResource(gateway, zone, scope))
        : [toNatGatewayResource(gateway, null, scope)];
      for (const row of rows) {
        if (row) resources.push(row);
        else skipped += 1;
      }
    }
    nextToken = out.NextToken ?? undefined;
    pages += 1;
  } while (nextToken && pages < MAX_PAGES_PER_SCOPE);

  if (nextToken) {
    console.warn(
      `[infra-inventory-sync] ${describeScope(scope)}: stopped at the ${MAX_PAGES_PER_SCOPE}-page cap; inventory may be incomplete`,
    );
  }
  return { resources, skipped };
}

/**
 * Persist one scope's discovered resources.
 *
 * `first_seen` is written once and never overwritten — it is the answer to
 * "how long have we known about this?", which an upsert that refreshed it
 * would destroy. Everything else is refreshed from the live describe, so a
 * renamed or re-tagged instance converges on the next tick.
 *
 * There is no delete pass by design (decision INFRA-SCOPE): absence is
 * expressed as a stale `last_seen`, so a chart keeps its subject.
 */
function upsertResources(
  scope: InfraScopeRow,
  resources: DiscoveredResource[],
  nowMs: number,
): number {
  const db = getInfraDb();
  const stmt = db.prepare(`
    INSERT INTO infra_resources (
      resource_key, project_id, account_id, region, service, resource_id,
      name, tags_json, environment, state, metric_dimensions_json, features_json,
      first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_key) DO UPDATE SET
      name = excluded.name,
      tags_json = excluded.tags_json,
      environment = excluded.environment,
      state = excluded.state,
      -- Refreshed every sweep, like everything else derived from the live
      -- describe. A cluster where an operator just turned Container Insights on
      -- starts collecting the paid metrics on the next collector tick, and one
      -- where they turned it off stops being billed for them.
      metric_dimensions_json = excluded.metric_dimensions_json,
      features_json = excluded.features_json,
      last_seen = excluded.last_seen
  `);

  const run = db.transaction((rows: DiscoveredResource[]) => {
    for (const row of rows) {
      const key = infraResourceKey({
        projectId: scope.project_id,
        accountId: row.accountId,
        region: scope.region,
        service: scope.service,
        resourceId: row.resourceId,
      });
      stmt.run(
        key,
        scope.project_id,
        row.accountId,
        scope.region,
        scope.service,
        row.resourceId,
        row.name,
        row.tagsJson,
        row.environment,
        row.state,
        JSON.stringify(row.metricDimensions),
        // NULL rather than `{}` for a service with no gated metrics: an empty
        // object and an absent one mean the same thing to the collector, and
        // the NULL keeps the column honest about there being nothing to record.
        Object.keys(row.features).length > 0 ? JSON.stringify(row.features) : null,
        nowMs,
        nowMs,
      );
    }
  });
  run(resources);
  return resources.length;
}

/**
 * Describe one scope with the right provider client.
 *
 * The dispatch is on the scope's own service token, which is also what
 * {@link listSyncableScopes} filters on, so an unknown service can only reach
 * here if the two lists drift — hence the throw rather than a silent no-op.
 */
async function syncScope(
  scope: InfraScopeRow,
  opts: InfraInventorySyncOptions,
  nowMs: number,
): Promise<{ upserted: number; skipped: number }> {
  const clientOpts = { profileName: scope.profile_name, region: scope.region };
  let discovered: { resources: DiscoveredResource[]; skipped: number };

  if (scope.service === EC2_SERVICE) {
    const client = opts.ec2ClientFactory
      ? opts.ec2ClientFactory(scope)
      : getProjectEc2Client(scope.project_id, clientOpts);
    discovered = await describeEc2Scope(client, scope);
  } else if (scope.service === ECS_SERVICE) {
    const client = opts.ecsClientFactory
      ? opts.ecsClientFactory(scope)
      : getProjectEcsClient(scope.project_id, clientOpts);
    discovered = await describeEcsScope(client, scope);
  } else if (scope.service === ALB_SERVICE || scope.service === NLB_SERVICE) {
    const client = opts.elbClientFactory
      ? opts.elbClientFactory(scope)
      : getProjectElbV2Client(scope.project_id, clientOpts);
    discovered = await describeElbScope(client, scope);
  } else if (scope.service === NATGW_SERVICE) {
    // NAT gateways are an EC2 API, so this shares the instance walk's client
    // and its cache entry rather than opening a second connection pool.
    const client = opts.ec2ClientFactory
      ? opts.ec2ClientFactory(scope)
      : getProjectEc2Client(scope.project_id, clientOpts);
    discovered = await describeNatGatewayScope(client, scope);
  } else {
    throw new Error(`no inventory describer for service '${scope.service}'`);
  }

  return {
    upserted: upsertResources(scope, discovered.resources, nowMs),
    skipped: discovered.skipped,
  };
}

/** Enabled scope rows this sweep knows how to describe. */
function listSyncableScopes(): InfraScopeRow[] {
  const placeholders = INFRA_SYNCABLE_SERVICES.map(() => '?').join(', ');
  return getInfraDb()
    .prepare(
      `SELECT id, project_id, profile_name, account_id, region, service, tag_filter_json
         FROM infra_scopes
        WHERE enabled = 1 AND service IN (${placeholders})
        ORDER BY project_id, region, profile_name, service`,
    )
    .all(...INFRA_SYNCABLE_SERVICES) as InfraScopeRow[];
}

/**
 * Run one inventory sweep across every enabled scope.
 *
 * Never throws: a scope that fails is counted, logged, and stepped over, so one
 * region with an expired role or a revoked IAM grant cannot cost every other
 * region its inventory. Scopes run sequentially rather than fanned out —
 * describe calls are cheap but rate-limited per account, and an hourly job has
 * no reason to spend concurrency it does not need.
 */
export async function runInfraInventorySync(
  opts: InfraInventorySyncOptions = {},
): Promise<InfraInventorySyncResult> {
  const result: InfraInventorySyncResult = {
    scopes: 0,
    synced: 0,
    failed: 0,
    upserted: 0,
    skipped: 0,
  };
  // The sweep is scheduled unconditionally at boot, but infra.db only exists
  // once initInfraDb() has run. A no-op beats a thrown tick on a Hub that has
  // not opened the store.
  if (!isInfraDbInitialized()) return result;

  const scopes = listSyncableScopes();
  result.scopes = scopes.length;
  const nowMs = opts.nowMs ?? Date.now();

  for (const scope of scopes) {
    try {
      const { upserted, skipped } = await syncScope(scope, opts, nowMs);
      result.synced += 1;
      result.upserted += upserted;
      result.skipped += skipped;
    } catch (err) {
      result.failed += 1;
      console.warn(
        `[infra-inventory-sync] ${describeScope(scope)} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (result.skipped > 0) {
    console.warn(
      `[infra-inventory-sync] skipped ${result.skipped} resource(s) with no resolvable account id`,
    );
  }
  return result;
}
