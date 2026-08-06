/**
 * Infrastructure-monitoring routes.
 *
 *   GET /api/projects/:projectId/infra/monitoring-status
 *
 * The Infrastructure module is gated on a project having a designated
 * monitoring profile whose credentials actually resolve (decision INFRA-CRED),
 * so this endpoint answers that one question and distinguishes "no profile
 * designated" from "designated but AWS refused" — the two states need
 * different words in the empty state and different actions from the operator.
 *
 * Admin-gated, matching the AWS profile routes: the probe result names the
 * profile and region, and a failure message can carry an AWS principal ARN.
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import type { RouteDeps } from '../types.js';
import { ProjectAwsProfileValidationError } from '../project-aws-profiles.js';
import { probeProjectMonitoringAccess } from '../infra/aws-clients.js';

export default function createInfraRoutes(deps: RouteDeps): Router {
  const { findProject } = deps;
  const router = Router();

  router.get(
    '/api/projects/:projectId/infra/monitoring-status',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      try {
        const probe = await probeProjectMonitoringAccess(projectId);
        // A project that cannot be monitored is not a failed request: the
        // module renders an empty state from this body. Only a malformed
        // request is a 4xx.
        res.json({ ...probe, checkedAt: Date.now() });
      } catch (err) {
        if (err instanceof ProjectAwsProfileValidationError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
