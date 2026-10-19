import { z, registerComponent, registerPath } from '../openapi/registry.js';
import {
  CONTEXT_PAGE_MAX,
  PROJECT_RESOURCES,
  RECORD_RESOURCES,
  SEARCH_TYPES,
} from '../organization-context.js';

const id = z.string().min(1).max(200);
export const ContextParams = z.object({ organizationId: id });
export const ResourceParams = ContextParams.extend({
  projectId: id,
  resource: z.enum(PROJECT_RESOURCES),
});
export const RecordParams = ContextParams.extend({
  projectId: id,
  resource: z.enum(RECORD_RESOURCES),
  recordId: id,
});
// No offset ceiling: every returned nextOffset must be followable. Page size stays bounded.
const pagination = {
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(CONTEXT_PAGE_MAX).default(20),
};
export const OverviewQuery = z.object(pagination).strict();
export const ResourceQuery = z
  .object({
    ...pagination,
    q: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().max(2000).optional().openapi({
      description:
        'With q (or a card column filter): nextCursor from the previous page. Filtered results are cursor-paged.',
    }),
    column: z.string().trim().min(1).max(200).optional(),
    epicId: id.optional(),
  })
  .strict();
export const SearchQuery = z
  .object({
    limit: pagination.limit,
    cursor: z
      .string()
      .max(2000)
      .optional()
      .openapi({ description: 'nextCursor from the previous page; omit for the first page.' }),
    q: z.string().trim().min(1).max(200),
    types: z
      .string()
      .optional()
      .transform((value) => (value ? value.split(',') : [...SEARCH_TYPES]))
      .pipe(z.array(z.enum(SEARCH_TYPES)).min(1)),
  })
  .strict();
export const SummaryQuery = z.object(pagination).strict();

const Source = registerComponent(
  'OrganizationContextSource',
  z.object({
    serverId: z.string(),
    organizationId: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    record: z.string().openapi({ example: 'card:3f2a…' }),
  }),
);
const Cited = z
  .object({ source: Source, timestamp: z.string().nullable() })
  .passthrough()
  .openapi({ description: 'A record with its source citation and last-update timestamp.' });
const PageMeta = {
  serverId: z.string(),
  organizationId: z.string(),
  retrievedAt: z.string(),
  offset: z.number(),
  nextOffset: z.number().nullable(),
};
const Overview = z.object({
  ...PageMeta,
  agentId: z.string().nullable(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      source: Source,
      timestamp: z.string().nullable(),
      agents: z.array(z.object({ id: z.string(), name: z.string(), role: z.string().nullable() })),
      agentCount: z.number(),
      agentsTruncated: z.boolean(),
      board: z.object({
        columns: z
          .array(z.object({ name: z.string(), count: z.number() }))
          .openapi({ description: 'At most 20 columns; see columnCount/columnsTruncated.' }),
        columnCount: z.number(),
        columnsTruncated: z.boolean(),
        openCards: z.number(),
        totalCards: z.number(),
        epics: z.number(),
        phases: z.number(),
      }),
      wiki: z.object({ pages: z.number(), updatedAt: z.string().nullable() }),
      sessions: z.object({ own: z.number(), updatedAt: z.string().nullable() }),
    }),
  ),
});
const ResourceList = z.object({
  ...PageMeta,
  projectId: z.string(),
  resource: z.enum(PROJECT_RESOURCES),
  items: z.array(Cited),
  partial: z.boolean().openapi({
    description:
      'Filtered pages: the page stopped at the per-request scan budget; keep following nextCursor.',
  }),
  nextCursor: z
    .string()
    .nullable()
    .openapi({ description: 'Filtered pages: opaque continuation; null on the last page.' }),
});
const RecordDetail = z.object({
  serverId: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  resource: z.enum(RECORD_RESOURCES),
  retrievedAt: z.string(),
  record: Cited,
});
const SearchResults = z.object({
  serverId: z.string(),
  organizationId: z.string(),
  retrievedAt: z.string(),
  partial: z.boolean().openapi({
    description:
      'True when the page stopped at the per-request scan budget; fewer results does not mean the end.',
  }),
  nextCursor: z
    .string()
    .nullable()
    .openapi({ description: 'Opaque keyset cursor for the next page; null on the last page.' }),
  results: z.array(
    z.object({
      type: z.enum(SEARCH_TYPES),
      id: z.string(),
      title: z.string(),
      snippet: z.string(),
      source: Source,
      timestamp: z.string().nullable(),
    }),
  ),
});
const Summary = z.object({
  serverId: z.string(),
  retrievedAt: z.string(),
  organizations: z.number(),
  linkedProjects: z.number().openapi({
    description:
      'Distinct visible projects; a project linked to several organizations counts once.',
  }),
  offset: z.number(),
  nextOffset: z.number().nullable(),
  perOrganization: z
    .array(z.object({ organizationId: z.string(), name: z.string(), linkedProjects: z.number() }))
    .openapi({ description: 'One page of the per-organization breakdown.' }),
});

const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
const error = json(z.object({ error: z.string() }));
const errors = {
  400: { description: 'Invalid request.', content: error },
  401: { description: 'Authentication or capability missing, expired or revoked.', content: error },
  403: {
    description: 'Capability lacks projects:read or targets another organization.',
    content: error,
  },
  404: { description: 'Organization, project or record absent or not authorized.', content: error },
};
const scope =
  ' Authorized for the intersection of current organization links, the calling agent project scope (organization capabilities) and the acting user project ACL. Sessions are limited to the acting user. Free text is redacted and truncated.';
const base = '/api/organizations/{organizationId}/context';

registerPath({
  method: 'get',
  path: '/api/organizations/summary',
  tags: ['Organizations'],
  summary: 'Server-wide organization totals for the current user',
  description:
    'Counts only organizations and projects the user can see. A project linked to several organizations is counted once. Not available to organization capabilities.',
  request: { query: SummaryQuery },
  responses: { 200: { description: 'Totals.', content: json(Summary) }, ...errors },
});
registerPath({
  method: 'get',
  path: base,
  tags: ['Organizations'],
  summary: 'Paginated overview of authorized linked projects',
  description: 'Roster, board, wiki and own-session counts per project.' + scope,
  request: { params: ContextParams, query: OverviewQuery },
  responses: { 200: { description: 'Overview page.', content: json(Overview) }, ...errors },
});
registerPath({
  method: 'get',
  path: `${base}/search`,
  tags: ['Organizations'],
  summary: 'Search wiki pages, cards and epics across authorized linked projects',
  description: 'Results are cited and newest-first.' + scope,
  request: { params: ContextParams, query: SearchQuery },
  responses: { 200: { description: 'Search page.', content: json(SearchResults) }, ...errors },
});
registerPath({
  method: 'get',
  path: `${base}/projects/{projectId}/{resource}`,
  tags: ['Organizations'],
  summary: 'List one resource of an authorized linked project',
  description: 'agents, cards, epics, phases, wiki pages or the acting user sessions.' + scope,
  request: { params: ResourceParams, query: ResourceQuery },
  responses: { 200: { description: 'Resource page.', content: json(ResourceList) }, ...errors },
});
registerPath({
  method: 'get',
  path: `${base}/projects/{projectId}/{resource}/{recordId}`,
  tags: ['Organizations'],
  summary: 'Read one record of an authorized linked project on demand',
  description:
    'Card (with recent comments), epic, wiki page (by slug) or own session status with its latest result.' +
    scope,
  request: { params: RecordParams },
  responses: { 200: { description: 'Record.', content: json(RecordDetail) }, ...errors },
});
