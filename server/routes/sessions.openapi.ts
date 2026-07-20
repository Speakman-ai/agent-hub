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
import { SESSION_MODES } from '../session-mode.js';

/** Shared enum for session_mode across request/response schemas. */
const SessionModeSchema = z.enum(SESSION_MODES);

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
      session_mode: SessionModeSchema.nullable().optional().openapi({
        description:
          'Session mode picker dimension: `chat` (default), `design`, `scoping`, `skill-builder`, or `consult`. NULL/absent on legacy rows → treated as `chat`. `design` loads the design skill; `scoping` loads kanban planning with a live epic flowchart panel; `skill-builder` loads the skill-authoring coach; `consult` is read-only Hub/project Q&A with no code ship or Finalize. Set via `PATCH /api/sessions/{sessionId}` or `PUT .../mode`.',
      }),
      reasoning_effort: z.enum(['high', 'pro']).nullable().optional().openapi({
        description:
          'Codex reasoning ("thinking") preset: `high` (default) or `pro` (→ xhigh). NULL/absent on legacy rows and non-Codex sessions; treated as `high`.',
      }),
      worktree_path: z.string().nullable().optional(),
      worktree_branch: z.string().nullable().optional(),
      worktree_checkout_branch: z.string().nullable().optional(),
      code_changed_at: z.string().nullable().optional(),
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
      linked_epic_id: z.string().nullable().optional().openapi({
        description:
          'Epic linked for scoping mode. When `session_mode` is `scoping`, the web client renders a live Epic → Phase → Ticket flowchart for this epic. Set/cleared via `PUT /api/sessions/{sessionId}/linked-epic`.',
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
  /** @deprecated Rejected when true — use session_mode: "consult" instead. */
  ask_mode: z.boolean().optional(),
  session_mode: SessionModeSchema.optional(),
});

/** PATCH /api/sessions/:sessionId — `name`, `max_turns`, and/or `finalize_automation`. */
export const PatchSessionRequestSchema = z.object({
  name: z.string().optional(),
  max_turns: z.number().int().min(0).optional(),
  finalize_automation: z.enum(['manual', 'review', 'push', 'merge']).optional(),
  // Session-control axes folded into one atomic PATCH so the session-mode
  // picker (Design/Ask/Build/…) can change several axes in a single
  // transaction. Persisting `session_mode` + `ask_mode` + `finalize_automation`
  // together avoids partial commits: e.g. entering Design from `merge` must
  // both switch the mode AND reset ship intent, all-or-nothing. A `design`
  // request without a usable worktree rejects the WHOLE patch (400), so no
  // other axis is mutated.
  session_mode: SessionModeSchema.optional(),
  ask_mode: z.boolean().optional(),
});

export const AddSessionAgentRequestSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
});

export const PutSessionEngineRequestSchema = z.object({
  engine: z.enum(['claude-code', 'cursor-agent', 'gemini-cli', 'codex-cli', 'grok-cli'], {
    error: 'Invalid engine. Must be claude-code, cursor-agent, gemini-cli, codex-cli, or grok-cli',
  }),
});

export const PutSessionModelRequestSchema = z.object({
  model: z.string({ error: 'Invalid model' }).min(1, 'Invalid model'),
});

const SessionCredentialFieldSchema = registerComponent(
  'SessionCredentialField',
  z.object({
    key: z.string().min(1).max(64).openapi({
      description: 'Stable field key, for example `username` or `password`.',
    }),
    label: z.string().min(1).max(80),
    type: z.enum(['text', 'username', 'password']),
  }),
);

export const SubmitSessionCredentialRequestSchema = z.object({
  service: z.string().min(1).max(120).openapi({
    description: 'Human-facing service name, for example `Survey Tracker`.',
  }),
  purpose: z.string().min(1).max(240).openapi({
    description: 'Why the agent is requesting these credentials.',
  }),
  fields: z.array(SessionCredentialFieldSchema).min(1).max(6),
  values: z.record(z.string(), z.string()).openapi({
    description:
      'Plaintext values keyed by field key. Stored encrypted until one-time consumption, never returned by status endpoints.',
  }),
  ttlSeconds: z.number().positive().max(3600).optional().openapi({
    description: 'Credential lifetime in seconds. Defaults to 15 minutes, capped at 1 hour.',
  }),
});

const SessionCredentialStatusResponse = registerComponent(
  'SessionCredentialStatusResponse',
  z.object({
    requestId: z.string(),
    service: z.string(),
    purpose: z.string(),
    fields: z.array(SessionCredentialFieldSchema),
    status: z.enum(['submitted', 'consumed', 'expired']),
    submittedAt: z.string(),
    consumedAt: z.string().nullable(),
    expiresAt: z.string(),
  }),
);

