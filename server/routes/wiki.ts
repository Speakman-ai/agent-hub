import { Router, Request, Response } from 'express';
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

    if (req.query.q) {
      // Legacy `?q=` keeps returning FTS5 results so the wiki-search skill and
      // any existing callers aren't disturbed. New callers should hit the
      // dedicated `/wiki/search` endpoint below for hybrid/semantic modes.
      res.json(
        searchPages(projectId, req.query.q as string, parseInt(req.query.limit as string) || 10),
      );
    } else if (req.query.category) {
      res.json(stmts.getWikiPagesByCategory.all(projectId, req.query.category));
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

    const q = (req.query.q as string | undefined)?.trim();
    if (!q)
      return res.json({ mode: 'hybrid', results: [], geminiConfigured: isGeminiConfigured() });

    const mode = parseMode(req.query.mode);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 10, 1), 50);

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

    const { title, content, category, updatedBy } = req.body as {
      title?: string;
      content?: string;
      category?: string;
      updatedBy?: string;
    };
    if (!title) return res.status(400).json({ error: 'Title is required' });

    try {
      const page = createPage(projectId, { title, content, category, updatedBy });
      broadcast({ type: 'wiki_update', projectId, page });
      res.status(201).json(page);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.put('/api/projects/:projectId/wiki/:slug', (req: Request, res: Response) => {
    const { title, content, category, updatedBy } = req.body as {
      title?: string;
      content?: string;
      category?: string;
      updatedBy?: string;
    };
    try {
      const page = updatePage(req.params.projectId as string, req.params.slug as string, {
        title,
        content,
        category,
        updatedBy,
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
