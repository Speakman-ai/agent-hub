/**
 * Zod schemas + OpenAPI registrations for the agents route group.
 *
 * This module is imported for two reasons:
 *
 *   1. `server/routes/agents.ts` imports the exported request schemas and
 *      uses `safeParse(...)` to validate incoming bodies. The handler
 *      keeps its downstream logic (workspace creation, FK cascade-deletes,
 *      sub-agent ref scrub, hooks/MCP/context plumbing, …) — only the
 *      hand-rolled `if (!field) return 400` checks are replaced.
 *
 *   2. `server/openapi/generate.ts` walks `server/routes/*.ts` and
 *      imports every module to trigger the side-effect `registerPath` /
 *      `registerComponent` calls below. The agents section of the
 *      generated `docs/api/openapi.yaml` comes out of this file.
 *
 * Design notes:
 *
 * - **`browserToolsEnabled` / browser dims kept as strict boolean / int.**
 *   Pre-Zod handlers rejected `"false"` / `"true"` strings with a
 *   bespoke 400 ("browserToolsEnabled must be a boolean"). We preserve
 *   the wire shape — Zod's default `z.boolean()` already rejects strings.
 *
 * - **Browser viewport dimensions** accept `null` to clear the override
 *   ("explicit erase" semantics) — the handler distinguishes `null`
 *   from omitted via `null | undefined` matching.
 *
 * - **Unknown keys are passed through.** The pre-Zod PATCH handler iterates
 *   an allowlist of known top-level keys and silently ignores the rest;
 *   we mirror that by leaving the schema open (no `.strict()`).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

// ─── Domain component schemas (response shapes) ──────────────────

export const AgentComponent = registerComponent(
  'Agent',
  z
    .object({
      id: z.string(),
      name: z.string(),
      engine: z.string(),
      model: z.string().optional(),
      systemPrompt: z.string().optional(),
      color: z.string().optional(),
      avatar: z.string().optional(),
      role: z.string().optional(),
      reviewer: z.string().optional(),
      canReview: z.boolean().optional(),
      active: z.boolean().optional(),
      delegationEnabled: z.boolean().optional(),
      browserToolsEnabled: z.boolean().optional(),
      browserViewportWidth: z.number().int().optional(),
      browserViewportHeight: z.number().int().optional(),
      browserPageLoadTimeoutMs: z.number().int().optional(),
      heartbeat: z
        .object({
          enabled: z.boolean(),
          interval: z.string(),
          prompt: z.string(),
        })
        .optional(),
    })
    .openapi({
      description:
        'An agent. Many additional optional fields exist on the row (subAgents, hooks, mcpServers, …) — only the stable, documented surface is enumerated here.',
    }),
);

export const AgentEnrichedComponent = registerComponent(
  'AgentEnriched',
  AgentComponent.extend({
    lastActivity: z.string().nullable().optional(),
    lastMessage: z
      .object({
        role: z.string(),
        content: z.string(),
        created_at: z.string(),
      })
      .nullable()
      .optional(),
  }).openapi({
    description: 'Agent shape + the most-recent session timestamp and a truncated last message.',
  }),
);

export const BulkEngineResponseComponent = registerComponent(
  'AgentsBulkEngineResponse',
  z
    .object({
      updated: z.number().int(),
      engine: z.string(),
      model: z.string(),
    })
    .openapi({ description: 'Result of POST /api/agents/bulk-engine.' }),
);

export const AgentErrorResponseComponent = registerComponent(
  'AgentErrorResponse',
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
 * Browser viewport dimension — finite int in [min, max], or `null` to
 * explicitly erase the override. The handler treats `undefined` (key
 * omitted) as "preserve", `null` as "delete from the agent record",
 * and any number in-range as "set to that value".
 */
const BrowserDim = (min: number, max: number) =>
  z
    .number({ error: 'must be a finite number or null' })
    .finite()
    .refine((n) => n >= min && n <= max, `must be between ${min} and ${max}`)
    .nullable()
    .optional();

const BrowserPageLoadTimeoutMs = z
  .number({ error: 'browserPageLoadTimeoutMs must be a finite number or null' })
  .finite()
  .refine(
    (n) => n >= 1000 && n <= 120_000,
    'browserPageLoadTimeoutMs must be between 1000 and 120000',
  )
  .nullable()
  .optional();

/**
 * Pre-Zod check rejected non-string-non-boolean values for
 * `browserToolsEnabled`. Zod's `boolean()` matches the same semantics —
 * `"false"`/`0`/numbers are all rejected, only `true`/`false` pass.
 */
const BrowserToolsEnabled = z
  .boolean({ error: 'browserToolsEnabled must be a boolean' })
  .optional();

/**
 * Per-agent skill allowlist. `undefined` (key omitted) => preserve; `null` =>
 * clear the restriction (agent sees every skill); an array => restrict the
 * agent to exactly those skill ids (empty array means no skills).
 */
const AllowedSkills = z
  .array(z.string({ error: 'allowedSkills entries must be strings' }))
  .nullable()
  .optional();

export const HeartbeatConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    interval: z.string().optional(),
    prompt: z.string().optional(),
  })
  .optional();

