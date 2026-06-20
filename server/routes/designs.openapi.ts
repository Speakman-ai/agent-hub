/**
 * OpenAPI registrations for the designs router. The legacy CRUD surface in
 * designs.ts predates the Zod registry (tracked as coverage debt in
 * scripts/openapi-coverage-baseline.json); new endpoints register here so the
 * published spec documents them. Imported for side effects by designs.ts and
 * walked directly by the generator (server/openapi/generate.ts).
 */
import { z, registerPath } from '../openapi/registry.js';

const jsonContent = (schema: z.ZodTypeAny) => ({ 'application/json': { schema } });

const designIdParams = z.object({
  id: z.string().openapi({ description: 'Design id.' }),
});

export const DesignImportResultSchema = z
  .object({
    designId: z.string(),
    sessionId: z.string().openapi({
      description: 'The design-mode session the design now lives in.',
    }),
    agentId: z.string(),
    importedMessages: z.number().int().openapi({
      description: 'Count of design messages replayed into the session.',
    }),
    reused: z.boolean().openapi({
      description:
        'True when the design was already imported and the existing session was returned.',
    }),
    skipped: z.enum(['already-imported']).optional(),
  })
  .openapi('DesignImportResult');

registerPath({
  method: 'post',
  path: '/api/designs/{id}/import',
  tags: ['Designs'],
  summary: 'Migrate a standalone design into a design-mode session',
  description:
    'Creates a `design`-mode session for an agent in one of the design’s linked ' +
    'projects, provisions its worktree, copies the design artifact dir into ' +
    '`<worktree>/design/`, and replays the design transcript as session messages. ' +
    'Non-destructive: the design row, files, and messages are preserved (standalone ' +
    'tables are dropped a release later, gated on parity). Idempotent — re-running ' +
    'returns the existing mapping with `reused: true`.',
  request: { params: designIdParams },
  responses: {
    201: {
      description: 'Design imported into a new session.',
      content: jsonContent(DesignImportResultSchema),
    },
    200: {
      description: 'Design was already imported; existing session returned.',
      content: jsonContent(DesignImportResultSchema),
    },
    404: { description: 'Design not found.' },
    409: {
      description:
        'Import could not proceed. `error: "design_import_failed"` (e.g. no eligible target ' +
        'agent in a linked project) is terminal; `error: "import_in_progress"` (`retryable: ' +
        'true`) means a concurrent import holds the lock — retry shortly.',
    },
    503: { description: 'Worktree provisioning is not wired.' },
  },
});