const ConsumeSessionCredentialResponse = registerComponent(
  'ConsumeSessionCredentialResponse',
  z.object({
    requestId: z.string(),
    service: z.string(),
    purpose: z.string(),
    values: z.record(z.string(), z.string()).openapi({
      description:
        'Plaintext values. The same requestId can be consumed again until it expires (so an agent that loses the value can re-fetch it); the encrypted payload is erased when the request expires or is deleted.',
    }),
  }),
);

/**
 * PUT /api/sessions/:sessionId/reasoning-effort — Codex "thinking" level.
 * `high` (default) maps to `model_reasoning_effort=high`; `pro` maps to
 * `xhigh`. Applies only to Codex (`codex-cli`) sessions.
 */
export const PutSessionReasoningEffortRequestSchema = z.object({
  effort: z.enum(['high', 'pro'], {
    error: 'Invalid reasoning effort. Must be "high" or "pro".',
  }),
});

/**
 * PUT /api/sessions/:sessionId/mode — set the session mode picker dimension.
 * `chat` (default), `design`, or `scoping`.
 */
export const PutSessionModeRequestSchema = z.object({
  mode: SessionModeSchema,
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

/**
 * PUT /api/sessions/:sessionId/worktree-branch — choose (or clear) the existing
 * remote branch this session's worktree is checked out onto. `branch: null`
 * clears the choice back to the default fresh session branch before the
 * worktree is provisioned. After provisioning, a clean and idle session may
 * switch to an existing non-default branch; code changes, active turns, and
 * Finalize lock the branch.
 */
export const PutSessionWorktreeBranchRequestSchema = z.object({
  branch: z
    .string()
    .trim()
    .min(1, 'branch must be a non-empty string or null')
    .max(255, 'branch name is too long')
    // Reject leading '-' (would be read as a git flag), any '..' segment, and
    // anything outside the safe branch-name character set.
    .regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._][A-Za-z0-9._/-]*$/, 'invalid branch name')
    .nullable()
    .openapi({
      description:
        'Existing remote branch to position the session worktree on, or null to clear the choice before provisioning (revert to the default fresh session branch). After provisioning, only a clean and idle session may switch to an existing non-default branch.',
    }),
});

export const RewindRequestSchema = z.object({
  uuid: z.string({ error: 'uuid is required' }).min(1, 'uuid is required'),
});

export const PatchCheckpointRequestSchema = z.object({
  label: z.string({ error: 'label is required' }),
});

