/**
 * Zod schemas + OpenAPI registrations for the wiki route group.
 *
 * This module is imported for two reasons:
 *
 *   1. `server/routes/wiki.ts` imports the exported request schemas and
 *      uses `safeParse(...)` to validate incoming bodies / query params.
 *      The handler keeps all of its downstream logic (slug collision
 *      handling, FTS index sync, embedding scheduling, broadcast, …) —
 *      only the ad-hoc `req.body as { ... }` cast is replaced.
 *
 *   2. `server/openapi/generate.ts` walks `server/routes/*.ts` and
 *      imports every module to trigger the side-effect `registerPath` /
 *      `registerComponent` calls below. The wiki section of the
 *      generated `docs/api/openapi.yaml` comes out of this file.
 *
 * Design notes:
 *
 * - **No aliases.** Unlike the board routes, wiki bodies have always been
 *   camelCase (`updatedBy`) — no snake_case wire keys to fold in.
 *
 * - **List endpoint shape switching.** `GET /wiki` flips its response
 *   shape depending on which query param is set (`?q=` → FTS results
 *   with snippet/rank; `?category=` → category filter; bare → all pages).
 *   We register the union as the 200 response so the spec captures every
 *   case without exploding into three operations.
 *
 * - **Search response components.** The hybrid search endpoint surfaces
 *   score components (`ftsScore`, `semanticScore`, `score`) and an
 *   optional `matchedChunk`. We register a dedicated component so the
 *   shape stays in lock-step with `SearchResultRow` in
 *   `wiki-embeddings.ts`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Domain component schemas (response shapes) ──────────────────

const WIKI_CATEGORIES = [
  'general',
  'api-docs',
  'architecture',
  'conventions',
  'test-patterns',
  'troubleshooting',
  'onboarding',
] as const;

const WikiCategoryEnum = z.enum(WIKI_CATEGORIES);

export const WikiPageComponent = registerComponent(
  'WikiPage',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      title: z.string(),
      slug: z.string(),
      content: z.string(),
      category: z.string(),
      updated_by: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({ description: 'A wiki page row.' }),
);

// Returned by `searchPages` (legacy FTS5 path on `GET /wiki?q=`). Same row
// shape with optional `snippet` (FTS5 highlight) and `rank` (bm25-ish score).
export const WikiSearchHitComponent = registerComponent(
  'WikiSearchHit',
  WikiPageComponent.extend({
    snippet: z.string().optional(),
    rank: z.number().optional(),
  }).openapi({
    description:
      'A wiki page returned from the legacy FTS5 search path (`GET /wiki?q=`). Adds the highlighted `snippet` and bm25-ish `rank`.',
  }),
);

// Returned by the dedicated /wiki/search endpoint. Drops the heavy
// `content` body (search responses can include many rows) and exposes the
// hybrid scoring components alongside the optional matched chunk.
export const WikiHybridSearchResultComponent = registerComponent(
  'WikiHybridSearchResult',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      title: z.string(),
      slug: z.string(),
      category: z.string(),
      updated_by: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
      score: z.number(),
      ftsScore: z.number().optional(),
      semanticScore: z.number().optional(),
      matchedChunk: z.string().optional(),
      snippet: z.string().optional(),
    })
    .openapi({
      description:
        'A hit from the hybrid/semantic/fts wiki search. `score` is the blended ranking; `ftsScore` / `semanticScore` are the per-mode components; `matchedChunk` is the highest-scoring chunk on the page (semantic / hybrid only).',
    }),
);

export const WikiSearchResponseComponent = registerComponent(
  'WikiSearchResponse',
  z
    .object({
      mode: z.enum(['hybrid', 'semantic', 'fts']),
      query: z.string().optional(),
      geminiConfigured: z.boolean(),
      results: z.array(WikiHybridSearchResultComponent),
    })
    .openapi({
      description:
        'Envelope returned by `GET /wiki/search`. `geminiConfigured` reports whether the server has a Gemini API key (semantic + hybrid modes fall back to FTS when false).',
    }),
);

export const WikiBackfillResultComponent = registerComponent(
  'WikiBackfillResult',
  z
    .object({
      projectId: z.string(),
      total: z.number().int(),
      embedded: z.number().int(),
      skipped: z.number().int(),
      errors: z.array(
        z.object({
          pageId: z.string(),
          error: z.string(),
        }),
      ),
    })
    .openapi({
      description:
        'Result of a project-wide wiki re-embedding pass. `total` is the count of pages scanned; `embedded` increments per successfully chunk-and-embed; `skipped` counts pages skipped because the embed client could not be invoked; `errors` lists per-page failures.',
    }),
);

export const WikiErrorResponseComponent = registerComponent(
  'WikiErrorResponse',
  z
    .object({
      error: z.string(),
      details: z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          }),
        )
        .optional(),
    })
    .openapi({
      description:
        'Error envelope. `details` is populated for 400 schema-validation errors with one entry per failing Zod issue.',
    }),
);

// ─── Request schemas ──────────────────────────────────────────────

/**
 * POST /wiki body. `title` is the only required field; `category` is a
 * free-form string on the wire today (the persistence layer doesn't
 * reject unknown categories) so we keep it as `string` here rather than
 * `WikiCategoryEnum` — locking it down would be a separate breaking
 * change and is outside this migration's scope.
 */
