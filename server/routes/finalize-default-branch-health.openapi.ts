/**
 * Zod schemas + OpenAPI registration for the default-branch health read
 * (`server/routes/finalize-default-branch-health.ts`).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'DefaultBranchHealthError',
  z.object({ error: z.string() }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const DefaultBranchFailure = registerComponent(
  'DefaultBranchFailure',
  z
    .object({
      job_id: z.string(),
      matrix_key: z.string().openapi({ description: 'Matrix shard key; empty for a plain job.' }),
      first_failing_sha: z.string(),
      last_failing_sha: z.string(),
      last_run_id: z.string().nullable(),
    })
    .openapi({ description: 'A job instance failing on the default branch.' }),
);

const DefaultBranchHealthResponse = registerComponent(
  'DefaultBranchHealthResponse',
  z
    .object({
      project_id: z.string(),
      state: z.enum(['green', 'red', 'unknown']).openapi({
        description:
          '`red` while any instance is failing or a breakage is open; `green` once CI has reported ' +
          'on the default branch with nothing failing; `unknown` before the first report.',
      }),
      branch: z.string().nullable(),
      last_sha: z.string().nullable(),
      last_status: z.enum(['succeeded', 'failed']).nullable(),
      updated_at: z.number().int().nullable(),
      breakage: z
        .object({
          id: z.string(),
          card_id: z.string().nullable().openapi({ description: 'Kanban card tracking it.' }),
          first_failing_sha: z.string(),
          last_failing_sha: z.string(),
          created_at: z.number().int(),
        })
        .nullable(),
      failures: z.array(DefaultBranchFailure),
    })
    .openapi({ description: 'Default-branch CI health from the full run after each merge.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/default-branch-health',
  tags: ['Finalize'],
  summary: 'Read default-branch CI health',
  description:
    'Instances failing on the default branch and the open breakage card, recorded by the full ' +
    'push-CI run on every merge. Read-only; merges are never blocked on it.',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: { description: 'Health snapshot.', content: jsonContent(DefaultBranchHealthResponse) },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
    500: { description: 'Health could not be read.', content: jsonContent(ErrorResponse) },
  },
});
