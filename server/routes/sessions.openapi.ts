/**
 * Zod schemas + OpenAPI registrations for the sessions / messages route
 * group.
 *
 * This module is imported for two reasons:
 *
 *   1. `server/routes/sessions.ts` imports the exported request schemas
 *      and uses `safeParse(...)` to validate incoming bodies. The
 *      handlers keep their downstream logic (engine/model coupling,
 *      worktree gating in workflow mode, ownership checks, broadcast,
 *      …) — only the hand-rolled `if (!field) return 400` checks are
 *      replaced.
 *
 *   2. `server/openapi/generate.ts` walks `server/routes/*.ts` and
 *      imports every module to trigger the side-effect `registerPath` /
 *      `registerComponent` calls below. The sessions section of the
 *      generated `docs/api/openapi.yaml` comes out of this file.
 *
 * Design notes:
 *
 * - **Boolean toggles** (`ask-mode`, `react-loop`) share the same
 *   `{ enabled: boolean }` shape. The legacy `worktree` toggle was
 *   removed when Agent Hub locked to worktree-only sessions; the
 *   `use_worktree` column survives on rows for legacy data + internal
 *   shared-checkout callers (e.g., preview-wizard) but is no longer
 *   user-toggleable.
 *
 * - **Engine / model coupling** is left in the handler: validating that
 *   `model` is in `engineValidModels[engine]` needs the request-time
 *   config object, which Zod has no access to. The schema gates that
 *   `model` is a non-empty string; the cross-field check fires after.
 *
 * - **`ask_mode` on create** stays snake_case to match what the React
 *   client + the legacy intake endpoint send. We document the snake_case
 *   wire form and don't try to fold it in.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Domain component schemas (response shapes) ──────────────────

export const SessionComponent = registerComponent(
  'Session',
  z
    .object({
      id: z.string(),
      agent_id: z.string(),
      name: z.string(),
      engine: z.string(),
      checkpoint_rewind_supported: z.boolean().openapi({
        description:
          'True when the session engine supports Claude Code checkpoint file rewind (`POST /api/sessions/{sessionId}/rewind`). Today only `claude-code`. Other engines return HTTP 400 with `code: checkpoint_rewind_unsupported_engine` from that endpoint.',
      }),
      model: z.string(),
      use_worktree: z.number().int(),
      ask_mode: z.number().int(),
      react_loop_enabled: z.number().int().nullable().optional(),
      worktree_path: z.string().nullable().optional(),
      worktree_branch: z.string().nullable().optional(),
      engine_session_id: z.string().nullable().optional(),
      cron_id: z.number().int().nullable().optional(),
      deleted_at: z.string().nullable().optional(),
      created_at: z.string(),
      updated_at: z.string(),
      owner_user_id: z.string().nullable().optional(),
      orchestration_phase: z.string().nullable().optional(),
      orchestration_meta: z.string().nullable().optional(),
    })
    .openapi({
      description:
        'A chat session row. Booleans are stored as 0/1 SQLite ints for `use_worktree`, `ask_mode`, `react_loop_enabled`. `use_worktree` is always 1 for user-created sessions; the column is preserved for legacy rows and internal shared-checkout callers (e.g., preview-wizard).',
    }),
);

export const MessageComponent = registerComponent(
  'Message',
  z
    .object({
      id: z.string(),
      session_id: z.string(),
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
      engine: z.string().nullable().optional(),
      model: z.string().nullable().optional(),
      attachments: z.string().nullable().optional(),
      metadata: z.string().nullable().optional(),
      created_at: z.string(),
    })
    .openapi({ description: 'A single message row inside a session.' }),
);

export const SessionErrorResponseComponent = registerComponent(
  'SessionErrorResponse',
  z
    .object({
      error: z.string(),
      code: z.string().optional().openapi({
        description:
          'Optional machine-readable code (for example `checkpoint_rewind_unsupported_engine` from `POST .../rewind` when the session is not Claude Code).',
      }),
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
 * Boolean toggle body shared by /ask-mode, /react-loop, /worktree.
 * Pre-Zod handlers rejected non-boolean (string / number / missing)
 * with `"enabled must be a boolean"`. Zod's strict `boolean()` matches.
 */
export const ToggleEnabledRequestSchema = z.object({
  enabled: z.boolean({ error: 'enabled must be a boolean' }),
});

export const CreateSessionRequestSchema = z.object({
  name: z.string().optional(),
  engine: z.string().optional(),
  model: z.string().optional(),
  ask_mode: z.boolean().optional(),
});

/**
 * PATCH /api/sessions/:sessionId — currently only `name` is updated.
 * Extra keys are silently ignored by the handler (mirrors the pre-Zod
 * behaviour).
 */
