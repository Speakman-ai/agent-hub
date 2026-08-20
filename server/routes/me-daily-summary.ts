/**
 * GET/POST /api/me/daily-summary — Hub Daily Summary for the calling user.
 *
 * GET never spawns a model: it returns today's stored report, or `{ report: null }`
 * when none has been generated for the caller's local calendar day.
 * POST gathers Hub facts and runs an available engine (with failover).
 */
import { Router, type Request, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import type { RouteDeps } from '../types.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import { EngineAuthRequiredError } from '../per-user-cli-spawn.js';
import {
  generateDailySummary,
  getDailySummaryPayload,
  parseDailySummaryTimeZone,
  NoEnginesAvailableError,
} from '../hub-daily-summary.js';
import './me-daily-summary.openapi.js';

export interface MeDailySummaryRouteOptions {
  now?: () => Date;
  generate?: typeof generateDailySummary;
}

export default function createMeDailySummaryRoutes(
  deps: RouteDeps,
  overrides: MeDailySummaryRouteOptions = {},
): Router {
  const router = Router();
  const now = () => overrides.now?.() ?? new Date();
  const generate = overrides.generate ?? generateDailySummary;

  router.get('/api/me/daily-summary', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const timeZone = parseDailySummaryTimeZone(req.query.tz);
    res.json(getDailySummaryPayload({ userId: areq.authUserId, timeZone, now: now() }));
  });

  router.post('/api/me/daily-summary', async (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const bodyTz =
      req.body && typeof req.body === 'object' ? (req.body as { tz?: unknown }).tz : undefined;
    const timeZone = parseDailySummaryTimeZone(bodyTz) ?? parseDailySummaryTimeZone(req.query.tz);
    try {
      const report = await generate({
        userId: areq.authUserId,
        timeZone,
        deps,
        caller: resolveVisibilityCaller(req),
        now: now(),
      });
      res.json({
        date: report.date,
        timeZone: report.timeZone,
        report,
      });
    } catch (err) {
      if (err instanceof NoEnginesAvailableError) {
        res.status(503).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof EngineAuthRequiredError) {
        res.status(400).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
