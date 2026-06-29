import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole } from '../roles.js';
import {
  getReleaseNotificationSettings,
  resetReleaseNotificationSettings,
  updateReleaseNotificationSettings,
  validateReleaseDigestPrompt,
} from '../release-notification-settings.js';
import type { RouteDeps } from '../types.js';
import { UpdateReleaseNotificationSettingsRequestSchema } from './release-notification-settings.openapi.js';

export default function createReleaseNotificationSettingsRoutes(deps: RouteDeps): Router {
  const router = Router();
  const { findProject } = deps;

  function resolveProject(req: Request, res: Response): string | null {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return project.id;
  }

  router.get(
    '/api/projects/:projectId/release-notification-settings',
    requireRole('User'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      res.json(getReleaseNotificationSettings(projectId));
    },
  );

  router.put(
    '/api/projects/:projectId/release-notification-settings',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      const parsed = UpdateReleaseNotificationSettingsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      let releaseDigestPrompt: string;
      try {
        releaseDigestPrompt = validateReleaseDigestPrompt(parsed.data.releaseDigestPrompt);
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
      res.json(
        updateReleaseNotificationSettings({
          projectId,
          releaseDigestPrompt,
          updatedBy: (req as AuthenticatedRequest).authUserId ?? null,
        }),
      );
    },
  );

  router.post(
    '/api/projects/:projectId/release-notification-settings/reset',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      res.json(resetReleaseNotificationSettings(projectId));
    },
  );

  return router;
}
