/**
 * Infrastructure-monitoring routes.
 *
 *   GET  /api/projects/:projectId/infra/monitoring-status
 *   GET  /api/projects/:projectId/infra/cost
 *   POST /api/projects/:projectId/infra/cost/projection
 *   PUT  /api/projects/:projectId/infra/cost/config
 *   GET  /api/projects/:projectId/infra/scopes
 *   PUT  /api/projects/:projectId/infra/scopes
 *   GET  /api/projects/:projectId/infra/retention
 *   PUT  /api/projects/:projectId/infra/retention
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
 * The `scopes` routes are decision INFRA-SCOPE's operator surface: the opt-in
 * allowlist that gates every billed request. `PUT` is a whole-list replace and
 * optionally carries the ceiling, so approving a projection and capping it are
 * one operator action against one price.
 *
 * The `retention` routes expose the window and byte quota the reaper enforces
 * against `infra.db`. They read and write config only — the deletes happen on
 * the reaper's own schedule, never on a request.
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
import {
  getInfraRetentionConfig,
  setInfraRetentionConfig,
  getInfraDbFileBytes,
} from '../infra/infra-retention-store.js';
import {
  DEFAULT_INFRA_RETENTION_DAYS,
  MIN_INFRA_RETENTION_DAYS,
  MAX_INFRA_RETENTION_DAYS,
  DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
  MIN_INFRA_PROJECT_QUOTA_BYTES,
  MAX_INFRA_PROJECT_QUOTA_BYTES,
} from '../infra/infra-schema.js';
import {
  listInfraScopes,
  replaceInfraScopes,
  uncollectableServices,
  InfraScopeValidationError,
  MAX_INFRA_SCOPES_PER_PROJECT,
} from '../infra/infra-scope-store.js';
import { collectableServices } from '../infra/service-metric-packs.js';
import { INFRA_SERVICE_PACKS, infraPackedServices } from '../infra/packs/index.js';
import {
  listInfraResources,
  listInfraResourceFacets,
  listInfraResourceSeries,
  getInfraResource,
  serializeInfraResource,
  type InfraResourceSeries,
} from '../infra/infra-resource-store.js';
import { queryInfraMetricBuckets, type InfraMetricBucketRow } from '../infra/infra-metric-store.js';
import {
  aggregationForStat,
  buildInfraAlertOverlay,
  resolveDisplayPeriod,
  selectBucketValue,
  MAX_CHART_BUCKETS,
} from '../infra/infra-metric-read.js';
import {
  listInfraAlerts,
  listInfraAlertTransitions,
  serializeInfraAlert,
} from '../infra/alert-store.js';
import {
  CostProjectionRequestSchema,
  CostCeilingRequestSchema,
  RetentionConfigRequestSchema,
  ScopesReplaceRequestSchema,
  ResourceListParamsSchema,
  MetricSeriesParamsSchema,
  MetricRangeParamsSchema,
} from './infra.openapi.js';

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

/**
 * The allowlist plus the price of running it.
 *
 * The projection covers **enabled** scopes only: a disabled scope issues no
 * billed requests, so pricing it would overstate the bill and make pausing a
 * scope look like it saved nothing. Degradation is passed through so the figure
 * matches the cadence the collector is actually running at — except `paused`,
 * which prices as `normal` because a paused project's number has to answer
 * "what will this cost when it resumes", not "what does a stopped collector
 * spend" (zero, for every configuration, which is not a decision aid).
 */
function buildScopesBody(projectId: string, nowMs: number): Record<string, unknown> {
  const scopes = listInfraScopes(projectId, MAX_RESOURCE_STALENESS_MS, nowMs);
  const config = getInfraCostConfig(projectId);
  const projection = projectMonthlyApiCost(
    scopes.filter((s) => s.enabled),
    { degradation: config.degradationLevel === 'paused' ? 'normal' : config.degradationLevel },
  );

  return {
    scopes,
    projection,
    collectableServices: collectableServices(),
    uncollectableServices: uncollectableServices(scopes),
    monthlyCeilingUsd: config.monthlyCeilingUsd,
    degradation: config.degradationLevel,
    maxScopes: MAX_INFRA_SCOPES_PER_PROJECT,
    configured: scopes.length > 0,
  };
}

/** Scopes body for a Hub whose `infra.db` never opened — nothing stored, nothing polled. */
function emptyScopesBody(): Record<string, unknown> {
  return {
    scopes: [],
    projection: { metricsRequestedPerMonth: 0, estimatedMonthlyCostUsd: 0, perScope: [] },
    collectableServices: collectableServices(),
    uncollectableServices: [],
    monthlyCeilingUsd: null,
    degradation: 'normal',
    maxScopes: MAX_INFRA_SCOPES_PER_PROJECT,
    configured: false,
  };
}

/** Documented bounds and defaults, echoed alongside every retention response. */
const RETENTION_LIMITS = {
  defaults: {
    retentionDays: DEFAULT_INFRA_RETENTION_DAYS,
    quotaBytes: DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
  },
  bounds: {
    minRetentionDays: MIN_INFRA_RETENTION_DAYS,
    maxRetentionDays: MAX_INFRA_RETENTION_DAYS,
    minQuotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES,
    maxQuotaBytes: MAX_INFRA_PROJECT_QUOTA_BYTES,
  },
} as const;

