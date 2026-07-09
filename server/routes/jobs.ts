/**
 * jobs.ts — admin/observability surface for the in-house SQLite job queue.
 *
 * The queue (`server/jobs/`) is a single host-wide table that heartbeats,
 * crons, and future autonomous background tasks drain. This router exposes a
 * minimal management surface over it: list jobs (filter by status/type),
 * requeue a dead-lettered job, and delete a job row. All three are
 * Admin/Owner-gated — this is operator tooling, not per-project data.
 *
 * Read/mutate logic lives in `server/jobs/admin.ts` (pure functions over a db
 * handle) so it can be unit-tested without a running queue; this file is the
 * thin HTTP + Zod layer.
 */
import { Router, type Request, type Response } from 'express';
import type { RouteDeps } from '../types.js';
import { getDb } from '../db.js';
import { requireRole } from '../roles.js';
import { z, registerPath } from '../openapi/registry.js';
import {
  JOB_STATUSES,
  isJobStatus,
  listJobs,
  countJobsByStatus,
  listJobTypes,
  retryDeadLetterJob,
  deleteJob,
  getJobRow,
} from '../jobs/admin.js';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = z.object({ error: z.string() });

const JobStatusSchema = z.enum(['queued', 'running', 'done', 'dead_letter']);

const JobSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.string(),
  status: JobStatusSchema,
  priority: z.number().int(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  run_at: z.number(),
  claimed_by: z.string().nullable(),
  claimed_at: z.number().nullable(),
  lease_id: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

const JobCountsSchema = z.object({
  queued: z.number().int(),
  running: z.number().int(),
  done: z.number().int(),
  dead_letter: z.number().int(),
  total: z.number().int(),
});

registerPath({
  method: 'get',
  path: '/api/jobs',
  tags: ['Jobs'],
  summary: 'List background jobs (Admin) — filter by status and/or type',
  description:
    'Newest-first listing of the host-wide job queue with per-status counts and the distinct job types present. Admin/Owner only.',
  request: {
    query: z.object({
      status: JobStatusSchema.optional(),
      type: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Jobs, counts, and the distinct types present.',
      content: jsonContent(
        z.object({
          jobs: z.array(JobSchema),
          counts: JobCountsSchema,
          types: z.array(z.string()),
          limit: z.number().int(),
          offset: z.number().int(),
        }),
      ),
    },
    400: { description: 'Invalid filter.', content: jsonContent(ErrorResponse) },
    403: { description: 'Not an Admin/Owner.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/jobs/{id}/retry',
  tags: ['Jobs'],
  summary: 'Requeue a dead-lettered job (Admin)',
  description:
    'Resets a dead_letter job back to queued with a fresh attempt budget so a worker retries it. Only dead_letter jobs are retryable (409 otherwise).',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Job requeued.', content: jsonContent(z.object({ job: JobSchema })) },
    403: { description: 'Not an Admin/Owner.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown job.', content: jsonContent(ErrorResponse) },
    409: {
      description: 'Job is not in the dead_letter state.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/jobs/{id}',
  tags: ['Jobs'],
  summary: 'Delete a background job row (Admin)',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Job deleted.', content: jsonContent(z.object({ ok: z.boolean() })) },
    403: { description: 'Not an Admin/Owner.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown job.', content: jsonContent(ErrorResponse) },
  },
});

export default function createJobRoutes(_deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/jobs', requireRole('Admin'), (req: Request, res: Response) => {
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !isJobStatus(statusRaw)) {
      return res.status(400).json({
        error: `Invalid status filter. Expected one of: ${JOB_STATUSES.join(', ')}`,
      });
    }
    const type =
      typeof req.query.type === 'string' && req.query.type.length > 0 ? req.query.type : undefined;
    let limit = Number.parseInt((req.query.limit as string) || '', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    let offset = Number.parseInt((req.query.offset as string) || '', 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const db = getDb();
    const jobs = listJobs(db, { status: statusRaw, type, limit, offset });
    res.json({
      jobs,
      counts: countJobsByStatus(db),
      types: listJobTypes(db),
      limit,
      offset,
    });
  });

  router.post('/api/jobs/:id/retry', requireRole('Admin'), (req: Request, res: Response) => {
    const id = req.params.id as string;
    const db = getDb();
    const result = retryDeadLetterJob(db, id);
    if (result === 'not_found') {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (result === 'not_dead_letter') {
      return res.status(409).json({ error: 'Only dead-lettered jobs can be retried.' });
    }
    res.json({ job: getJobRow(db, id) });
  });

  // Deleting a `running` job (one a worker is mid-flight on) is allowed by
  // design: this is admin tooling for clearing rows, and the queue tolerates
  // it safely — the worker's settle UPDATE is lease-scoped, so it simply
  // no-ops against the now-missing row (see JobQueue.process / the lease
  // guard in schema.ts). No orphaned worker, no lost-update.
  router.delete('/api/jobs/:id', requireRole('Admin'), (req: Request, res: Response) => {
    const id = req.params.id as string;
    const removed = deleteJob(getDb(), id);
    if (!removed) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ ok: true });
  });

  return router;
}
