/**
 * Zod schemas + OpenAPI registrations for `server/routes/me-sessions.ts`:
 * the caller's recent sessions across every agent, and replying to one.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { IdempotencyKeyHeaders } from './sessions.openapi.js';

export const MAX_RECENT_SESSIONS = 50;
export const MAX_RECENT_MESSAGES = 10;
export const MAX_REPLY_LENGTH = 50_000;

const ErrorResponse = registerComponent(
  'MeSessionsErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for /api/me/sessions.' }),
);

export const RecentSessionsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_RECENT_SESSIONS)
    .default(20)
    .openapi({
      description: `How many sessions to return, newest activity first (1-${MAX_RECENT_SESSIONS}, default 20).`,
    }),
  messages: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_RECENT_MESSAGES)
    .default(0)
    .openapi({
      description: `Also return each session's last N user/assistant messages (0-${MAX_RECENT_MESSAGES}, default 0).`,
    }),
  maxChars: z.coerce.number().int().min(50).max(20_000).default(2000).openapi({
    description: 'Truncate each returned message body to this many characters (default 2000).',
  }),
});

const RecentMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.string(),
});

const RecentSession = registerComponent(
  'MeRecentSession',
  z
    .object({
      id: z.string(),
      name: z.string(),
      agentId: z.string(),
      agentName: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      state: z.string().openapi({
        description: 'Resolved session lifecycle state (working, needs_input, idle, pushed, ...).',
      }),
      updatedAt: z.string(),
      lastReply: z
        .string()
        .nullable()
        .openapi({ description: 'Latest assistant message, truncated to maxChars.' }),
      messages: z.array(RecentMessage),
    })
    .openapi({ description: 'One of the caller’s sessions with its status and latest reply.' }),
);

export const RecentSessionsResponseSchema = z.object({ sessions: z.array(RecentSession) });

export const SessionReplyRequestSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'content is required')
    .max(MAX_REPLY_LENGTH, `content exceeds ${MAX_REPLY_LENGTH} characters`),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/me/sessions/recent',
  tags: ['Sessions'],
  summary: "List the caller's most recently active sessions across all agents",
  description:
    'Sessions owned by the caller on projects they can view, newest activity first, with resolved state and the latest assistant reply. Archived, hidden, SideBar and cron sessions are left out.',
  request: { query: RecentSessionsQuerySchema },
  responses: {
    200: { description: 'Recent sessions.', content: jsonContent(RecentSessionsResponseSchema) },
    400: errorResponse('Invalid query.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/sessions/{sessionId}/reply',
  tags: ['Sessions'],
  summary: 'Send a message to one of your sessions',
  description:
    'Runs `content` as the next user turn, exactly as if typed in the chat box. When the session is busy the message is queued and runs when the current turn ends. Responds 202 only once the message is stored (immediately or in the queue).',
  request: {
    params: z.object({ sessionId: z.string() }),
    headers: IdempotencyKeyHeaders,
    body: { content: jsonContent(SessionReplyRequestSchema) },
  },
  responses: {
    202: {
      description:
        'Accepted; `queued` is true when it waits behind a running turn. A reused Idempotency-Key returns `Idempotent-Replayed: true` and does not send again.',
      content: jsonContent(z.object({ sessionId: z.string(), queued: z.boolean() })),
    },
    400: errorResponse('Validation failed, or a malformed Idempotency-Key.'),
    404: errorResponse('Session not found, not yours, or its agent no longer exists.'),
    422: errorResponse('The Idempotency-Key was already used with a different message.'),
    503: errorResponse(
      'Not accepted, so nothing was stored: the chat handler is unavailable or declined the message, or an earlier attempt with this Idempotency-Key is still in flight (see Retry-After). Safe to retry with the same key.',
    ),
  },
});