export const CreateAgentRequestSchema = z.object({
  id: z
    .string({ error: 'id is required and must be alphanumeric+hyphens' })
    .min(1, 'id is required and must be alphanumeric+hyphens')
    .regex(/^[a-zA-Z0-9-]+$/, 'id is required and must be alphanumeric+hyphens'),
  projectId: z.string({ error: 'projectId is required' }).min(1, 'projectId is required'),
  name: z.string().optional(),
  engine: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  color: z.string().optional(),
  avatar: z.string().optional(),
  role: z.string().optional(),
  heartbeat: HeartbeatConfigSchema,
  browserToolsEnabled: BrowserToolsEnabled,
  browserViewportWidth: BrowserDim(320, 3840),
  browserViewportHeight: BrowserDim(240, 2160),
  browserPageLoadTimeoutMs: BrowserPageLoadTimeoutMs,
  allowedSkills: AllowedSkills,
});

/**
 * PATCH /api/agents/:agentId — partial update. The pre-Zod handler iterates
 * an allowlist of keys, so we mirror that here: every top-level field is
 * optional, unknown keys are silently ignored (no `.strict()`).
 */
export const UpdateAgentRequestSchema = z.object({
  name: z.string().optional(),
  engine: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  color: z.string().optional(),
  avatar: z.string().optional(),
  heartbeat: HeartbeatConfigSchema,
  active: z.boolean().optional(),
  reviewer: z.string().optional(),
  role: z.string().optional(),
  canReview: z.boolean().optional(),
  delegationEnabled: z.boolean().optional(),
  browserToolsEnabled: BrowserToolsEnabled,
  browserViewportWidth: BrowserDim(320, 3840),
  browserViewportHeight: BrowserDim(240, 2160),
  browserPageLoadTimeoutMs: BrowserPageLoadTimeoutMs,
  allowedSkills: AllowedSkills,
});

export const BulkEngineRequestSchema = z.object({
  engine: z.string({ error: 'Invalid or missing engine' }).min(1, 'Invalid or missing engine'),
  model: z.string().optional(),
});

export const UpdateAgentMemoryRequestSchema = z.object({
  content: z.string({ error: 'content must be a string' }),
});

export const UpdateAgentContextRequestSchema = z.object({
  content: z.string({ error: 'content must be a string' }),
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
  content: jsonContent(AgentErrorResponseComponent),
});

// GET /api/agents
registerPath({
  method: 'get',
  path: '/api/agents',
  tags: ['Agents'],
  summary: 'List all agents (enriched with last-activity / last-message)',
  responses: {
    200: {
      description: 'Array of agents enriched with last-activity metadata.',
      content: jsonContent(z.array(AgentEnrichedComponent)),
    },
  },
});

// POST /api/agents
registerPath({
  method: 'post',
  path: '/api/agents',
  tags: ['Agents'],
  summary: 'Create a new agent under an existing project',
  description:
    'Returns 400 for missing/invalid id (must be alphanumeric + hyphens) or missing projectId, 404 if the project does not exist, 409 if the id collides with an existing agent.',
  request: { body: { content: jsonContent(CreateAgentRequestSchema) } },
  responses: {
    201: { description: 'Created agent.', content: jsonContent(AgentEnrichedComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Project not found.'),
    409: errorResponse('Agent id already exists.'),
  },
});

// PATCH /api/agents/:agentId
registerPath({
  method: 'patch',
  path: '/api/agents/{agentId}',
  tags: ['Agents'],
  summary: 'Partially update an agent',
  description:
    'Omitted keys preserve the existing value. `browserViewportWidth` / `browserViewportHeight` / `browserPageLoadTimeoutMs` accept `null` to clear the override.',
  request: {
    params: agentIdParams,
    body: { content: jsonContent(UpdateAgentRequestSchema) },
  },
  responses: {
    200: { description: 'Updated agent.', content: jsonContent(AgentEnrichedComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Agent not found.'),
  },
});

// DELETE /api/agents/:agentId
registerPath({
  method: 'delete',
  path: '/api/agents/{agentId}',
  tags: ['Agents'],
  summary: 'Hard-delete an agent and its dependent rows',
  description:
    'Stops the in-memory heartbeat, transactionally clears every child store keyed by `agent_id` (sessions cascade messages/delegations/handoffs/skill_invocations/background_tasks/message_queue/checkpoints via FK ON DELETE CASCADE), drops the agent from `projects.json`, refreshes the project room, and best-effort removes the on-disk agent workspace. Returns 204 on success.',
  request: { params: agentIdParams },
  responses: {
    204: { description: 'Agent and dependent rows removed.' },
    404: errorResponse('Agent not found.'),
    500: errorResponse('Internal cleanup failure.'),
  },
});

// POST /api/agents/bulk-engine
registerPath({
  method: 'post',
  path: '/api/agents/bulk-engine',
  tags: ['Agents'],
  summary: 'Bulk-set per-user engine + model overrides for every visible agent',
  description:
    "Requires authentication. Writes the caller's own `agentEngineOverrides` and `agentModelOverrides` for every agent in projects they can view — never the shared `agents` row. Falls back to the engine's default model when `model` is missing or not in the engine's allowlist.",
  request: { body: { content: jsonContent(BulkEngineRequestSchema) } },
  responses: {
    200: {
      description: 'Bulk-engine result.',
      content: jsonContent(BulkEngineResponseComponent),
    },
    400: errorResponse('Validation failed or unknown engine.'),
    401: errorResponse('Authentication required.'),
  },
});

// PUT /api/agents/:agentId/memory
registerPath({
  method: 'put',
  path: '/api/agents/{agentId}/memory',
  tags: ['Agents'],
  summary: 'Replace the agent memory file (MEMORY.md) contents',
  request: {
    params: agentIdParams,
    body: { content: jsonContent(UpdateAgentMemoryRequestSchema) },
  },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
    400: errorResponse('Validation failed or workspace not configured.'),
    404: errorResponse('Agent not found.'),
  },
});
