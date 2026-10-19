/** Organization-scoped, read-only cross-project context.
 *
 * Every call takes an already-resolved {@link OrganizationReadScope}: the intersection of the
 * organization's current links, the agent's configured project scope (capability callers) and
 * the acting user's project ACL. Results carry a source citation and a timestamp, are
 * paginated, and truncate free text so a large portfolio never becomes unbounded prompt input.
 * Sessions are limited to the acting user's own; credentials and artifacts are never read here.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getDb, getStmts } from './db.js';
import { getActiveOrgId } from './orgs.js';
import { findProjectForServer } from './project-model.js';
import { getUserById } from './users-store.js';
import {
  getBusinessOrganization,
  getBusinessOrganizationRole,
  listBusinessOrganizationProjectLinks,
  listBusinessOrganizations,
} from './business-organizations-store.js';
import {
  organizationAccess,
  visibleOrganizationProject,
  type OrganizationCaller,
} from './business-organizations-access.js';
import {
  isOrganizationWorkspace,
  onOrganizationContextInvalidated,
  resolveOrganizationSessionAuthority,
  type OrganizationCapability,
} from './organization-capabilities.js';
import { registerOrganizationAccessRevalidator } from './organization-spawn-policy.js';
import { isColumnCancelled, isColumnDone, isColumnShippedLane } from './kanban-blockers.js';
import { formatCardShortId } from './kanban-short-id.js';
import { computeSessionState } from './session-state.js';
import { buildRedactionConfig, redactText } from './logs/log-redaction.js';
import type { Project } from './types.js';

export interface OrganizationReadScope {
  serverId: string;
  organizationId: string;
  userId: string;
  /** Null for a human member reading through their own login (no agent scope applies). */
  agentId: string | null;
  projectIds: string[];
  /** Changes whenever links, ACLs, roles, credentials or agent configuration change. */
  accessVersion: string;
}

export interface SourceReference {
  serverId: string;
  organizationId: string;
  projectId: string;
  projectName: string;
  record: string;
}

export class OrganizationContextNotFound extends Error {}

export const CONTEXT_PAGE_MAX = 50;
export const CONTEXT_CACHE_TTL_MS = 15_000;
const CONTEXT_CACHE_MAX = 500;
const DESCRIPTION_MAX = 4_000;
const WIKI_CONTENT_MAX = 12_000;
const COMMENT_MAX = 1_000;
const SESSION_RESULT_MAX = 4_000;
/** Every nested list in a response is capped here and reports its full size, so a single
 * item (one project, one epic) can never carry unbounded prompt input. */
export const NESTED_LIST_MAX = 20;
/** Structural backstop applied to every output array by {@link sanitizeContextOutput}. */
export const OUTPUT_ARRAY_MAX = 50;

/** Explicit cap with truncation info; callers spread it under their own field names. */
export function capList<T>(items: readonly T[], max = NESTED_LIST_MAX) {
  return { items: items.slice(0, max), total: items.length, truncated: items.length > max };
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const redaction = buildRedactionConfig();

/** The single redaction rule: stored text is redacted IN FULL before anything else touches
 * it. Slicing, excerpting, matching or ordering raw text first can cut a credential into an
 * unrecognizable fragment, or turn a query into an oracle over the secret. */
export function redact(text: string | null | undefined): string {
  return redactText(text ?? '', redaction).value;
}

/** Text-loading policy, covering SQLite's own work as well as what reaches JavaScript.
 *
 * SQLite reads a TEXT value in full (including overflow pages) whenever an expression
 * references it, even substr(col, 1, n); only octet_length()/typeof() are answered from the
 * record header. So {@link boundedText} first checks the header-only byte size and reads the
 * value only when it is at most FIELD_LOAD_MAX bytes; larger fields are never read and come
 * back NULL (reported as truncated). Within that, at most `max + REDACTION_MARGIN` characters
 * reach JavaScript; they are redacted and only then cut to `max`. The margin guarantees any
 * credential starting before the cut (PEM keys, tokens: far shorter) was redacted whole. */
export const FIELD_LOAD_MAX = 1_000_000;
/** Metadata fields (titles, names, slugs, labels) are displayed at METADATA_MAX characters
 * and appear once per row in list pages, so SQLite reads them only up to this size; longer
 * metadata is omitted rather than read. */
export const METADATA_READ_MAX = 16_384;
export const REDACTION_MARGIN = 8_192;
/** Search and filters match only the first RECORD_MATCH_MAX characters of each text field. */
export const RECORD_MATCH_MAX = 100_000;

/** Largest stored size SQLite will read for a field shown at `max` characters. */
export function readLimit(max: number): number {
  return max <= METADATA_MAX ? METADATA_READ_MAX : FIELD_LOAD_MAX;
}

export function boundedText(expression: string, max: number): string {
  return `CASE WHEN octet_length(${expression}) <= ${readLimit(max)} THEN substr(${expression}, 1, ${max + REDACTION_MARGIN}) END`;
}
/** boundedText plus its header-only stored size, so callers can flag omitted text. */
function boundedTextWithSize(expression: string, max: number, alias: string): string {
  return `${boundedText(expression, max)} AS ${alias}, octet_length(${expression}) AS ${alias}_bytes`;
}

/** Secrets pasted into cards, wiki or chat never reach organization context. `loaded` must
 * come from {@link boundedText} with the same `max` (or be inherently short). */
function clean(
  loaded: string | null | undefined,
  max: number,
  storedBytes?: number | string | null,
): { text: string; truncated: boolean } {
  const value = redact(loaded);
  const omitted = loaded == null && Number(storedBytes ?? 0) > 0;
  return value.length > max
    ? { text: value.slice(0, max), truncated: true }
    : { text: value, truncated: omitted || (loaded?.length ?? 0) >= max + REDACTION_MARGIN };
}

/** Free-text fields already bounded by {@link clean}; every other string is metadata. */
const BOUNDED_TEXT_KEYS = new Set(['description', 'content', 'snippet']);
const METADATA_MAX = 300;

/** Final pass over every response: titles, names, labels, slugs and record references are
 * user-controlled too, so every string is redacted and metadata is length-bounded. It also
 * bounds structure: no array exceeds OUTPUT_ARRAY_MAX and depth is limited, so the total size
 * of any response is bounded even if a future field forgets its explicit cap. Explicit caps
 * (pagination, {@link capList}) are all below the backstop and report truncation. */
export function sanitizeContextOutput<T>(value: T, key = '', depth = 0): T {
  if (typeof value === 'string') {
    const redacted = redact(value);
    return (
      BOUNDED_TEXT_KEYS.has(key) || redacted.length <= METADATA_MAX
        ? redacted
        : redacted.slice(0, METADATA_MAX)
    ) as T;
  }
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value
      .slice(0, OUTPUT_ARRAY_MAX)
      .map((item) => sanitizeContextOutput(item, key, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, sanitizeContextOutput(v, k, depth + 1)]),
  ) as T;
}

