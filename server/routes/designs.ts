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
  listDesignFilesRecursive,
  patchDesignChatEngineModelSession,
} from '../designs-store.js';
import {
  DESIGN_CHAT_ENGINES,
  isDesignChatEngine,
  normalizeDesignEngine,
} from '../design-multi-engine.js';
import { getDesignStatus } from '../design-chat.js';
import { getActiveOrgId } from '../orgs.js';

interface DesignRouteDeps extends RouteDeps {
  /** Absolute path of `<dataDir>/designs/`. Injected by index.ts. */
  getDesignsRoot: () => string;
}

export default function createDesignRoutes(deps: DesignRouteDeps): Router {
  const { findProject, broadcast, getDesignsRoot, config } = deps;
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

    const body = req.body as {
      name?: string;
      linkedProjectIds?: string[];
      agentEngine?: string | null;
      agentModel?: string | null;
    };
    const { name, linkedProjectIds, agentEngine, agentModel } = body;
    const rawBody = req.body as Record<string, unknown>;

    let nextEngine: string | null = design.agent_engine ?? null;
    let nextModel: string | null = design.agent_model ?? null;
    let nextSession: string | null = design.engine_session_id ?? null;

    if ('agentEngine' in rawBody) {
      const raw = agentEngine;
      if (raw === null || raw === undefined) {
        nextEngine = null;
      } else if (typeof raw === 'string' && !raw.trim()) {
        nextEngine = null;
      } else if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'agentEngine must be a string or null' });
      } else {
        const trimmed = raw.trim();
        if (!isDesignChatEngine(trimmed)) {
          return res.status(400).json({
            error: `Invalid agentEngine. Allowed: ${DESIGN_CHAT_ENGINES.join(', ')}`,
          });
        }
        nextEngine = trimmed;
      }
      nextSession = null;
      if (!('agentModel' in rawBody)) {
        nextModel = null;
      }
    }

    if ('agentModel' in rawBody) {
      const raw = agentModel;
      const prevModelTrim = (design.agent_model || '').trim();
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== 'string') {
          return res.status(400).json({ error: 'agentModel must be a string or null' });
        }
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          const all = config.allValidModels;
          if (!all.includes(trimmed)) {
            return res.status(400).json({
              error: `Invalid model. Must be one of: ${all.join(', ')}`,
            });
          }
          const effEngine = normalizeDesignEngine(nextEngine);
          const allowed = config.engineValidModels[effEngine] || [];
          if (allowed.length > 0 && !allowed.includes(trimmed)) {
            return res.status(400).json({
              error: `Model "${trimmed}" is not valid for Design Studio (${effEngine}). Allowed: ${allowed.join(', ')}`,
            });
          }
          nextModel = trimmed;
        } else {
          nextModel = null;
        }
      } else {
        nextModel = null;
      }
      const nextModelTrim = (nextModel || '').trim();
      if (prevModelTrim !== nextModelTrim) {
        nextSession = null;
      }
    }

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
      if ('agentEngine' in rawBody || 'agentModel' in rawBody) {
        patchDesignChatEngineModelSession(design.id, nextEngine, nextModel, nextSession);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: msg });
    }

    const updated = getDesign(design.id, lookup, getActiveOrgId());
    // Metadata-only — do not emit `design_updated` (that reloads the canvas iframe).
    if (updated) broadcast({ type: 'design_metadata_updated', design: updated });
    res.json(updated);
  });

  router.delete('/api/designs/:id', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    deleteDesign(design.id, getDesignsRoot());
    broadcast({ type: 'design_deleted', designId: design.id });
    res.json({ ok: true });
  });

  /**
   * Recursive listing of the design's artifact files. Lets regular (non-
   * Design-Studio) agents discover what a design has produced without
   * guessing paths or scraping the iframe — the URL-encoded output of each
   * entry can be fetched via the existing `/design-files/:id/<path>` mount.
   *
   * Shape:
   *   { files: [{ path: "index.html", size: 1234, mtime: "..." }, ...] }
   *
   * org-scoped through `getDesign()` so cross-org reads 404.
   */
  router.get('/api/designs/:id/files', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    const files = listDesignFilesRecursive(getDesignsRoot(), design.id);
    res.json({ designId: design.id, files });
  });

  router.get('/api/designs/:id/messages', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json(listDesignMessages(design.id));
  });

  /**
   * Status probe — answers "is a CLI turn currently running for this design,
   * and if so, what's the latest partial output?". The client calls this on
   * view re-entry to restore the thinking/streaming indicators (closing the
   * gap between navigation and the next WS broadcast) and to replay whatever
   * text has already been produced so the user isn't staring at a blank
   * spinner.
   */
  router.get('/api/designs/:id/status', (req: Request, res: Response) => {
    const design = getDesign(req.params.id as string, lookup, getActiveOrgId());
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json(getDesignStatus(design.id));
  });

  return router;
}
