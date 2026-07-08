/**
 * Zod schemas + OpenAPI registrations for the Finalize↔GitHub parity harness
 * route group (`server/routes/finalize-parity.ts`).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'ParityError',
  z.object({ error: z.string(), message: z.string().optional() }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const VerdictEnum = z.enum(['green', 'red', 'unknown']);
const DivergenceClassEnum = z.enum([
  'agree_green',
  'agree_red',
  'false_green',
  'false_red',
  'indeterminate',
]);
const JobStateEnum = z.enum(['green', 'red', 'unknown', 'skipped']);

const ParityJobSchema = registerComponent(
  'ParityJob',
  z
    .object({
      name: z.string(),
      state: JobStateEnum,
    })
    .openapi({ description: 'One CI job/check, normalized to a name + parity state.' }),
);

const ParityRecordSchema = registerComponent(
  'ParityRecord',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      pr_number: z.number().int().nullable(),
      commit_sha: z.string(),
      run_id: z.string().nullable(),
      finalize_verdict: VerdictEnum,
      finalize_jobs: z.array(ParityJobSchema),
      github_verdict: VerdictEnum,
      github_jobs: z.array(ParityJobSchema),
      divergence_class: DivergenceClassEnum,
      note: z.string().nullable(),
      observed_at: z.number().int(),
    })
    .openapi({
      description:
        'One per-commit parity observation: the Finalize verdict + per-job states vs the ' +
        'GitHub Actions verdict + per-job states, with the derived divergence class.',
    }),
);

const ParitySummarySchema = registerComponent(
  'ParitySummary',
  z
    .object({
      total: z.number().int(),
      agree_green: z.number().int(),
      agree_red: z.number().int(),
      false_green: z.number().int(),
      false_red: z.number().int(),
      indeterminate: z.number().int(),
    })
    .openapi({ description: 'Count of records per divergence class for the window.' }),
);

const ParityRangeSchema = z.object({
  from_ms: z.number().int(),
  to_ms: z.number().int(),
  from_iso: z.string(),
  to_iso: z.string(),
});

const ParityListResponseSchema = registerComponent(
  'ParityListResponse',
  z.object({
    project_id: z.string(),
    range: ParityRangeSchema,
    summary: ParitySummarySchema,
    records: z.array(ParityRecordSchema),
  }),
);

const ParityRecordRequestSchema = registerComponent(
  'ParityRecordRequest',
  z
    .object({
      commit_sha: z.string(),
      pr_number: z.number().int().positive().nullable().optional(),
      run_id: z.string().nullable().optional(),
      finalize_verdict: VerdictEnum,
      finalize_jobs: z.array(ParityJobSchema).optional(),
      github_verdict: VerdictEnum,
      github_jobs: z.array(ParityJobSchema).optional(),
      note: z.string().nullable().optional(),
    })
    .openapi({ description: 'Record (or update, idempotent on commit) one parity observation.' }),
);

const ParityRecordResponseSchema = registerComponent(
  'ParityRecordResponse',
  z.object({ record: ParityRecordSchema }),
);

const ParitySeedResponseSchema = registerComponent(
  'ParitySeedResponse',
  z.object({
    project_id: z.string(),
    seeded: z.number().int(),
    records: z.array(ParityRecordSchema),
  }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/parity',
  tags: ['Finalize'],
  summary: 'List Finalize↔GitHub parity records with a divergence breakdown',
  description:
    'Returns per-commit parity observations for the window, newest first, plus a class summary. ' +
    'The summary always reflects the full window even when `class` filters the record list.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      range: z.string().optional().openapi({
        description: '`<N><m|h|d>` (e.g. `7d`, `24h`) or `<isoFrom>..<isoTo>`. Defaults to 24h.',
      }),
      class: DivergenceClassEnum.optional().openapi({
        description: 'Filter the record list to a single divergence class.',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Parity records + summary for the window.',
      content: jsonContent(ParityListResponseSchema),
    },
    400: errorResponse('Range or class filter could not be parsed.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/parity',
  tags: ['Finalize'],
  summary: 'Record one Finalize↔GitHub parity observation',
  description:
    'Idempotent on (project, commit_sha). Derives the divergence class, persists the record, ' +
    'emits the `finalize_github_parity` counter, and fires a false-green alert when Finalize ' +
    'is green but GitHub is red.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(ParityRecordRequestSchema) },
  },
  responses: {
    201: {
      description: 'The stored parity record.',
      content: jsonContent(ParityRecordResponseSchema),
    },
    400: errorResponse('Missing commit_sha or invalid verdict / jobs / pr_number.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/parity/seed',
  tags: ['Finalize'],
  summary: 'Seed the parity dataset with known false-greens (PR#1001)',
  description:
    'Idempotently seeds the project dataset with documented false-green observations, ' +
    'starting with PR webapp#1001 (commit 6ad87ec).',
  request: {
    params: z.object({ projectId: z.string() }),
  },
  responses: {
    201: {
      description: 'The seeded parity records.',
      content: jsonContent(ParitySeedResponseSchema),
    },
    404: errorResponse('Project not found.'),
  },
});
