/**
 * Settings → Preview environment (compose-only, Build and run).
 *
 *   GET  /api/projects/:projectId/preview/environment-draft
 *   POST /api/projects/:projectId/preview/build
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import { collectPreviewEnvironmentDraft } from '../preview-environment-draft.js';
import {
  runPreviewEnvironmentBuild,
  type PreviewEnvironmentBuildBody,
} from '../preview-environment-build.js';
import type { PreviewComposeRuntime } from '../preview/preview-compose-runtime.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';

export interface PreviewEnvironmentRouteDeps extends RouteDeps {
  getPreviewComposeRuntime: () => PreviewComposeRuntime;
}

export default function createPreviewEnvironmentRoutes(deps: PreviewEnvironmentRouteDeps): Router {
  const { findProject, saveProjects, getPreviewComposeRuntime } = deps;
  const router = Router();

  router.get(
    '/api/projects/:projectId/preview/environment-draft',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const cwd = project.cwd;
      if (!cwd || typeof cwd !== 'string') {
        res.status(400).json({ error: 'Project has no cwd configured' });
        return;
      }
      const draft = collectPreviewEnvironmentDraft(cwd);
      res.json({ draft, projectId: project.id });
    },
  );

  router.post(
    '/api/projects/:projectId/preview/build',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const cwd = project.cwd;
      if (!cwd || typeof cwd !== 'string') {
        res.status(400).json({ error: 'Project has no cwd configured' });
        return;
      }
      const body = (req.body ?? {}) as PreviewEnvironmentBuildBody;
      let result;
      try {
        result = await runPreviewEnvironmentBuild({
          project,
          cwd,
          body,
          saveProjects,
          getPreviewComposeRuntime,
          actorUserId: (req as AuthenticatedRequest).authUserId ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ ok: false, error: message });
        return;
      }
      if ('statusCode' in result && result.statusCode) {
        res.status(result.statusCode).json({ ok: false, error: result.error });
        return;
      }
      res.json(result);
    },
  );

  return router;
}