export const CreateWikiPageRequestSchema = z.object({
  title: z.string({ error: 'Title is required' }).min(1, 'Title is required'),
  content: z.string().optional(),
  category: z.string().optional(),
  updatedBy: z.string().optional(),
});

/**
 * PUT /wiki/:slug body. Every field is optional — omitted keys preserve
 * the existing value. `updatedBy` defaults to `'user'` server-side when
 * omitted.
 */
export const UpdateWikiPageRequestSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  category: z.string().optional(),
  updatedBy: z.string().optional(),
});

// Coercion helper for ?limit= which arrives as a string when present.
const LimitQuery = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : Number(v)),
  z.number().int().positive().optional(),
);

export const ListWikiPagesQuerySchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  limit: LimitQuery,
});

export const SearchWikiQuerySchema = z.object({
  q: z.string().optional(),
  mode: z.enum(['hybrid', 'semantic', 'fts']).optional(),
  limit: LimitQuery,
});

// ─── OpenAPI path registrations ───────────────────────────────────

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project ID (slug).' }),
});

const projectSlugParams = projectIdParams.extend({
  slug: z.string().openapi({ description: 'Wiki page slug (URL-safe).' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(WikiErrorResponseComponent),
});

// GET /wiki — list / legacy FTS search / category filter
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/wiki',
  tags: ['Wiki'],
  summary: 'List wiki pages (optionally filtered or FTS-searched)',
  description: [
    'When `?q=` is set, returns FTS5 hits in the legacy shape (page row + `snippet` + `rank`).',
    'When `?category=` is set, returns pages in that category.',
    'Otherwise returns every page in the project (content omitted for list payload size).',
    '`limit` only applies to the `?q=` path; the bare and category responses are unpaginated.',
  ].join(' '),
  request: {
    params: projectIdParams,
    query: ListWikiPagesQuerySchema,
  },
  responses: {
    200: {
      description: 'Wiki pages (shape depends on the query params).',
      content: jsonContent(z.array(WikiSearchHitComponent)),
    },
    404: errorResponse('Project not found.'),
  },
});

// GET /wiki/search — hybrid / semantic / fts search
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/wiki/search',
  tags: ['Wiki'],
  summary: 'Search wiki pages (hybrid / semantic / fts)',
  description:
    'Defaults to hybrid mode. Falls back to pure FTS when the Gemini API key is missing or the query embedding fails. Returns an empty `results` array for blank queries so the caller can branch on configuration without a separate health probe.',
  request: {
    params: projectIdParams,
    query: SearchWikiQuerySchema,
  },
  responses: {
    200: {
      description: 'Search envelope.',
      content: jsonContent(WikiSearchResponseComponent),
    },
    404: errorResponse('Project not found.'),
    500: errorResponse('Underlying search or embedding error.'),
  },
});

// POST /wiki/reembed — project-wide backfill
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/wiki/reembed',
  tags: ['Wiki'],
  summary: 'Re-embed every page in the project',
  description:
    'Idempotent: re-runs the chunk + embed pipeline for every page in the project. Useful after provisioning the Gemini API key for the first time or after changing the embedding model.',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Backfill report.',
      content: jsonContent(WikiBackfillResultComponent),
    },
    404: errorResponse('Project not found.'),
    503: errorResponse('Gemini API key not configured.'),
    500: errorResponse('Backfill failed.'),
  },
});

// GET /wiki/categories — list known categories
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/wiki/categories',
  tags: ['Wiki'],
  summary: 'List known wiki categories',
  description:
    'Returns the in-code list of categories (`general`, `api-docs`, `architecture`, `conventions`, `test-patterns`, `troubleshooting`, `onboarding`). The persistence layer accepts any string today; this list is purely a UI hint.',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Known categories.',
      content: jsonContent(z.array(WikiCategoryEnum)),
    },
  },
});

// GET /wiki/:slug — single page
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/wiki/{slug}',
  tags: ['Wiki'],
  summary: 'Get a single wiki page by slug',
  request: { params: projectSlugParams },
  responses: {
    200: { description: 'Page row.', content: jsonContent(WikiPageComponent) },
    404: errorResponse('Page not found.'),
  },
});

// POST /wiki — create a page
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/wiki',
  tags: ['Wiki'],
  summary: 'Create a wiki page',
  description:
    'Slug is derived from `title` via lowercase + non-alphanumeric squash. Returns 409 when the resulting slug collides with an existing page on the same project.',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateWikiPageRequestSchema) },
  },
  responses: {
    201: { description: 'New page.', content: jsonContent(WikiPageComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Project not found.'),
    409: errorResponse('Slug collision.'),
  },
});

// PUT /wiki/:slug — update a page
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/wiki/{slug}',
  tags: ['Wiki'],
  summary: 'Update a wiki page',
  description:
    'Partial update. Omitted fields keep their current value. Renaming `title` may change the slug; collisions return 409.',
  request: {
    params: projectSlugParams,
    body: { content: jsonContent(UpdateWikiPageRequestSchema) },
  },
  responses: {
    200: { description: 'Updated page.', content: jsonContent(WikiPageComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Page not found.'),
    409: errorResponse('Slug collision after rename.'),
  },
});

// DELETE /wiki/:slug — delete a page
registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/wiki/{slug}',
  tags: ['Wiki'],
  summary: 'Delete a wiki page',
  request: { params: projectSlugParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
    404: errorResponse('Page not found.'),
  },
});
