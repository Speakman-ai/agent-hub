/**
 * Admin-gated read + credential management for AWS Health events.
 *
 *   GET    /api/projects/:projectId/infra/health-events
 *   GET    /api/projects/:projectId/infra/health-ingest
 *   POST   /api/projects/:projectId/infra/health-ingest   (mint / rotate)
 *   DELETE /api/projects/:projectId/infra/health-ingest   (revoke)
 *
 * The ingest half of this feature is a separate public route
 * (`infra-health-ingest.ts`); this file is the operator-facing surface that
 * mints the credential that route consumes and reads back what arrived.
 *
 * There is no route here that talks to AWS. Health events are pushed to the Hub
 * by an EventBridge rule the operator creates in their own account — the Hub
 * side is ingest-only, and nothing on this surface can create, modify, or poll
 * anything in the monitored account.
 */
import { Router, type Request, type Response } from 'express';
import { z } from '../openapi/registry.js';
import { requireRole } from '../roles.js';
import { isInfraDbInitialized } from '../infra/infra-db.js';
import { INFRA_HEALTH_INGEST_PATH } from '../infra/infra-schema.js';
import {
  listInfraHealthEvents,
  serializeInfraHealthEvent,
  countInfraHealthEvents,
} from '../infra/health-event-store.js';
import {
  createInfraHealthIngestToken,
  getInfraHealthIngestToken,
  revokeInfraHealthIngestToken,
} from '../infra/health-ingest-token-store.js';
import { HealthEventListParamsSchema } from './infra-health.openapi.js';
import type { RouteDeps } from '../types.js';

function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  res: Response,
): { ok: true; data: z.infer<T> } | { ok: false } {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return { ok: false };
  }
  return { ok: true, data: parsed.data };
}

/**
 * The rule pattern the operator must paste into EventBridge.
 *
 * Returned from the API rather than only living in docs so the UI can offer a
 * copy button: AWS documents in an explicit callout that the rule must use
 * `"source": ["aws.health"]` and that a wildcard like `"aws.health*"` will
 * never match — a silently-matching-nothing rule is the most likely setup
 * failure, and handing the operator the exact literal removes the chance.
 */
export const AWS_HEALTH_EVENT_PATTERN = {
  source: ['aws.health'],
  'detail-type': ['AWS Health Event', 'AWS Health Abuse Event'],
} as const;

export default function createInfraHealthRoutes(deps: RouteDeps): Router {
  const { findProject } = deps;
  const router = Router();

  function guard(req: Request, res: Response): string | null {
    const projectId = req.params.projectId as string;
    if (!findProject(projectId)) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return projectId;
  }

  router.get(
    '/api/projects/:projectId/infra/health-events',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = guard(req, res);
      if (!projectId) return;
      const parsed = validate(HealthEventListParamsSchema, req.query, res);
      if (!parsed.ok) return;

      // A read on a project whose infra store never opened is an empty
      // timeline, not an error — the Overview tab renders its empty state
      // from this body rather than branching on a status code.
      if (!isInfraDbInitialized()) {
        res.json({ events: [], total: 0, ingestConfigured: false });
        return;
      }

      const events = listInfraHealthEvents(projectId, {
        limit: parsed.data.limit,
        latestOnly: parsed.data.latestOnly !== false,
        statusCode: parsed.data.statusCode,
      });
      const token = getInfraHealthIngestToken(projectId);
      res.json({
        events: events.map(serializeInfraHealthEvent),
        total: countInfraHealthEvents(projectId),
        // Lets the timeline distinguish "no events yet" from "ingest was never
        // wired up", which are very different operator next-actions.
        ingestConfigured: Boolean(token && !token.revokedAt),
      });
    },
  );

  router.get(
    '/api/projects/:projectId/infra/health-ingest',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = guard(req, res);
      if (!projectId) return;
      if (!isInfraDbInitialized()) {
        res.status(503).json({ error: 'Infrastructure store is unavailable' });
        return;
      }
      res.json({
        token: getInfraHealthIngestToken(projectId),
        ingestPath: INFRA_HEALTH_INGEST_PATH,
        eventPattern: AWS_HEALTH_EVENT_PATTERN,
      });
    },
  );

  router.post(
    '/api/projects/:projectId/infra/health-ingest',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = guard(req, res);
      if (!projectId) return;
      if (!isInfraDbInitialized()) {
        res.status(503).json({ error: 'Infrastructure store is unavailable' });
        return;
      }
      const { token, info } = createInfraHealthIngestToken(projectId);
      // The only response that ever carries the plaintext. Re-reading the
      // credential later is impossible by design; the operator rotates instead.
      res.status(201).json({
        token,
        info,
        ingestPath: INFRA_HEALTH_INGEST_PATH,
        eventPattern: AWS_HEALTH_EVENT_PATTERN,
      });
    },
  );

  router.delete(
    '/api/projects/:projectId/infra/health-ingest',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = guard(req, res);
      if (!projectId) return;
      if (!isInfraDbInitialized()) {
        res.status(503).json({ error: 'Infrastructure store is unavailable' });
        return;
      }
      const revoked = revokeInfraHealthIngestToken(projectId);
      res.json({ revoked, token: getInfraHealthIngestToken(projectId) });
    },
  );

  return router;
}
