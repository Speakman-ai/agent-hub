import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { hasAtLeastRole, requireRole } from '../roles.js';
import {
  addReleaseDigestRecipient,
  getReleaseNotificationSettings,
  listReleaseDigestRecipients,
  removeReleaseDigestRecipient,
  resetReleaseNotificationSettings,
  updateReleaseDigestRecipient,
  updateReleaseNotificationSettings,
  validateReleaseDigestPrompt,
} from '../release-notification-settings.js';
import type { RouteDeps } from '../types.js';
import {
  CreateReleaseDigestRecipientRequestSchema,
  PatchReleaseDigestRecipientRequestSchema,
  UpdateReleaseNotificationSettingsRequestSchema,
} from './release-notification-settings.openapi.js';

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
      const role = (req as AuthenticatedRequest).authRole;
      res.json(
        getReleaseNotificationSettings(projectId, {
          includeRecipients: hasAtLeastRole(role, 'Admin'),
        }),
      );
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
          includeRecipients: true,
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
      res.json(resetReleaseNotificationSettings(projectId, { includeRecipients: true }));
    },
  );

  router.get(
    '/api/projects/:projectId/release-notification-settings/recipients',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      res.json({ recipients: listReleaseDigestRecipients(projectId) });
    },
  );

  router.post(
    '/api/projects/:projectId/release-notification-settings/recipients',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      const parsed = CreateReleaseDigestRecipientRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      try {
        const recipient = addReleaseDigestRecipient({
          projectId,
          ...parsed.data,
          updatedBy: (req as AuthenticatedRequest).authUserId ?? null,
        });
        return res.status(201).json(recipient);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes('already exists') ? 409 : 400;
        return res.status(status).json({ error: message });
      }
    },
  );

  router.patch(
    '/api/projects/:projectId/release-notification-settings/recipients/:recipientId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      const parsed = PatchReleaseDigestRecipientRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      try {
        const recipient = updateReleaseDigestRecipient({
          projectId,
          recipientId: req.params.recipientId as string,
          ...parsed.data,
          updatedBy: (req as AuthenticatedRequest).authUserId ?? null,
        });
        if (!recipient) {
          return res.status(404).json({ error: 'Release digest recipient not found' });
        }
        return res.json(recipient);
      } catch (err: unknown) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  router.delete(
    '/api/projects/:projectId/release-notification-settings/recipients/:recipientId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      if (!removeReleaseDigestRecipient(projectId, req.params.recipientId as string)) {
        return res.status(404).json({ error: 'Release digest recipient not found' });
      }
      return res.json({ ok: true });
    },
  );

  return router;
}
