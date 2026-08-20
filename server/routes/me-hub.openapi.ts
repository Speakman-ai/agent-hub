/**
 * OpenAPI for GET/POST /api/me/hub-session.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { SessionComponent } from './sessions.openapi.js';

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
      description: 'Engine and model for Hub chats, Daily Summary, and other Hub-level generation.',
    }),
);

registerPath({
  method: 'get',
  path: '/api/me/hub-model',
  tags: ['Hub'],
  summary: "Read the caller's Hub engine and model",
  description:
    "Resolved from the caller's per-user Hub assistant override, else the hidden Hub agent defaults. Daily Summary and other Hub generation use this pick.",
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
    "Persists a per-user override on the hidden Hub assistant and updates the caller's live Hub session. Daily Summary generation uses the same pick.",
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
