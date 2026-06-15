/**
 * Zod schemas + OpenAPI registrations for the per-project RUM ingest-client
 * management routes (server/routes/rum-clients.ts).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = registerComponent(
  'RumClientErrorResponse',
  z.object({ error: z.string() }).openapi({
    description: 'Error envelope for RUM ingest-client routes.',
  }),
);

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const ClientIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
  clientId: z.string().openapi({ description: 'RUM client id.' }),
});

const RumClient = registerComponent(
  'RumClient',
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      name: z.string(),
      prefix: z.string().openapi({ description: 'First 12 chars of the token (e.g. `rum_xxxx`).' }),
      createdAt: z.string(),
      createdBy: z.string().nullable(),
      lastUsedAt: z.string().nullable(),
      revokedAt: z.string().nullable(),
    })
    .openapi({ description: 'Public metadata for a RUM ingest client. Never includes the token.' }),
);

const MintedRumClient = registerComponent(
  'MintedRumClient',
  RumClient.extend({
    token: z.string().openapi({
      description:
        'The plaintext `rum_`-prefixed token. Returned ONCE at mint; never retrievable again.',
    }),
  }).openapi({ description: 'A freshly minted RUM ingest client including its one-time token.' }),
);

const RumClientList = registerComponent(
  'RumClientListResponse',
  z
    .object({
      projectId: z.string(),
      clients: z.array(RumClient),
    })
    .openapi({ description: 'A project’s active (non-revoked) RUM ingest clients.' }),
);

const MintRumClientBody = z.object({
  name: z.string().min(1).max(100).openapi({ description: 'Human label for the ingest client.' }),
});

const RevokeRumClientResponse = registerComponent(
  'RevokeRumClientResponse',
  z.object({ revoked: z.literal(true) }).openapi({ description: 'RUM client revoked.' }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/rum/clients',
  tags: ['RUM'],
  summary: 'Mint a per-project RUM ingest token',
  description:
    'Admin+. Mints a new `rum_`-prefixed ingest credential for the project. The plaintext token is returned ONCE in the `token` field and is never retrievable again. Vendor sites send it as the `X-RUM-Token` header on `POST /api/replays` to attribute a capture to this project.',
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(MintRumClientBody) },
  },
  responses: {
    201: { description: 'Token minted.', content: jsonContent(MintedRumClient) },
    400: errorResponse('Invalid name.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/rum/clients',
  tags: ['RUM'],
  summary: 'List a project’s RUM ingest clients',
  description:
    'Admin+. Lists active (non-revoked) ingest clients for the project. Returns metadata only — never the token or its hash.',
  request: { params: ProjectIdParam },
  responses: {
    200: { description: 'Active clients.', content: jsonContent(RumClientList) },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/rum/clients/{clientId}',
  tags: ['RUM'],
  summary: 'Revoke a RUM ingest client',
  description:
    'Admin+. Revokes (soft-deletes) an ingest client. Uploads bearing that token are rejected afterward. Scoped to the project — a clientId from another project resolves to 404.',
  request: { params: ClientIdParam },
  responses: {
    200: { description: 'Revoked.', content: jsonContent(RevokeRumClientResponse) },
    404: errorResponse('Project or client not found.'),
  },
});
