/**
 * PR Environments — Provision wizard routes.
 *
 * Backs the "Provision PR Environments" button on the
 * `Settings → PR Environments` page. The wizard contract is documented
 * in `docs/architecture/pr-environments-provisioning-wizard-v1-spec.md`;
 * this module owns the HTTP surface and delegates the state machine to
 * `server/pr-env-provisioning/orchestrator.ts`.
 *
 *   POST /api/settings/pr-env/provision         — start a job
 *   GET  /api/settings/pr-env/provision/last    — last terminal summary
 *
 * The WebSocket replay endpoint
 * (`/api/settings/pr-env/provision/:jobId/events`) is registered
 * alongside the new-project provisioning WS in `server/index.ts` —
 * adding it lives in the follow-up implementation card so the WS
 * upgrade path is hooked in one place.
 *
 * The phase executor is injected so tests can drive the orchestrator
 * with a stub. Production wiring (host detection, certbot subprocess,
 * IAM SDK calls, verify wrapper) is intentionally not in V1's spec PR;
 * the executor falls through to `stubExecutor` so the whole pipe is
 * exercisable end-to-end before real adapters land.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  startProvisionJob,
  stubExecutor,
  lastFinishedSummary,
  type PrEnvExecutor,
  type PrEnvProvisionPayload,
} from '../pr-env-provisioning/orchestrator.js';
import { isPrEnvKillSwitchOn, PR_ENV_KILL_SWITCH_MESSAGE } from '../pr-env-killswitch.js';

export interface PrEnvProvisionDeps {
  /** Test hook — production leaves unset and the route uses `stubExecutor`. */
  executor?: PrEnvExecutor;
  /** Test hook — production uses `uuidv4`. */
  newJobId?: () => string;
}

function resolveWsBase(req: Request): string {
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = forwardedProto ? forwardedProto.split(',')[0]!.trim() : req.protocol;
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  const host = req.get('host') || `localhost:${process.env.PORT || 3051}`;
  return `${wsProto}://${host}`;
}

function pickStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export default function createPrEnvProvisionRoutes(deps: PrEnvProvisionDeps = {}): Router {
  const router = Router();
  const executor = deps.executor ?? stubExecutor;
  const newJobId = deps.newJobId ?? (() => uuidv4());

  // Kill-switch gate (epic 88367984): provisioning wizard is being
  // removed alongside the rest of the PR-env subsystem. Mounted as a
  // module-scoped middleware so every route returns 410 Gone uniformly.
  router.use((_req: Request, res: Response, next): void => {
    if (isPrEnvKillSwitchOn()) {
      res.status(410).json({ error: PR_ENV_KILL_SWITCH_MESSAGE });
      return;
    }
    next();
  });

  router.post('/api/settings/pr-env/provision', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const payload: PrEnvProvisionPayload = {
      previewHost: pickStr(body.previewHost),
      hostedZoneId: pickStr(body.hostedZoneId),
      repoFullName: pickStr(body.repoFullName),
      dryRun: body.dryRun === true,
      operatorEmail: pickStr(body.operatorEmail) || undefined,
    };

    if (!payload.previewHost) return res.status(400).json({ error: 'previewHost is required' });
    if (!payload.hostedZoneId) return res.status(400).json({ error: 'hostedZoneId is required' });
    if (!payload.repoFullName) return res.status(400).json({ error: 'repoFullName is required' });

    const jobId = newJobId();
    try {
      startProvisionJob({ jobId, payload, executor });
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    const wsUrl = `${resolveWsBase(req)}/api/settings/pr-env/provision/${jobId}/events`;
    return res.status(201).json({ jobId, wsUrl });
  });

  router.get('/api/settings/pr-env/provision/last', (_req: Request, res: Response) => {
    const summary = lastFinishedSummary();
    return res.json(summary ?? { jobId: null });
  });

  return router;
}
