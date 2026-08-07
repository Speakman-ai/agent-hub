/**
 * infra-resource-store.ts — reads over `infra_resources` and the series catalog
 * behind the Resources and Metrics tabs (decision INFRA-UI).
 *
 * Read-only by design. Inventory rows are written by the hourly describe sweep
 * (`inventory-sync.ts`) and nothing else; a browser that could also write them
 * would be a second source of truth for what exists in an AWS account, which is
 * the one thing this table is not allowed to be.
 *
 * Two properties shape the queries here:
 *
 *   - **Rows are never deleted.** Decision INFRA-SCOPE keeps a terminated
 *     instance in the table so it ages out of the UI on `last_seen` instead of
 *     vanishing mid-chart. So every list read is a `last_seen`-ordered,
 *     staleness-filterable view, not a `SELECT *`.
 *   - **Tag text is untrusted.** `tags_json` is operator- and third-party-
 *     controlled (decision INFRA-WIZARD). It is filtered through parameterised
 *     `json_each`, never string-concatenated into a JSON path, and it leaves
 *     here as data.
 */

import { getInfraDb } from './infra-db.js';

/** `infra_resources` as stored. */
export interface InfraResourceRow {
  resource_key: string;
  project_id: string;
  account_id: string;
  region: string;
  service: string;
  resource_id: string;
  name: string | null;
  tags_json: string | null;
  environment: string | null;
  state: string | null;
  metric_dimensions_json: string | null;
  features_json: string | null;
  first_seen: number;
  last_seen: number;
}

/** Default page size for the inventory browser. */
export const DEFAULT_INFRA_RESOURCE_LIMIT = 100;
/** Hard page ceiling. One screen of inventory, not the whole account. */
export const MAX_INFRA_RESOURCE_LIMIT = 500;
/** Series offered on the metric picker for one resource. */
export const MAX_INFRA_RESOURCE_SERIES = 200;

export interface InfraResourceListQuery {
  projectId: string;
  service?: string;
  region?: string;
  accountId?: string;
  /**
   * Exact `environment` match. The sentinel `'none'` selects rows carrying no
   * environment label — an unlabelled resource is the interesting case when
   * hunting for what is not yet joined to a deployment, and there is no other
   * way to ask for it with an equality filter.
   */
  environment?: string;
  state?: string;
  /** Case-insensitive substring over resource id and name. */
  search?: string;
  /** Tag key that must be present. */
  tagKey?: string;
  /** Exact value that `tagKey` must carry. Ignored without `tagKey`. */
  tagValue?: string;
  /** Drop rows not seen since this epoch ms — the "still exists" filter. */
  seenSinceMs?: number;
  limit?: number;
  /** Opaque cursor from a prior page (`${last_seen}_${resource_key}`). */
  cursor?: string;
}

export interface InfraResourceListPage {
  resources: InfraResourceRow[];
  nextCursor: string | null;
}

/** Sentinel `environment` value selecting rows with no environment label. */
export const INFRA_RESOURCE_NO_ENVIRONMENT = 'none';

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_INFRA_RESOURCE_LIMIT;
  return Math.min(MAX_INFRA_RESOURCE_LIMIT, Math.max(1, Math.floor(limit)));
}

function encodeCursor(row: InfraResourceRow): string {
  return `${row.last_seen}_${row.resource_key}`;
}

/**
 * Decode a page cursor, or null when it is unparseable.
 *
 * A malformed cursor reads as "start from the beginning" rather than throwing,
 * matching `listInfraAlerts`. The keyset predicate is project-scoped either
 * way, so a cursor minted against another project can only ever skip rows in
 * this one, never surface theirs.
 */
function decodeCursor(cursor: string | undefined): { lastSeen: number; key: string } | null {
  if (!cursor) return null;
  const sep = cursor.indexOf('_');
  if (sep <= 0) return null;
  const lastSeen = Number(cursor.slice(0, sep));
  const key = cursor.slice(sep + 1);
  if (!Number.isFinite(lastSeen) || !key) return null;
  return { lastSeen, key };
}

/** Escape LIKE wildcards so a resource id containing `%` is not a wildcard. */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Filter clauses shared by the list read and the facet read, so a facet can
 * never offer a value that the list it filters would return nothing for.
 */
