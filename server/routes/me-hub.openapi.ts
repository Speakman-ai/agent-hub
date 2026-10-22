/**
 * OpenAPI for GET/POST /api/me/hub-session.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { SessionComponent } from './sessions.openapi.js';
import { SERVER_AGENT_LIMITS } from '../../shared/utils/hub.js';

const ErrorResponse = registerComponent(
  'MeHubErrorResponse',
  z
    .object({ error: z.string() })
    .openapi({ description: 'Error envelope for Hub session routes.' }),
);

const HubAgent = registerComponent(
  'HubAssistantAgent',
  z
    .object({
      id: z.string(),
      name: z.string(),
      role: z.string().optional(),
      engine: z.string(),
      model: z.string().optional(),
      projectId: z.string().optional(),
    })
    .passthrough()
    .openapi({ description: 'The hidden Hub assistant agent (not on a project roster).' }),
);

const HubSessionResponse = registerComponent(
  'MeHubSessionResponse',
  z
    .object({
      session: SessionComponent,
      agent: HubAgent,
    })
    .openapi({
      description: "The calling user's persistent Hub assistant session and its agent.",
    }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const hubSessionPath = (method: 'get' | 'post') => ({
  method,
  path: '/api/me/hub-session',
  tags: ['Hub'],
  summary: "Get or create the calling user's Hub assistant session",
  description:
    'Idempotent. Returns the existing Hub session for this user, or creates one ' +
    '(session_mode=hub, no worktree) on the hidden Hub assistant agent. Spawn ' +
    'credentials follow the session owner. The Hub project is omitted from GET /api/projects.',
  responses: {
    200: {
      description: 'Existing Hub session.',
      content: jsonContent(HubSessionResponse),
    },
    201: {
      description: 'Newly created Hub session.',
      content: jsonContent(HubSessionResponse),
    },
    401: errorResponse('Authentication required.'),
  },
});

registerPath(hubSessionPath('get'));
registerPath(hubSessionPath('post'));

const HubModelResponse = registerComponent(
  'MeHubModelResponse',
  z
    .object({
      engine: z.string(),
      model: z.string(),
    })
    .openapi({
      description: 'Engine and model for Hub chats, chat digests, and other Hub-level generation.',
    }),
);

registerPath({
  method: 'get',
  path: '/api/me/hub-model',
  tags: ['Hub'],
  summary: "Read the caller's Hub engine and model",
  description:
    "Resolved from the caller's per-user Hub assistant override, else the hidden Hub agent defaults. Chat digests and other Hub generation use this pick.",
  responses: {
    200: {
      description: 'Resolved Hub engine and model.',
      content: jsonContent(HubModelResponse),
    },
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/me/hub-model',
  tags: ['Hub'],
  summary: "Set the caller's Hub engine and model",
  description:
    "Persists a per-user override on the hidden Hub assistant and updates the caller's live Hub session. Chat digests use the same pick.",
  request: {
    body: {
      content: jsonContent(
        z.object({
          engine: z.string(),
          model: z.string(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: 'Saved Hub engine and model.',
      content: jsonContent(HubModelResponse),
    },
    400: errorResponse('Invalid engine or model.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/hub-session/clear',
  tags: ['Hub'],
  summary: 'Clear Hub assistant chat history',
  description:
    "Archives the current Hub chat and creates a fresh empty session with the caller's Hub engine/model. Message history is recoverable from the archived session for 24h.",
  responses: {
    200: {
      description: 'New empty Hub session.',
      content: jsonContent(HubSessionResponse),
    },
    401: errorResponse('Authentication required.'),
  },
});

const ServerAgentSkillRef = registerComponent(
  'MeServerAgentSkillRef',
  z
    .object({
      id: z.string().openapi({ description: 'Skill id.' }),
      projectId: z
        .string()
        .optional()
        .openapi({ description: 'Owning project; omit for a global or bundled skill.' }),
    })
    .openapi({ description: 'A skill added to the Server Agent.' }),
);

const ServerAgentSkillOption = registerComponent(
  'MeServerAgentSkillOption',
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    source: z.enum(['project', 'global', 'default']),
  }),
);

const ServerAgentSettings = registerComponent(
  'MeServerAgentSettings',
  z
    .object({
      name: z.string().openapi({ description: 'Custom name, or empty when using the default.' }),
      instructions: z
        .string()
        .openapi({ description: 'Extra instructions appended to the Server Agent prompt.' }),
      skills: z
        .array(ServerAgentSkillRef)
        .openapi({ description: 'Skills the caller added on top of the built-in set.' }),
      builtInSkills: z
        .array(z.string())
        .openapi({ description: 'Skill ids the Server Agent always loads.' }),
      defaultName: z.string(),
      effectiveName: z.string().openapi({ description: 'The name the agent uses right now.' }),
    })
    .openapi({ description: "The caller's Server Agent name, instructions and added skills." }),
);

registerPath({
  method: 'get',
  path: '/api/me/server-agent',
  tags: ['Hub'],
  summary: "Read the caller's Server Agent settings",
  description: 'Per-user name and instructions for the Server Agent (the Hub assistant).',
  responses: {
    200: { description: 'Server Agent settings.', content: jsonContent(ServerAgentSettings) },
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/me/server-agent',
  tags: ['Hub'],
  summary: "Update the caller's Server Agent settings",
  description:
    'Omitted fields keep their value; an empty string resets that field to the default. ' +
    'Takes effect on the next turn of the Server Agent session.',
  request: {
    body: {
      content: jsonContent(
        z.object({
          name: z.string().max(SERVER_AGENT_LIMITS.name).optional(),
          instructions: z.string().max(SERVER_AGENT_LIMITS.instructions).optional(),
          skills: z
            .array(ServerAgentSkillRef)
            .max(SERVER_AGENT_LIMITS.skills)
            .optional()
            .openapi({
              description:
                'Replaces the added skills. Each must exist, project skills must come from a ' +
                'project the caller can view, ids must be unique, and built-in skills are rejected.',
            }),
        }),
      ),
    },
  },
  responses: {
    200: { description: 'Saved settings.', content: jsonContent(ServerAgentSettings) },
    400: errorResponse('Invalid name, instructions or skills.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/me/server-agent/skill-options',
  tags: ['Hub'],
  summary: 'List skills the caller can add to their Server Agent',
  description:
    'Global and bundled skills, plus project skills grouped by project for every project the ' +
    'caller can view. Built-in Server Agent skills are listed separately and excluded from both.',
  responses: {
    200: {
      description: 'Skill options.',
      content: jsonContent(
        z.object({
          builtIn: z.array(z.string()),
          global: z.array(ServerAgentSkillOption),
          projects: z.array(
            z.object({
              projectId: z.string(),
              projectName: z.string(),
              skills: z.array(ServerAgentSkillOption),
            }),
          ),
        }),
      ),
    },
    401: errorResponse('Authentication required.'),
  },
});