export const ForwardSessionRequestSchema = z.object({
  targetAgentId: z
    .string({ error: 'targetAgentId is required' })
    .min(1, 'targetAgentId is required')
    .openapi({
      description:
        'Agent to forward the conversation to. May belong to a different project than the source session (cross-project forwarding); the caller must be able to view the target agent’s project.',
    }),
  messageIds: z.array(z.string()).optional().openapi({
    description: 'Specific message IDs to include (default: all, capped to the last 200).',
  }),
  prompt: z.string().max(50_000).optional().openapi({
    description: 'Extra instructions prepended to the forwarded context (max 50k chars).',
  }),
  autoStart: z.boolean().optional().openapi({
    description: 'When true, immediately send the forwarded message to the target agent’s CLI.',
  }),
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

const sessionCredentialRequestParams = sessionIdParams.extend({
  requestId: z.string().openapi({
    description: 'Agent-supplied credential request id from the chat prompt block.',
  }),
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

// DELETE /api/agents/:agentId/sessions/pushed
registerPath({
  method: 'delete',
  path: '/api/agents/{agentId}/sessions/pushed',
  tags: ['Sessions'],
  summary: 'Bulk soft-delete (archive) every *pushed* session for an agent',
  description:
    'Archives only sessions whose resolved lifecycle state is `pushed` (Finalize pushed the branch but it has not merged yet). Sessions in any other state — working, waiting, in-flight Finalize phases, or merged — are left untouched, as are sessions with an active in-flight CLI process.',
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

// DELETE /api/agents/:agentId/sessions/merged
registerPath({
  method: 'delete',
  path: '/api/agents/{agentId}/sessions/merged',
  tags: ['Sessions'],
  summary: 'Bulk soft-delete (archive) every *merged* session for an agent',
  description:
    'Archives only sessions whose resolved lifecycle state is `merged` (the work landed on the default branch). Sessions in any other state — working, waiting, in-flight Finalize phases, or pushed-but-not-merged — are left untouched, as are sessions with an active in-flight CLI process. Companion to the pushed-only bulk clear: under Merge Automatically, shipped sessions settle in `merged`, not `pushed`.',
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

// POST /api/sessions/:sessionId/forward
registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/forward',
  tags: ['Sessions'],
  summary: 'Forward a session’s conversation to another agent',
  description:
    'Creates a new session on the target agent seeded with the forwarded transcript as the initial user message. The target agent may live in a different project (cross-project forwarding); the caller must own the source session and be able to view the target agent’s project, otherwise 404. The new session inherits the source session’s owner.',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(ForwardSessionRequestSchema) },
  },
  responses: {
    201: {
      description:
        'New forwarded session plus the pre-stored forwarded message id (null when autoStart).',
      content: jsonContent(
        z.object({ session: SessionComponent, forwardedMessageId: z.string().nullable() }),
      ),
    },
    400: errorResponse(
      'Validation failed, no messages to forward, or forwarded content too large.',
    ),
    404: errorResponse('Source session not found, or target agent not found / not viewable.'),
    503: errorResponse('Auto-start requested but the chat handler is not initialized.'),
  },
});

// GET /api/sessions/:sessionId/messages
registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/messages',
  tags: ['Sessions'],
  summary: 'List messages in a session (oldest first)',
  description:
    'Without `paginated`, returns the full transcript when it fits the JSON response budget, otherwise a truncated envelope with the newest rows; `limit` slices the newest N. With `paginated=1`, returns a DB-limited keyset page (newest page first, `limit` page size, default 40, max 200) as a plain oldest-first array; pass `before` (the oldest loaded message id) to fetch the next older page. Powers the client reverse-infinite-scroll loader.',
  request: {
    params: sessionIdParams,
    query: z.object({
      limit: z.string().optional().openapi({
        description:
          'Newest N messages (positive integer). Legacy: in-memory slice. Paginated: DB page size, clamped to 200 (default 40).',
      }),
      paginated: z.string().optional().openapi({
        description:
          'Set to `1` (or `true`) to opt into DB-side keyset pagination (newest page first).',
      }),
      before: z.string().optional().openapi({
        description:
          'The oldest already-loaded message id. Returns the page of messages immediately older than it. Implies pagination.',
      }),
    }),
  },
  responses: {
    200: {
      description:
        'Message rows (oldest-first), or a truncated envelope for very large un-paginated transcripts.',
      content: jsonContent(z.union([z.array(MessageComponent), SessionMessagesListComponent])),
    },
    404: errorResponse('Session not found (or hidden by ownership).'),
  },
});

// GET /api/sessions/:sessionId/credential-requests/:requestId
registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/credential-requests/{requestId}',
  tags: ['Sessions'],
  summary: 'Get session credential request status',
  description:
    'Returns metadata and status for an ephemeral credential request. Plaintext credential values are never returned by this endpoint.',
  request: { params: sessionCredentialRequestParams },
  responses: {
    200: {
      description: 'Credential request metadata and status.',
      content: jsonContent(SessionCredentialStatusResponse),
    },
    404: errorResponse('Session or credential request not found.'),
  },
});

// PUT /api/sessions/:sessionId/credential-requests/:requestId
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/credential-requests/{requestId}',
  tags: ['Sessions'],
  summary: 'Submit ephemeral session credentials',
  description:
    'Stores user-submitted credentials encrypted with a short TTL. The values are not added to chat history and are not returned by status reads.',
  request: {
    params: sessionCredentialRequestParams,
    body: { content: jsonContent(SubmitSessionCredentialRequestSchema) },
  },
  responses: {
    200: {
      description: 'Credential request accepted.',
      content: jsonContent(SessionCredentialStatusResponse),
    },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Session not found.'),
  },
});

