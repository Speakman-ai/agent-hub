/**
 * Per-project RUM (real user monitoring) ingest-client management routes.
 *
 *   POST   /api/projects/:projectId/rum/clients
 *     Admin+. Mint a new ingest token for the project. The plaintext token is
 *     returned ONCE in the response `token` field and is never retrievable
 *     again — the caller must copy it into the vendor site's recorder config.
 *
 *   GET    /api/projects/:projectId/rum/clients
 *     Admin+. List the project's active (non-revoked) ingest clients. Only
 *     metadata (id, name, prefix, timestamps) — never the token or its hash.
 *
 *   DELETE /api/projects/:projectId/rum/clients/:clientId
 *     Admin+. Revoke (soft-delete) a client. Subsequent uploads bearing that
 *     token are rejected at the ingest gate. Scoped to the project, so a
 *     clientId from another project resolves to 404.
 *
 * Token verification + attribution happens at `POST /api/replays` (see
 * server/routes/replays.ts) via the `X-RUM-Token` header.
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import { resolveOwnerUserId } from '../session-ownership.js';
import { mintRumClient, listRumClients, revokeRumClient } from '../rum-clients-store.js';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';

export default function createRumClientRoutes(deps: RouteDeps): Router {
  const { findProject } = deps;
  const router = Router();

  router.post(
    '/api/projects/:projectId/rum/clients',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      const createdBy = resolveOwnerUserId(req as AuthenticatedRequest);
      try {
        const client = mintRumClient(project.id, name, createdBy);
        res.status(201).json(client);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  router.get(
    '/api/projects/:projectId/rum/clients',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json({ projectId: project.id, clients: listRumClients(project.id) });
    },
  );

  router.delete(
    '/api/projects/:projectId/rum/clients/:clientId',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const revoked = revokeRumClient(project.id, req.params.clientId as string);
      if (!revoked) {
        res.status(404).json({ error: 'RUM client not found' });
        return;
      }
      res.json({ revoked: true });
    },
  );

  return router;
}
