/**
 * Zod schemas + OpenAPI registrations for the per-user MCP server registry.
 *
 * Endpoints scope to `req.authUserId` — a user only sees their own
 * servers. Sensitive fields (env, headers) are masked on read.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'McpServersErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for MCP server routes.' }),
);

const McpTransport = z.enum(['stdio', 'http']);

export const McpServerComponent = registerComponent(
  'McpServer',
  z
    .object({
      id: z.string(),
      userId: z.string(),
      name: z.string(),
      catalogId: z.string().nullable(),
      transport: McpTransport,
      command: z.string(),
      args: z.array(z.string()),
      url: z.string(),
      env: z.record(z.string(), z.string()),
      headers: z.record(z.string(), z.string()),
      enabled: z.boolean(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
    })
    .passthrough()
    .openapi({
      description:
        'A single MCP server registry row. Sensitive `env` / `headers` values are masked on list reads.',
    }),
);

export const McpCatalogEntryComponent = registerComponent(
  'McpCatalogEntry',
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      transport: McpTransport,
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
    })
    .passthrough()
    .openapi({ description: 'Well-known MCP catalog template.' }),
);

export const CreateMcpServerRequestSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
    transport: McpTransport.openapi({ description: 'stdio (subprocess) or http (remote URL).' }),
    catalogId: z.string().nullable().optional(),
    command: z.string().optional(),
    url: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.transport === 'stdio' && !val.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['command'],
        message: 'stdio transport requires a command',
      });
    }
    if (val.transport === 'http' && !val.url?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'http transport requires a url',
      });
    }
  });

export const UpdateMcpServerRequestSchema = z.object({
  name: z.string().optional(),
  catalogId: z.string().nullable().optional(),
  transport: McpTransport.optional(),
  command: z.string().optional(),
  url: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

const idParams = z.object({ id: z.string().openapi({ description: 'MCP server id.' }) });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/mcp-catalog',
  tags: ['MCP Servers'],
  summary: 'Read the well-known MCP catalog templates',
  responses: {
    200: {
      description: 'Catalog entries.',
      content: jsonContent(z.object({ entries: z.array(McpCatalogEntryComponent) })),
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/mcp-servers',
  tags: ['MCP Servers'],
  summary: "List the calling user's MCP servers (masked)",
  responses: {
    200: {
      description: 'Masked MCP server rows.',
      content: jsonContent(z.object({ servers: z.array(McpServerComponent) })),
    },
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/mcp-servers',
  tags: ['MCP Servers'],
  summary: 'Create an MCP server entry',
  request: { body: { content: jsonContent(CreateMcpServerRequestSchema) } },
  responses: {
    201: {
      description: 'Created server (with secrets — only returned at creation).',
      content: jsonContent(z.object({ server: McpServerComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/mcp-servers/{id}',
  tags: ['MCP Servers'],
  summary: 'Update an MCP server entry (partial)',
  request: {
    params: idParams,
    body: { content: jsonContent(UpdateMcpServerRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated server.',
      content: jsonContent(z.object({ server: McpServerComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('MCP server not found (or not owned by caller).'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/mcp-servers/{id}',
  tags: ['MCP Servers'],
  summary: 'Delete an MCP server entry',
  request: { params: idParams },
  responses: {
    200: {
      description: 'Deleted.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
    401: errorResponse('Authentication required.'),
    404: errorResponse('MCP server not found (or not owned by caller).'),
  },
});