export const PatchSessionRequestSchema = z.object({
  name: z.string().optional(),
});

export const PutSessionEngineRequestSchema = z.object({
  engine: z.enum(['claude-code', 'cursor-agent', 'gemini-cli', 'codex-cli'], {
    error: 'Invalid engine. Must be claude-code, cursor-agent, gemini-cli, or codex-cli',
  }),
});

export const PutSessionModelRequestSchema = z.object({
  model: z.string({ error: 'Invalid model' }).min(1, 'Invalid model'),
});

export const RewindRequestSchema = z.object({
  uuid: z.string({ error: 'uuid is required' }).min(1, 'uuid is required'),
});

export const PatchCheckpointRequestSchema = z.object({
  label: z.string({ error: 'label is required' }),
});

// ─── OpenAPI path registrations ───────────────────────────────────

const agentIdParams = z.object({
  agentId: z.string().openapi({ description: 'Agent ID.' }),
});

const sessionIdParams = z.object({
  sessionId: z.string().openapi({ description: 'Session UUID.' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(SessionErrorResponseComponent),
});

// GET /api/agents/:agentId/sessions
registerPath({
  method: 'get',
  path: '/api/agents/{agentId}/sessions',
  tags: ['Sessions'],
  summary: 'List sessions for an agent (owner-filtered)',
  description:
    'Returns only sessions the caller owns. Pre-Phase-4 NULL-owner rows fall through to org-owner ownership.',
  request: { params: agentIdParams },
  responses: {
    200: { description: 'Array of sessions.', content: jsonContent(z.array(SessionComponent)) },
  },
});

// POST /api/agents/:agentId/sessions
registerPath({
  method: 'post',
  path: '/api/agents/{agentId}/sessions',
  tags: ['Sessions'],
  summary: 'Create a new session for an agent',
  description:
    "Defaults the engine and model to the agent's configured engine/model. Sessions are always created with a per-session git worktree (the legacy shared-checkout option was removed when Agent Hub locked to worktree-only sessions).",
  request: {
    params: agentIdParams,
    body: { content: jsonContent(CreateSessionRequestSchema) },
  },
  responses: {
    200: { description: 'New session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed.'),
  },
});

// DELETE /api/agents/:agentId/sessions
registerPath({
  method: 'delete',
  path: '/api/agents/{agentId}/sessions',
  tags: ['Sessions'],
  summary: 'Bulk soft-delete (archive) every session for an agent',
  request: { params: agentIdParams },
  responses: {
    200: {
      description: 'Archive counts.',
      content: jsonContent(
        z.object({ ok: z.literal(true), archived: z.number().int(), deleted: z.number().int() }),
      ),
    },
  },
});

// DELETE /api/agents/:agentId/sessions/inactive
registerPath({
  method: 'delete',
  path: '/api/agents/{agentId}/sessions/inactive',
  tags: ['Sessions'],
  summary: 'Bulk soft-delete (archive) every *inactive* session for an agent',
  description: 'Skips sessions with an active in-flight CLI process.',
  request: { params: agentIdParams },
  responses: {
    200: {
      description: 'Archive counts.',
      content: jsonContent(
        z.object({ ok: z.literal(true), archived: z.number().int(), deleted: z.number().int() }),
      ),
    },
  },
});

// GET /api/sessions/:sessionId
registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}',
  tags: ['Sessions'],
  summary: 'Get a single session by id',
  request: { params: sessionIdParams },
  responses: {
    200: { description: 'Session row.', content: jsonContent(SessionComponent) },
    404: errorResponse('Session not found (or hidden by ownership).'),
  },
});

// GET /api/sessions/:sessionId/messages
registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/messages',
  tags: ['Sessions'],
  summary: 'List every message in a session (oldest first)',
  request: { params: sessionIdParams },
  responses: {
    200: { description: 'Array of messages.', content: jsonContent(z.array(MessageComponent)) },
    404: errorResponse('Session not found (or hidden by ownership).'),
  },
});

// PATCH /api/sessions/:sessionId
registerPath({
  method: 'patch',
  path: '/api/sessions/{sessionId}',
  tags: ['Sessions'],
  summary: 'Rename a session',
  description: 'Currently only `name` is updated; unknown keys are silently ignored.',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(PatchSessionRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Session not found.'),
  },
});

