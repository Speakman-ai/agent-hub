import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import {
  listPages,
  getPage,
  createPage,
  updatePage,
  deletePage,
  searchPages,
  CATEGORIES as WIKI_CATEGORIES,
} from '../wiki.js';
import {
  searchWiki,
  backfillProject,
  isGeminiConfigured,
  type SearchMode,
} from '../wiki-embeddings.js';
import type { RouteDeps } from '../types.js';
import {
  CreateWikiPageRequestSchema,
  UpdateWikiPageRequestSchema,
  ListWikiPagesQuerySchema,
  SearchWikiQuerySchema,
} from './wiki.openapi.js';

/**
 * Validate `req.body` against a Zod schema. On failure, writes a 400 with
 * `{error, details}` and returns `undefined`; the handler must `return`
 * immediately. On success, returns the parsed data (typed).
 *
 * Mirrors the helper in `board.ts` so the wire shape of validation
 * failures is identical across route groups.
 */
function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

/**
 * Same as `parseBody` but for `req.query`. Express delivers query values
 * as `string | string[] | undefined` so the schema is responsible for any
 * coercion (see `LimitQuery` in `wiki.openapi.ts`).
 */
function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  req: Request,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

function parseMode(raw: unknown): SearchMode {
  if (raw === 'semantic' || raw === 'fts' || raw === 'hybrid') return raw;
  return 'hybrid';
}

export default function createWikiRoutes({ findProject, broadcast, stmts }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/api/projects/:projectId/wiki', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = parseQuery(ListWikiPagesQuerySchema, req, res);
    if (!parsed) return;

    if (parsed.q) {
      // Legacy `?q=` keeps returning FTS5 results so the wiki-search skill and
      // any existing callers aren't disturbed. New callers should hit the
      // dedicated `/wiki/search` endpoint below for hybrid/semantic modes.
      res.json(searchPages(projectId, parsed.q, parsed.limit ?? 10));
    } else if (parsed.category) {
      res.json(stmts.getWikiPagesByCategory.all(projectId, parsed.category));
    } else {
      res.json(listPages(projectId));
    }
  });

  // New hybrid/semantic/fts search endpoint. Defaults to hybrid; falls back
  // to pure FTS if the Gemini API key is missing or the query embed fails.
  router.get('/api/projects/:projectId/wiki/search', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = parseQuery(SearchWikiQuerySchema, req, res);
    if (!parsed) return;

    const q = parsed.q?.trim();
    if (!q)
      return res.json({ mode: 'hybrid', results: [], geminiConfigured: isGeminiConfigured() });

    const mode = parseMode(parsed.mode);
    const rawLimit = parsed.limit ?? 10;
    const limit = Math.min(Math.max(rawLimit, 1), 50);

    try {
      const results = await searchWiki(projectId, q, { mode, limit });
      res.json({ mode, query: q, geminiConfigured: isGeminiConfigured(), results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Idempotent backfill: re-embed every page in the project. Useful after
  // provisioning the API key for the first time, or after changing the
  // embedding model.
  router.post('/api/projects/:projectId/wiki/reembed', async (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!isGeminiConfigured()) {
      return res.status(503).json({
        error: 'Gemini API key not configured. Set GEMINI_API_KEY or config.geminiApiKey.',
      });
    }

    try {
      const result = await backfillProject(projectId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/projects/:projectId/wiki/categories', (_req: Request, res: Response) => {
    res.json(WIKI_CATEGORIES);
  });

  router.get('/api/projects/:projectId/wiki/:slug', (req: Request, res: Response) => {
    const page = getPage(req.params.projectId as string, req.params.slug as string);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
  });

  router.post('/api/projects/:projectId/wiki', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const parsed = parseBody(CreateWikiPageRequestSchema, req, res);
    if (!parsed) return;

    try {
      const page = createPage(projectId, {
        title: parsed.title,
        content: parsed.content,
        category: parsed.category,
        updatedBy: parsed.updatedBy,
      });
      broadcast({ type: 'wiki_update', projectId, page });
      res.status(201).json(page);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.put('/api/projects/:projectId/wiki/:slug', (req: Request, res: Response) => {
    const parsed = parseBody(UpdateWikiPageRequestSchema, req, res);
    if (!parsed) return;

    try {
      const page = updatePage(req.params.projectId as string, req.params.slug as string, {
        title: parsed.title,
        content: parsed.content,
        category: parsed.category,
        updatedBy: parsed.updatedBy,
      });
      broadcast({ type: 'wiki_update', projectId: req.params.projectId, page });
      res.json(page);
    } catch (err) {
      if ((err as Error).message.includes('not found'))
        return res.status(404).json({ error: (err as Error).message });
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/projects/:projectId/wiki/:slug', (req: Request, res: Response) => {
    const deleted = deletePage(req.params.projectId as string, req.params.slug as string);
    if (!deleted) return res.status(404).json({ error: 'Page not found' });
    broadcast({ type: 'wiki_delete', projectId: req.params.projectId, slug: req.params.slug });
    res.json({ ok: true });
  });

  return router;
}
