import { z, registerPath } from '../openapi/registry.js';
import { SessionComponent } from './sessions.openapi.js';
import { OrganizationParams } from './organizations.openapi.js';

export const OrganizationAgentParams = OrganizationParams.extend({
  agentId: z.string().min(1).max(200),
});
export const OrganizationSessionBody = z
  .object({ name: z.string().trim().min(1).max(200).optional() })
  .strict();
export const OrganizationAgentPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    systemPrompt: z.string().max(32000).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export const OrganizationRuntimeAgent = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.string(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  computerToolEnabled: z.boolean().optional(),
  organizationScope: z.object({
    enabled: z.boolean(),
    archivedAt: z.string().nullable().optional(),
    projects: z.union([z.literal('all-linked'), z.array(z.string())]),
    tools: z.array(z.string()),
  }),
});
export const OrganizationMemoryBody = z
  .object({
    projectId: z.string().min(1).max(200),
    sourceRecord: z.string().min(1).max(500),
    content: z.string().trim().min(1).max(2000),
  })
  .strict();
const Memory = OrganizationMemoryBody.extend({
  id: z.string(),
  serverId: z.string(),
  organizationId: z.string(),
  timestamp: z.string(),
});
const json = (schema: z.ZodType) => ({ 'application/json': { schema } });
const errors = {
  400: { description: 'Invalid request.' },
  401: { description: 'User identity required.' },
  403: { description: 'Organization administrator required.' },
  404: { description: 'Organization agent or session unavailable.' },
};
registerPath({
  method: 'get',
  path: '/api/organizations/{organizationId}/agents',
  tags: ['Organizations'],
  summary: 'List organization agents, including disabled and archived entries for administrators',
  request: { params: OrganizationParams },
  responses: {
    200: {
      description: 'Organization roster; an empty roster is valid.',
      content: json(z.object({ agents: z.array(OrganizationRuntimeAgent) })),
    },
    ...errors,
  },
});
registerPath({
  method: 'patch',
  path: '/api/organizations/{organizationId}/agents/{agentId}',
  tags: ['Organizations'],
  summary: 'Edit, disable or archive an existing organization agent without replacing its identity',
  request: {
    params: OrganizationAgentParams,
    body: { required: true, content: json(OrganizationAgentPatch) },
  },
  responses: {
    200: {
      description: 'Updated agent; history retained.',
      content: json(z.object({ agent: OrganizationRuntimeAgent })),
    },
    ...errors,
  },
});
registerPath({
  method: 'post',
  path: '/api/organizations/{organizationId}/agents/{agentId}/sessions',
  tags: ['Organizations'],
  summary: 'Start a private organization workflow chat using the initiating user identity',
  request: {
    params: OrganizationAgentParams,
    body: { required: true, content: json(OrganizationSessionBody) },
  },
  responses: {
    201: {
      description: 'New user-owned session; no Git workspace or background job.',
      content: json(z.object({ session: SessionComponent, agent: OrganizationRuntimeAgent })),
    },
    ...errors,
  },
});
function memoryPath(method: 'get' | 'post') {
  return {
    method,
    path: '/api/sessions/{sessionId}/organization-memory',
    tags: ['Organizations'],
    summary:
      method === 'get'
        ? 'Read authorized private organization memory'
        : 'Save private organization memory with project provenance',
    request: {
      params: z.object({ sessionId: z.string().min(1) }),
      ...(method === 'post'
        ? { body: { required: true, content: json(OrganizationMemoryBody) } }
        : {}),
    },
    responses: {
      [method === 'post' ? 201 : 200]: {
        description: 'Scoped to the session owner, organization and current project/tool access.',
        content: json(
          method === 'post'
            ? z.object({ memory: Memory })
            : z.object({ memories: z.array(Memory) }),
        ),
      },
      ...errors,
    },
  };
}
registerPath(memoryPath('get'));
registerPath(memoryPath('post'));
