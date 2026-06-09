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
 *   shared-checkout callers but is no longer user-toggleable.
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
      max_turns: z.number().int().optional(),
      linked_design_id: z.string().nullable().optional().openapi({
        description:
          "Optional Design Studio design id linked to this session. When set, the web client renders the design's live canvas in a preview pane beside the chat. Set/cleared via `PUT /api/sessions/{sessionId}/linked-design`. Not a foreign key — a stale id (design since deleted) is tolerated and ignored at render time.",
      }),
      state: z
        .enum([
          'waiting_for_user_input',
          'working',
          'running_tests',
          'reviewing',
          'pending_checks',
          'pending_push',
          'pushed',
          'merged',
        ])
        .optional()
        .openapi({
          description:
            'Always-on lifecycle state of the session — exactly one value, surfaced as a single status icon in the clients. Resolved server-side at read time from active-task / Finalize-run / Done-column signals (see `server/session-state.ts`) and present on enriched session payloads (list, detail, `session_created`). The server also backfills the persisted `sessions.state` cache and emits a dedicated `session_state` WebSocket push at production signal boundaries (chat turn start/end, linked-card auto-close, kanban move to Done). Clients keep Finalize phases live from `finalize_run_phase_changed` and use `session_state` for persisted seed / terminal updates such as `merged`.',
        }),
      agents: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            color: z.string(),
            position: z.number().int(),
            role: z.enum(['executor', 'advisor']),
            projectId: z.string().optional(),
            projectName: z.string().optional(),
          }),
        )
        .optional(),
      advisor_count: z.number().int().optional(),
    })
    .openapi({
      description:
        'A chat session row. Booleans are stored as 0/1 SQLite ints for `use_worktree`, `ask_mode`, `react_loop_enabled`. `use_worktree` is always 1 for user-created sessions; the column is preserved for legacy rows and internal shared-checkout callers.',
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

export const SessionMessagesListComponent = registerComponent(
  'SessionMessagesList',
  z
    .object({
      messages: z.array(MessageComponent),
      truncated: z.literal(true),
      omitted: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .openapi({
      description:
        'Truncated message list when the full transcript exceeds the JSON response budget. Oldest rows are omitted; `messages` is oldest-first within the returned slice.',
    }),
);

export const SessionSummaryComponent = registerComponent(
  'SessionSummary',
  z
    .object({
      session: z.object({
        id: z.string(),
        name: z.string(),
        engine: z.string(),
        model: z.string(),
        updatedAt: z.string(),
      }),
      projectId: z.string().nullable(),
      projectGithubRepo: z.string().nullable(),
      linkedCard: z
        .object({
          id: z.string(),
          title: z.string(),
          pr_url: z.string().nullable(),
          review_status: z.string().nullable(),
          columnName: z.string().nullable(),
        })
        .nullable(),
      finalizePrUrl: z.string().nullable().openapi({
        description:
          'PR URL recorded by the latest Finalize run for this session when the linked kanban card does not already carry a PR URL.',
      }),
      sessionTitlePrUrl: z.string().nullable().openapi({
        description:
          'Best-effort PR URL inferred from Resolve/Review-style session titles when neither the linked card nor the latest Finalize run supplies a PR URL.',
      }),
      runSnapshot: z.record(z.string(), z.unknown()),
      skills: z.array(
        z.object({
          id: z.string(),
          skillId: z.string(),
          status: z.string(),
          source: z.string(),
          injectedBytes: z.number().nullable(),
          createdAt: z.string(),
        }),
      ),
    })
    .openapi({
      description:
        'Session summary metadata used by the chat header and orchestration panels: linked PR, run snapshot, and loaded skills.',
    }),
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

/** PATCH /api/sessions/:sessionId — `name`, `max_turns`, and/or `finalize_automation`. */
export const PatchSessionRequestSchema = z.object({
  name: z.string().optional(),
  max_turns: z.number().int().min(0).optional(),
  finalize_automation: z.enum(['manual', 'review', 'push', 'merge']).optional(),
});

export const AddSessionAgentRequestSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
});

export const PutSessionEngineRequestSchema = z.object({
  engine: z.enum(['claude-code', 'cursor-agent', 'gemini-cli', 'codex-cli'], {
    error: 'Invalid engine. Must be claude-code, cursor-agent, gemini-cli, or codex-cli',
  }),
});

export const PutSessionModelRequestSchema = z.object({
  model: z.string({ error: 'Invalid model' }).min(1, 'Invalid model'),
});

/**
 * PUT /api/sessions/:sessionId/linked-design — link a Design Studio design to
 * the session (or clear it). `designId: null` unlinks. A non-null id must
 * reference a design in the caller's active org.
 */
export const PutSessionLinkedDesignRequestSchema = z.object({
  designId: z
    .string()
    .min(1, 'designId must be a non-empty string or null')
    .nullable()
    .openapi({ description: 'Design id to link, or null to clear the link.' }),
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

const sessionAgentIdParams = sessionIdParams.extend({
  agentId: z.string().openapi({ description: 'Advisor agent ID to remove.' }),
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
  summary: 'List messages in a session (oldest first)',
  description:
    'Returns the full transcript when it fits the JSON response budget; otherwise returns a truncated envelope with the newest rows. Use `limit` to request only the newest N messages.',
  request: {
    params: sessionIdParams,
    query: z.object({
      limit: z.string().optional().openapi({
        description: 'When set, return only the newest N messages (positive integer).',
      }),
    }),
  },
  responses: {
    200: {
      description: 'Message rows, or a truncated envelope for very large transcripts.',
      content: jsonContent(z.union([z.array(MessageComponent), SessionMessagesListComponent])),
    },
    404: errorResponse('Session not found (or hidden by ownership).'),
  },
});

// GET /api/sessions/:sessionId/summary
registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/summary',
  tags: ['Sessions'],
  summary: 'Get session summary metadata',
  description:
    'Returns the compact metadata used by the chat header: linked kanban-card PR, latest Finalize PR fallback, title-inferred PR fallback, run snapshot, and loaded skills.',
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Session summary metadata.',
      content: jsonContent(SessionSummaryComponent),
    },
    404: errorResponse('Session not found.'),
  },
});

// PATCH /api/sessions/:sessionId
registerPath({
  method: 'patch',
  path: '/api/sessions/{sessionId}',
  tags: ['Sessions'],
  summary: 'Update session fields',
  description:
    'Updates `name` and/or `max_turns` (multi-agent advisor cap). Other keys are ignored.',
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

// PUT /api/sessions/:sessionId/linked-design
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/linked-design',
  tags: ['Sessions'],
  summary: 'Link (or unlink) a Design Studio design to a session',
  description:
    "Sets `linked_design_id` so the web client renders the design's live canvas in a preview pane beside the chat. Pass `designId: null` to clear the link. A non-null id must reference a design in the caller's active org.",
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(PutSessionLinkedDesignRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Session or design not found.'),
  },
});

// POST /api/sessions/:sessionId/agents
registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/agents',
  tags: ['Sessions'],
  summary: 'Add a read-only advisor agent to a multi-agent session',
  description:
    'Session owner only. Advisor may belong to any project the caller can view. Reviewer-role agents are rejected.',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(AddSessionAgentRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session with roster.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed or primary agent cannot be added as advisor.'),
    403: errorResponse('Reviewer agents cannot join multi-agent sessions.'),
    404: errorResponse('Session or agent not found.'),
  },
});

