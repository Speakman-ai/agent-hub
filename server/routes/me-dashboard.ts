/**
 * REST surface for the personal (User Module) dashboard aggregation.
 *
 *   GET /api/me/dashboard   full per-uid fan-out (work + todos + Google)
 *   GET /api/me/work        just the assigned-cards ("My Work") slice
 *
 * Both are keyed by `req.authUserId` and RBAC-filtered to the projects the
 * caller can view (spec AGGREGATION). Read-only: writes go through the specific
 * todo / promote / card endpoints. `/api/me/dashboard` is cached per uid; pass
 * `?fresh=1` to bypass after a mutation.
 */
import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { buildMeDashboard, buildMyWork } from '../me-dashboard.js';
import type { GoogleReader } from '../me-dashboard-google.js';

export interface MeDashboardRouteOptions {
  /** Injectable Google reader for tests; production uses the live reader. */
  googleReader?: GoogleReader;
}

export default function createMeDashboardRoutes(
  deps: RouteDeps,
  overrides: MeDashboardRouteOptions = {},
): Router {
  const router = Router();

  router.get('/api/me/dashboard', async (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const caller = resolveVisibilityCaller(req);
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const timeZone = typeof req.query.tz === 'string' ? req.query.tz : undefined;

    const payload = await buildMeDashboard(deps, {
      uid: areq.authUserId,
      caller,
      fresh,
      date,
      timeZone,
      googleReader: overrides.googleReader,
    });
    res.json(payload);
  });

  router.get('/api/me/work', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const caller = resolveVisibilityCaller(req);
    res.json(buildMyWork(deps, areq.authUserId, caller));
  });

  return router;
}
