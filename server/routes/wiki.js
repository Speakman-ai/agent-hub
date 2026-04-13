import { Router } from 'express';
import { stmts } from '../db.js';
import {
  listPages,
  getPage,
  createPage,
  updatePage,
  deletePage,
  searchPages,
  CATEGORIES as WIKI_CATEGORIES,
} from '../wiki.js';

/**
 * Create the wiki router.
 *
 * @param {object} deps
 * @param {function} deps.findProject  - (projectId) => project | null
 * @param {function} deps.broadcast    - (data) => void – send to all WS clients
 * @returns {Router}
 */
export default function createWikiRouter({ findProject, broadcast }) {
  const router = Router();

  // List / search / filter wiki pages
  router.get('/api/projects/:projectId/wiki', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (req.query.q) {
      res.json(searchPages(req.params.projectId, req.query.q, parseInt(req.query.limit) || 10));
    } else if (req.query.category) {
      res.json(stmts.getWikiPagesByCategory.all(req.params.projectId, req.query.category));
    } else {
      res.json(listPages(req.params.projectId));
    }
  });

  // List valid categories
  router.get('/api/projects/:projectId/wiki/categories', (_req, res) => {
    res.json(WIKI_CATEGORIES);
  });

  // Get a single page by slug
  router.get('/api/projects/:projectId/wiki/:slug', (req, res) => {
    const page = getPage(req.params.projectId, req.params.slug);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json(page);
  });

  // Create a new page
  router.post('/api/projects/:projectId/wiki', (req, res) => {
    const project = findProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { title, content, category, updatedBy } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    try {
      const page = createPage(req.params.projectId, { title, content, category, updatedBy });
      broadcast({ type: 'wiki_update', projectId: req.params.projectId, page });
      res.status(201).json(page);
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  // Update an existing page
  router.put('/api/projects/:projectId/wiki/:slug', (req, res) => {
    const { title, content, category, updatedBy } = req.body;
    try {
      const page = updatePage(req.params.projectId, req.params.slug, {
        title,
        content,
        category,
        updatedBy,
      });
      broadcast({ type: 'wiki_update', projectId: req.params.projectId, page });
      res.json(page);
    } catch (err) {
      if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
      res.status(409).json({ error: err.message });
    }
  });

  // Delete a page
  router.delete('/api/projects/:projectId/wiki/:slug', (req, res) => {
    const deleted = deletePage(req.params.projectId, req.params.slug);
    if (!deleted) return res.status(404).json({ error: 'Page not found' });
    broadcast({ type: 'wiki_delete', projectId: req.params.projectId, slug: req.params.slug });
    res.json({ ok: true });
  });

  return router;
}
