/**
 * Zod schemas + OpenAPI registration for the Finalize test inventory lookup
 * (`server/routes/finalize-test-inventory.ts`).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'TestInventoryError',
  z.object({ error: z.string(), message: z.string().optional() }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const TestInventoryEntry = registerComponent(
  'TestInventoryEntry',
  z
    .object({
      job_id: z.string(),
      matrix_key: z.string().openapi({ description: 'Matrix shard key; empty for a plain job.' }),
      test_file: z.string().openapi({
        description:
          'Test file as the JUnit report named it (repo-relative when the runner gave an absolute ' +
          'path under the workspace; Go reports the package import path).',
      }),
    })
    .openapi({ description: 'One test file and the job instance that ran it.' }),
);

const TestInventoryLookupResponse = registerComponent(
  'TestInventoryLookupResponse',
  z
    .object({
      project_id: z.string(),
      base_sha: z.string(),
      status: z.enum(['ok', 'stale', 'missing']),
      sha: z
        .string()
        .optional()
        .openapi({ description: 'Head sha of the full default-branch run the inventory is from.' }),
      branch: z.string().optional(),
      recorded_at: z.number().int().optional(),
      reason: z.string().optional().openapi({ description: 'Why the inventory is stale.' }),
      entries: z
        .array(TestInventoryEntry)
        .optional()
        .openapi({ description: 'Present only when `status` is `ok`.' }),
    })
    .openapi({
      description:
        '`ok`: the inventory sha is an ancestor of `base_sha` and `entries` is usable. `stale`: it ' +
        'is not (or ancestry could not be determined). `missing`: no full default-branch run has ' +
        'recorded an inventory. Selection treats `stale` and `missing` as a forced full run.',
    }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/test-inventory',
  tags: ['Finalize'],
  summary: 'Look up the test inventory for a base sha',
  description:
    'Returns which job instance (job + matrix shard) runs which test file, learned from the JUnit ' +
    'XML of the last full CI run on the default branch. Only those runs write it; session and ' +
    'selected runs never do.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      baseSha: z
        .string()
        .openapi({ description: 'Session base commit to check staleness against.' }),
    }),
  },
  responses: {
    200: {
      description: 'Inventory lookup result.',
      content: jsonContent(TestInventoryLookupResponse),
    },
    400: { description: 'Missing or malformed baseSha.', content: jsonContent(ErrorResponse) },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
    500: { description: 'Inventory could not be read.', content: jsonContent(ErrorResponse) },
  },
});
