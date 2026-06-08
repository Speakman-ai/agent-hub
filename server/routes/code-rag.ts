import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import {
  indexProjectCode,
  searchCode,
  countProjectCodeChunks,
  isGeminiConfigured,
  type CodeSearchMode,
} from '../code-embeddings.js';
import type { RouteDeps } from '../types.js';
import { CodeSearchQuerySchema, CodeIndexRequestSchema } from './code-rag.openapi.js';

function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  res: Response,
): { ok: true; data: z.infer<T> } | { ok: false } {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return { ok: false };
  }
  return { ok: true, data: result.data };
}

function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = validate(schema, req.query, res);
  return result.ok ? result.data : undefined;
}

/**
 * Code-RAG routes: index the project source tree, check status, and run
 * hybrid/semantic/fts search over the indexed chunks. The chat handler injects
 * top matches automatically (see `server/code-rag.ts`); these endpoints expose
 * the same machinery for manual indexing and debugging.
 */
export default function createCodeRagRoutes({ findProject }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.post('/api/projects/:projectId/code-index', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Validate the body (rejects e.g. `maxFiles: -1`) BEFORE any indexing work,
    // so out-of-bounds values can't reach `indexProjectCode` and trigger a
    // partial scan / accidental prune.
    const parsed = validate(CodeIndexRequestSchema, req.body, res);
    if (!parsed.ok) return;
    const maxFiles = parsed.data?.maxFiles;

    if (!isGeminiConfigured()) {
      return res.status(503).json({
        error: 'Gemini API key not configured. Set GEMINI_API_KEY or config.geminiApiKey.',
      });
    }

    try {
      const result = await indexProjectCode(projectId, project.cwd, { maxFiles });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/projects/:projectId/code-index/status', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({
      chunks: countProjectCodeChunks(projectId),
      geminiConfigured: isGeminiConfigured(),
    });
  });

  router.get('/api/projects/:projectId/code-search', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = parseQuery(CodeSearchQuerySchema, req, res);
    if (!parsed) return;

    const q = parsed.q?.trim();
    if (!q)
      return res.json({ mode: 'hybrid', results: [], geminiConfigured: isGeminiConfigured() });

    const mode: CodeSearchMode = parsed.mode ?? 'hybrid';
    const limit = Math.min(Math.max(parsed.limit ?? 8, 1), 50);

    try {
      const results = await searchCode(projectId, q, { mode, limit });
      res.json({ mode, query: q, geminiConfigured: isGeminiConfigured(), results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