export function isoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return `${value.replace(' ', 'T')}Z`;
  return value;
}

function latest(...values: Array<string | null | undefined>): string | null {
  const iso = values.map(isoTimestamp).filter((v): v is string => !!v);
  return iso.length ? iso.sort().at(-1)! : null;
}

// ── Scope resolution ────────────────────────────────────────────────────────

function readableProject(serverId: string, projectId: string): Project | null {
  const project = findProjectForServer(serverId, projectId);
  return project && !isOrganizationWorkspace(project) ? project : null;
}

/** Re-resolves the capability's current authority; a revoked or stale grant yields null. */
export function scopeFromCapability(grant: OrganizationCapability): OrganizationReadScope | null {
  if (grant.serverId !== getActiveOrgId() || !grant.tools.includes('projects:read')) return null;
  let current;
  try {
    current = resolveOrganizationSessionAuthority(grant.sessionId);
  } catch {
    return null;
  }
  if (current.fingerprint !== grant.fingerprint) return null;
  return {
    serverId: current.serverId,
    organizationId: current.organizationId,
    userId: current.userId,
    agentId: current.agentId,
    projectIds: current.projectIds.filter((id) => readableProject(current.serverId, id)),
    accessVersion: current.fingerprint,
  };
}

/** A member reading with their own login: organization links ∩ their project ACL. */
export function scopeForMember(
  caller: OrganizationCaller,
  organizationId: string,
): OrganizationReadScope | null {
  if (caller.serverId !== getActiveOrgId()) return null;
  if (!getBusinessOrganization(caller.serverId, organizationId)) return null;
  if (!organizationAccess(caller, organizationId).canView) return null;
  const links = listBusinessOrganizationProjectLinks(caller.serverId, organizationId);
  const projectIds = [...links.keys()]
    .filter(
      (id) =>
        visibleOrganizationProject(caller, id) !== null && readableProject(caller.serverId, id),
    )
    .sort();
  return {
    serverId: caller.serverId,
    organizationId,
    userId: caller.userId,
    agentId: null,
    projectIds,
    accessVersion: digest({
      links: projectIds.map((id) => [id, links.get(id)]),
      serverRole: caller.serverRole,
      organizationRole: getBusinessOrganizationRole(caller.serverId, organizationId, caller.userId),
      credentialVersion: getUserById(caller.userId)?.credential_version ?? null,
    }),
  };
}

function projectInScope(scope: OrganizationReadScope, projectId: string): Project {
  const project = scope.projectIds.includes(projectId)
    ? readableProject(scope.serverId, projectId)
    : null;
  // One error for unknown, unlinked, out-of-scope and inaccessible: no existence oracle.
  if (!project) throw new OrganizationContextNotFound('Project not found');
  return project;
}

function source(scope: OrganizationReadScope, project: Project, record: string): SourceReference {
  return {
    serverId: scope.serverId,
    organizationId: scope.organizationId,
    projectId: project.id,
    projectName: project.name,
    record,
  };
}

// ── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, { expiresAt: number; value: unknown }>();

export function clearOrganizationContextCache(): void {
  cache.clear();
}
export function organizationContextCacheKeys(): string[] {
  return [...cache.keys()];
}

/** Keyed by Server, organization, agent, user and access version. Any authority mutation also
 * clears everything, so an unlink never serves a cached result for the rest of the TTL. */
