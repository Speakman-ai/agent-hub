/**
 * Zod schemas + OpenAPI registrations for the session-watchdog REST surface.
 *
 * Routes live in ./watchdog.ts; the state machine in ../session-watchdog.ts.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'WatchdogErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for watchdog routes.' }),
);

const WatchdogRowComponent = registerComponent(
  'WatchdogRow',
  z
    .object({
      session_id: z.string(),
      card_id: z.string().nullable(),
      pr_url: z.string().nullable(),
      awaiting_response: z.number().int(),
      last_token_at: z.number().int().nullable(),
      last_user_message_at: z.number().int().nullable(),
      nudge_count: z.number().int(),
      last_nudge_at: z.number().int().nullable(),
      budget_started_at: z.number().int().nullable(),
      state: z.string(),
      disabled_reason: z.string().nullable(),
      created_at: z.number().int(),
      updated_at: z.number().int(),
    })
    .openapi({ description: 'Current row from `session_watchdog`.' }),
);

const WatchdogEventComponent = registerComponent(
  'WatchdogEvent',
  z
    .object({
      id: z.number().int(),
      session_id: z.string(),
      tier: z.string(),
      reason: z.string().nullable(),
      created_at: z.number().int(),
    })
    .openapi({ description: 'Audit row from `watchdog_events`.' }),
);

const sessionIdParams = z.object({
  sessionId: z.string().openapi({ description: 'Session id.' }),
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
  path: '/api/sessions/{sessionId}/watchdog',
  tags: ['Watchdog'],
  summary: 'Read the current watchdog row + recent events for a session',
  description:
    'Returns the per-session watchdog row plus the 20 most-recent audit events. If no row exists yet, `exists` is false and `events` is empty.',
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Watchdog state.',
      content: jsonContent(
        z.union([
          z.object({
            session_id: z.string(),
            exists: z.literal(false),
            events: z.array(WatchdogEventComponent),
          }),
          z.object({
            exists: z.literal(true),
            row: WatchdogRowComponent,
            events: z.array(WatchdogEventComponent),
          }),
        ]),
      ),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/watchdog/nudge',
  tags: ['Watchdog'],
  summary: 'Force a watchdog tier dispatch immediately (default T2)',
  description:
    'Bypasses the idle/cooldown gates and dispatches the chosen tier now. Used by the UI "nudge" button and by ops tooling.',
  request: {
    params: sessionIdParams,
    body: {
      content: jsonContent(
        z.object({
          tier: z
            .enum(['T1', 'T2', 'T3', 'T4'])
            .optional()
            .openapi({ description: 'Which tier to force. Defaults to T2.' }),
        }),
      ),
    },
  },
  responses: {
    202: {
      description: 'Dispatched.',
      content: jsonContent(
        z.object({ ok: z.literal(true), tier: z.enum(['T1', 'T2', 'T3', 'T4']) }),
      ),
    },
    400: errorResponse('Invalid tier value.'),
    409: errorResponse('Dispatch refused (watchdog disabled, session unknown, etc.).'),
  },
});
