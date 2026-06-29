/**
 * Zod schemas + OpenAPI registrations for the heartbeats route group.
 *
 * This module is imported for two reasons:
 *
 *   1. `server/routes/heartbeats.ts` imports the exported request schemas
 *      and uses `safeParse(...)` to validate incoming bodies. The handlers
 *      keep their downstream logic (heartbeat scheduling, agent lookup,
 *      thread retrieval, …) — only the hand-rolled body destructuring is
 *      replaced with Zod.
 *
 *   2. `server/openapi/generate.ts` walks `server/routes/*.ts` and
 *      imports every module to trigger the side-effect `registerPath` /
 *      `registerComponent` calls below. The heartbeats section of the
 *      generated `docs/api/openapi.yaml` comes out of this file.
 *
 * Design notes:
 *
 * - **Cron-expression validation lives in the schema.** A custom Zod
 *   refinement runs `cron.validate(...)` from `node-cron` on the
 *   `interval` field so an invalid expression returns 400 from the
 *   generic `parseBody` chokepoint instead of bubbling out of the
 *   scheduler later. The pre-Zod handler accepted any string and only
 *   detected garbage at reschedule time.
 *
 * - **Empty `interval` is allowed.** The legacy handler treated an
 *   omitted/empty interval as "preserve" / "no schedule" — disabling a
 *   heartbeat without setting one is valid. The schema therefore allows
 *   either an empty string OR a valid cron expression.
 *
 * - **`model` is `string | null | undefined`.** `undefined` (omitted) =
 *   preserve; `null` or `''` = clear the override; any other string =
 *   set. Zod can't validate against the engine allowlist without the
 *   request-time config, so cross-field model validation stays in the
 *   handler.
 *
 * - **Unknown keys are passed through** — the pre-Zod PUT handler only
 *   destructured 4 keys and ignored the rest, so we mirror that by
 *   leaving the schema open (no `.strict()`).
 */

import cron from 'node-cron';
import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Custom refinements ──────────────────────────────────────────

/**
 * A cron expression accepted by `node-cron`. Empty string (or omitted) is
 * also valid — that means "no schedule" and is how a heartbeat is
 * created/updated without an active interval.
 */
const cronExpression = (fieldName: string) =>
  z.string().refine((s) => s === '' || cron.validate(s), {
    message: `${fieldName} must be a valid cron expression`,
  });

// ─── Domain component schemas (response shapes) ──────────────────

export const HeartbeatConfigComponent = registerComponent(
  'HeartbeatConfig',
  z
    .object({
      enabled: z.boolean(),
      interval: z.string(),
      prompt: z.string(),
      model: z.string().optional(),
      owner_user_id: z.string().nullable().optional(),
      shared: z.union([z.boolean(), z.number().int()]).optional(),
    })
    .openapi({
      description:
        'Per-agent heartbeat configuration. `interval` is a cron expression (empty = no schedule); `model` overrides the engine default at run time.',
    }),
);

export const HeartbeatLogComponent = registerComponent(
  'HeartbeatLog',
  z
    .object({
      id: z.number().int(),
      agent_id: z.string(),
      timestamp: z.string(),
      prompt: z.string(),
      result: z.string().nullable(),
      status: z.enum(['pending', 'running', 'success', 'error']),
    })
    .openapi({ description: 'A single heartbeat run row.' }),
);

export const HeartbeatStateComponent = registerComponent(
  'HeartbeatState',
  z
    .object({
      agent_id: z.string(),
      enabled: z.number().int(),
      interval: z.string().nullable(),
      next_run_at: z.string().nullable(),
      last_run_at: z.string().nullable(),
    })
    .passthrough()
    .openapi({ description: 'Heartbeat scheduler state row.' }),
);

export const HeartbeatOverviewComponent = registerComponent(
  'HeartbeatOverview',
  z
    .object({
      agentId: z.string(),
      projectId: z.string().optional(),
      agentName: z.string(),
      color: z.string().optional(),
      heartbeat: HeartbeatConfigComponent,
      latestLog: HeartbeatLogComponent.nullable(),
      state: HeartbeatStateComponent.nullable(),
      owner_user_id: z.string().nullable(),
      owner_username: z.string().nullable(),
      shared: z.number().int(),
      can_manage: z.boolean(),
    })
    .openapi({ description: 'Per-agent heartbeat overview returned by GET /api/heartbeats.' }),
);

export const HeartbeatStateInfoComponent = registerComponent(
  'HeartbeatStateInfo',
  z
    .object({
      agentId: z.string(),
      agentName: z.string(),
      enabled: z.boolean(),
      interval: z.string().nullable(),
      next_run_at: z.string().nullable(),
      last_run_at: z.string().nullable(),
      overdue: z.boolean(),
      overdue_seconds: z.number().int(),
    })
    .openapi({
      description:
        'Live heartbeat state with overdue calculation, returned by GET /api/heartbeats/state.',
    }),
);

