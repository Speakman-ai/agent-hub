/**
 * Watchdog REST surface.
 *
 *   GET  /api/sessions/:sessionId/watchdog            — current row + recent events
 *   POST /api/sessions/:sessionId/watchdog/nudge       — force a tier (default T2)
 *
 * Used by the UI to render a "watchdog state" pip on the session card
 * and to expose a manual "nudge this session now" button. The
 * underlying state machine lives in `server/session-watchdog.ts`.
 */

import { Router, Request, Response } from 'express';
import type { RouteDeps } from '../types.js';
import {
  forceNudge,
  getWatchdogState,
  getRecentWatchdogEvents,
  type WatchdogTier,
} from '../session-watchdog.js';

const VALID_TIERS: ReadonlyArray<WatchdogTier> = ['T1', 'T2', 'T3', 'T4'];

export default function createWatchdogRoutes(_deps: RouteDeps): Router {
  const router = Router();

  router.get(
    '/api/sessions/:sessionId/watchdog',
    (req: Request, res: Response): Response | void => {
      const row = getWatchdogState(req.params.sessionId as string);
      if (!row) return res.json({ session_id: req.params.sessionId, exists: false, events: [] });
      const events = getRecentWatchdogEvents(req.params.sessionId as string, 20);
      return res.json({ exists: true, row, events });
    },
  );

  router.post(
    '/api/sessions/:sessionId/watchdog/nudge',
    async (req: Request, res: Response): Promise<Response | void> => {
      const raw = (req.body as { tier?: string } | undefined)?.tier ?? 'T2';
      const tier = String(raw).toUpperCase() as WatchdogTier;
      if (!VALID_TIERS.includes(tier)) {
        return res.status(400).json({ error: `Invalid tier "${raw}"`, valid: VALID_TIERS });
      }
      const result = await forceNudge(req.params.sessionId as string, tier);
      if (!result.dispatched) {
        return res.status(409).json({ error: result.reason || 'Could not dispatch nudge' });
      }
      return res.status(202).json({ ok: true, tier });
    },
  );

  return router;
}