function buildFilterClauses(query: InfraResourceListQuery): {
  clauses: string[];
  params: unknown[];
} {
  const clauses = ['r.project_id = ?'];
  const params: unknown[] = [query.projectId];

  if (query.service) {
    clauses.push('r.service = ?');
    params.push(query.service);
  }
  if (query.region) {
    clauses.push('r.region = ?');
    params.push(query.region);
  }
  if (query.accountId) {
    clauses.push('r.account_id = ?');
    params.push(query.accountId);
  }
  if (query.environment) {
    if (query.environment === INFRA_RESOURCE_NO_ENVIRONMENT) {
      clauses.push("(r.environment IS NULL OR r.environment = '')");
    } else {
      clauses.push('r.environment = ?');
      params.push(query.environment);
    }
  }
  if (query.state) {
    clauses.push('r.state = ?');
    params.push(query.state);
  }
  if (query.search) {
    clauses.push("(r.resource_id LIKE ? ESCAPE '\\' OR COALESCE(r.name, '') LIKE ? ESCAPE '\\')");
    const like = likeContains(query.search);
    params.push(like, like);
  }
  if (query.tagKey) {
    // `tags_json` holds AWS's own `[{Key,Value}]` array, so the predicate walks
    // elements rather than object keys. COALESCE keeps `json_each` on valid
    // JSON for rows that carry no tags at all.
    //
    // The key and value are bound parameters, never interpolated into a JSON
    // path: a tag key is third-party-controlled text, and a path built by
    // concatenation would let `$."a"."b"` in a key reach into the document.
    if (query.tagValue) {
      clauses.push(
        `EXISTS (SELECT 1 FROM json_each(COALESCE(r.tags_json, '[]')) t
                  WHERE json_extract(t.value, '$.Key') = ?
                    AND json_extract(t.value, '$.Value') = ?)`,
      );
      params.push(query.tagKey, query.tagValue);
    } else {
      clauses.push(
        `EXISTS (SELECT 1 FROM json_each(COALESCE(r.tags_json, '[]')) t
                  WHERE json_extract(t.value, '$.Key') = ?)`,
      );
      params.push(query.tagKey);
    }
  }
  if (typeof query.seenSinceMs === 'number' && Number.isFinite(query.seenSinceMs)) {
    clauses.push('r.last_seen >= ?');
    params.push(Math.floor(query.seenSinceMs));
  }

  return { clauses, params };
}

/** One bounded, keyset-paginated page of inventory, most-recently-seen first. */
export function listInfraResources(query: InfraResourceListQuery): InfraResourceListPage {
  const limit = clampLimit(query.limit);
  const { clauses, params } = buildFilterClauses(query);

  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    clauses.push('(r.last_seen < ? OR (r.last_seen = ? AND r.resource_key < ?))');
    params.push(cursor.lastSeen, cursor.lastSeen, cursor.key);
  }

  // Over-fetch by one so the presence of a next page is known without a second
  // COUNT query.
  const rows = getInfraDb()
    .prepare(
      `SELECT r.* FROM infra_resources r
        WHERE ${clauses.join(' AND ')}
        ORDER BY r.last_seen DESC, r.resource_key DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as InfraResourceRow[];

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    nextCursor = encodeCursor(rows[rows.length - 1]);
  }
  return { resources: rows, nextCursor };
}

/** One inventory row, or null when it does not exist or belongs elsewhere. */
export function getInfraResource(projectId: string, resourceKey: string): InfraResourceRow | null {
  const row = getInfraDb()
    .prepare('SELECT * FROM infra_resources WHERE project_id = ? AND resource_key = ?')
    .get(projectId, resourceKey) as InfraResourceRow | undefined;
  return row ?? null;
}

/** The distinct values the filter controls offer, for one project. */
export interface InfraResourceFacets {
  services: string[];
  regions: string[];
  accounts: string[];
  environments: string[];
  states: string[];
  tagKeys: string[];
  /** Rows matching the current filters, ignoring paging. */
  total: number;
}

/** Facet values plus the unpaged match count for the same filter set. */
export function listInfraResourceFacets(query: InfraResourceListQuery): InfraResourceFacets {
  const db = getInfraDb();
  // Facets describe the whole project, not the current filter: a service
  // dropdown that hides every service except the one already selected cannot
  // be used to change the selection.
  const scope = { projectId: query.projectId };
  const { clauses, params } = buildFilterClauses(scope);
  const where = clauses.join(' AND ');

  const distinct = (column: string): string[] =>
    (
      db
        .prepare(
          `SELECT DISTINCT ${column} AS v FROM infra_resources r
            WHERE ${where} AND ${column} IS NOT NULL AND ${column} != ''
            ORDER BY v`,
        )
        .all(...params) as { v: string }[]
    ).map((r) => r.v);

  const tagKeys = (
    db
      .prepare(
        `SELECT DISTINCT json_extract(t.value, '$.Key') AS v
           FROM infra_resources r, json_each(COALESCE(r.tags_json, '[]')) t
          WHERE ${where} AND json_extract(t.value, '$.Key') IS NOT NULL
          ORDER BY v
          LIMIT 200`,
      )
      .all(...params) as { v: string }[]
  ).map((r) => r.v);

  const filtered = buildFilterClauses(query);
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM infra_resources r WHERE ${filtered.clauses.join(' AND ')}`,
      )
      .get(...filtered.params) as { n: number }
  ).n;

  return {
    services: distinct('r.service'),
    regions: distinct('r.region'),
    accounts: distinct('r.account_id'),
    environments: distinct('r.environment'),
    states: distinct('r.state'),
    tagKeys,
    total,
  };
}