export const HeartbeatThreadComponent = registerComponent(
  'HeartbeatThreadResponse',
  z
    .object({
      thread: z.unknown().nullable(),
      entries: z.array(z.unknown()),
    })
    .openapi({
      description:
        'Heartbeat thread (persistent output log) for one agent. `thread` is null when no run has produced one yet.',
    }),
);

export const HeartbeatRunResponseComponent = registerComponent(
  'HeartbeatRunResponse',
  z
    .object({
      logId: z.union([z.number().int(), z.string()]),
      status: z.literal('running'),
    })
    .openapi({ description: 'Acknowledgment from POST /api/heartbeats/:agentId/run.' }),
);

export const HeartbeatErrorResponseComponent = registerComponent(
  'HeartbeatErrorResponse',
  z
    .object({
      error: z.string(),
      details: z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          }),
        )
        .optional(),
    })
    .openapi({
      description:
        'Error envelope. `details` is populated for 400 schema-validation errors with one entry per failing Zod issue.',
    }),
);

// ─── Request schemas ──────────────────────────────────────────────

/**
 * PUT /api/heartbeats/:agentId — partial update.
 *
 * - `enabled` toggles the schedule.
 * - `interval` is a cron expression OR empty string.
 * - `prompt` replaces the heartbeat prompt.
 * - `model` is `string | null` — empty/null clears the per-heartbeat model
 *   override and falls back to the engine default at run time.
 */
export const UpdateHeartbeatRequestSchema = z.object({
  enabled: z.boolean().optional(),
  interval: cronExpression('interval').optional(),
  prompt: z.string().optional(),
  model: z.string().nullable().optional(),
  shared: z
    .union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')])
    .optional(),
});

// ─── OpenAPI path registrations ───────────────────────────────────

const agentIdParams = z.object({
  agentId: z.string().openapi({ description: 'Agent ID.' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(HeartbeatErrorResponseComponent),
});

// GET /api/heartbeats
registerPath({
  method: 'get',
  path: '/api/heartbeats',
  tags: ['Heartbeats'],
  summary: 'List heartbeat overview for every agent',
  responses: {
    200: {
      description: 'Array of per-agent heartbeat overviews.',
      content: jsonContent(z.array(HeartbeatOverviewComponent)),
    },
  },
});

// GET /api/heartbeats/state
registerPath({
  method: 'get',
  path: '/api/heartbeats/state',
  tags: ['Heartbeats'],
  summary: 'Live heartbeat state with overdue calculation',
  description:
    'Filters out agents with no heartbeat configured. `overdue` flips true once `next_run_at` is in the past.',
  responses: {
    200: {
      description: 'Array of live heartbeat states.',
      content: jsonContent(z.array(HeartbeatStateInfoComponent)),
    },
  },
});

// GET /api/heartbeats/:agentId/logs
registerPath({
  method: 'get',
  path: '/api/heartbeats/{agentId}/logs',
  tags: ['Heartbeats'],
  summary: 'List recent heartbeat run rows for an agent',
  request: {
    params: agentIdParams,
    query: z.object({
      limit: z.string().optional().openapi({ description: 'Max rows (default 50).' }),
    }),
  },
  responses: {
    200: {
      description: 'Array of heartbeat log rows (newest first).',
      content: jsonContent(z.array(HeartbeatLogComponent)),
    },
  },
});

// GET /api/heartbeats/:agentId/thread
registerPath({
  method: 'get',
  path: '/api/heartbeats/{agentId}/thread',
  tags: ['Heartbeats'],
  summary: 'Fetch the persistent heartbeat thread for an agent',
  request: { params: agentIdParams },
  responses: {
    200: {
      description: 'Thread + entries (both null/empty when no thread exists yet).',
      content: jsonContent(HeartbeatThreadComponent),
    },
    404: errorResponse('Agent not found.'),
  },
});

// PUT /api/heartbeats/:agentId
registerPath({
  method: 'put',
  path: '/api/heartbeats/{agentId}',
  tags: ['Heartbeats'],
  summary: "Update an agent's heartbeat configuration",
  description:
    'Omitted keys preserve the existing value. `model` accepts `null`/`""` to clear the per-heartbeat model override. `interval` must be a valid cron expression (empty string is also accepted to leave the schedule unset).',
  request: {
    params: agentIdParams,
    body: { content: jsonContent(UpdateHeartbeatRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated per-agent heartbeat overview.',
      content: jsonContent(HeartbeatOverviewComponent),
    },
    400: errorResponse('Validation failed (e.g. invalid cron expression).'),
    404: errorResponse('Agent not found.'),
  },
});

// POST /api/heartbeats/:agentId/run
registerPath({
  method: 'post',
  path: '/api/heartbeats/{agentId}/run',
  tags: ['Heartbeats'],
  summary: 'Trigger an immediate one-shot heartbeat run',
  description:
    'Inserts a "running" log row and starts the heartbeat asynchronously — the response returns immediately with the new log id.',
  request: { params: agentIdParams },
  responses: {
    200: {
      description: 'Run acknowledgment.',
      content: jsonContent(HeartbeatRunResponseComponent),
    },
    400: errorResponse('No heartbeat prompt configured.'),
    404: errorResponse('Agent not found.'),
  },
});
