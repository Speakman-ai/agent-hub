/**
 * Zod schema + OpenAPI registration for the log-store health metrics route
 * (decision LOG-SCOPE). Read-only; Admin-gated and project-ACL scoped. Imported
 * for its side-effect `registerPath` call by `server/openapi/generate.ts` and
 * by the route module so the mount and the docs never drift.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const LogMetricsComponent = registerComponent(
  'LogStoreMetrics',
  z
    .object({
      queue: z
        .object({
          depth: z.number().int().openapi({ description: 'Records pending in the write queue.' }),
          depthLimit: z
            .number()
            .int()
            .openapi({ description: 'Queue depth cap; a full queue applies 429 backpressure.' }),
        })
        .openapi({ description: 'Hub-wide batch-writer queue state.' }),
      counters: z
        .object({
          accepted: z.number().int(),
          written: z.number().int(),
          rejected: z.number().int(),
          dropped: z.number().int(),
          redacted: z.number().int(),
          writeErrors: z.number().int(),
          expiredDeleted: z.number().int(),
          quotaDeleted: z.number().int(),
        })
        .openapi({ description: 'Monotonic ingest/reaper counters since boot.' }),
      latency: z
        .object({
          meanFlushMs: z.number(),
          flushCount: z.number().int(),
        })
        .openapi({ description: 'Writer flush latency.' }),
      storage: z
        .object({
          projectBytes: z
            .number()
            .int()
            .openapi({ description: 'Normalized bytes stored for this project.' }),
          dbBytes: z.number().int().openapi({ description: 'On-disk size of logs.db.' }),
          quotaBytes: z.number().int(),
          retentionDays: z.number().int(),
          retentionLagRecords: z
            .number()
            .int()
            .openapi({ description: 'Records past retention not yet reaped for this project.' }),
        })
        .openapi({ description: 'Per-project storage + retention gauges.' }),
    })
    .openapi({ description: 'Log-store health metrics (decision LOG-SCOPE).' }),
);

const ErrorComponent = registerComponent(
  'LogMetricsErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/logs/metrics',
  tags: ['Log Sources'],
  summary: 'Log-store health metrics',
  description:
    'Returns batch-writer queue depth, ingest/reaper counters (accepted, written, rejected, dropped, redacted, write errors, reaper deletions), writer latency, and per-project storage + retention-lag gauges. Requires Admin and project access.',
  request: {
    params: z.object({ projectId: z.string().openapi({ description: 'Project ID (slug).' }) }),
  },
  responses: {
    200: {
      description: 'Metrics.',
      content: { 'application/json': { schema: LogMetricsComponent } },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
    404: {
      description: 'Project not found or not visible to the caller.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
  },
});