function cached<T>(scope: OrganizationReadScope, op: string, args: unknown, build: () => T): T {
  const key = JSON.stringify([
    scope.serverId,
    scope.organizationId,
    scope.agentId,
    scope.userId,
    scope.accessVersion,
    op,
    args,
  ]);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;
  const value = build();
  if (cache.size >= CONTEXT_CACHE_MAX) {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    while (cache.size >= CONTEXT_CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, { expiresAt: now + CONTEXT_CACHE_TTL_MS, value });
  return value;
}
registerOrganizationAccessRevalidator(clearOrganizationContextCache);
onOrganizationContextInvalidated(clearOrganizationContextCache);

// ── Queries ─────────────────────────────────────────────────────────────────

export interface Page {
  offset: number;
  limit: number;
}
function paged<T>(rows: T[], { offset, limit }: Page) {
  return {
    offset,
    nextOffset: rows.length > limit ? offset + limit : null,
    items: rows.slice(0, limit),
  };
}
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

function agentIds(project: Project): string[] {
  return project.agents.map((agent) => agent.id);
}

function ownSessionsSql(project: Project): { where: string; params: string[] } {
  const ids = agentIds(project);
  return {
    where: `owner_user_id = ? AND deleted_at IS NULL AND discarded_at IS NULL
      AND agent_id IN (${ids.length ? placeholders(ids.length) : "''"})`,
    params: ids,
  };
}

function projectOverview(scope: OrganizationReadScope, project: Project) {
  const db = getDb();
  const columns = db
    .prepare(
      // Aggregate over IDs only, then read the guarded name per output row: in an aggregate
      // query SQLite would copy the full name into its sorter before any CASE guard runs.
      `SELECT ${boundedText('c.name', METADATA_MAX)} AS name, coalesce(g.count, 0) AS count,
              g.updated AS updated
       FROM kanban_boards b JOIN kanban_columns c ON c.board_id = b.id
       LEFT JOIN (
         SELECT k.column_id, COUNT(*) AS count, MAX(k.updated_at) AS updated
         FROM kanban_cards k JOIN kanban_boards kb ON kb.id = k.board_id
         WHERE kb.project_id = ? GROUP BY k.column_id
       ) g ON g.column_id = c.id
       WHERE b.project_id = ? ORDER BY b.created_at, c.position, c.id`,
    )
    .all(project.id, project.id) as Array<{ name: string; count: number; updated: string | null }>;
  const open = columns
    .filter(
      (c) => !isColumnDone(c.name) && !isColumnShippedLane(c.name) && !isColumnCancelled(c.name),
    )
    .reduce((sum, c) => sum + c.count, 0);
  const epics = db
    .prepare(
      `SELECT COUNT(*) AS count, MAX(e.updated_at) AS updated FROM kanban_epics e
       JOIN kanban_boards b ON b.id = e.board_id WHERE b.project_id = ?`,
    )
    .get(project.id) as { count: number; updated: string | null };
  const phases = db
    .prepare(
      `SELECT COUNT(*) AS count FROM kanban_phases p
       JOIN kanban_boards b ON b.id = p.board_id WHERE b.project_id = ?`,
    )
    .get(project.id) as { count: number };
  const wiki = db
    .prepare(
      'SELECT COUNT(*) AS count, MAX(updated_at) AS updated FROM wiki_pages WHERE project_id = ?',
    )
    .get(project.id) as { count: number; updated: string | null };
  const own = ownSessionsSql(project);
  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS count, MAX(updated_at) AS updated FROM sessions WHERE ${own.where}`,
    )
    .get(scope.userId, ...own.params) as { count: number; updated: string | null };
  const agents = capList(project.agents);
  const columnList = capList(columns);
  return {
    id: project.id,
    name: project.name,
    source: source(scope, project, `project:${project.id}`),
    timestamp: latest(
      ...columns.map((c) => c.updated),
      epics.updated,
      wiki.updated,
      sessions.updated,
    ),
    agents: agents.items.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role ?? null,
    })),
    agentCount: agents.total,
    agentsTruncated: agents.truncated,
    board: {
      // Totals cover every column; the per-column list is capped. Use the cards list with
      // ?column= for a column beyond the cap.
      columns: columnList.items.map((c) => ({ name: c.name, count: c.count })),
      columnCount: columnList.total,
      columnsTruncated: columnList.truncated,
      openCards: open,
      totalCards: columns.reduce((sum, c) => sum + c.count, 0),
      epics: epics.count,
      phases: phases.count,
    },
    wiki: { pages: wiki.count, updatedAt: isoTimestamp(wiki.updated) },
    sessions: { own: sessions.count, updatedAt: isoTimestamp(sessions.updated) },
  };
}

export function organizationOverview(scope: OrganizationReadScope, page: Page) {
  return cached(scope, 'overview', page, () => {
    const ids = scope.projectIds.slice(page.offset, page.offset + page.limit + 1);
    const result = paged(ids, page);
    return sanitizeContextOutput({
      serverId: scope.serverId,
      organizationId: scope.organizationId,
      agentId: scope.agentId,
      retrievedAt: new Date().toISOString(),
      offset: result.offset,
      nextOffset: result.nextOffset,
      projects: result.items.map((id) =>
        projectOverview(scope, readableProject(scope.serverId, id)!),
      ),
    });
  });
}

export const PROJECT_RESOURCES = [
  'agents',
  'cards',
  'epics',
  'phases',
  'wiki',
  'sessions',
] as const;
export type ProjectResource = (typeof PROJECT_RESOURCES)[number];
export const RECORD_RESOURCES = ['cards', 'epics', 'wiki', 'sessions'] as const;
export type RecordResource = (typeof RECORD_RESOURCES)[number];

export interface ResourceFilter {
  q?: string;
  column?: string;
  epicId?: string;
}

/** Card list columns: system scalars plus user-controlled text, which always goes through
 * boundedText. Shared by plain lists, filtered scans (which also price them) and details. */
const CARD_SCALARS = [
  'k.id AS id',
  'k.short_id AS short_id',
  'k.priority AS priority',
  'k.epic_id AS epic_id',
  'k.phase_id AS phase_id',
  'k.updated_at AS updated_at',
];
const CARD_METADATA_FIELDS: TextField[] = [
  { column: 'c.name', max: METADATA_MAX, alias: 'column_name' },
  { column: 'k.assignee', max: METADATA_MAX, alias: 'assignee' },
  { column: 'k.pr_url', max: METADATA_MAX, alias: 'pr_url' },
  { column: 'b.card_prefix', max: METADATA_MAX, alias: 'card_prefix' },
];
const selectFields = (fields: TextField[]) =>
  fields.map((f) => `${boundedText(f.column, f.max)} AS ${f.alias}`).join(', ');
const CARD_LIST_COLUMNS = (a: string) =>
  [
    ...CARD_SCALARS.map((column) => column.replace(/^k\./, `${a}.`)),
    selectFields([{ column: `${a}.title`, max: METADATA_MAX, alias: 'title' }]),
    selectFields(CARD_METADATA_FIELDS),
  ].join(', ');
function cardItem(
  scope: OrganizationReadScope,
  project: Project,
  r: Record<string, string | number | null>,
) {
  return {
    id: r.id as string,
    shortId: formatCardShortId(r.card_prefix as string | null, r.short_id as number | null),
    title: r.title as string,
    priority: r.priority as string,
    column: r.column_name as string,
    epicId: (r.epic_id as string | null) ?? null,
    phaseId: (r.phase_id as string | null) ?? null,
    assignee: (r.assignee as string | null) ?? null,
    prUrl: (r.pr_url as string | null) ?? null,
    source: source(scope, project, `card:${r.id}`),
    timestamp: isoTimestamp(r.updated_at as string),
  };
}
function wikiItem(scope: OrganizationReadScope, project: Project, r: Record<string, string>) {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    category: r.category,
    source: source(scope, project, `wiki:${r.slug}`),
    timestamp: isoTimestamp(r.updated_at),
  };
}
const WIKI_SCALARS = ['id', 'updated_at'];
const WIKI_METADATA_FIELDS: TextField[] = [
  { column: 'category', max: METADATA_MAX, alias: 'category' },
];
const WIKI_LIST_COLUMNS = [
  ...WIKI_SCALARS,
  selectFields([
    { column: 'slug', max: METADATA_MAX, alias: 'slug' },
    { column: 'title', max: METADATA_MAX, alias: 'title' },
    ...WIKI_METADATA_FIELDS,
  ]),
].join(', ');

function cardWhere(project: Project, filter: ResourceFilter) {
  const where = ['b.project_id = ?'];
  const params: string[] = [project.id];
  if (filter.epicId) {
    where.push('k.epic_id = ?');
    params.push(filter.epicId);
  }
  // filter.column is a text predicate: it runs in the bounded scan (scanFilteredList), on each
  // card's redacted column name, so any number of columns and duplicate names are covered.
  return { where: where.join(' AND '), params };
}

/** Text-filtered lists (q, or a card column name) run on the bounded scan engine and page
 * with a sealed cursor. Every text predicate is decided here, on redacted text. */
function scanFilteredList(
  scope: OrganizationReadScope,
  project: Project,
  resource: 'cards' | 'wiki',
  filter: ResourceFilter,
  limit: number,
  cursor: SearchCursor | undefined,
) {
  type Row = { item: unknown; texts: string[]; column?: string };
  const { q } = filter;
  const column = resource === 'cards' ? filter.column?.toLowerCase() : undefined;
  const accept = (row: Row) =>
    (!q || matchesRedacted(row.texts, q)) && (!column || row.column === column);
  const w = resource === 'cards' ? cardWhere(project, filter) : null;
  const scanSource: ScanSource<Row> = w
    ? tableScanSource<Row>({
        type: 'cards',
        from: `kanban_cards k JOIN kanban_columns c ON c.id = k.column_id
               JOIN kanban_boards b ON b.id = k.board_id`,
        where: w.where,
        params: w.params,
        key: { updated: 'k.updated_at', project: 'b.project_id', id: 'k.id' },
        scalars: CARD_SCALARS,
        // Without q, only display fields are loaded (and priced): no description read.
        fields: q
          ? [
              { column: 'k.title', max: RECORD_MATCH_MAX, alias: 'title' },
              { column: 'k.description', max: RECORD_MATCH_MAX, alias: 'description' },
              ...CARD_METADATA_FIELDS,
            ]
          : [{ column: 'k.title', max: METADATA_MAX, alias: 'title' }, ...CARD_METADATA_FIELDS],
        toRow: (r) => ({
          item: cardItem(scope, project, r as Record<string, string | number | null>),
          texts: q
            ? [
                clean(r.title as string | null, RECORD_MATCH_MAX).text,
                clean(r.description as string | null, RECORD_MATCH_MAX).text,
              ]
            : [],
          column: clean(r.column_name as string | null, METADATA_MAX).text.toLowerCase(),
        }),
        accept,
      })
    : tableScanSource<Row>({
        type: 'wiki',
        from: 'wiki_pages',
        where: 'project_id = ?',
        params: [project.id],
        key: { updated: 'updated_at', project: 'project_id', id: 'id' },
        scalars: WIKI_SCALARS,
        fields: [
          { column: 'title', max: RECORD_MATCH_MAX, alias: 'title' },
          { column: 'slug', max: RECORD_MATCH_MAX, alias: 'slug' },
          ...WIKI_METADATA_FIELDS,
        ],
        toRow: (r) => ({
          item: wikiItem(scope, project, r as Record<string, string>),
          texts: [
            clean(r.title as string | null, RECORD_MATCH_MAX).text,
            clean(r.slug as string | null, RECORD_MATCH_MAX).text,
          ],
        }),
        accept,
      });
  const scan = boundedScan([scanSource], cursor, limit);
  return {
    items: scan.hits.map(({ row }) => row.item),
    partial: scan.partial,
    resumeAfter: scan.resumeAfter,
  };
}

export function listCursorBinding(
  scope: OrganizationReadScope,
  projectId: string,
  resource: ProjectResource,
  filter: ResourceFilter,
): string {
  return JSON.stringify([
    'list',
    scope.serverId,
    scope.organizationId,
    scope.userId,
    scope.agentId,
    projectId,
    resource,
    filter.q ?? null,
    filter.column ?? null,
    filter.epicId ?? null,
  ]);
}

function listRows(
  scope: OrganizationReadScope,
  project: Project,
  resource: ProjectResource,
  page: Page,
  filter: ResourceFilter,
) {
  const db = getDb();
  const take = page.limit + 1;
  switch (resource) {
    case 'agents':
      return project.agents.slice(page.offset, page.offset + take).map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role ?? null,
        source: source(scope, project, `agent:${agent.id}`),
        timestamp: null,
      }));
    case 'cards': {
      // Text filters (q) take the bounded scan path in listProjectResource.
      const w = cardWhere(project, filter);
      return (
        db
          .prepare(
            `SELECT ${CARD_LIST_COLUMNS('k')}
             FROM kanban_cards k JOIN kanban_columns c ON c.id = k.column_id
             JOIN kanban_boards b ON b.id = k.board_id
             WHERE ${w.where} ORDER BY k.updated_at DESC, k.id LIMIT ? OFFSET ?`,
          )
          .all(...w.params, take, page.offset) as Array<Record<string, string | number | null>>
      ).map((r) => cardItem(scope, project, r));
    }
    case 'epics': {
      const rows = db
        .prepare(
          `SELECT e.id, ${boundedText('e.name', METADATA_MAX)} AS name, e.state, e.updated_at,
                  (SELECT COUNT(*) FROM kanban_cards k WHERE k.epic_id = e.id) AS card_count
           FROM kanban_epics e JOIN kanban_boards b ON b.id = e.board_id
           WHERE b.project_id = ? ORDER BY e.position, e.id LIMIT ? OFFSET ?`,
        )
        .all(project.id, take, page.offset) as Array<Record<string, string | number | null>>;
      return rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        state: (r.state as string | null) ?? null,
        cardCount: r.card_count as number,
        source: source(scope, project, `epic:${r.id}`),
        timestamp: isoTimestamp(r.updated_at as string),
      }));
    }
    case 'phases': {
      const where = ['b.project_id = ?'];
      const params: unknown[] = [project.id];
      if (filter.epicId) {
        where.push('p.epic_id = ?');
        params.push(filter.epicId);
      }
      const rows = db
        .prepare(
          `SELECT p.id, p.epic_id, ${boundedText('p.name', METADATA_MAX)} AS name, p.position,
                  p.updated_at,
                  (SELECT COUNT(*) FROM kanban_cards k WHERE k.phase_id = p.id) AS card_count
           FROM kanban_phases p JOIN kanban_boards b ON b.id = p.board_id
           WHERE ${where.join(' AND ')} ORDER BY p.epic_id, p.position, p.id LIMIT ? OFFSET ?`,
        )
        .all(...params, take, page.offset) as Array<Record<string, string | number | null>>;
      return rows.map((r) => ({
        id: r.id as string,
        epicId: r.epic_id as string,
        name: r.name as string,
        position: r.position as number,
        cardCount: r.card_count as number,
        source: source(scope, project, `phase:${r.id}`),
        timestamp: isoTimestamp(r.updated_at as string),
      }));
    }
    case 'wiki':
      return (
        db
          .prepare(
            `SELECT ${WIKI_LIST_COLUMNS} FROM wiki_pages
             WHERE project_id = ? ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
          )
          .all(project.id, take, page.offset) as Array<Record<string, string>>
      ).map((r) => wikiItem(scope, project, r));
    case 'sessions': {
      const own = ownSessionsSql(project);
      const rows = db
        .prepare(
          `SELECT id, ${boundedText('name', METADATA_MAX)} AS name, agent_id, created_at, updated_at
           FROM sessions WHERE ${own.where}
           ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
        )
        .all(scope.userId, ...own.params, take, page.offset) as Array<Record<string, string>>;
      const stmts = getStmts();
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        agentId: r.agent_id,
        agentName: project.agents.find((agent) => agent.id === r.agent_id)?.name ?? null,
        state: computeSessionState(stmts, r.id),
        createdAt: isoTimestamp(r.created_at),
        source: source(scope, project, `session:${r.id}`),
        timestamp: isoTimestamp(r.updated_at),
      }));
    }
  }
}

export function listProjectResource(
  scope: OrganizationReadScope,
  projectId: string,
  resource: ProjectResource,
  page: Page,
  filter: ResourceFilter = {},
  rawCursor?: string,
) {
  const project = projectInScope(scope, projectId);
  const base = {
    serverId: scope.serverId,
    organizationId: scope.organizationId,
    projectId: project.id,
    resource,
    retrievedAt: new Date().toISOString(),
  };
  const textFiltered =
    (resource === 'wiki' && !!filter.q) || (resource === 'cards' && !!(filter.q || filter.column));
  if (textFiltered) {
    // Text-filtered pages are cursor-paged: an offset would rescan from the start every time.
    if (page.offset !== 0)
      throw new InvalidContextCursor('Use cursor, not offset, with q or column');
    const binding = listCursorBinding(scope, project.id, resource, filter);
    const cursor = rawCursor === undefined ? undefined : decodeSearchCursor(rawCursor, binding);
    if (cursor === null) throw new InvalidContextCursor('Invalid cursor');
    const scan = scanFilteredList(
      scope,
      project,
      resource as 'cards' | 'wiki',
      filter,
      page.limit,
      cursor,
    );
    return {
      ...sanitizeContextOutput({ ...base, offset: 0, nextOffset: null, items: scan.items }),
      partial: scan.partial,
      nextCursor: scan.resumeAfter
        ? encodeSearchCursor(positionOf(scan.resumeAfter), binding)
        : null,
    };
  }
  if (rawCursor !== undefined) throw new InvalidContextCursor('Cursor requires q or column');
  const result = paged(listRows(scope, project, resource, page, filter) as unknown[], page);
  return {
    ...sanitizeContextOutput({
      ...base,
      offset: result.offset,
      nextOffset: result.nextOffset,
      items: result.items,
    }),
    partial: false,
    nextCursor: null,
  };
}

function notFound(): never {
  throw new OrganizationContextNotFound('Record not found');
}

export function getProjectRecord(
  scope: OrganizationReadScope,
  projectId: string,
  resource: RecordResource,
  recordId: string,
) {
  return sanitizeContextOutput(projectRecord(scope, projectId, resource, recordId));
}

function projectRecord(
  scope: OrganizationReadScope,
  projectId: string,
  resource: RecordResource,
  recordId: string,
) {
  const project = projectInScope(scope, projectId);
  const db = getDb();
  const base = {
    serverId: scope.serverId,
    organizationId: scope.organizationId,
    projectId: project.id,
    resource,
    retrievedAt: new Date().toISOString(),
  };
  switch (resource) {
    case 'cards': {
      const row = db
        .prepare(
          `SELECT ${CARD_LIST_COLUMNS('k')}, ${boundedText('k.labels', METADATA_MAX)} AS labels,
                  ${boundedTextWithSize('k.description', DESCRIPTION_MAX, 'description')}
           FROM kanban_cards k
           JOIN kanban_columns c ON c.id = k.column_id JOIN kanban_boards b ON b.id = k.board_id
           WHERE k.id = ? AND b.project_id = ?`,
        )
        .get(recordId, project.id) as Record<string, string | number | null> | undefined;
      if (!row) notFound();
      const description = clean(
        row.description as string | null,
        DESCRIPTION_MAX,
        row.description_bytes,
      );
      const comments = (
        db
          .prepare(
            `SELECT id, ${boundedText('author', METADATA_MAX)} AS author,
                    ${boundedTextWithSize('content', COMMENT_MAX, 'content')}, created_at
             FROM kanban_card_comments
             WHERE card_id = ? ORDER BY created_at DESC, id DESC LIMIT 10`,
          )
          .all(recordId) as Array<Record<string, string>>
      ).map((c) => ({
        id: c.id,
        author: c.author,
        content: clean(c.content, COMMENT_MAX, c.content_bytes).text,
        timestamp: isoTimestamp(c.created_at),
      }));
      return {
        ...base,
        record: {
          id: row.id as string,
          shortId: formatCardShortId(
            row.card_prefix as string | null,
            row.short_id as number | null,
          ),
          title: row.title as string,
          column: row.column_name as string,
          priority: row.priority as string,
          epicId: (row.epic_id as string | null) ?? null,
          phaseId: (row.phase_id as string | null) ?? null,
          assignee: (row.assignee as string | null) ?? null,
          labels: (row.labels as string | null) ?? null,
          prUrl: (row.pr_url as string | null) ?? null,
          description: description.text,
          truncated: description.truncated,
          recentComments: comments,
          source: source(scope, project, `card:${row.id}`),
          timestamp: isoTimestamp(row.updated_at as string),
        },
      };
    }
    case 'epics': {
      const row = db
        .prepare(
          `SELECT e.id, ${boundedText('e.name', METADATA_MAX)} AS name, e.state, e.updated_at,
                  ${boundedTextWithSize('e.description', DESCRIPTION_MAX, 'description')}
           FROM kanban_epics e JOIN kanban_boards b ON b.id = e.board_id
           WHERE e.id = ? AND b.project_id = ?`,
        )
        .get(recordId, project.id) as Record<string, string | null> | undefined;
      if (!row) notFound();
      const description = clean(row.description, DESCRIPTION_MAX, row.description_bytes);
      // Group by column ID, then merge on the redacted name, so raw text never decides grouping.
      const byName = new Map<string, number>();
      for (const c of db
        .prepare(
          // IDs-only aggregate; the guarded name is read per output row (see projectOverview).
          `SELECT ${boundedText('c.name', METADATA_MAX)} AS name, g.count AS count
           FROM (SELECT column_id, COUNT(*) AS count FROM kanban_cards
                 WHERE epic_id = ? GROUP BY column_id) g
           JOIN kanban_columns c ON c.id = g.column_id`,
        )
        .all(recordId) as Array<{ name: string; count: number }>)
        byName.set(redact(c.name), (byName.get(redact(c.name)) ?? 0) + c.count);
      const columns = capList([...byName].map(([name, count]) => ({ name, count })));
      return {
        ...base,
        record: {
          id: row.id!,
          name: row.name!,
          state: row.state ?? null,
          description: description.text,
          truncated: description.truncated,
          cardsByColumn: columns.items,
          columnCount: columns.total,
          columnsTruncated: columns.truncated,
          source: source(scope, project, `epic:${row.id}`),
          timestamp: isoTimestamp(row.updated_at),
        },
      };
    }
    case 'wiki': {
      // Addressable by page ID, or by a slug only when that slug is shown unredacted. A raw
      // slug comparison would otherwise confirm guesses of a secret embedded in a slug.
      const row = db
        .prepare(
          `SELECT id, ${boundedText('slug', METADATA_MAX)} AS slug, octet_length(slug) AS slug_bytes,
                  ${boundedText('title', METADATA_MAX)} AS title,
                  ${boundedText('category', METADATA_MAX)} AS category, updated_at,
                  ${boundedTextWithSize('content', WIKI_CONTENT_MAX, 'content')}
           FROM wiki_pages WHERE project_id = ? AND (id = ? OR slug = ?) ORDER BY id = ? DESC`,
        )
        .get(project.id, recordId, recordId, recordId) as Record<string, string> | undefined;
      if (
        !row ||
        (row.id !== recordId &&
          (Buffer.byteLength(row.slug) !== Number(row.slug_bytes) || redact(row.slug) !== row.slug))
      )
        notFound();
      const content = clean(row.content, WIKI_CONTENT_MAX, row.content_bytes);
      return {
        ...base,
        record: {
          id: row.id,
          slug: row.slug,
          title: row.title,
          category: row.category,
          content: content.text,
          truncated: content.truncated,
          source: source(scope, project, `wiki:${row.slug}`),
          timestamp: isoTimestamp(row.updated_at),
        },
      };
    }
    case 'sessions': {
      const own = ownSessionsSql(project);
      const row = db
        .prepare(
          `SELECT id, ${boundedText('name', METADATA_MAX)} AS name, agent_id, updated_at,
                  ${boundedTextWithSize('last_turn_error', COMMENT_MAX, 'last_turn_error')}
           FROM sessions WHERE id = ? AND ${own.where}`,
        )
        .get(recordId, scope.userId, ...own.params) as Record<string, string | null> | undefined;
      if (!row) notFound();
      // Only the latest assistant result: user prompts may carry pasted secrets or other context.
      const last = db
        .prepare(
          `SELECT ${boundedTextWithSize('content', SESSION_RESULT_MAX, 'content')}, created_at
           FROM messages WHERE session_id = ? AND role = 'assistant'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(recordId) as
        | { content: string | null; content_bytes: number; created_at: string }
        | undefined;
      const result = last ? clean(last.content, SESSION_RESULT_MAX, last.content_bytes) : null;
      return {
        ...base,
        record: {
          id: row.id!,
          name: row.name!,
          agentId: row.agent_id!,
          agentName: project.agents.find((agent) => agent.id === row.agent_id)?.name ?? null,
          state: computeSessionState(getStmts(), row.id!),
          lastError:
            row.last_turn_error || Number(row.last_turn_error_bytes) > 0
              ? clean(row.last_turn_error, COMMENT_MAX, row.last_turn_error_bytes).text
              : null,
          latestResult: result
            ? {
                content: result.text,
                truncated: result.truncated,
                timestamp: isoTimestamp(last!.created_at),
              }
            : null,
          source: source(scope, project, `session:${row.id}`),
          timestamp: isoTimestamp(row.updated_at),
        },
      };
    }
  }
}