// DELETE /api/sessions/:sessionId
registerPath({
  method: 'delete',
  path: '/api/sessions/{sessionId}',
  tags: ['Sessions'],
  summary: 'Archive (soft-delete) a single session',
  description:
    'Kills any in-flight CLI process, closes the browser session best-effort, and marks the row with `deleted_at`. Recoverable for 24h via `POST /api/sessions/{sessionId}/restore`.',
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Archive ack.',
      content: jsonContent(z.object({ ok: z.literal(true), archived: z.literal(true) })),
    },
    404: errorResponse('Session not found.'),
  },
});

// POST /api/sessions/:sessionId/restore
registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/restore',
  tags: ['Sessions'],
  summary: 'Restore an archived session',
  request: { params: sessionIdParams },
  responses: {
    200: { description: 'Restored session.', content: jsonContent(SessionComponent) },
    404: errorResponse('Session not found.'),
    409: errorResponse('Session is not archived.'),
  },
});

// PUT /api/sessions/:sessionId/engine
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/engine',
  tags: ['Sessions'],
  summary: 'Switch the engine for a session',
  description:
    "Resets the model to the new engine's default if the current model isn't valid for the chosen engine. Clears the `engine_session_id` so the next chat starts a fresh CLI side.",
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(PutSessionEngineRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed or invalid engine.'),
    404: errorResponse('Session not found.'),
  },
});

// PUT /api/sessions/:sessionId/model
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/model',
  tags: ['Sessions'],
  summary: 'Switch the model for a session',
  description:
    "Two-step validation: `model` must be in `config.allValidModels` (the cross-engine union), AND in the current session engine's `engineValidModels` list. Returns 400 otherwise.",
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(PutSessionModelRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed or model not valid for the current engine.'),
    404: errorResponse('Session not found.'),
  },
});

// NOTE: `PUT /api/sessions/{sessionId}/worktree` was removed when Agent
// Hub locked to worktree-only sessions.

// PUT /api/sessions/:sessionId/ask-mode
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/ask-mode',
  tags: ['Sessions'],
  summary: 'Toggle ask-mode (read-only / plan-mode) on a session',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(ToggleEnabledRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Session not found.'),
  },
});

// PUT /api/sessions/:sessionId/react-loop
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/react-loop',
  tags: ['Sessions'],
  summary: 'Toggle the host-mediated ReAct loop on a session',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(ToggleEnabledRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Session not found.'),
  },
});

// POST /api/sessions/:sessionId/rewind
registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/rewind',
  tags: ['Sessions'],
  summary: 'Rewind a Claude Code session to a checkpoint UUID',
  description:
    'Spawns `claude --resume <engine_session_id> --rewind-files <uuid>`. Supported only when `session.engine` is `claude-code`. Other engines: HTTP 400 with `code: checkpoint_rewind_unsupported_engine`.',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(RewindRequestSchema) },
  },
  responses: {
    200: {
      description: 'Rewind kicked off.',
      content: jsonContent(
        z.object({ status: z.literal('rewind_started'), uuid: z.string(), sessionId: z.string() }),
      ),
    },
    400: errorResponse(
      'Body validation failed, engine does not support rewind, or session never captured a Claude engine session id.',
    ),
    404: errorResponse('Session or checkpoint not found.'),
    409: errorResponse('Session is actively running.'),
  },
});

// PATCH /api/sessions/:sessionId/checkpoints/:uuid
registerPath({
  method: 'patch',
  path: '/api/sessions/{sessionId}/checkpoints/{uuid}',
  tags: ['Sessions'],
  summary: 'Rename a checkpoint label',
  request: {
    params: sessionIdParams.extend({
      uuid: z.string().openapi({ description: 'Checkpoint UUID.' }),
    }),
    body: { content: jsonContent(PatchCheckpointRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated checkpoint.',
      content: jsonContent(
        z.object({ session_id: z.string(), uuid: z.string(), label: z.string() }),
      ),
    },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Checkpoint not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/preview/start',
  tags: ['Sessions'],
  summary: 'Start worktree preview for a chat session',
  description:
    'Boots the project preview runtime for this session (same handler as `<agenthub:preview>`). Progress and iframe URL are delivered over WebSocket as `agenthub_preview` events.',
  request: {
    params: sessionIdParams,
    body: {
      content: jsonContent(
        z
          .object({
            route: z.string().optional().openapi({
              description:
                'In-app route to load (must start with `/`). Defaults to first capture route or `/`.',
            }),
            reason: z.string().optional(),
          })
          .openapi({ description: 'Optional preview task overrides.' }),
      ),
    },
  },
  responses: {
    200: {
      description: 'Preview boot kicked off.',
      content: jsonContent(z.object({ ok: z.literal(true), started: z.literal(true) })),
    },
    404: errorResponse('Session not found.'),
    500: errorResponse('Unexpected server error.'),
  },
});
