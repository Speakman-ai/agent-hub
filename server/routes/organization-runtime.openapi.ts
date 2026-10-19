import { z, registerPath } from '../openapi/registry.js';
import { SessionComponent } from './sessions.openapi.js';
import { OrganizationParams } from './organizations.openapi.js';

export const OrganizationAgentParams = OrganizationParams.extend({
  agentId: z.string().min(1).max(200),
});
export const OrganizationSessionBody = z
  .object({ name: z.string().trim().min(1).max(200).optional() })
  .strict();
const OrganizationTool = z.enum([
  'projects:read',
  'dispatch',
  'artifacts',
  'credentials',
  'skills',
  'web',
  'browser',
  'computer',
  'approvals',
]);
const ProjectScope = z.union([
  z.literal('all-linked'),
  z.array(z.string().min(1).max(200)).max(500),
]);
const AgentConfigFields = {
  name: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().max(32000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  tools: z
    .array(OrganizationTool)
    .max(OrganizationTool.options.length * 2)
    .optional(),
  projects: ProjectScope.optional().openapi({
    description:
      "'all-linked' or an explicit subset (empty allowed). Explicit IDs must be linked and visible to the caller. Effective scope is always intersected with each session owner's current access.",
  }),
  computerToolEnabled: z.boolean().optional().openapi({
    description: 'Computer preference; requires the computer tool. Never provisions a desktop.',
  }),
  enabled: z.boolean().optional(),
};
export const OrganizationAgentPatch = z
  .object({ ...AgentConfigFields, archived: z.boolean().optional() })
  .strict();
export const OrganizationAgentCreate = z
  .object({
    ...AgentConfigFields,
    engine: z.string().trim().min(1).max(100).optional(),
    templateId: z.string().min(1).max(100).optional().openapi({
      description:
        'Optional starter template. Copies name and instructions only; grants no tools or projects.',
    }),
  })
  .strict();
export const OrganizationAgentTemplateSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  label: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
});
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
  organizationTemplate: z.object({ id: z.string(), version: z.number().int() }).optional(),
  isAssistant: z.boolean().optional(),
  effectiveProjectIds: z
    .array(z.string())
    .optional()
    .openapi({ description: 'Linked projects this agent can reach for the calling user now.' }),
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
  path: '/api/organizations/{organizationId}/agents',
  tags: ['Organizations'],
  summary: 'Create an organization agent from scratch or from an optional starter template',
  request: {
    params: OrganizationParams,
    body: { required: true, content: json(OrganizationAgentCreate) },
  },
  responses: {
    201: {
      description: 'New agent with a stable ID. Computer is off unless explicitly enabled.',
      content: json(z.object({ agent: OrganizationRuntimeAgent })),
    },
    ...errors,
  },
});
registerPath({
  method: 'get',
  path: '/api/organizations/{organizationId}/agents/{agentId}',
  tags: ['Organizations'],
  summary: 'Read one organization agent with its effective project scope for the caller',
  request: { params: OrganizationAgentParams },
  responses: {
    200: {
      description: 'Agent configuration. Members only see enabled, unarchived agents.',
      content: json(z.object({ agent: OrganizationRuntimeAgent })),
    },
    ...errors,
  },
});
registerPath({
  method: 'get',
  path: '/api/organizations/{organizationId}/agent-templates',
  tags: ['Organizations'],
  summary: 'List optional organization-agent starter templates',
  request: { params: OrganizationParams },
  responses: {
    200: {
      description: 'Versioned starter instructions. Templates carry no permissions.',
      content: json(z.object({ templates: z.array(OrganizationAgentTemplateSchema) })),
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