// ── Search ──────────────────────────────────────────────────────────────────

export const SEARCH_TYPES = ['wiki', 'cards', 'epics'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** Whitespace-separated terms; a hit must contain every term in its redacted text. */
function queryTerms(q: string): string[] {
  return q.split(/\s+/).filter(Boolean);
}

/** Snippet from the fully redacted text, so a secret straddling the window is never cut into
 * an unrecognizable fragment. Never use SQLite snippet(): it windows raw stored text. */
function excerpt(redactedText: string, q: string): string {
  const first = queryTerms(q)[0]?.toLowerCase() ?? '';
  const at = Math.max(0, redactedText.toLowerCase().indexOf(first));
  const start = Math.max(0, at - 80);
  return redactedText.slice(start, start + 240);
}

interface SearchHit {
  /** Raw stored keys: pagination orders exactly as the SQL ORDER BY does. Server-generated
   * row IDs only, never user-controlled text such as slugs. */
  sortKey: string;
  sortId: string;
  type: SearchType;
  id: string;
  title: string;
  snippet: string;
  source: SourceReference;
  timestamp: string | null;
}

/** Position of the last returned hit in the search total order. Opaque to callers. */
export interface SearchCursor {
  sortKey: string;
  type: SearchType;
  projectId: string;
  id: string;
}
/** Cursors carry raw keys (a wiki slug may itself contain a secret), so they are sealed with
 * AES-256-GCM under a per-process key: unreadable and tamper-evident to callers. The
 * caller's scope and query are bound as associated data, so a cursor cannot be replayed by
 * another user, agent, organization or query. A restart invalidates outstanding cursors. */
const CURSOR_KEY = randomBytes(32);

export function searchCursorBinding(
  scope: Pick<OrganizationReadScope, 'serverId' | 'organizationId' | 'userId' | 'agentId'>,
  q: string,
  types: readonly SearchType[],
): string {
  return JSON.stringify([
    scope.serverId,
    scope.organizationId,
    scope.userId,
    scope.agentId,
    q,
    [...types].sort(),
  ]);
}

export function encodeSearchCursor(cursor: SearchCursor, binding: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', CURSOR_KEY, iv);
  cipher.setAAD(Buffer.from(binding));
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify([cursor.sortKey, cursor.type, cursor.projectId, cursor.id])),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url');
}

