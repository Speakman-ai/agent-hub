/**
 * Zod schemas + OpenAPI registrations for the log-sources route group
 * (decision LOG-AUTH). Same contract as the other `*.openapi.ts` companions:
 *   1. `server/routes/log-sources.ts` imports the request schemas and
 *      validates the body with `safeParse(...)`.
 *   2. `server/openapi/generate.ts` imports this module for the side-effect
 *      `registerPath` calls that land in `docs/api/openapi.yaml`.
 *
 * Sources are project-scoped, write-only ingest credentials: a source's
 * `ahlog_` token identifies exactly one (project, source) and grants no
 * read/query/management access. Management here (list/create/rotate/revoke/
 * delete) is Admin-gated and project-ACL scoped.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Request schemas ────────────────────────────────────────────────

export const CreateLogSourceRequestSchema = z.object({
  name: z.string().min(1).max(100),
  serviceName: z.string().max(200).nullish(),
  environment: z.string().max(200).nullish(),
});

export const UpdateLogSourceRequestSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    serviceName: z.string().max(200).nullish(),
    environment: z.string().max(200).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });

// ─── Response component schemas ──────────────────────────────────────

const LogSourceComponent = registerComponent(
  'LogSource',
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      name: z.string(),
      serviceName: z.string().nullable(),
      environment: z.string().nullable(),
      tokenPrefix: z.string().nullable(),
      status: z.enum(['active', 'revoked']),
      createdAt: z.number().int(),
      rotatedAt: z.number().int().nullable(),
      revokedAt: z.number().int().nullable(),
      lastIngestAt: z.number().int().nullable().openapi({
        description:
          'Wall-clock ms of the most recent record ingested under this source, or null if it has never ingested.',
      }),
    })
    .openapi({ description: 'A project log source. Never carries token material.' }),
);

const LogSourceWithTokenComponent = registerComponent(
  'LogSourceWithToken',
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      name: z.string(),
      serviceName: z.string().nullable(),
      environment: z.string().nullable(),
      tokenPrefix: z.string().nullable(),
      status: z.enum(['active', 'revoked']),
      createdAt: z.number().int(),
      rotatedAt: z.number().int().nullable(),
      revokedAt: z.number().int().nullable(),
      lastIngestAt: z.number().int().nullable().openapi({
        description:
          'Wall-clock ms of the most recent record ingested under this source, or null if it has never ingested.',
      }),
      token: z.string().openapi({
        description:
          'Plaintext `ahlog_` ingest token. Returned ONCE at create/rotate; only its hash is stored. Surface it to the user immediately — it cannot be retrieved later.',
      }),
    })
    .openapi({ description: 'A log source plus its freshly minted plaintext ingest token.' }),
);

const LogSourceListComponent = registerComponent(
  'LogSourceList',
  z.object({ sources: z.array(LogSourceComponent) }).openapi({ description: 'Project sources.' }),
);

const LogSourceAuditEntryComponent = registerComponent(
  'LogSourceAuditEntry',
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      sourceId: z.string().nullable(),
      action: z.enum(['create', 'update', 'rotate', 'revoke', 'delete']),
      actorUserId: z.string().nullable(),
      detail: z.string().nullable(),
      createdAt: z.number().int(),
    })
    .openapi({ description: 'A source/token lifecycle audit event.' }),
);

const LogSourceAuditListComponent = registerComponent(
  'LogSourceAuditList',
  z
    .object({ entries: z.array(LogSourceAuditEntryComponent) })
    .openapi({ description: 'Lifecycle audit for a source.' }),
);

const LogSourceErrorComponent = registerComponent(
  'LogSourceErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

// ─── Path registrations ──────────────────────────────────────────────

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project ID (slug).' }),
});
const sourceParams = z.object({
  projectId: z.string().openapi({ description: 'Project ID (slug).' }),
  sourceId: z.string().openapi({ description: 'Log source ID.' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(LogSourceErrorComponent),
});

const TAG = 'Log Sources';

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/log-sources',
  tags: [TAG],
  summary: 'List a project’s log sources',
  description:
    'Returns all log sources for the project, newest-first. Never includes token material — only the non-secret `tokenPrefix`. Requires Admin and project access.',
  request: { params: projectIdParams },
  responses: {
    200: { description: 'Sources.', content: jsonContent(LogSourceListComponent) },
    403: errorResponse('Insufficient role.'),
    404: errorResponse('Project not found or not visible to the caller.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/log-sources',
  tags: [TAG],
  summary: 'Create a log source and mint its ingest token',
  description:
    'Registers a named source and returns its `ahlog_` ingest token exactly once (only the hash is stored). Source names are unique per project (409 on collision). Requires Admin and project access.',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateLogSourceRequestSchema) },
  },
  responses: {
    201: {
      description: 'Source created; token revealed once.',
      content: jsonContent(LogSourceWithTokenComponent),
    },
    400: errorResponse('Body validation failed.'),
    403: errorResponse('Insufficient role.'),
    404: errorResponse('Project not found or not visible to the caller.'),
    409: errorResponse('A source with this name already exists in the project.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/log-sources/{sourceId}',
  tags: [TAG],
  summary: 'Get one log source',
  request: { params: sourceParams },
  responses: {
    200: { description: 'Source.', content: jsonContent(LogSourceComponent) },
    403: errorResponse('Insufficient role.'),
    404: errorResponse('Project or source not found.'),
  },
});

registerPath({
  method: 'patch',
  path: '/api/projects/{projectId}/log-sources/{sourceId}',
  tags: [TAG],
  summary: 'Update a log source’s metadata',
  description:
    'Updates name / serviceName / environment. Token material is untouched. Requires Admin and project access.',
  request: {
    params: sourceParams,
    body: { content: jsonContent(UpdateLogSourceRequestSchema) },
  },
  responses: {
    200: { description: 'Updated source.', content: jsonContent(LogSourceComponent) },
    400: errorResponse('Body validation failed.'),
    403: errorResponse('Insufficient role.'),
    404: errorResponse('Project or source not found.'),
    409: errorResponse('A source with this name already exists in the project.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/log-sources/{sourceId}',
  tags: [TAG],
  summary: 'Delete a log source and its token',
  request: { params: sourceParams },
  responses: {
    204: { description: 'Deleted.' },
    403: errorResponse('Insufficient role.'),
    404: errorResponse('Project or source not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/log-sources/{sourceId}/rotate',
  tags: [TAG],
  summary: 'Rotate a log source’s ingest token',
  description:
    'Mints a fresh token (invalidating the previous one) and re-activates a revoked source. The new plaintext token is returned exactly once. Requires Admin and project access.',
  request: { params: sourceParams },
  responses: {
    200: {
      description: 'Rotated; new token revealed once.',
      content: jsonContent(LogSourceWithTokenComponent),
    },
    403: errorResponse('Insufficient role.'),
    404: errorResponse('Project or source not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/log-sources/{sourceId}/revoke',
  tags: [TAG],
  summary: 'Revoke a log source’s ingest token',
  description:
    'Write-disables the source: its token can no longer ingest. The row is kept for audit. Idempotent. Requires Admin and project access.',
  request: { params: sourceParams },
  responses: {
    200: { description: 'Revoked source.', content: jsonContent(LogSourceComponent) },
    403: errorResponse('Insufficient role.'),
    404: errorResponse('Project or source not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/log-sources/{sourceId}/audit',
  tags: [TAG],
  summary: 'List a log source’s lifecycle audit',
  description:
    'Returns create/update/rotate/revoke/delete events for the source, newest-first, attributed to the acting user. Requires Admin and project access.',
  request: { params: sourceParams },
  responses: {
    200: { description: 'Audit entries.', content: jsonContent(LogSourceAuditListComponent) },
    403: errorResponse('Insufficient role.'),
    404: errorResponse('Project or source not found.'),
  },
});
