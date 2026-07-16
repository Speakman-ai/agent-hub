/**
 * project-stats.ts — per-project Stats page read surface.
 *
 * Serves daily / weekly / monthly time series for six product metrics
 * (PRs merged, support tickets resolved, tickets made, tickets completed,
 * epics completed, model most used). Mounted behind authMiddleware + the
 * project visibility gate like every other `/api/projects/:projectId/*`
 * router. Aggregation lives in ../project-stats.ts; the completion/resolution
 * timestamps it reads are maintained by the triggers in ../stats-completion.ts.
 */

import { Router, type Request, type Response } from 'express';
import type { Project, RouteDeps } from '../types.js';
import { getDb } from '../db.js';
import { z, registerPath } from '../openapi/registry.js';
import {
  computeProjectStats,
  normalizeBucketCount,
  STAT_GRANULARITIES,
  type StatGranularity,
} from '../project-stats.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = z.object({ error: z.string() });

const GranularitySchema = z.enum(['day', 'week', 'month']);

const StatBucketSchema = z.object({
  start: z.string(),
  label: z.string(),
});

const SeriesSchema = z.object({
  prs_merged: z.array(z.number().int()),
  support_tickets_resolved: z.array(z.number().int()),
  tickets_made: z.array(z.number().int()),
  tickets_completed: z.array(z.number().int()),
  epics_completed: z.array(z.number().int()),
});

const TotalsSchema = z.object({
  prs_merged: z.number().int(),
  support_tickets_resolved: z.number().int(),
  tickets_made: z.number().int(),
  tickets_completed: z.number().int(),
  epics_completed: z.number().int(),
});

const ProjectStatsResponseSchema = z.object({
  granularity: GranularitySchema,
  buckets: z.array(StatBucketSchema),
  series: SeriesSchema,
  totals: TotalsSchema,
  model_usage: z.array(z.object({ model: z.string(), count: z.number().int() })),
  top_model: z.string().nullable(),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/stats',
  tags: ['Projects'],
  summary: 'Per-project product metrics over time',
  description:
    'Daily / weekly / monthly time series for PRs merged, support tickets resolved, tickets made, tickets completed, epics completed, and model usage. Completion metrics use the completed_at / resolved_at timestamps maintained by DB triggers.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      granularity: GranularitySchema.optional(),
      buckets: z.coerce.number().int().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Project stats time series.',
      content: jsonContent(ProjectStatsResponseSchema),
    },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
    500: { description: 'Stats could not be read.', content: jsonContent(ErrorResponse) },
  },
});

export default function createProjectStatsRoutes(deps: RouteDeps): Router {
  const router = Router();

  const findProjectOr404 = (req: Request, res: Response): Project | null => {
    const project = deps.findProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return project;
  };

  router.get('/api/projects/:projectId/stats', (req: Request, res: Response) => {
    const project = findProjectOr404(req, res);
    if (!project) return;

    const granularityRaw =
      typeof req.query.granularity === 'string' ? req.query.granularity : 'day';
    const granularity: StatGranularity = (STAT_GRANULARITIES as readonly string[]).includes(
      granularityRaw,
    )
      ? (granularityRaw as StatGranularity)
      : 'day';

    const bucketsRaw = Number.parseInt((req.query.buckets as string) || '', 10);
    const count = normalizeBucketCount(
      granularity,
      Number.isFinite(bucketsRaw) ? bucketsRaw : undefined,
    );

    const agentIds = deps
      .allAgents()
      .filter((a) => a.projectId === project.id)
      .map((a) => a.id);

    try {
      const stats = computeProjectStats(getDb(), {
        projectId: project.id,
        agentIds,
        granularity,
        count,
        now: new Date(),
      });
      res.json(stats);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to read project stats',
      });
    }
  });

  return router;
}