export function decodeSearchCursor(raw: string, binding: string): SearchCursor | null {
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', CURSOR_KEY, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    const value = JSON.parse(plain.toString('utf8')) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      !value.every((part) => typeof part === 'string') ||
      !(SEARCH_TYPES as readonly string[]).includes(value[1])
    )
      return null;
    const [sortKey, type, projectId, id] = value as string[];
    return { sortKey, type: type as SearchType, projectId, id };
  } catch {
    return null;
  }
}

/** Keyset predicate: rows of source `type` strictly after the cursor in the total order
 * (updated_at desc, type, project, row id). */
function afterCursor(
  cursor: SearchCursor | undefined,
  type: SearchType,
  columns: { updated: string; project: string; id: string },
): { sql: string; params: string[] } {
  if (!cursor) return { sql: '', params: [] };
  const { updated, project, id } = columns;
  if (type > cursor.type) return { sql: ` AND ${updated} <= ?`, params: [cursor.sortKey] };
  if (type < cursor.type) return { sql: ` AND ${updated} < ?`, params: [cursor.sortKey] };
  return {
    sql: ` AND (${updated} < ? OR (${updated} = ? AND (${project} > ? OR (${project} = ? AND ${id} > ?))))`,
    params: [cursor.sortKey, cursor.sortKey, cursor.projectId, cursor.projectId, cursor.id],
  };
}