/**
 * Resolved retention config for one project.
 *
 * `dbBytes` is the whole file rather than the project's share on purpose: a
 * per-project figure needs a full-table aggregate over `infra_metric_points`,
 * and on a store holding tens of millions of points that would block the event
 * loop for a page load. The reaper pays that cost on its own schedule, off the
 * request path.
 */
function buildRetentionBody(projectId: string): Record<string, unknown> {
  const config = getInfraRetentionConfig(projectId);
  return {
    retentionDays: config.retentionDays,
    quotaBytes: config.quotaBytes,
    configured: config.configured,
    updatedAt: config.updatedAt,
    ...RETENTION_LIMITS,
    dbBytes: getInfraDbFileBytes(),
  };
}

/** Retention body for a Hub whose `infra.db` never opened — defaults, nothing stored. */
function emptyRetentionBody(): Record<string, unknown> {
  return {
    retentionDays: DEFAULT_INFRA_RETENTION_DAYS,
    quotaBytes: DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
    configured: false,
    updatedAt: null,
    ...RETENTION_LIMITS,
    dbBytes: 0,
  };
}

/**
 * Pick the series a chart read should draw when the caller did not pin one.
 *
 * A `(resource, metric)` pair names a series only once namespace, stat, period
 * and dimensions are also fixed, and the collector legitimately stores one
 * metric under several of them. Rather than guess a tier the data may not be
 * stored at — which returns an empty chart that looks like an outage — the
 * choice is made from the catalog of what is *actually* stored, preferring the
 * series with the most points and breaking ties deterministically so the same
 * request draws the same chart twice.
 */
function pickMetricSeries(
  catalog: readonly InfraResourceSeries[],
  filters: {
    metric: string;
    namespace?: string;
    stat?: string;
    dimensionsHash?: string;
    period?: number;
  },
): InfraResourceSeries | null {
  const matches = catalog.filter(
    (s) =>
      s.metricName === filters.metric &&
      (!filters.namespace || s.namespace === filters.namespace) &&
      (!filters.stat || s.stat === filters.stat) &&
      (!filters.dimensionsHash || s.dimensionsHash === filters.dimensionsHash) &&
      (filters.period === undefined || s.periodSeconds === filters.period),
  );
  if (matches.length === 0) return null;
  return matches.sort(
    (a, b) =>
      b.pointCount - a.pointCount ||
      a.periodSeconds - b.periodSeconds ||
      a.namespace.localeCompare(b.namespace) ||
      a.stat.localeCompare(b.stat) ||
      a.dimensionsHash.localeCompare(b.dimensionsHash),
  )[0];
}

