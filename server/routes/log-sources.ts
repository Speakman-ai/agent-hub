/**
 * Log-source management routes (decision LOG-AUTH).
 *
 *   GET    /api/projects/:projectId/log-sources                    — list
 *   POST   /api/projects/:projectId/log-sources                    — create (token once)
 *   GET    /api/projects/:projectId/log-sources/:sourceId          — get one
 *   PATCH  /api/projects/:projectId/log-sources/:sourceId          — update metadata
 *   DELETE /api/projects/:projectId/log-sources/:sourceId          — delete
 *   POST   /api/projects/:projectId/log-sources/:sourceId/rotate   — rotate token (once)
 *   POST   /api/projects/:projectId/log-sources/:sourceId/revoke   — revoke token
 *   GET    /api/projects/:projectId/log-sources/:sourceId/audit    — lifecycle audit
 *
 * These manage write-only ingest credentials; the tokens themselves cannot
 * call any Agent Hub API. Management is Admin-gated (`requireRole('Admin')`)
 * AND project-ACL scoped (`canViewProject`) so a non-member Admin of another
 * project can't enumerate a project's sources. A project the caller can't see
 * returns 404 (not 403) so we don't leak its existence.
 */
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../auth.js';
import { requireRole } from '../roles.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import type { RouteDeps } from '../types.js';
import {
  createLogSource,
  deleteLogSource,
  getLogSource,
  listLogSourceAudit,
  listLogSources,
  revokeLogSourceToken,
  rotateLogSourceToken,
  updateLogSource,
  LogSourceError,
} from '../logs/log-sources-store.js';
import {
  CreateLogSourceRequestSchema,
  UpdateLogSourceRequestSchema,
} from './log-sources.openapi.js';

function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  res: Response,
): { ok: true; data: z.infer<T> } | { ok: false } {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({ error: first?.message ?? 'Validation failed' });
    return { ok: false };
  }
  return { ok: true, data: result.data };
}

export default function createLogSourceRoutes({ findProject }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  /**
   * Resolve + authorize a project for the caller. Returns null (and sends the
   * response) when the project is missing or not visible — both surface as 404
   * so a hidden project's existence never leaks.
   */
  function requireVisibleProject(req: Request, res: Response): { ok: boolean } {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
      res.status(404).json({ error: 'Project not found' });
      return { ok: false };
    }
    return { ok: true };
  }

  function actorId(req: Request): string | null {
    return (req as AuthenticatedRequest).authUserId ?? null;
  }

  // ─── List ─────────────────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/log-sources',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res).ok) return;
      res.json({ sources: listLogSources(req.params.projectId as string) });
    },
  );

  // ─── Create ───────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/log-sources',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res).ok) return;
      const parsed = validate(CreateLogSourceRequestSchema, req.body, res);
      if (!parsed.ok) return;
      try {
        const created = createLogSource(
          {
            projectId: req.params.projectId as string,
            name: parsed.data.name,
            serviceName: parsed.data.serviceName ?? null,
            environment: parsed.data.environment ?? null,
            actorUserId: actorId(req),
          },
          Date.now(),
        );
        res.status(201).json(created);
      } catch (err) {
        if (err instanceof LogSourceError) {
          return res.status(err.status).json({ error: err.message });
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ─── Get one ──────────────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/log-sources/:sourceId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res).ok) return;
      const source = getLogSource(req.params.projectId as string, req.params.sourceId as string);
      if (!source) return res.status(404).json({ error: 'Log source not found' });
      res.json(source);
    },
  );

  // ─── Update metadata ──────────────────────────────────────────────
  router.patch(
    '/api/projects/:projectId/log-sources/:sourceId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res).ok) return;
      const parsed = validate(UpdateLogSourceRequestSchema, req.body, res);
      if (!parsed.ok) return;
      try {
        const updated = updateLogSource(
          req.params.projectId as string,
          req.params.sourceId as string,
          parsed.data,
          actorId(req),
          Date.now(),
        );
        if (!updated) return res.status(404).json({ error: 'Log source not found' });
        res.json(updated);
      } catch (err) {
        if (err instanceof LogSourceError) {
          return res.status(err.status).json({ error: err.message });
        }
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // ─── Delete ───────────────────────────────────────────────────────
  router.delete(
    '/api/projects/:projectId/log-sources/:sourceId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res).ok) return;
      const removed = deleteLogSource(
        req.params.projectId as string,
        req.params.sourceId as string,
        actorId(req),
        Date.now(),
      );
      if (!removed) return res.status(404).json({ error: 'Log source not found' });
      res.status(204).end();
    },
  );

  // ─── Rotate token ─────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/log-sources/:sourceId/rotate',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res).ok) return;
      const rotated = rotateLogSourceToken(
        req.params.projectId as string,
        req.params.sourceId as string,
        actorId(req),
        Date.now(),
      );
      if (!rotated) return res.status(404).json({ error: 'Log source not found' });
      res.json(rotated);
    },
  );

  // ─── Revoke token ─────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/log-sources/:sourceId/revoke',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res).ok) return;
      const revoked = revokeLogSourceToken(
        req.params.projectId as string,
        req.params.sourceId as string,
        actorId(req),
        Date.now(),
      );
      if (!revoked) return res.status(404).json({ error: 'Log source not found' });
      res.json(revoked);
    },
  );

  // ─── Lifecycle audit ──────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/log-sources/:sourceId/audit',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      if (!requireVisibleProject(req, res).ok) return;
      const source = getLogSource(req.params.projectId as string, req.params.sourceId as string);
      if (!source) return res.status(404).json({ error: 'Log source not found' });
      res.json({
        entries: listLogSourceAudit(req.params.projectId as string, req.params.sourceId as string),
      });
    },
  );

  return router;
}