// POST /api/sessions/:sessionId/credential-requests/:requestId/consume
registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/credential-requests/{requestId}/consume',
  tags: ['Sessions'],
  summary: 'Consume ephemeral session credentials',
  description:
    'Returns plaintext values for the owning session. The same requestId can be consumed repeatedly until it expires, so an agent that loses the value (for example inside a throwaway subprocess) can re-fetch it instead of asking the user to resubmit. An expired or missing request returns 404; the encrypted payload is erased on expiry or delete.',
  request: { params: sessionCredentialRequestParams },
  responses: {
    200: {
      description: 'Plaintext values for the requested credentials.',
      content: jsonContent(ConsumeSessionCredentialResponse),
    },
    404: errorResponse('Session or available credential request not found.'),
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

// POST /api/sessions/:sessionId/extract-skill
registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/extract-skill',
  tags: ['Sessions'],
  summary: 'Turn this session into a skill (Skill Builder Phase 4)',
  description:
    "Hands the session's transcript to the project's Skill Builder coach agent, which mines the repeated context/procedures and drafts a SKILL.md via the skills write API (\"extract, don't invent\"). Spawns a fresh non-worktree coach session and returns its id; the coach streams a draft for the user to review/edit and save.",
  request: { params: sessionIdParams },
  responses: {
    201: {
      description: 'Skill Builder coach session spawned.',
      content: jsonContent(
        z.object({
          sessionId: z.string().openapi({ description: 'The new coach session id.' }),
          agentId: z.string().openapi({ description: 'The Skill Builder agent id.' }),
          session: SessionComponent.nullable(),
        }),
      ),
    },
    400: errorResponse('No messages, no resolvable project, or no Skill Builder coach agent.'),
    404: errorResponse('Session not found (or hidden by ownership).'),
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

// PUT /api/sessions/:sessionId/worktree-branch
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/worktree-branch',
  tags: ['Sessions'],
  summary: 'Choose (or clear) the existing branch a session worktree checks out onto',
  description:
    'Before provisioning, sets `worktree_checkout_branch` so the session worktree starts directly on the chosen existing remote branch. After provisioning, switches a clean and idle worktree onto the chosen existing non-default branch. Commits then land there and Finalize pushes or updates its PR. Pass `branch: null` only before provisioning to clear the choice and revert to the default fresh `agent-hub/<agent>/session-<id>` branch. Code changes, active turns, Finalize runs, dirty worktrees, and the repository default branch are rejected.',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(PutSessionWorktreeBranchRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed or session does not use a worktree.'),
    404: errorResponse('Session not found.'),
    409: errorResponse('The branch cannot be changed in the current session state.'),
  },
});

// PUT /api/sessions/:sessionId/linked-epic
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/linked-epic',
  tags: ['Sessions'],
  summary: 'Link (or unlink) a kanban epic to a session for scoping mode',
  description:
    "Sets `linked_epic_id` so a scoping-mode session renders the Epic → Phase → Ticket flowchart and loads the epic's spec context. Pass `epicId: null` to clear the link. A non-null id must reference an epic on the session's own project board.",
  request: {
    params: sessionIdParams,
    body: {
      content: jsonContent(
        z.object({
          epicId: z
            .string()
            .nullable()
            .optional()
            .openapi({ description: 'Epic UUID to link, or null to unlink.' }),
        }),
      ),
    },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    404: errorResponse('Session or epic not found (incl. an epic on a different project).'),
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

// PUT /api/sessions/:sessionId/reasoning-effort
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/reasoning-effort',
  tags: ['Sessions'],
  summary: 'Set the Codex reasoning ("thinking") level for a session',
  description:
    'Codex (`codex-cli`) sessions only. `high` (default) runs at `model_reasoning_effort=high`; `pro` runs at `xhigh` (max thinking, same model). Ignored for non-Codex engines.',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(PutSessionReasoningEffortRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Session not found.'),
  },
});

// PUT /api/sessions/:sessionId/ask-mode
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/ask-mode',
  tags: ['Sessions'],
  summary: 'Legacy Ask toggle alias for Consult mode',
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

// PUT /api/sessions/:sessionId/mode
registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/mode',
  tags: ['Sessions'],
  summary: 'Set the session mode (chat | design)',
  description:
    'Folds the standalone Design Studio into the chat-mode picker. `chat` (default) is a normal coding session; `design` loads the design skill and produces HTML/CSS/JS artifacts in the session worktree. Flipping back to `chat` keeps those artifacts in the same checkout. `design` requires a session with an isolated worktree — setting it on a worktree-less session is rejected with 400 (`design_mode_requires_worktree`), since artifacts must live in the worktree and must not pollute the shared project checkout.',
  request: {
    params: sessionIdParams,
    body: { content: jsonContent(PutSessionModeRequestSchema) },
  },
  responses: {
    200: { description: 'Updated session.', content: jsonContent(SessionComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Session not found.'),
  },
});

