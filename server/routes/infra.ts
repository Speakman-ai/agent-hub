/**
 * Infrastructure-monitoring routes.
 *
 *   GET  /api/projects/:projectId/infra/monitoring-status
 *   GET  /api/projects/:projectId/infra/cost
 *   POST /api/projects/:projectId/infra/cost/projection
 *   PUT  /api/projects/:projectId/infra/cost/config
 *
 * The Infrastructure module is gated on a project having a designated
 * monitoring profile whose credentials actually resolve (decision INFRA-CRED),
 * so `monitoring-status` answers that one question and distinguishes "no profile
 * designated" from "designated but AWS refused" — the two states need
 * different words in the empty state and different actions from the operator.
 *
 * The `cost` routes are decision INFRA-COST's operator surface: what has been
 * spent, what the current configuration is on track to spend, what a *proposed*
 * configuration would spend before it is saved, and the ceiling the collector
 * degrades against. None of them call AWS — every figure is local SQLite or
 * pure arithmetic over the service metric packs, so the scope editor can price
 * a keystroke without spending anything to do it.
 *
 * Admin-gated, matching the AWS profile routes: the probe result names the
 * profile and region, a failure message can carry an AWS principal ARN, and the
 * cost surface exposes account ids on its run history.
 */
import { Router, Request, Response } from 'express';
import type { z } from 'zod';
import { requireRole } from '../roles.js';
import type { RouteDeps } from '../types.js';
import { ProjectAwsProfileValidationError } from '../project-aws-profiles.js';
import { probeProjectMonitoringAccess } from '../infra/aws-clients.js';
import { isInfraDbInitialized } from '../infra/infra-db.js';
import { projectMonthlyApiCost, type MonthlyCostProjection } from '../infra/infra-cost.js';
import {
  getInfraCostConfig,
  getInfraSpendToDate,
  listInfraCollectRuns,
  listScopeResourceCounts,
  setInfraCostCeiling,
} from '../infra/infra-cost-store.js';
import { MAX_RESOURCE_STALENESS_MS } from '../infra/metric-collector.js';
import { CostProjectionRequestSchema, CostCeilingRequestSchema } from './infra.openapi.js';

function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  res: Response,
): { ok: true; data: z.infer<T> } | { ok: false } {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return { ok: false };
  }
  return { ok: true, data: result.data };
}

/**
 * The empty cost body for a Hub whose `infra.db` never opened.
 *
 * `initInfraDb()` failures are logged and swallowed at boot so infra telemetry
 * can never block startup, which means these handlers can legitimately run with
 * no store behind them. Returning zeroes keeps the Infrastructure module's cost
 * panel rendering its "nothing collected yet" state instead of a 500 that reads
 * like a billing fault.
 */
function emptyCostBody(nowMs: number): Record<string, unknown> {
  return {
    monthStartMs: Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), 1),
    monthToDateUsd: 0,
    extrapolatedMonthUsd: 0,
    metricsRequested: 0,
    queriesIssued: 0,
    datapointsReturned: 0,
    throttles: 0,
    errors: 0,
    runs: 0,
    futureDatedRuns: 0,
    monthlyCeilingUsd: null,
    degradation: 'normal',
    degradedAt: null,
    configured: false,
    projection: { metricsRequestedPerMonth: 0, estimatedMonthlyCostUsd: 0, perScope: [] },
    recentRuns: [],
  };
}

/** Spend to date, ceiling, current-scope projection and recent ticks, in one body. */
function buildCostBody(projectId: string, nowMs: number): Record<string, unknown> {
  const spend = getInfraSpendToDate(projectId, nowMs);
  const config = getInfraCostConfig(projectId);
  // Counted against the same staleness bound the collector polls under, so the
  // projection prices the population that will actually be billed rather than
  // every inventory row ever seen.
  const counts = listScopeResourceCounts(projectId, MAX_RESOURCE_STALENESS_MS, nowMs);
  const projection: MonthlyCostProjection = projectMonthlyApiCost(counts, {
    degradation: config.degradationLevel === 'paused' ? 'normal' : config.degradationLevel,
  });

  return {
    ...spend,
    monthlyCeilingUsd: config.monthlyCeilingUsd,
    degradation: config.degradationLevel,
    degradedAt: config.degradedAt,
    configured: config.configured,
    projection,
    recentRuns: listInfraCollectRuns(projectId, 20).map(({ projectId: _pid, ...run }) => run),
  };
}

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

  router.get(
    '/api/projects/:projectId/infra/cost',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const nowMs = Date.now();
      res.json(isInfraDbInitialized() ? buildCostBody(projectId, nowMs) : emptyCostBody(nowMs));
    },
  );

  router.post(
    '/api/projects/:projectId/infra/cost/projection',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = validate(CostProjectionRequestSchema, req.body ?? {}, res);
      if (!parsed.ok) return;
      // No database read at all: the scopes being priced are the ones on screen,
      // not the ones stored. That is the whole point of pricing before save.
      res.json(projectMonthlyApiCost(parsed.data.scopes, { degradation: parsed.data.degradation }));
    },
  );

  router.put(
    '/api/projects/:projectId/infra/cost/config',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = validate(CostCeilingRequestSchema, req.body ?? {}, res);
      if (!parsed.ok) return;
      if (!isInfraDbInitialized()) {
        res.status(503).json({ error: 'Infrastructure store is unavailable' });
        return;
      }
      const nowMs = Date.now();
      setInfraCostCeiling(projectId, parsed.data.monthlyCeilingUsd, nowMs);
      res.json(buildCostBody(projectId, nowMs));
    },
  );

  return router;
}
