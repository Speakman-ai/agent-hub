/**
 * Active worktree previews for a project (Settings → Preview).
 *
 *   GET  /api/projects/:projectId/previews
 *   POST /api/projects/:projectId/previews/:previewId/stop
 *   POST /api/projects/:projectId/previews/purge
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import { getDb } from '../db.js';
import {
  listProjectPreviewInstances,
  purgeProjectPreviewInstances,
  stopProjectPreviewInstance,
} from '../preview/project-preview-instances.js';
import type { DevServerRuntime } from '../preview/dev-server-runtime.js';
import type { RouteDeps } from '../types.js';

export interface PreviewInstancesRouteDeps extends RouteDeps {
  getDevServerRuntime?: () => DevServerRuntime | null;
}

export default function createPreviewInstancesRoutes(deps: PreviewInstancesRouteDeps): Router {
  const { findProject, getDevServerRuntime } = deps;
  const router = Router();
  const stopDeps = { getDevServerRuntime };

  router.get(
    '/api/projects/:projectId/previews',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const result = listProjectPreviewInstances(getDb(), project.id);
      res.json({ projectId: project.id, ...result });
    },
  );

  router.post(
    '/api/projects/:projectId/previews/purge',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      try {
        const result = await purgeProjectPreviewInstances(getDb(), stopDeps, project.id);
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  router.post(
    '/api/projects/:projectId/previews/:previewId/stop',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const previewId = req.params.previewId as string;
      if (previewId === 'purge') {
        res.status(400).json({ error: 'Use POST .../previews/purge to stop all previews' });
        return;
      }
      try {
        const result = await stopProjectPreviewInstance(getDb(), stopDeps, project.id, previewId);
        if (!result.stopped) {
          res.status(404).json({ error: 'Preview not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  return router;
}