/** One chartable series on a resource, as offered by the metric picker. */
export interface InfraResourceSeries {
  namespace: string;
  metricName: string;
  stat: string;
  periodSeconds: number;
  dimensionsHash: string;
  dimensionsJson: string | null;
  pointCount: number;
  firstTsMs: number;
  lastTsMs: number;
}

/**
 * Every series stored for one resource.
 *
 * The picker is populated from what was actually collected rather than from the
 * service metric pack, so a metric the pack lists but the account never
 * published (a paid-feature metric, per INFRA-COST) is absent instead of
 * offering a chart that can only be empty.
 *
 * `periodSeconds` is part of the series identity here for the same reason the
 * store warns about leaving it open on a read: one metric can be stored at
 * several period tiers, and a chart that does not pin one interleaves two
 * tiers at duplicate timestamps.
 */
export function listInfraResourceSeries(
  projectId: string,
  resourceKey: string,
  limit = MAX_INFRA_RESOURCE_SERIES,
): InfraResourceSeries[] {
  const rows = getInfraDb()
    .prepare(
      `SELECT namespace, metric_name, stat, period_s, dimensions_hash,
              MAX(dimensions_json) AS dimensions_json,
              COUNT(*) AS point_count,
              MIN(ts_ms) AS first_ts_ms,
              MAX(ts_ms) AS last_ts_ms
         FROM infra_metric_points
        WHERE project_id = ? AND resource_key = ?
        GROUP BY namespace, metric_name, stat, period_s, dimensions_hash
        ORDER BY namespace, metric_name, stat, period_s
        LIMIT ?`,
    )
    .all(projectId, resourceKey, Math.max(1, Math.floor(limit))) as Array<{
    namespace: string;
    metric_name: string;
    stat: string;
    period_s: number;
    dimensions_hash: string;
    dimensions_json: string | null;
    point_count: number;
    first_ts_ms: number;
    last_ts_ms: number;
  }>;

  return rows.map((r) => ({
    namespace: r.namespace,
    metricName: r.metric_name,
    stat: r.stat,
    periodSeconds: r.period_s,
    dimensionsHash: r.dimensions_hash,
    dimensionsJson: r.dimensions_json,
    pointCount: r.point_count,
    firstTsMs: r.first_ts_ms,
    lastTsMs: r.last_ts_ms,
  }));
}

/**
 * Parse `tags_json` into a flat map for the wire.
 *
 * Untrusted text: parsed defensively and never thrown on. A row whose tags do
 * not parse still describes a real resource, and failing the whole inventory
 * page over one malformed tag blob would take the resource browser down with
 * it.
 */
export function parseResourceTags(tagsJson: string | null): Record<string, string> {
  if (!tagsJson) return {};
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    if (!Array.isArray(parsed)) return {};
    const tags: Record<string, string> = {};
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const { Key, Value } = entry as { Key?: unknown; Value?: unknown };
      if (typeof Key !== 'string' || Key === '') continue;
      tags[Key] = typeof Value === 'string' ? Value : '';
    }
    return tags;
  } catch {
    return {};
  }
}

/**
 * Parse a JSON-object column (`metric_dimensions_json`, `features_json`) for
 * the wire.
 *
 * Same defensive contract as {@link parseResourceTags}, and `{}` for a row that
 * predates the column. Values are passed through as-is rather than coerced:
 * dimension values are strings and feature flags are booleans, and a client
 * that gets something else should see it rather than a laundered version of it.
 */
export function parseResourceJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Inventory row -> wire shape. Tags arrive parsed; every value is data. */
export function serializeInfraResource(row: InfraResourceRow): Record<string, unknown> {
  return {
    resourceKey: row.resource_key,
    projectId: row.project_id,
    accountId: row.account_id,
    region: row.region,
    service: row.service,
    resourceId: row.resource_id,
    name: row.name,
    environment: row.environment,
    state: row.state,
    tags: parseResourceTags(row.tags_json),
    // The dimension set the resource's series are keyed on, so a client can
    // tell which of a pack's declarations applies: `AWS/ECS` `CPUUtilization`
    // means one thing at `ClusterName` and another at `ClusterName` +
    // `ServiceName`, and the metric name alone cannot distinguish them.
    metricDimensions: parseResourceJsonObject(row.metric_dimensions_json),
    // Which paid provider features are on for this resource. Drives the
    // "Container Insights is off, here is what it would cost" notice rather
    // than rendering charts that can only be empty.
    features: parseResourceJsonObject(row.features_json),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}
