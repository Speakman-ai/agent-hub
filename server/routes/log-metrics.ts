/**
 * Log-store health metrics route (decision LOG-SCOPE: "Publish health metrics
 * for accepted/dropped records, queue depth, write latency, database bytes,
 * retention lag, redaction counts").
 *
 *   GET /api/projects/:projectId/logs/metrics
 *
 * The ingest counters and the batch-writer queue are process-wide (there is one
 * queue and one logs.db), so `counters`/`queue`/`latency` are hub-wide; the
 * `storage` block is resolved for the requested project. Read-only and
 * Admin-gated + project-ACL scoped, like the log-sources management routes — a
 * hidden project returns 404 so its existence never leaks.
 */
import { Router, type Request, type Response } from 'express';
import { requireRole } from '../roles.js';
import { canViewProject } from '../project-visibility.js';
import { resolveVisibilityCaller } from '../project-visibility-middleware.js';
import type { RouteDeps } from '../types.js';
import { getLogMetrics, meanFlushLatencyMs } from '../logs/log-metrics.js';
import { getLogWriteQueue } from '../logs/log-write-queue.js';
import {
  getProjectByteSize,
  getLogsDbFileBytes,
  countExpiredLogRecords,
  getRetentionConfig,
} from '../logs/logs-db.js';
import './log-metrics.openapi.js';

export default function createLogMetricsRoutes({ findProject }: RouteDeps): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/api/projects/:projectId/logs/metrics',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const project = findProject(projectId);
      if (!project || !canViewProject(project, resolveVisibilityCaller(req))) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const counters = getLogMetrics();
      const queue = getLogWriteQueue();
      const config = getRetentionConfig(projectId);
      const now = Date.now();

      res.json({
        queue: {
          depth: queue.size(),
          depthLimit: queue.depthLimit,
        },
        counters: {
          accepted: counters.accepted,
          written: counters.written,
          rejected: counters.rejected,
          dropped: counters.dropped,
          redacted: counters.redacted,
          writeErrors: counters.writeErrors,
          expiredDeleted: counters.expiredDeleted,
          quotaDeleted: counters.quotaDeleted,
        },
        latency: {
          meanFlushMs: meanFlushLatencyMs(counters),
          flushCount: counters.flushCount,
        },
        storage: {
          projectBytes: getProjectByteSize(projectId),
          dbBytes: getLogsDbFileBytes(),
          quotaBytes: config.quotaBytes,
          retentionDays: config.retentionDays,
          retentionLagRecords: countExpiredLogRecords(projectId, now),
        },
      });
    },
  );

  return router;
}
