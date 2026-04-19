/**
 * Designs REST routes. CRUD + message history for hub-level Claude-Design
 * canvases. Chat itself flows over WebSocket (`design_chat` / `design_cancel`
 * in server/websocket.ts → design-chat.ts); this router only covers the
 * data-plane surface that the web client needs to list, create, rename,
 * link, or delete designs.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps, DesignWithProjects } from '../types.js';
import {
  createDesign,
  listDesigns,
  getDesign,
  renameDesign,
  setLinkedProjects,
  deleteDesign,
  listDesignMessages,
} from '../designs-store.js';
import { getActiveOrgId } from '../orgs.js';

interface DesignRouteDeps extends RouteDeps {
  /** Absolute path of `<dataDir>/designs/`. Injected by index.ts. */
  getDesignsRoot: () => string;
}

export default function createDesignRoutes(deps: DesignRouteDeps): Router {
  const { findProject, broadcast, getDesignsRoot } = deps;
  const router = Router();

  function lookup(projectId: string) {
    return findProject(projectId);
  }

  router.get('/api/designs', (_req: Request, res: Response) => {
    res.json(listDesigns(lookup, getActiveOrgId()));
  });

  router.post('/api/designs', (req: Request, res: Response) => {
    const { name, linkedProjectIds } = req.body as {
      name?: string;
      linkedProjectIds?: string[];
    };
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const ids = Array.isArray(linkedProjectIds)
      ? linkedProjectIds.filter((x) => typeof x === 'string')
      : [];
    try {
      const design = createDesign(name, ids, getDesignsRoot(), lookup, getActiveOrgId());
      broadcast({ type: 'design_created', design });
      res.status(201).json(design);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  router.get('/api/designs/:id', (req: Request, res: Response) => {
    const design: DesignWithProjects | null = getDesign(
      req.params.id as string,
      lookup,
      getActiveOrgId(),
    );
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json(design);
  });

  router.patch('/api/designs/:id', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });

    const { name, linkedProjectIds } = req.body as {
      name?: string;
      linkedProjectIds?: string[];
    };
    try {
      if (typeof name === 'string' && name.trim()) {
        renameDesign(design.id, name);
      }
      if (Array.isArray(linkedProjectIds)) {
        setLinkedProjects(
          design.id,
          linkedProjectIds.filter((x) => typeof x === 'string'),
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: msg });
    }

    const updated = getDesign(design.id, lookup, getActiveOrgId());
    broadcast({ type: 'design_updated', designId: updated?.id });
    res.json(updated);
  });

  router.delete('/api/designs/:id', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    deleteDesign(design.id, getDesignsRoot());
    broadcast({ type: 'design_deleted', designId: design.id });
    res.json({ ok: true });
  });

  router.get('/api/designs/:id/messages', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json(listDesignMessages(design.id));
  });

  return router;
}
