/** Protected, bounded historical customer-log query API (LOG-QUERY). */
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../roles.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import type { RouteDeps } from '../types.js';
import { queryLogRecords } from '../logs/logs-db.js';
import { serializeLogRecord } from '../logs/log-record-api.js';
import { LogQueryParamsSchema } from './log-query.openapi.js';

/** SQLite's FTS5 parser errors are invalid user search expressions, not outages. */
export function isFtsSyntaxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /fts5:\s*syntax error|unterminated string|malformed match expression/i.test(err.message);
}

export default function createLogQueryRoutes({ findProject }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/api/projects/:projectId/logs',
    requireRole('User'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const project = findProject(projectId);
      if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const parsed = LogQueryParamsSchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid log query' });
        return;
      }
      try {
        const page = queryLogRecords({ projectId, ...parsed.data });
        res.json({ records: page.records.map(serializeLogRecord), nextCursor: page.nextCursor });
      } catch (err) {
        // SQLite FTS5 rejects malformed MATCH syntax (for example an unmatched
        // quote). Treat that as a bad search, not an internal server failure.
        if (parsed.data.text && isFtsSyntaxError(err)) {
          res.status(400).json({ error: 'Invalid full-text search query' });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