// DELETE /api/sessions/:sessionId/agents/:agentId
registerPath({
  method: 'delete',
  path: '/api/sessions/{sessionId}/agents/{agentId}',
  tags: ['Sessions'],
  summary: 'Remove an advisor from a multi-agent session',
  description: 'Session owner only. Cannot remove the primary executor.',
  request: { params: sessionAgentIdParams },
  responses: {
    200: { description: 'Updated session with roster.', content: jsonContent(SessionComponent) },
    400: errorResponse('Cannot remove the primary executor.'),
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
  path: '/api/sessions/{sessionId}/preview/ticket',
  tags: ['Sessions'],
  summary: 'Mint a single-use preview iframe ticket',
  description:
    "Returns a short-lived single-use ticket the SPA appends to the preview iframe `src` as `?ticket=…`. Browsers cannot attach `Authorization: Bearer …` to an iframe top-level navigation, so this endpoint is the bridge between the SPA's JWT session and the preview proxy. The ticket is bound to (sessionId, caller) and ~60 s TTL; on first hit the proxy consumes the ticket and writes a path-scoped HttpOnly cookie so sub-resources (.js/.css/images) authenticate automatically.",
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Ticket minted.',
      content: jsonContent(
        z.object({
          ticket: z.string().openapi({
            description: 'Single-use opaque token (prefixed `ahpt_`). Append as `?ticket=…`.',
          }),
          ttlSeconds: z.number().int().openapi({
            description: 'Seconds the ticket remains valid before it must be re-minted.',
          }),
        }),
      ),
    },
    404: errorResponse('Session not found or not owned by the caller.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/preview/stop',
  tags: ['Sessions'],
  summary: 'Stop worktree preview for a chat session',
  description:
    'Tears down compose/legacy preview runtimes for this session. Safe while boot is still in progress.',
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Preview teardown requested.',
      content: jsonContent(z.object({ ok: z.literal(true), stopped: z.literal(true) })),
    },
    404: errorResponse('Session not found.'),
    500: errorResponse('Unexpected server error.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/workspace/ensure',
  tags: ['Sessions'],
  summary: 'Provision session git worktree',
  description:
    'Clones or reuses the per-session worktree before the first chat message so preview and file edits use the same checkout. Idempotent when `worktree_path` is already set.',
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Worktree ready (or skipped for workflow / wizard sessions).',
      content: jsonContent(
        z.object({
          ok: z.literal(true),
          skipped: z.boolean(),
          worktreePath: z.string(),
          session: SessionComponent,
        }),
      ),
    },
    404: errorResponse('Session not found.'),
    503: errorResponse('Provisioning not wired on this server.'),
    500: errorResponse('Unexpected server error.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/ship',
  tags: ['Sessions'],
  summary: 'Ship session work (Create ticket & PR)',
  description:
    'Operator-initiated publish for ad-hoc sessions: injects the `create-ticket-and-pr` skill, records a system callout in chat, and starts an agent turn without persisting a visible user slash-command message.',
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Ship workflow started.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
    400: errorResponse('Session has no worktree.'),
    404: errorResponse('Session, agent, or skill not found.'),
    409: errorResponse('Session is streaming, ship is in progress, or is a resolve-PR session.'),
    403: errorResponse('Disabled in workflow mode.'),
    500: errorResponse('Unexpected server error.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/preview/start',
  tags: ['Sessions'],
  summary: 'Start worktree preview for a chat session',
  description:
    'Boots the project preview runtime for this session (human-initiated only; agent `<agenthub:preview>` blocks are ignored). Progress and iframe URL are delivered over WebSocket as `agenthub_preview` events.',
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
    409: errorResponse('Session workspace is not ready yet.'),
    500: errorResponse('Unexpected server error.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/preview/state',
  tags: ['Sessions'],
  summary: 'Get current preview state for a chat session',
  description:
    'Returns the current `agenthub_preview` event for the session — the same wire shape delivered live over WebSocket and on the WS connect-snapshot — or `{ event: null }` when no compose preview is active. The client uses this to reconcile a preview pane that is stuck on `preview_starting` because a live `ready` event was dropped while the socket stayed open (no reconnect, so the connect-snapshot never replayed).',
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Current preview event, or null when none is active.',
      content: jsonContent(
        z.object({
          event: z
            .object({
              type: z.literal('agenthub_preview'),
              kind: z.enum(['preview_starting', 'preview', 'preview_failed']),
              sessionId: z.string(),
              previewId: z.string(),
              target: z.literal('client'),
              route: z.string(),
              previewUrl: z.string().optional(),
              fullUrl: z.string().optional(),
              port: z.number().optional(),
              screenshotPath: z.string().nullable(),
              logTail: z.array(z.string()),
              error: z.string().optional(),
            })
            .nullable()
            .openapi({
              description:
                'The current preview snapshot event, or null when no preview is active for the session.',
            }),
        }),
      ),
    },
    404: errorResponse('Session not found.'),
    500: errorResponse('Unexpected server error.'),
  },
});