/** Per-request work bound for every text-matching read (search and filtered lists). Matching
 * runs synchronously over redacted text, so each request examines at most this many rows and
 * loads at most this many characters, then returns a continuation positioned after the last
 * examined row. */
export const SCAN_ROW_BUDGET = 2_000;
export const SCAN_CHAR_BUDGET = 2_000_000;
const SCAN_KEY_BATCH = 200;

/** A row position plus the characters loading it will cost. Keys come from lightweight
 * queries (IDs, timestamps, capped lengths); no stored text is read to produce them. */
interface ScanKey {
  sortKey: string;
  type: SearchType;
  projectId: string;
  sortId: string;
  cost: number;
}

/** Build only with {@link tableScanSource}: it derives pricing and loading from one spec. */
interface ScanSource<R> {
  type: SearchType;
  keys: (after: SearchCursor | undefined, batch: number) => ScanKey[];
  /** Loads the row's bounded text; called only once the budget admits its cost. */
  load: (key: ScanKey) => R | undefined;
  accept: (row: R) => boolean;
}

const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Total order: updated_at desc, type, project, row ID. Matches every key query's ORDER BY. */
function compareKeys(a: ScanKey, b: ScanKey): number {
  return (
    binary(b.sortKey, a.sortKey) ||
    binary(a.type, b.type) ||
    binary(a.projectId, b.projectId) ||
    binary(a.sortId, b.sortId)
  );
}
const positionOf = (k: ScanKey): SearchCursor => ({
  sortKey: k.sortKey,
  type: k.type,
  projectId: k.projectId,
  id: k.sortId,
});