// GET /api/sessions/:sessionId/design-files
const SessionDesignFileComponent = z
  .object({
    path: z
      .string()
      .openapi({ description: 'Forward-slash path relative to the worktree `design/` dir.' }),
    size: z.number().openapi({ description: 'File size in bytes.' }),
    mtime: z.string().openapi({ description: 'Last-modified time, ISO 8601.' }),
  })
  .openapi('SessionDesignFile');

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/design-files',
  tags: ['Sessions'],
  summary: 'List design-mode artifacts produced in the session worktree',
  description:
    'Returns the regular files a `design`-mode session has written under its worktree `design/` dir. The web client renders these live in an iframe canvas; mobile/Electron (no in-app iframe) show this flat list plus an open-in-browser link to `/session-files/{sessionId}/design/<path>`. A worktree-less session (which can never enter design mode) and a session that wrote no artifacts both return an empty list.',
  request: { params: sessionIdParams },
  responses: {
    200: {
      description: 'Design artifact listing.',
      content: jsonContent(z.object({ files: z.array(SessionDesignFileComponent) })),
    },
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

// ─── Session code-diff pane ──────────────────────────────────────────

const ChangeStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
]);

export const SessionChangeFileComponent = registerComponent(
  'SessionChangeFile',
  z
    .object({
      path: z.string().openapi({ description: 'Repo-relative path (new path for renames).' }),
      oldPath: z.string().optional().openapi({ description: 'Previous path for renames/copies.' }),
      status: ChangeStatusSchema,
      additions: z.number().int(),
      deletions: z.number().int(),
      binary: z.boolean(),
      untracked: z
        .boolean()
        .openapi({ description: 'True for files git is not tracking yet (freshly created).' }),
    })
    .openapi({ description: 'One changed file in a session worktree.' }),
);

export const SessionChangesComponent = registerComponent(
  'SessionChanges',
  z
    .object({
      baseBranch: z.string().nullable(),
      baseSha: z
        .string()
        .nullable()
        .openapi({ description: 'Merge-base SHA the diff is anchored to (null if unresolved).' }),
      headSha: z.string().nullable(),
      branch: z.string().nullable(),
      dirty: z
        .boolean()
        .openapi({ description: 'True when the worktree has uncommitted changes.' }),
      files: z.array(SessionChangeFileComponent),
      truncated: z
        .boolean()
        .openapi({ description: 'True when the file list was capped at the server limit.' }),
    })
    .openapi({ description: 'Total session delta (committed + uncommitted + untracked) vs base.' }),
);

export const SessionFileDiffComponent = registerComponent(
  'SessionFileDiff',
  z
    .object({
      path: z.string(),
      status: ChangeStatusSchema,
      binary: z.boolean(),
      unifiedDiff: z
        .string()
        .openapi({ description: 'Unified diff body. Empty when binary or tooLarge.' }),
      tooLarge: z
        .boolean()
        .openapi({ description: 'True when the patch exceeded the byte cap and was withheld.' }),
    })
    .openapi({ description: 'Unified diff for a single changed file.' }),
);

// GET /api/sessions/:sessionId/changes
registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/changes',
  tags: ['Sessions'],
  summary: 'List files changed in a session worktree',
  description:
    'Returns the total session delta — committed, uncommitted, and untracked files — diffed against the merge-base of the base branch and the worktree HEAD. Owner-filtered; a session the caller does not own returns 404. Sessions with no worktree return an empty file list.',
  request: { params: sessionIdParams },
  responses: {
    200: { description: 'Session change summary.', content: jsonContent(SessionChangesComponent) },
    404: errorResponse('Session not found.'),
    500: errorResponse('Failed to compute session changes.'),
  },
});

// GET /api/sessions/:sessionId/changes/diff
registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/changes/diff',
  tags: ['Sessions'],
  summary: 'Unified diff for a single changed file',
  description:
    "Returns the unified diff for one file in a session worktree. The `file` must be a repo-relative path that the server reports as changed for this session — absolute paths and `..` traversal are rejected, and paths outside the changed-file set return 404 (the endpoint is membership-gated so it can't be used as an arbitrary file-read primitive). Whether a file is tracked vs. untracked is determined server-side. Binary and oversized diffs return an empty body with `binary`/`tooLarge` set.",
  request: {
    params: sessionIdParams,
    query: z.object({
      file: z
        .string()
        .openapi({ description: 'Repo-relative path to diff (new path for renames).' }),
    }),
  },
  responses: {
    200: { description: 'File diff.', content: jsonContent(SessionFileDiffComponent) },
    400: errorResponse('Missing or invalid (absolute / out-of-worktree) file path.'),
    404: errorResponse('Session not found, has no worktree, or file is not a session change.'),
    500: errorResponse('Failed to compute file diff.'),
  },
});