/** Empty chart body. The window and resolved period stay authoritative. */
function emptyMetricBody(
  resource: Record<string, unknown> | null,
  fromMs: number,
  toMs: number,
  periodSeconds: number,
): Record<string, unknown> {
  return {
    resource,
    series: null,
    fromMs,
    toMs,
    periodSeconds,
    aggregation: 'avg',
    maxBuckets: MAX_CHART_BUCKETS,
    truncated: false,
    points: [],
    alarmSegments: [],
    alerts: [],
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
    '/api/projects/:projectId/infra/metric-packs',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      // Static declarations — no DB, no AWS, no per-project state. The project
      // in the path is an authorization scope, not an input: a caller who
      // cannot see the project cannot read the catalog either.
      res.json({ packs: infraPackedServices().map((service) => INFRA_SERVICE_PACKS[service]) });
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

  router.get(
    '/api/projects/:projectId/infra/scopes',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(isInfraDbInitialized() ? buildScopesBody(projectId, Date.now()) : emptyScopesBody());
    },
  );

  router.put(
    '/api/projects/:projectId/infra/scopes',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = validate(ScopesReplaceRequestSchema, req.body ?? {}, res);
      if (!parsed.ok) return;
      if (!isInfraDbInitialized()) {
        res.status(503).json({ error: 'Infrastructure store is unavailable' });
        return;
      }
      const nowMs = Date.now();
      try {
        // Ceiling first, inside the same request but before the scopes land: if
        // the allowlist is rejected, an operator who also lowered their cap has
        // still had the cap applied. Failing the other way round would widen the
        // scope list while leaving the brake off.
        if (parsed.data.monthlyCeilingUsd !== undefined) {
          setInfraCostCeiling(projectId, parsed.data.monthlyCeilingUsd, nowMs);
        }
        replaceInfraScopes(projectId, parsed.data.scopes, nowMs);
      } catch (err) {
        if (err instanceof InfraScopeValidationError) {
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
      res.json(buildScopesBody(projectId, nowMs));
    },
  );

  router.get(
    '/api/projects/:projectId/infra/retention',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json(isInfraDbInitialized() ? buildRetentionBody(projectId) : emptyRetentionBody());
    },
  );

  router.put(
    '/api/projects/:projectId/infra/retention',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = validate(RetentionConfigRequestSchema, req.body ?? {}, res);
      if (!parsed.ok) return;
      if (!isInfraDbInitialized()) {
        res.status(503).json({ error: 'Infrastructure store is unavailable' });
        return;
      }
      // Out-of-range values are clamped by the store rather than rejected here,
      // so the response is the authoritative statement of what was stored.
      setInfraRetentionConfig(projectId, parsed.data);
      res.json(buildRetentionBody(projectId));
    },
  );

  // ── Read surface: resource browser and metric charts (INFRA-UI) ──────────

  router.get(
    '/api/projects/:projectId/infra/resources',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = validate(ResourceListParamsSchema, req.query ?? {}, res);
      if (!parsed.ok) return;
      if (!isInfraDbInitialized()) {
        res.json({
          resources: [],
          nextCursor: null,
          facets: {
            services: [],
            regions: [],
            accounts: [],
            environments: [],
            states: [],
            tagKeys: [],
            total: 0,
          },
          staleAfterMs: MAX_RESOURCE_STALENESS_MS,
        });
        return;
      }

      // Defaults to the collector's own staleness bound so the browser opens on
      // what is actually being polled. Rows are never deleted, so without a
      // default the first thing an operator sees is every instance the account
      // has ever run. `seenSince=0` is the explicit way to ask for that.
      const seenSinceMs =
        parsed.data.seenSince === undefined
          ? Date.now() - MAX_RESOURCE_STALENESS_MS
          : parsed.data.seenSince;

      const query = { projectId, ...parsed.data, seenSinceMs };
      const page = listInfraResources(query);
      res.json({
        resources: page.resources.map(serializeInfraResource),
        nextCursor: page.nextCursor,
        facets: listInfraResourceFacets(query),
        staleAfterMs: MAX_RESOURCE_STALENESS_MS,
      });
    },
  );

  router.get(
    '/api/projects/:projectId/infra/metric-series',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = validate(MetricSeriesParamsSchema, req.query ?? {}, res);
      if (!parsed.ok) return;
      if (!isInfraDbInitialized()) {
        res.json({ resource: null, series: [] });
        return;
      }
      const resource = getInfraResource(projectId, parsed.data.resource);
      res.json({
        resource: resource ? serializeInfraResource(resource) : null,
        series: listInfraResourceSeries(projectId, parsed.data.resource),
      });
    },
  );

  router.get(
    '/api/projects/:projectId/infra/metrics',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = validate(MetricRangeParamsSchema, req.query ?? {}, res);
      if (!parsed.ok) return;
      const {
        resource: resourceKey,
        metric,
        from,
        to,
        namespace,
        stat,
        dimensionsHash,
      } = parsed.data;
      const nowMs = Date.now();

      if (!isInfraDbInitialized()) {
        res.json(emptyMetricBody(null, from, to, resolveDisplayPeriod(from, to, nowMs)));
        return;
      }

      const resourceRow = getInfraResource(projectId, resourceKey);
      const resource = resourceRow ? serializeInfraResource(resourceRow) : null;
      const series = pickMetricSeries(listInfraResourceSeries(projectId, resourceKey), {
        metric,
        namespace,
        stat,
        dimensionsHash,
        period: parsed.data.period,
      });

      if (!series) {
        res.json(emptyMetricBody(resource, from, to, resolveDisplayPeriod(from, to, nowMs)));
        return;
      }

      // The display period is resolved from the window, never from a constant:
      // CloudWatch's retention tier for the window's start, raised to the tier
      // the series is stored at, then widened until the range fits the bucket
      // cap. A caller pinning `period` pins the *stored* tier being read, not
      // the width it is drawn at — those are different questions.
      const periodSeconds = resolveDisplayPeriod(from, to, nowMs, {
        storedPeriodSeconds: series.periodSeconds,
      });
      const aggregation = aggregationForStat(series.stat);
      const { buckets, truncated } = queryInfraMetricBuckets({
        projectId,
        resourceKey,
        metricName: metric,
        namespace: series.namespace,
        stat: series.stat,
        dimensionsHash: series.dimensionsHash,
        periodSeconds: series.periodSeconds,
        startMs: from,
        endMs: to,
        bucketSeconds: periodSeconds,
        maxBuckets: MAX_CHART_BUCKETS,
      });

      const alerts = listInfraAlerts({ projectId, resourceKey }).alerts;
      const alarmSegments = buildInfraAlertOverlay(
        alerts.map((alert) => ({ alert, transitions: listInfraAlertTransitions(alert.id) })),
        from,
        to,
      );

      res.json({
        resource,
        series,
        fromMs: from,
        toMs: to,
        periodSeconds,
        aggregation,
        maxBuckets: MAX_CHART_BUCKETS,
        truncated,
        points: buckets.map((b: InfraMetricBucketRow) => ({
          tsMs: b.tsMs,
          value: selectBucketValue(aggregation, b),
          count: b.count,
        })),
        alarmSegments,
        alerts: alerts.map((alert) => serializeInfraAlert(alert)),
      });
    },
  );

  return router;
}