/** A user-controlled text column a scan loads, always through {@link boundedText}. */
interface TextField {
  column: string;
  max: number;
  alias: string;
}

/** Declares one scannable table. {@link tableScanSource} generates BOTH the key query that
 * prices a row and the load query from this single declaration, so a row can never load a
 * text field its cost did not include. `scalars` are system-generated, fixed-size columns only
 * (IDs, numbers, timestamps, enum values); any user-controlled text belongs in `fields`. */
interface TableScanSpec<R> {
  type: SearchType;
  from: string;
  where: string;
  params: unknown[];
  key: { updated: string; project: string; id: string };
  scalars: string[];
  fields: TextField[];
  toRow: (r: Record<string, unknown>) => R;
  accept: (row: R) => boolean;
}

/** Header-only stored bytes SQLite reads to load these fields through {@link boundedText}.
 * octet_length() on a column compiles to OP_Column with OPFLAG_BYTELENARG and is answered
 * from the record header (length() or substr() would read the whole value). Fields over
 * their readLimit() cost 0 because boundedText never reads them. Bytes also bound the characters
 * that reach JavaScript. The EXPLAIN check in the tests keeps key queries header-only. */
function loadCost(fields: TextField[], scalars: number): string {
  return fields
    .map(
      ({ column, max }) =>
        `CASE WHEN octet_length(${column}) <= ${readLimit(max)} THEN octet_length(${column}) ELSE 0 END`,
    )
    .concat([String(64 * (scalars + 1))])
    .join(' + ');
}

function tableScanSource<R>(spec: TableScanSpec<R>): ScanSource<R> {
  const db = getDb();
  const { updated, project, id } = spec.key;
  const cost = loadCost(spec.fields, spec.scalars.length);
  const select = [
    ...spec.scalars,
    ...spec.fields.map((f) => `${boundedText(f.column, f.max)} AS ${f.alias}`),
  ].join(', ');
  return {
    type: spec.type,
    keys: (after, batch) => {
      const p = afterCursor(after, spec.type, spec.key);
      return db
        .prepare(
          `SELECT ${updated} AS sortKey, '${spec.type}' AS type, ${project} AS projectId,
                  ${id} AS sortId, ${cost} AS cost
           FROM ${spec.from} WHERE ${spec.where}${p.sql}
           ORDER BY ${updated} DESC, ${project}, ${id} LIMIT ?`,
        )
        .all(...spec.params, ...p.params, batch) as ScanKey[];
    },
    load: (key) => {
      const r = db
        .prepare(`SELECT ${select} FROM ${spec.from} WHERE ${spec.where} AND ${id} = ?`)
        .get(...spec.params, key.sortId) as Record<string, unknown> | undefined;
      return r ? spec.toRow(r) : undefined;
    },
    accept: spec.accept,
  };
}

/** Case-insensitive: every query term appears in the redacted text. */
function matchesRedacted(texts: Array<string | null | undefined>, q: string): boolean {
  const haystack = texts.map(redact).join('\n').toLowerCase();
  return queryTerms(q).every((term) => haystack.includes(term.toLowerCase()));
}

/** The one engine behind every text-matching read.
 *
 * Eligibility depends ONLY on redacted text: key queries select by scope and keyset alone,
 * never by stored text, because any raw MATCH/LIKE prefilter lets secret content change which
 * rows appear (an oracle).
 *
 * Work is bounded: keys are merged lazily across sources and examined one at a time in the
 * global total order. A row's text is loaded only if its cost fits the remaining character
 * budget, so neither loading nor matching can exceed the budget (the first row is always
 * admitted; its cost is capped per field). Because everything up to the last examined row
 * has been examined, the continuation resumes exactly, even after a rejected row. */
function boundedScan<R>(
  sources: Array<ScanSource<R>>,
  cursor: SearchCursor | undefined,
  limit: number,
): { hits: Array<{ key: ScanKey; row: R }>; resumeAfter: ScanKey | null; partial: boolean } {
  const state = sources.map((source) => ({
    source,
    buffer: [] as ScanKey[],
    after: cursor,
    exhausted: false,
  }));
  const hits: Array<{ key: ScanKey; row: R }> = [];
  let rows = 0;
  let chars = 0;
  let lastExamined: ScanKey | null = null;
  for (;;) {
    for (const s of state) {
      if (s.buffer.length || s.exhausted) continue;
      const batch = s.source.keys(s.after, SCAN_KEY_BATCH);
      s.buffer = batch;
      if (batch.length < SCAN_KEY_BATCH) s.exhausted = true;
      if (batch.length) s.after = positionOf(batch.at(-1)!);
    }
    let next: (typeof state)[number] | null = null;
    for (const s of state)
      if (s.buffer.length && (!next || compareKeys(s.buffer[0], next.buffer[0]) < 0)) next = s;
    if (!next) return { hits, resumeAfter: null, partial: false };
    const key = next.buffer[0];
    if (rows > 0 && (rows >= SCAN_ROW_BUDGET || chars + key.cost > SCAN_CHAR_BUDGET))
      return { hits, resumeAfter: lastExamined, partial: true };
    next.buffer.shift();
    rows++;
    chars += key.cost;
    const row = next.source.load(key);
    if (row !== undefined && next.source.accept(row)) {
      // One accepted row beyond the page proves there is more: resume after the last returned.
      if (hits.length === limit) return { hits, resumeAfter: hits.at(-1)!.key, partial: false };
      hits.push({ key, row });
    }
    lastExamined = key;
  }
}

