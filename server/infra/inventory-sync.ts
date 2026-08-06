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
 * This ticket seeds EC2. Other services are additive: add a describer and a
 * branch in {@link syncScope}.
 */

import {
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  type Filter,
  type Instance,
} from '@aws-sdk/client-ec2';
import { getInfraDb, isInfraDbInitialized, infraResourceKey } from './infra-db.js';
import { getProjectEc2Client } from './aws-clients.js';

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

/** Service token this ticket implements. */
const EC2_SERVICE = 'ec2';

/**
 * Page cap for a single scope's `DescribeInstances` pagination.
 *
 * At the API's 1,000-results-per-page maximum this is 100,000 instances in one
 * region, far past any plausible scope. It exists so a malformed or looping
 * `NextToken` cannot spin a tick forever holding a client open.
 */
const MAX_PAGES_PER_SCOPE = 100;

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

/** Just enough of an `EC2Client` to describe instances; keeps tests SDK-free. */
export interface Ec2DescribeClient {
  send(command: DescribeInstancesCommand): Promise<DescribeInstancesCommandOutput>;
}

export interface InfraInventorySyncOptions {
  /** Injected clock so tests can assert on `first_seen` / `last_seen`. */
  nowMs?: number;
  /** Test seam: build the EC2 client for a scope. */
  ec2ClientFactory?: (scope: InfraScopeRow) => Ec2DescribeClient;
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
 * Stored format is `{"Key": ["v1","v2"]}` — a map of tag key to accepted
 * values, ANDed across keys and ORed within one, which is exactly EC2's own
 * filter semantics. A bare string is accepted as a single value.
 *
 * Throws on anything it cannot parse, and that direction is deliberate: the
 * caller turns the throw into a skipped scope. Degrading a broken filter to
 * "no filter" would silently widen the sweep to every instance in the region,
 * turning an operator typo into unbounded describe traffic and an inventory
 * they never opted into.
 */
export function buildEc2TagFilters(tagFilterJson: string | null): Filter[] {
  if (tagFilterJson === null || tagFilterJson.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(tagFilterJson);
  } catch (err) {
    throw new Error(`tag_filter_json is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tag_filter_json must be a JSON object of tag key -> value(s)');
  }

  const filters: Filter[] = [];
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === '') throw new Error('tag_filter_json contains an empty tag key');
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) {
      throw new Error(`tag_filter_json key "${key}" has no values`);
    }
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new Error(`tag_filter_json key "${key}" has a non-string value`);
      }
    }
    filters.push({ Name: `tag:${key}`, Values: values as string[] });
  }
  return filters;
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
      name, tags_json, environment, state, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_key) DO UPDATE SET
      name = excluded.name,
      tags_json = excluded.tags_json,
      environment = excluded.environment,
      state = excluded.state,
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
        nowMs,
        nowMs,
      );
    }
  });
  run(resources);
  return resources.length;
}

async function syncScope(
  scope: InfraScopeRow,
  opts: InfraInventorySyncOptions,
  nowMs: number,
): Promise<{ upserted: number; skipped: number }> {
  const client = opts.ec2ClientFactory
    ? opts.ec2ClientFactory(scope)
    : getProjectEc2Client(scope.project_id, {
        profileName: scope.profile_name,
        region: scope.region,
      });
  const { resources, skipped } = await describeEc2Scope(client, scope);
  return { upserted: upsertResources(scope, resources, nowMs), skipped };
}

/** Enabled scope rows this sweep knows how to describe. */
function listSyncableScopes(): InfraScopeRow[] {
  return getInfraDb()
    .prepare(
      `SELECT id, project_id, profile_name, account_id, region, service, tag_filter_json
         FROM infra_scopes
        WHERE enabled = 1 AND service = ?
        ORDER BY project_id, region, profile_name`,
    )
    .all(EC2_SERVICE) as InfraScopeRow[];
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
