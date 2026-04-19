import { Router, Request, Response } from 'express';
import { aggregateToolErrors } from '../tool-errors.js';
import type { RouteDeps } from '../types.js';

/**
 * Stub endpoint for the Session Health epic. Greps TOOL_ERROR self-report
 * lines out of the project's daily notes and returns them as structured JSON
 * alongside minimal aggregate counts. See `server/tool-errors.ts` and the
 * wiki page "TOOL_ERROR Aggregation Stub" for the contract.
 */
export default function createToolErrorRoutes({ findProject }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/api/projects/:projectId/tool-errors', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const sinceRaw = (req.query.since as string | undefined) ?? '';
    let since: string | undefined;
    if (sinceRaw) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)) {
        return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
      }
      since = sinceRaw;
    }

    const limitRaw = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

    const agg = aggregateToolErrors(project.ahw, { since });
    const truncated = agg.errors.length > limit;
    const errors = truncated ? agg.errors.slice(0, limit) : agg.errors;

    res.json({
      projectId,
      since: agg.since,
      total: agg.total,
      returned: errors.length,
      truncated,
      errors,
      countsByTool: agg.countsByTool,
      countsByErrorType: agg.countsByErrorType,
      countsByDate: agg.countsByDate,
    });
  });

  return router;
}