export class InvalidContextCursor extends Error {}

export function searchOrganization(
  scope: OrganizationReadScope,
  input: { q: string; types: SearchType[]; limit: number; cursor?: SearchCursor },
) {
  return cached(scope, 'search', input, () => {
    const projects = new Map(
      scope.projectIds.flatMap((id) => {
        const project = readableProject(scope.serverId, id);
        return project ? [[id, project] as const] : [];
      }),
    );
    const ids = [...projects.keys()];
    const inList = placeholders(ids.length);
    type Row = { hit: () => SearchHit; texts: string[] };
    const sources: Array<ScanSource<Row>> = [];
    const accept = (row: Row) => matchesRedacted(row.texts, input.q);
    if (ids.length && input.types.includes('wiki'))
      sources.push(
        tableScanSource<Row>({
          type: 'wiki',
          from: 'wiki_pages',
          where: `project_id IN (${inList})`,
          params: ids,
          key: { updated: 'updated_at', project: 'project_id', id: 'id' },
          scalars: ['id', 'project_id', 'updated_at'],
          fields: [
            { column: 'title', max: RECORD_MATCH_MAX, alias: 'title' },
            { column: 'content', max: RECORD_MATCH_MAX, alias: 'content' },
            { column: 'slug', max: METADATA_MAX, alias: 'slug' },
          ],
          toRow: (r) => {
            const title = clean(r.title as string | null, RECORD_MATCH_MAX).text;
            const content = clean(r.content as string | null, RECORD_MATCH_MAX).text;
            return {
              texts: [title, content],
              hit: () => ({
                sortKey: r.updated_at as string,
                sortId: r.id as string,
                type: 'wiki' as const,
                // Page ID, not slug: a slug may be redacted, and detail accepts the ID.
                id: r.id as string,
                title,
                snippet: excerpt(content, input.q),
                source: source(scope, projects.get(r.project_id as string)!, `wiki:${r.slug}`),
                timestamp: isoTimestamp(r.updated_at as string),
              }),
            };
          },
          accept,
        }),
      );
    const boardSources = [
      { type: 'cards' as const, table: 'kanban_cards', alias: 'k', name: 'title', record: 'card' },
      { type: 'epics' as const, table: 'kanban_epics', alias: 'e', name: 'name', record: 'epic' },
    ];
    for (const s of boardSources) {
      if (!ids.length || !input.types.includes(s.type)) continue;
      const a = s.alias;
      sources.push(
        tableScanSource<Row>({
          type: s.type,
          from: `${s.table} ${a} JOIN kanban_boards b ON b.id = ${a}.board_id`,
          where: `b.project_id IN (${inList})`,
          params: ids,
          key: { updated: `${a}.updated_at`, project: 'b.project_id', id: `${a}.id` },
          scalars: [`${a}.id AS id`, 'b.project_id AS project_id', `${a}.updated_at AS updated_at`],
          fields: [
            { column: `${a}.${s.name}`, max: RECORD_MATCH_MAX, alias: 'name' },
            { column: `${a}.description`, max: RECORD_MATCH_MAX, alias: 'description' },
          ],
          toRow: (r) => {
            const name = clean(r.name as string | null, RECORD_MATCH_MAX).text;
            const description = clean(r.description as string | null, RECORD_MATCH_MAX).text;
            return {
              texts: [name, description],
              hit: () => ({
                sortKey: r.updated_at as string,
                sortId: r.id as string,
                type: s.type,
                id: r.id as string,
                title: name,
                snippet: excerpt(description || name, input.q),
                source: source(scope, projects.get(r.project_id as string)!, `${s.record}:${r.id}`),
                timestamp: isoTimestamp(r.updated_at as string),
              }),
            };
          },
          accept,
        }),
      );
    }
    const scan = boundedScan(sources, input.cursor, input.limit);
    const nextCursor = scan.resumeAfter
      ? encodeSearchCursor(
          positionOf(scan.resumeAfter),
          searchCursorBinding(scope, input.q, input.types),
        )
      : null;
    // The cursor is sealed, so it is attached after sanitizing (redaction would corrupt it).
    return {
      ...sanitizeContextOutput({
        serverId: scope.serverId,
        organizationId: scope.organizationId,
        retrievedAt: new Date().toISOString(),
        results: scan.hits.map(({ row }) => {
          const { sortKey: _sortKey, sortId: _sortId, ...hit } = row.hit();
          return hit;
        }),
      }),
      // True when this page stopped at the scan budget: fewer results does not mean the end.
      // Keep following nextCursor until it is null.
      partial: scan.partial,
      nextCursor,
    };
  });
}

// ── Server totals ───────────────────────────────────────────────────────────

/** Server-wide totals for one user. A project linked to several organizations counts once. */
export function organizationServerSummary(caller: OrganizationCaller, page: Page) {
  const organizations = listBusinessOrganizations(caller.serverId).filter(
    (organization) => organizationAccess(caller, organization.id).canView,
  );
  const distinct = new Set<string>();
  const all = organizations.map((organization) => {
    const scope = scopeForMember(caller, organization.id);
    const projectIds = scope?.projectIds ?? [];
    for (const id of projectIds) distinct.add(id);
    return {
      organizationId: organization.id,
      name: organization.name,
      linkedProjects: projectIds.length,
    };
  });
  return sanitizeContextOutput({
    serverId: caller.serverId,
    retrievedAt: new Date().toISOString(),
    organizations: organizations.length,
    linkedProjects: distinct.size,
    // Totals cover every organization; the per-organization breakdown is paginated.
    offset: page.offset,
    nextOffset: all.length > page.offset + page.limit ? page.offset + page.limit : null,
    perOrganization: all.slice(page.offset, page.offset + page.limit),
  });
}
