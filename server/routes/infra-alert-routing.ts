import { Router, type Request, type Response } from 'express';
import { requireRole } from '../roles.js';
import type { RouteDeps } from '../types.js';
import { isInfraDbInitialized } from '../infra/infra-db.js';
import {
  deleteInfraAlertRouting,
  resolveAllInfraAlertRouting,
  upsertInfraAlertRouting,
} from '../infra/alert-routing-store.js';
import { InfraAlertRoutingUpdateSchema } from './infra-alert-routing.openapi.js';

export default function createInfraAlertRoutingRoutes(deps: RouteDeps): Router {
  const router = Router();
  const resolveProject = (req: Request, res: Response): string | null => {
    const projectId = req.params.projectId as string;
    if (!deps.findProject(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    if (!isInfraDbInitialized()) {
      res.status(503).json({ error: 'Infrastructure store is unavailable' });
      return null;
    }
    return projectId;
  };

  router.get('/api/projects/:projectId/infra/alert-routing', requireRole('Admin'), (req, res) => {
    const projectId = resolveProject(req, res);
    if (!projectId) return;
    res.json({ projectId, routing: resolveAllInfraAlertRouting(projectId) });
  });

  router.put('/api/projects/:projectId/infra/alert-routing', requireRole('Admin'), (req, res) => {
    const projectId = resolveProject(req, res);
    if (!projectId) return;
    const parsed = InfraAlertRoutingUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid routing entry' });
      return;
    }
    upsertInfraAlertRouting(projectId, parsed.data);
    res.json({ projectId, routing: resolveAllInfraAlertRouting(projectId) });
  });

  router.delete(
    '/api/projects/:projectId/infra/alert-routing/:severity/:channel',
    requireRole('Admin'),
    (req, res) => {
      const projectId = resolveProject(req, res);
      if (!projectId) return;
      const severity = req.params.severity as 'critical' | 'warning' | 'info';
      const channel = req.params.channel as 'in_app' | 'push' | 'email';
      if (!deleteInfraAlertRouting(projectId, severity, channel)) {
        res.status(404).json({ error: 'Routing override not found' });
        return;
      }
      res.json({ projectId, routing: resolveAllInfraAlertRouting(projectId) });
    },
  );
  return router;
}
