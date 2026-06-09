/**
 * Zod schemas + OpenAPI registrations for the Finalize flaky-test quarantine
 * lane + flake-history route group (`server/routes/finalize-quarantine.ts`).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'QuarantineError',
  z.object({ error: z.string(), message: z.string().optional() }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const QuarantineStatusEnum = z.enum(['active', 'overdue']);

const QuarantineEntrySchema = registerComponent(
  'QuarantineEntry',
  z
    .object({
      id: z.string(),
      job_id: z.string(),
      matrix_key: z.string(),
      owner: z.string(),
      reason: z.string().nullable(),
      quarantined_at: z.number().int(),
      expires_at: z.number().int(),
      created_by: z.string().nullable(),
      status: QuarantineStatusEnum,
      days_until_expiry: z.number().int(),
    })
    .openapi({
      description:
        'One quarantine-lane entry: a flaky job instance excused from blocking the gate, ' +
        'with a named owner and an expiry. `overdue` means it is past expiry and no longer excuses.',
    }),
);

const QuarantineListResponse = registerComponent(
  'QuarantineListResponse',
  z.object({
    project_id: z.string(),
    now: z.number().int(),
    max_days: z.number().int(),
    default_days: z.number().int(),
    active: z.array(QuarantineEntrySchema),
    overdue: z.array(QuarantineEntrySchema),
  }),
);

const QuarantineCreateRequest = registerComponent(
  'QuarantineCreateRequest',
  z.object({
    job_id: z.string().openapi({ description: 'The ci.yaml v2 job id to quarantine.' }),
    matrix_key: z
      .string()
      .optional()
      .openapi({ description: 'Matrix-shard discriminator; omit/empty for non-matrix jobs.' }),
    owner: z.string().openapi({ description: 'Named owner accountable for resolving the flake.' }),
    reason: z.string().optional().openapi({ description: 'Why this instance is quarantined.' }),
    days: z
      .number()
      .optional()
      .openapi({ description: 'Quarantine duration in days; clamped to ≤30 (default 30).' }),
    created_by: z.string().optional(),
  }),
);

const QuarantineCreateResponse = registerComponent(
  'QuarantineCreateResponse',
  z.object({ project_id: z.string(), entry: QuarantineEntrySchema }),
);

const FlakeInstanceSchema = registerComponent(
  'FlakeInstance',
  z
    .object({
      job_id: z.string(),
      matrix_key: z.string(),
      runs: z.number().int(),
      failed_runs: z.number().int(),
      flaked_runs: z.number().int(),
      flake_rate: z.number(),
      fail_rate: z.number(),
      last_seen: z.number().int(),
      quarantined: z.boolean(),
    })
    .openapi({
      description:
        'Per job/matrix instance flake statistics over the requested window. ' +
        '`flake_rate` = fraction of runs that flaked within the run OR ended failed.',
    }),
);

const FlakeListResponse = registerComponent(
  'FlakeListResponse',
  z.object({
    project_id: z.string(),
    window_days: z.number().int(),
    instances: z.array(FlakeInstanceSchema),
  }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/quarantine',
  tags: ['Finalize'],
  summary: 'List flaky-test quarantine entries (active + overdue)',
  description:
    'Returns the project quarantine lane split into active entries (still excusing their instance) ' +
    'and overdue entries (past expiry, awaiting human renewal or removal).',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: {
      description: 'Quarantine entries for the project.',
      content: jsonContent(QuarantineListResponse),
    },
    404: errorResponse('Project not found.'),
    500: errorResponse('Quarantine list could not be read.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/quarantine',
  tags: ['Finalize'],
  summary: 'Quarantine a flaky job instance',
  description:
    'Adds (or updates, idempotent per instance) a quarantine entry. `days` is clamped to ≤30. ' +
    'A quarantined instance still runs but no longer blocks the push gate until it expires.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(QuarantineCreateRequest) },
  },
  responses: {
    201: {
      description: 'Quarantine entry created/updated.',
      content: jsonContent(QuarantineCreateResponse),
    },
    400: errorResponse('Missing job_id/owner or invalid days.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Quarantine entry could not be written.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/finalize/quarantine/{id}',
  tags: ['Finalize'],
  summary: 'Release a quarantine entry',
  request: {
    params: z.object({ projectId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: 'Quarantine entry released.' },
    404: errorResponse('Project or quarantine entry not found.'),
    500: errorResponse('Quarantine entry could not be deleted.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/flakes',
  tags: ['Finalize'],
  summary: 'Per-instance flake statistics from recorded run history',
  description:
    'Computes a flake rate per job/matrix instance over the requested window (default 30 days), ' +
    'newest-evidence first, annotated with whether the instance is currently quarantined.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      windowDays: z.string().optional().openapi({
        description: 'Look-back window in days; positive integer (default 30, max 365).',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Flake statistics for the window.',
      content: jsonContent(FlakeListResponse),
    },
    400: errorResponse('windowDays must be a positive integer.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Flake history could not be read.'),
  },
});
