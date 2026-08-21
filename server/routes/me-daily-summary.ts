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
import { getUserPreferencesRow, mergeUserPreferencesJson } from '../user-preferences-store.js';
import {
  normalizeDailySummarySchedule,
  type HubDailySummarySchedule,
} from '../daily-summary-schedule.js';
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

  router.get('/api/me/daily-summary/schedule', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const schedule = getUserPreferencesRow(areq.authUserId).hubDailySummarySchedule ?? null;
    res.json({ schedule });
  });

  router.put('/api/me/daily-summary/schedule', (req: Request, res: Response) => {
    const areq = req as AuthenticatedRequest;
    if (!areq.authUserId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid schedule body' });
      return;
    }
    if ('enabled' in body && typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: '`enabled` must be a boolean' });
      return;
    }
    if ('times' in body && !Array.isArray(body.times)) {
      res.status(400).json({ error: '`times` must be an array of HH:MM strings' });
      return;
    }
    // Normalization drops invalid times and clears the schedule when nothing
    // valid remains, so passing `{ times: [] }` (or all-invalid) turns it off.
    const normalized: HubDailySummarySchedule | undefined = normalizeDailySummarySchedule(body);
    const stored = mergeUserPreferencesJson(areq.authUserId, {
      hubDailySummarySchedule: normalized,
    });
    res.json({ schedule: stored.hubDailySummarySchedule ?? null });
  });

  return router;
}
