/**
 * Zod schemas + OpenAPI registrations for the code-RAG route group.
 *
 * Imported for two reasons (same contract as `wiki.openapi.ts`):
 *   1. `server/routes/code-rag.ts` imports the request schemas and validates
 *      incoming query/body with `safeParse(...)`.
 *   2. `server/openapi/generate.ts` imports this module so the side-effect
 *      `registerPath` calls land in the generated `docs/api/openapi.yaml`.
 *
 * Code-RAG indexes a project's source tree into chunk-level embeddings + an
 * FTS5 index, then serves hybrid (BM25 + cosine) search. See
 * `server/code-embeddings.ts` and `server/code-rag.ts`.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Request schemas ────────────────────────────────────────────────

const LimitQuery = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : Number(v)),
  z.number().int().positive().optional(),
);

export const CodeSearchQuerySchema = z.object({
  q: z.string().optional(),
  mode: z.enum(['hybrid', 'semantic', 'fts']).optional(),
  limit: LimitQuery,
});

export const CodeIndexRequestSchema = z
  .object({
    maxFiles: z.number().int().positive().max(20000).optional(),
  })
  .optional();

// ─── Response component schemas ──────────────────────────────────────

const CodeSearchResultComponent = registerComponent(
  'CodeSearchResult',
  z
    .object({
      filePath: z.string(),
      chunkIdx: z.number().int(),
      startLine: z.number().int(),
      endLine: z.number().int(),
      text: z.string(),
      score: z.number(),
      ftsScore: z.number().optional(),
      semanticScore: z.number().optional(),
      snippet: z.string().optional(),
    })
    .openapi({ description: 'A single chunk-level code search hit with a citation range.' }),
);

const CodeSearchResponseComponent = registerComponent(
  'CodeSearchResponse',
  z
    .object({
      mode: z.enum(['hybrid', 'semantic', 'fts']),
      query: z.string().optional(),
      geminiConfigured: z.boolean(),
      results: z.array(CodeSearchResultComponent),
    })
    .openapi({ description: 'Code search envelope.' }),
);

const CodeIndexResultComponent = registerComponent(
  'CodeIndexResult',
  z
    .object({
      projectId: z.string(),
      root: z.string(),
      scanned: z.number().int(),
      indexed: z.number().int(),
      skipped: z.number().int(),
      removed: z.number().int(),
      chunks: z.number().int(),
      errors: z.array(z.object({ file: z.string(), error: z.string() })),
      geminiConfigured: z.boolean(),
      truncated: z.boolean().openapi({
        description: 'True when the scan was capped by maxFiles; pruning was skipped.',
      }),
    })
    .openapi({ description: 'Per-run code indexing report.' }),
);

const CodeIndexStatusComponent = registerComponent(
  'CodeIndexStatus',
  z
    .object({
      chunks: z.number().int(),
      geminiConfigured: z.boolean(),
    })
    .openapi({ description: 'Code index status for a project.' }),
);

const CodeRagErrorResponseComponent = registerComponent(
  'CodeRagErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

// ─── Path registrations ──────────────────────────────────────────────

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project ID (slug).' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(CodeRagErrorResponseComponent),
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/code-index',
  tags: ['Code RAG'],
  summary: 'Index (or incrementally re-index) the project source tree',
  description:
    'Walks the project checkout (`project.cwd`), embeds eligible source files into chunk-level vectors, and refreshes the FTS index. Idempotent: unchanged files (matched by content hash) are skipped and deleted files are pruned (pruning is skipped when the scan is capped by `maxFiles`, i.e. `truncated: true`). Invalid `maxFiles` (non-positive or > 20000) returns 400. Returns 503 when no Gemini embedding key is configured.',
  request: {
    params: projectIdParams,
    body: {
      content: jsonContent(
        z.object({ maxFiles: z.number().int().positive().max(20000).optional() }),
      ),
    },
  },
  responses: {
    200: { description: 'Indexing report.', content: jsonContent(CodeIndexResultComponent) },
    400: errorResponse('Request body validation failed.'),
    404: errorResponse('Project not found.'),
    503: errorResponse('Gemini embedding key not configured.'),
    500: errorResponse('Indexing error.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/code-index/status',
  tags: ['Code RAG'],
  summary: 'Code index status',
  description:
    'Returns the number of indexed chunks for the project and whether Gemini is configured.',
  request: { params: projectIdParams },
  responses: {
    200: { description: 'Status.', content: jsonContent(CodeIndexStatusComponent) },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/code-search',
  tags: ['Code RAG'],
  summary: 'Search indexed project code (hybrid / semantic / fts)',
  description:
    'Defaults to hybrid mode. Falls back to pure FTS when the Gemini key is missing or the query embedding fails. Returns an empty `results` array for blank queries. Invalid `?limit=` (non-numeric) and unknown `?mode=` values return 400.',
  request: { params: projectIdParams, query: CodeSearchQuerySchema },
  responses: {
    200: { description: 'Search envelope.', content: jsonContent(CodeSearchResponseComponent) },
    400: errorResponse('Query parameter validation failed.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Underlying search or embedding error.'),
  },
});
