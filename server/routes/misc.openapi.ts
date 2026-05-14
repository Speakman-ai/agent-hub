/**
 * Zod schemas + OpenAPI registrations for the "misc" route group:
 * health, server logs, file browse, device tokens, usage stats.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { PUSH_EVENT_TYPES } from '../push.js';

const ErrorResponse = registerComponent(
  'MiscErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for misc routes.' }),
);

export const HealthResponseComponent = registerComponent(
  'HealthResponse',
  z
    .object({
      status: z.literal('ok'),
      version: z.string(),
      gitHash: z.string(),
      uptime: z.number(),
      projects: z.number().int(),
      agents: z.number().int(),
      authRequired: z.boolean(),
      apiKeyAuthEnabled: z.boolean(),
      jwtAuthEnabled: z.boolean(),
    })
    .openapi({ description: 'Liveness + runtime info for the server.' }),
);

const ServerLogEntry = z
  .object({
    ts: z.string().optional(),
    level: z.string().optional(),
    msg: z.string().optional(),
  })
  .passthrough();

const DirectoryEntry = z.object({
  name: z.string(),
  type: z.literal('directory'),
  path: z.string(),
});

export const BrowseResponseComponent = registerComponent(
  'BrowseResponse',
  z
    .object({
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(DirectoryEntry),
    })
    .openapi({
      description:
        'Directory listing under $HOME (the only allowed root). Hidden entries sorted last.',
    }),
);

export const RegisterDeviceRequestSchema = z.object({
  token: z.string().min(1, 'token is required'),
  platform: z.string().optional(),
});

const PushEventEnum = z.enum([...PUSH_EVENT_TYPES] as [string, ...string[]]);

export const DeviceTokenResponseComponent = registerComponent(
  'DeviceTokenResponse',
  z
    .object({
      token: z.string(),
      platform: z.string(),
      enabledEvents: z.array(z.string()).nullable(),
      supportedEvents: z.array(z.string()),
    })
    .openapi({ description: 'Push-token preferences and supported event list.' }),
);

export const UpdateDevicePreferencesRequestSchema = z.object({
  enabledEvents: z.array(PushEventEnum).nullable().optional(),
});

const UsageTotalsRow = z
  .object({
    sessions: z.number().int().optional(),
    messages: z.number().int().optional(),
    tokens: z.number().int().optional(),
    cost_usd: z.number().optional(),
  })
  .passthrough();

const UsageByAgentRow = z
  .object({
    agent_id: z.string(),
    agent_name: z.string(),
    agent_color: z.string(),
  })
  .passthrough();

const UsageByDayRow = z.object({ day: z.string() }).passthrough();

const RecentSessionRow = z
  .object({
    agent_id: z.string(),
    agent_name: z.string(),
    agent_color: z.string(),
  })
  .passthrough();

export const UsageResponseComponent = registerComponent(
  'UsageResponse',
  z
    .object({
      totals: UsageTotalsRow,
      byAgent: z.array(UsageByAgentRow),
      byDay: z.array(UsageByDayRow),
      recentSessions: z.array(RecentSessionRow),
    })
    .openapi({
      description:
        'Aggregated usage rollup. Cost de-dup of the Claude CLI cumulative `total_cost_usd` happens in `usage-aggregation.ts`.',
    }),
);

const tokenParams = z.object({ token: z.string() });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/health',
  tags: ['Health'],
  summary: 'Liveness + runtime info',
  responses: {
    200: { description: 'Health payload.', content: jsonContent(HealthResponseComponent) },
  },
});

registerPath({
  method: 'get',
  path: '/api/server-logs',
  tags: ['Health'],
  summary: 'Tail of the in-memory server log buffer',
  responses: {
    200: { description: 'Recent log entries.', content: jsonContent(z.array(ServerLogEntry)) },
  },
});

registerPath({
  method: 'get',
  path: '/api/browse',
  tags: ['Misc'],
  summary: 'Directory browser scoped to $HOME',
  description:
    'Lists immediate subdirectories of `path` (default $HOME). Refuses any path outside $HOME with 403; refuses non-directories with 400.',
  request: {
    query: z.object({
      path: z
        .string()
        .optional()
        .openapi({ description: 'Directory under $HOME. `~` and `~/foo` expand.' }),
    }),
  },
  responses: {
    200: { description: 'Directory listing.', content: jsonContent(BrowseResponseComponent) },
    400: errorResponse('Path is not a directory.'),
    403: errorResponse('Path escapes $HOME.'),
    404: errorResponse('Path does not exist.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/devices',
  tags: ['Devices'],
  summary: 'Register an APNs / FCM push token',
  request: { body: { content: jsonContent(RegisterDeviceRequestSchema) } },
  responses: {
    200: { description: 'Registered.', content: jsonContent(z.object({ ok: z.boolean() })) },
    400: errorResponse('token is required.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/devices/{token}',
  tags: ['Devices'],
  summary: 'Remove a push token',
  request: { params: tokenParams },
  responses: {
    200: { description: 'Removed.', content: jsonContent(z.object({ ok: z.boolean() })) },
  },
});

registerPath({
  method: 'get',
  path: '/api/devices/{token}',
  tags: ['Devices'],
  summary: "Read a push token's preferences + supported events",
  request: { params: tokenParams },
  responses: {
    200: { description: 'Token row.', content: jsonContent(DeviceTokenResponseComponent) },
    404: errorResponse('Token not registered.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/devices/{token}/preferences',
  tags: ['Devices'],
  summary: 'Update per-event push preferences',
  description:
    '`enabledEvents: null` clears the preference (legacy "all events" behaviour). Unknown event names are stripped server-side.',
  request: {
    params: tokenParams,
    body: { content: jsonContent(UpdateDevicePreferencesRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated.',
      content: jsonContent(
        z.object({ ok: z.boolean(), enabledEvents: z.array(z.string()).nullable() }),
      ),
    },
    400: errorResponse('enabledEvents must be an array or null.'),
    404: errorResponse('Token not registered.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/usage',
  tags: ['Usage'],
  summary: 'Aggregated usage stats (totals, per-agent, per-day, recent sessions)',
  responses: {
    200: { description: 'Usage payload.', content: jsonContent(UsageResponseComponent) },
    500: errorResponse('Aggregation query failed.'),
  },
});
