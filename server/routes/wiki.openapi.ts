/**
 * Zod schemas + OpenAPI registrations for the wiki route group.
 *
 * Imported for:
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

// Domain component schemas (response shapes)

const WIKI_CATEGORIES = [
  'general',
  'api-docs',
  'architecture',
  'conventions',
  'test-patterns',
  'troubleshooting',
  'onboarding',
  'documents',
] as const;

const WikiCategoryEnum = z.enum(WIKI_CATEGORIES);

// Full wiki page row — includes `content`. Used for single-page GET responses.
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
      source_file: z.object({ id: z.string(), path: z.string() }).nullable().optional().openapi({
        description:
          'Set when the page is generated from an uploaded wiki file. Such pages are read-only; PUT returns 409 `file_backed_page`.',
      }),
    })
    .openapi({ description: 'A wiki page row (includes full content).' }),
);

// List-item shape — no `content`. The list SQL (`getWikiPages`,
// `getWikiPagesByCategory`) never projects content to keep payload size down.
export const WikiPageListItemComponent = registerComponent(
  'WikiPageListItem',
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
    })
    .openapi({
      description:
        'A wiki page list item (content omitted for payload size). Returned by `GET /wiki` bare and `?category=` paths.',
    }),
);

// Returned by `searchPages` (legacy FTS5 path on `GET /wiki?q=`). Extends the
// list-item shape (no `content`) with FTS5 `snippet` and bm25-ish `rank`.
export const WikiSearchHitComponent = registerComponent(
  'WikiSearchHit',
  WikiPageListItemComponent.extend({
    snippet: z.string().optional(),
    rank: z.number().optional(),
  }).openapi({
    description:
      'A wiki page returned from the legacy FTS5 search path (`GET /wiki?q=`). Adds the highlighted `snippet` and bm25-ish `rank`. Content is not included.',
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

// Request schemas

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

export const DocumentBackfillRequestSchema = z.object({
  limit: z.number().int().min(1).max(25).optional().openapi({
    description:
      'Max undocumented Done cards to hand the docs agent this run (default 10, cap 25). Oldest first. The agent writes at most one page then stops; remaining cards in the batch are skip-marked when trivial.',
  }),
});

export const WikiScanRequestSchema = z.object({
  maxChanges: z.number().int().min(1).max(20).optional().openapi({
    description:
      'Max page writes (creates + updates) the docs agent may make this run (default 5, cap 20).',
  }),
});

// OpenAPI path registrations

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
    'When `?q=` is set, returns FTS5 hits (`WikiSearchHit[]` — list-item fields + `snippet` + `rank`, no `content`).',
    'When `?category=` is set, returns pages in that category (`WikiPageListItem[]`, no `content`).',
    'Otherwise returns every page in the project (`WikiPageListItem[]`, no `content`).',
    '`limit` only applies to the `?q=` path; the bare and category responses are unpaginated.',
    'Invalid `?limit=` values (non-numeric) and other schema violations return 400.',
  ].join(' '),
  request: {
    params: projectIdParams,
    query: ListWikiPagesQuerySchema,
  },
  responses: {
    200: {
      description: 'Wiki pages (shape depends on the query params — see description).',
      content: jsonContent(z.array(WikiPageListItemComponent)),
    },
    400: errorResponse('Query parameter validation failed.'),
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
    'Defaults to hybrid mode. Falls back to pure FTS when the Gemini API key is missing or the query embedding fails. Returns an empty `results` array for blank queries so the caller can branch on configuration without a separate health probe. Invalid `?limit=` values (non-numeric) and unknown `?mode=` values return 400.',
  request: {
    params: projectIdParams,
    query: SearchWikiQuerySchema,
  },
  responses: {
    200: {
      description: 'Search envelope.',
      content: jsonContent(WikiSearchResponseComponent),
    },
    400: errorResponse('Query parameter validation failed.'),
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

const WikiDocumentBackfillResultComponent = registerComponent(
  'WikiDocumentBackfillResult',
  z
    .object({
      skipped: z.boolean(),
      reason: z.string().optional(),
      reused: z.boolean().optional(),
      sessionId: z.string().optional(),
      agentId: z.string().optional(),
      queued: z.number().int().optional(),
    })
    .openapi({
      description:
        'Result of an on-demand wiki documentation backfill. `skipped: true` with `reason: none_undocumented` means the Done column has no remaining undocumented cards. Otherwise a docs-agent session was started (or reused) and `queued` is how many cards were handed to it.',
    }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/wiki/document-backfill',
  tags: ['Wiki'],
  summary: 'Start an on-demand wiki documentation backfill',
  description: [
    'Spawns the project docs agent to review the oldest undocumented Done cards.',
    'This is not a scheduled drain; call it when an operator asks to backfill.',
    'New work is documented automatically when a PR merges (if a docs agent exists and the linked card is still undocumented).',
    '`documented = 1` means reviewed for the wiki, not that the card has its own article.',
  ].join(' '),
  request: {
    params: projectIdParams,
    body: { content: jsonContent(DocumentBackfillRequestSchema), required: false },
  },
  responses: {
    200: {
      description: 'Existing backfill session reused, or nothing left to review.',
      content: jsonContent(WikiDocumentBackfillResultComponent),
    },
    201: {
      description: 'Docs session started.',
      content: jsonContent(WikiDocumentBackfillResultComponent),
    },
    400: errorResponse('Validation failed (invalid limit).'),
    404: errorResponse('Project or docs agent not found.'),
    409: errorResponse('Backfill skipped for another reason.'),
  },
});

const WikiScanResultComponent = registerComponent(
  'WikiScanResult',
  z
    .object({
      reused: z.boolean(),
      sessionId: z.string(),
      agentId: z.string(),
      pageCount: z.number().int(),
      maxChanges: z.number().int(),
    })
    .openapi({
      description:
        'A docs-agent scan session was started (or an already-running scan was reused). `pageCount` is how many wiki pages existed when the scan was queued.',
    }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/wiki/scan',
  tags: ['Wiki'],
  summary: 'Scan the codebase and docs for wiki updates',
  description: [
    'Spawns the project docs agent to audit the wiki against the current codebase and in-repo documentation.',
    'The agent adds missing pages and fixes stale ones, capped at `maxChanges` page writes.',
    'A second call while a scan is running returns the running session instead of starting another.',
  ].join(' '),
  request: {
    params: projectIdParams,
    body: { content: jsonContent(WikiScanRequestSchema), required: false },
  },
  responses: {
    200: {
      description: 'A scan is already running; its session is returned.',
      content: jsonContent(WikiScanResultComponent),
    },
    201: {
      description: 'Scan session started.',
      content: jsonContent(WikiScanResultComponent),
    },
    400: errorResponse('Validation failed (invalid maxChanges).'),
    404: errorResponse('Project or docs agent not found.'),
    409: errorResponse('Scan could not be started.'),
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

// Wiki files — uploaded documents in folders, indexed via a linked page.

export const WikiFileComponent = registerComponent(
  'WikiFile',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      folder: z.string().openapi({ description: 'Slash-separated folder path; empty for root.' }),
      filename: z.string(),
      path: z.string().openapi({ description: '`folder/filename`.' }),
      content_type: z.string(),
      size_bytes: z.number().int(),
      storage_key: z.string(),
      page_id: z.string().nullable(),
      page_slug: z
        .string()
        .nullable()
        .openapi({ description: 'Slug of the wiki page holding the extracted text.' }),
      extracted_chars: z.number().int(),
      truncated: z.number().int(),
      uploaded_by: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({
      description:
        'An uploaded wiki file. Its extracted text lives in the linked wiki page (category `documents`), which FTS, embeddings, and RAG index.',
    }),
);

export const ListWikiFilesQuerySchema = z.object({
  folder: z.string().optional().openapi({
    description: 'Only list files directly in this folder. Omit to list every file.',
  }),
});

export const UploadWikiFileQuerySchema = z.object({
  filename: z.string().min(1, 'filename is required'),
  folder: z.string().optional(),
});

export const MoveWikiFileRequestSchema = z.object({
  folder: z.string().openapi({ description: 'Destination folder path; empty string for root.' }),
});

const wikiFileParams = z.object({ projectId: z.string(), fileId: z.string() });

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/wiki-files',
  tags: ['Wiki'],
  summary: 'List uploaded wiki files',
  request: { params: projectIdParams, query: ListWikiFilesQuerySchema },
  responses: {
    200: {
      description: 'Files, ordered by folder then filename.',
      content: jsonContent(z.array(WikiFileComponent)),
    },
    400: errorResponse('Invalid folder.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/wiki-files',
  tags: ['Wiki'],
  summary: 'Upload a file into a wiki folder',
  description:
    'Raw request body is the file bytes. Text is extracted (PDF, DOCX, Markdown, HTML, plain-text formats) into a linked wiki page with category `documents`, so the document is searchable and used for RAG. Re-uploading the same `folder` + `filename` replaces the file and rewrites the page in place.',
  request: {
    params: projectIdParams,
    query: UploadWikiFileQuerySchema,
    body: {
      content: {
        'application/octet-stream': {
          schema: z.string().openapi({ format: 'binary', description: 'Raw file bytes.' }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Existing file replaced.',
      content: jsonContent(
        z.object({
          file: WikiFileComponent,
          page: z.object({ id: z.string(), slug: z.string(), title: z.string() }),
          replaced: z.boolean(),
        }),
      ),
    },
    201: {
      description: 'New file stored and indexed.',
      content: jsonContent(
        z.object({
          file: WikiFileComponent,
          page: z.object({ id: z.string(), slug: z.string(), title: z.string() }),
          replaced: z.boolean(),
        }),
      ),
    },
    400: errorResponse('Missing filename, bad folder, empty body, or rejected executable.'),
    404: errorResponse('Project not found.'),
    413: errorResponse('File too large, or it expands past the extraction limits.'),
    415: errorResponse('Unsupported file type.'),
    422: errorResponse('The file could not be parsed.'),
    503: errorResponse(
      'Upload capacity is saturated. Retry after the `Retry-After` header (seconds); `code` is `busy`.',
    ),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/wiki-files/{fileId}/download',
  tags: ['Wiki'],
  summary: 'Download the original bytes of an uploaded wiki file',
  request: { params: wikiFileParams },
  responses: {
    200: {
      description: 'File bytes with the stored content type.',
      content: {
        'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) },
      },
    },
    404: errorResponse('File not found.'),
    503: errorResponse('Download capacity is saturated. Retry after `Retry-After` seconds.'),
  },
});

registerPath({
  method: 'patch',
  path: '/api/projects/{projectId}/wiki-files/{fileId}',
  tags: ['Wiki'],
  summary: 'Move an uploaded wiki file to another folder',
  request: {
    params: wikiFileParams,
    body: { content: jsonContent(MoveWikiFileRequestSchema) },
  },
  responses: {
    200: { description: 'Updated file.', content: jsonContent(WikiFileComponent) },
    400: errorResponse('Invalid folder.'),
    404: errorResponse('File not found.'),
    409: errorResponse('A file with that name already exists in the destination folder.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/wiki-files/{fileId}',
  tags: ['Wiki'],
  summary: 'Delete an uploaded wiki file and its indexed page',
  request: { params: wikiFileParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
    404: errorResponse('File not found.'),
  },
});
