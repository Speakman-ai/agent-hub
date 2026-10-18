import { z, registerComponent, registerPath } from '../openapi/registry.js';

const connectionFields = {
  id: z.string(),
  name: z.string(),
  mode: z.enum(['local', 'remote']),
  color: z.string(),
  position: z.number(),
};
const LegacyConnection = registerComponent(
  'LegacyOrgConnection',
  z.object({
    ...connectionFields,
    remote_url: z.string(),
    api_key: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);
const ServerConnection = registerComponent(
  'ServerConnection',
  z.object({
    ...connectionFields,
    remoteUrl: z.string(),
    apiKey: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
const writeFields = {
  name: z.string().min(1),
  mode: z.enum(['local', 'remote']).optional(),
  color: z.string().optional(),
  remoteUrl: z.string().optional(),
  apiKey: z.string().optional(),
};
export const CreateServerRequestSchema = z.object({
  id: z.string().min(1).optional(),
  ...writeFields,
});
export const UpdateServerRequestSchema = z.object({
  ...writeFields,
  name: z.string().optional(),
  position: z.number().optional(),
});
export const SwitchServerRequestSchema = z.object({ serverId: z.string().min(1) });
const params = z.object({ id: z.string() });
const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
const errors = {
  400: {
    description: 'Invalid request or the last connection cannot be deleted.',
    content: json(z.object({ error: z.string() })),
  },
  401: { description: 'Authentication required.', content: json(z.object({ error: z.string() })) },
  403: {
    description: 'Insufficient role or target server membership.',
    content: json(z.object({ error: z.string() })),
  },
  404: { description: 'Connection not found.', content: json(z.object({ error: z.string() })) },
};

// Both vocabularies describe the SAME connection service. /api/organizations
// is reserved for future business groupings, never for these partitions.
for (const server of [false, true]) {
  const base = server ? '/api/servers' : '/api/orgs';
  const tags = [server ? 'Servers' : 'Legacy Server Connections'];
  const record = server ? ServerConnection : LegacyConnection;
  const context = server ? { serverId: z.string() } : { orgId: z.string() };
  const switchResponse = z.object({
    ok: z.boolean(),
    ...context,
    projects: z.number(),
    agents: z.number(),
  });
  const description =
    'Existing Server connection/data partition. Preserves legacy IDs, membership roles, JWT context and storage. Does not create or move business organizations or projects.';
  registerPath({
    method: 'get',
    path: base,
    tags,
    description,
    summary: 'List saved Server connections',
    responses: {
      200: { description: 'Connections in saved order.', content: json(z.array(record)) },
      ...errors,
    },
  });
  registerPath({
    method: 'get',
    path: `${base}/{id}`,
    tags,
    description,
    summary: 'Get a Server connection',
    request: { params },
    responses: { 200: { description: 'Saved connection.', content: json(record) }, ...errors },
  });
  registerPath({
    method: 'post',
    path: base,
    tags,
    description,
    summary: 'Create a Server connection (Owner)',
    request: {
      body: {
        required: true,
        content: json(
          server
            ? CreateServerRequestSchema
            : CreateServerRequestSchema.extend({ mode: z.string().optional() }),
        ),
      },
    },
    responses: {
      201: {
        description: 'Created connection; creator receives Owner membership.',
        content: json(record),
      },
      ...errors,
    },
  });
  registerPath({
    method: 'put',
    path: `${base}/{id}`,
    tags,
    description,
    summary: 'Update a Server connection',
    request: {
      params,
      body: {
        required: true,
        content: json(
          server
            ? UpdateServerRequestSchema
            : UpdateServerRequestSchema.extend({ mode: z.string().optional() }),
        ),
      },
    },
    responses: {
      200: { description: 'Updated connection with stable ID.', content: json(record) },
      ...errors,
    },
  });
  registerPath({
    method: 'delete',
    path: `${base}/{id}`,
    tags,
    description,
    summary: 'Delete a Server connection (target Owner)',
    request: { params },
    responses: {
      200: {
        description: 'Connection removed; data directory retained.',
        content: json(z.object({ ok: z.boolean() })),
      },
      ...errors,
    },
  });
  registerPath({
    method: 'get',
    path: `${base}/{id}/members`,
    tags,
    description,
    summary: 'List Server members (target Admin or Owner)',
    request: { params },
    responses: {
      200: {
        description: 'Existing Server memberships.',
        content: json(
          z.object({
            ...context,
            members: z.array(
              z.object({
                id: z.string(),
                username: z.string(),
                role: z.enum(['Owner', 'Admin', 'User']),
                createdAt: z.string(),
              }),
            ),
          }),
        ),
      },
      ...errors,
    },
  });
  registerPath({
    method: 'post',
    path: `${base}/{id}/switch`,
    tags,
    description,
    summary: 'Activate an existing Server partition (target member)',
    request: { params },
    responses: {
      200: {
        description:
          'Active partition; repeated switches are a no-op. Keeps the legacy org_switched event.',
        content: json(switchResponse),
      },
      ...errors,
      500: {
        description: 'Partition initialization failed.',
        content: json(z.object({ error: z.string() })),
      },
    },
  });
  registerPath({
    method: 'post',
    path: server ? '/api/server/switch' : '/api/org/switch',
    tags,
    description,
    summary: 'Activate a Server partition using a body ID',
    request: {
      body: {
        required: true,
        content: json(server ? SwitchServerRequestSchema : z.object({ orgId: z.string().min(1) })),
      },
    },
    responses: {
      200: { description: 'Active partition.', content: json(switchResponse) },
      ...errors,
      500: {
        description: 'Partition initialization failed.',
        content: json(z.object({ error: z.string() })),
      },
    },
  });
}
