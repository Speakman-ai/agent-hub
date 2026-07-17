/**
 * Zod schemas + OpenAPI registrations for the server-stored Finalize CI config
 * routes (`server/routes/finalize-ci-config.ts`).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'FinalizeCiConfigErrorResponse',
  z
    .object({
      error: z.string(),
      message: z.string().optional(),
      code: z.string().optional(),
      path: z.string().nullable().optional(),
    })
    .openapi({ description: 'Error envelope for server-stored Finalize CI config routes.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const ServerCiScope = z.enum(['project', 'personal']);

const ServerCiConfigView = registerComponent(
  'FinalizeServerCiConfigView',
  z
    .object({
      scope: ServerCiScope,
      ci_yaml_content: z.string().openapi({ description: 'The stored ci.yaml text.' }),
      updated_by: z.string().nullable().openapi({ description: 'User id of the last writer.' }),
      updated_at: z.number().openapi({ description: 'Epoch ms of the last write.' }),
    })
    .openapi({ description: 'A server-stored ci.yaml config for one scope.' }),
);

const GetResponse = registerComponent(
  'FinalizeServerCiConfigGetResponse',
  z
    .object({
      project_id: z.string(),
      project: ServerCiConfigView.nullable().openapi({
        description: 'The project-scoped (shared) config, or null when unset.',
      }),
      personal: ServerCiConfigView.nullable().openapi({
        description: "The caller's personal override, or null when unset / no user.",
      }),
    })
    .openapi({ description: 'Server-stored ci.yaml configs visible to the caller.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/ci-config',
  tags: ['Finalize'],
  summary: 'Get the server-stored Finalize CI config(s)',
  description:
    'Admin+. Returns the project-scoped server config and (when the caller has one) their personal override. These are the fallback used when a repo does not commit `.agent-hub/ci.yaml` — a committed file always takes precedence.',
  request: { params: z.object({ projectId: z.string() }) },
  responses: {
    200: { description: 'Stored configs.', content: jsonContent(GetResponse) },
    403: errorResponse('Caller lacks the Admin role.'),
    404: errorResponse('Project not found.'),
  },
});

const PutRequest = registerComponent(
  'FinalizeServerCiConfigPutRequest',
  z
    .object({
      ci_yaml_content: z.string().openapi({
        description: 'Verbatim ci.yaml. Validated against the ci.yaml schema before it is stored.',
      }),
      scope: ServerCiScope.optional().openapi({
        description:
          "Which scope to write. Defaults to 'project' (shared). 'personal' stores an override keyed to the calling user.",
      }),
    })
    .openapi({ description: 'Upsert a server-stored ci.yaml config.' }),
);

const PutResponse = registerComponent(
  'FinalizeServerCiConfigPutResponse',
  z
    .object({
      ok: z.literal(true),
      project_id: z.string(),
      config: ServerCiConfigView,
    })
    .openapi({ description: 'The stored config after upsert.' }),
);

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/finalize/ci-config',
  tags: ['Finalize'],
  summary: 'Upsert a server-stored Finalize CI config',
  description:
    'Admin+. Validates the ci.yaml against the schema, then stores it on the Agent Hub server (not committed to the repo). Runs in the Finalize runner exactly like a committed config would.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(PutRequest) },
  },
  responses: {
    200: { description: 'Config stored.', content: jsonContent(PutResponse) },
    400: errorResponse('Missing/invalid ci_yaml_content, bad scope, or ci_config_invalid.'),
    403: errorResponse('Caller lacks the Admin role.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Store write failed.'),
  },
});

const DeleteResponse = registerComponent(
  'FinalizeServerCiConfigDeleteResponse',
  z
    .object({
      ok: z.literal(true),
      project_id: z.string(),
      scope: ServerCiScope,
      deleted: z.boolean().openapi({ description: 'True when a row was actually removed.' }),
    })
    .openapi({ description: 'Delete outcome.' }),
);

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/finalize/ci-config',
  tags: ['Finalize'],
  summary: 'Delete a server-stored Finalize CI config',
  description: "Admin+. Removes one scope's server-stored ci.yaml (defaults to the project scope).",
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      scope: ServerCiScope.optional().openapi({
        description: "Scope to delete. Defaults to 'project'.",
      }),
    }),
  },
  responses: {
    200: { description: 'Delete processed.', content: jsonContent(DeleteResponse) },
    400: errorResponse('Bad scope.'),
    403: errorResponse('Caller lacks the Admin role.'),
    404: errorResponse('Project not found.'),
  },
});
