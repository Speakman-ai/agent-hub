/**
 * Zod schemas + OpenAPI registrations for the crons route group.
 *
 * This module is imported for two reasons:
 *
 *   1. `server/routes/crons.ts` imports the exported request schemas and
 *      uses `safeParse(...)` to validate incoming bodies. The handlers
 *      keep their downstream logic (model allowlist check via
 *      `normalizeCronModel`, skill principal cross-reference,
 *      reschedule, …) — only the hand-rolled `if (!field) return 400`
 *      and `try/catch normalize*` blocks are replaced with Zod.
 *
 *   2. `server/openapi/generate.ts` walks `server/routes/*.ts` and
 *      imports every module to trigger the side-effect `registerPath` /
 *      `registerComponent` calls below. The crons section of the
 *      generated `docs/api/openapi.yaml` comes out of this file.
 *
 * Design notes:
 *
 * - **Cron-expression validation lives in the schema.** A custom Zod
 *   refinement runs `cron.validate(...)` from `node-cron` on the
 *   `schedule` field so an invalid expression returns 400 from the
 *   generic `parseBody` chokepoint instead of bubbling out of
 *   `rescheduleCron` later.
 *
 * - **`timeout_ms` accepts `number | null | ""`.** The pre-Zod
 *   `normalizeTimeoutMs` rejected booleans, non-integers, and
 *   non-positive values — Zod replicates that. `null` and empty string
 *   both mean "use default", which the handler folds together.
 *
 * - **`notify_on_run` accepts boolean / 0 / 1 / "0" / "1" / "true" /
 *   "false".** The pre-Zod `normalizeNotifyOnRun` accepted this loose
 *   shape; clients have been observed sending each variant. We keep the
 *   loose accept and let the handler coerce to 0/1.
 *
 * - **Cross-field validations stay in the handler.** Two checks need
 *   request-time data Zod can't see:
 *     1. `model` against `config.engineValidModels['claude-code']` —
 *        validated by `normalizeCronModel` in the handler.
 *     2. `skill_principal_agent_id` membership in the cron project —
 *        validated by `assertCronSkillPrincipalMatchesProject`.
 *
 * - **Unknown keys are passed through** (no `.strict()`) since the
 *   pre-Zod handler iterated a known field list and silently ignored
 *   the rest.
 */

import cron from 'node-cron';
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { ALL_SUPPORTED_ENGINES } from '../engine-availability.js';

// ─── Custom refinements ──────────────────────────────────────────

const cronExpression = z
  .string({ error: 'schedule must be a valid cron expression' })
  .refine((s) => cron.validate(s), {
    message: 'schedule must be a valid cron expression',
  });

/**
 * `timeout_ms` accepts:
 *   - a positive integer (the override)
 *   - null (use default)
 *   - empty string `""` (use default — for compatibility with form encodings)
 *
 * Booleans, floats, NaN, ≤0 are rejected with a 400.
 */
const timeoutMs = z
  .union([
    z.literal(''),
    z.null(),
    z
      .number({ error: 'timeout_ms must be a positive integer (milliseconds)' })
      .int('timeout_ms must be a positive integer (milliseconds)')
      .positive('timeout_ms must be a positive integer (milliseconds)'),
  ])
  .optional();

/**
 * `notify_on_run` accepts boolean, 0/1, "0"/"1", "true"/"false". The
 * handler coerces the parsed value to 0/1.
 */
const notifyOnRun = z
  .union(
    [
      z.boolean(),
      z.literal(0),
      z.literal(1),
      z.literal('0'),
      z.literal('1'),
      z.literal('true'),
      z.literal('false'),
    ],
    { error: 'notify_on_run must be a boolean' },
  )
  .optional();

const sharedFlag = z
  .union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')], {
    error: 'shared must be a boolean',
  })
  .optional();

// ─── Domain component schemas (response shapes) ──────────────────

export const CronComponent = registerComponent(
  'Cron',
  z
    .object({
      id: z.number().int(),
      name: z.string(),
      schedule: z.string(),
      prompt: z.string(),
      cwd: z.string(),
      enabled: z.number().int(),
      last_run: z.string().nullable(),
      last_result: z.string().nullable(),
      next_run_at: z.string().nullable(),
      project_id: z.string().nullable(),
      timeout_ms: z.number().int().nullable(),
      notify_on_run: z.number().int(),
      model: z.string().nullable(),
      skill_principal_agent_id: z.string().nullable(),
      engine: z.string().nullable(),
      owner_user_id: z.string().nullable(),
      owner_username: z.string().nullable().optional(),
      shared: z.number().int(),
      can_manage: z.boolean().optional(),
      created_at: z.string(),
    })
    .openapi({
      description:
        'A cron job row. Booleans (`enabled`, `notify_on_run`, `shared`) are stored as 0/1 SQLite ints. `timeout_ms`, `model`, `project_id`, `skill_principal_agent_id`, `engine`, `owner_user_id` are nullable to mean "use default" / legacy system-owned. `engine` falls back to the skill principal agent\'s engine, then to `claude-code`; `owner_user_id` controls the spawn HOME for scheduled runs. `shared=1` makes the cron visible to the org while execution still uses the owner.',
    }),
);

export const CronLogComponent = registerComponent(
  'CronLog',
  z
    .object({
      id: z.number().int(),
      cron_id: z.number().int(),
      timestamp: z.string(),
      status: z.enum(['pending', 'running', 'success', 'error']),
      result: z.string().nullable(),
      duration_ms: z.number().int().nullable(),
    })
    .openapi({ description: 'A single cron run log row.' }),
);

export const CronThreadComponent = registerComponent(
  'CronThreadResponse',
  z
    .object({
      thread: z.unknown().nullable(),
      entries: z.array(z.unknown()),
    })
    .openapi({
      description:
        'Cron thread (persistent output log). Both `thread` and `entries` come back null/empty when the cron has no project association or no run has produced a thread yet.',
    }),
);

export const CronRunAckComponent = registerComponent(
  'CronRunAck',
  z
    .object({ status: z.literal('running') })
    .openapi({ description: 'Acknowledgment from POST /api/crons/:id/run.' }),
);

export const CronDeleteAckComponent = registerComponent(
  'CronDeleteAck',
  z.object({ ok: z.literal(true) }).openapi({ description: 'Delete acknowledgment.' }),
);

export const CronErrorResponseComponent = registerComponent(
  'CronErrorResponse',
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
 * `engine` accepts one of `ALL_SUPPORTED_ENGINES`, null, or empty string
 * (= "use default / inherit from skill principal at run time"). Loose
 * accept on the wire to match the rest of the cron fields; the handler
 * (`normalizeCronEngine`) does the strict allowlist check so that the
 * 400 error message can list the valid engine ids.
 */
const cronEngine = z
  .union([z.string(), z.null(), z.literal('')])
  .nullable()
  .optional();

/**
 * POST /api/crons — create a cron job.
 *
 * Required: `name`, `schedule` (valid cron expression), `prompt`. All
 * other fields are optional and default at the storage layer.
 */
export const CreateCronRequestSchema = z.object({
  name: z
    .string({ error: 'name, schedule, and prompt are required' })
    .min(1, 'name, schedule, and prompt are required'),
  schedule: cronExpression,
  prompt: z
    .string({ error: 'name, schedule, and prompt are required' })
    .min(1, 'name, schedule, and prompt are required'),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
  project_id: z.string().nullable().optional(),
  timeout_ms: timeoutMs,
  notify_on_run: notifyOnRun,
  shared: sharedFlag,
  model: z.string().nullable().optional(),
  skill_principal_agent_id: z.string().nullable().optional(),
  engine: cronEngine,
});

/**
 * PUT /api/crons/:id — partial update. Every field is optional;
 * omitted fields preserve the existing row value.
 *
 * Note: the legacy handler accepted `schedule = ""` as "preserve", since
 * the storage write used `schedule || existing.schedule`. We mirror that
 * by allowing empty string OR a valid cron expression.
 */
export const UpdateCronRequestSchema = z.object({
  name: z.string().optional(),
  schedule: z
    .string()
    .refine((s) => s === '' || cron.validate(s), {
      message: 'schedule must be a valid cron expression',
    })
    .optional(),
  prompt: z.string().optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
  project_id: z.string().nullable().optional(),
  timeout_ms: timeoutMs,
  notify_on_run: notifyOnRun,
  shared: sharedFlag,
  model: z.string().nullable().optional(),
  skill_principal_agent_id: z.string().nullable().optional(),
  engine: cronEngine,
});

// ─── OpenAPI path registrations ───────────────────────────────────

const cronIdParams = z.object({
  id: z.string().openapi({ description: 'Cron job numeric id (URL string).' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(CronErrorResponseComponent),
});

// GET /api/crons
registerPath({
  method: 'get',
  path: '/api/crons',
  tags: ['Crons'],
  summary: 'List visible cron jobs',
  description:
    'Returns shared crons, crons owned by the caller, and all crons for org Owners. Private crons are hidden from other non-Owner users.',
  responses: {
    200: { description: 'Array of cron jobs.', content: jsonContent(z.array(CronComponent)) },
  },
});

// POST /api/crons
registerPath({
  method: 'post',
  path: '/api/crons',
  tags: ['Crons'],
  summary: 'Create a new cron job',
  description: `\`schedule\` must be a valid cron expression. The cron owner is the authenticated caller. \`shared\` defaults to false; when true the cron is visible to the org but still executes under the owner's credentials. \`engine\` (when provided) must be one of: ${ALL_SUPPORTED_ENGINES.join(', ')} — when omitted/null, the cron inherits its engine from the resolved skill principal agent at run time, falling back to \`claude-code\`. \`model\` is validated against \`engineValidModels[engine]\` for whichever engine the cron resolves to. \`skill_principal_agent_id\` (when provided) must be an agent in the cron's project.`,
  request: { body: { content: jsonContent(CreateCronRequestSchema) } },
  responses: {
    200: { description: 'Created cron.', content: jsonContent(CronComponent) },
    400: errorResponse('Validation failed.'),
  },
});

// PUT /api/crons/:id
registerPath({
  method: 'put',
  path: '/api/crons/{id}',
  tags: ['Crons'],
  summary: 'Update a cron job',
  description:
    'Owner or cron owner only. Omitted fields preserve the existing value. `timeout_ms` / `notify_on_run` / `model` / `skill_principal_agent_id` / `engine` follow the present-key tristate (`undefined` = preserve, `null`/`""` = clear). `shared` toggles org-wide visibility without changing execution owner. When `engine` changes and an existing `model` is no longer valid for the new engine, the model is cleared (the user can resend a compatible value in the same PUT).',
  request: {
    params: cronIdParams,
    body: { content: jsonContent(UpdateCronRequestSchema) },
  },
  responses: {
    200: { description: 'Updated cron.', content: jsonContent(CronComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Cron not found.'),
  },
});

// DELETE /api/crons/:id
registerPath({
  method: 'delete',
  path: '/api/crons/{id}',
  tags: ['Crons'],
  summary: 'Delete a cron job',
  description: 'Disables the in-memory schedule and removes the row.',
  request: { params: cronIdParams },
  responses: {
    200: { description: 'Delete ack.', content: jsonContent(CronDeleteAckComponent) },
  },
});

// GET /api/crons/:id/logs
registerPath({
  method: 'get',
  path: '/api/crons/{id}/logs',
  tags: ['Crons'],
  summary: 'List recent run logs for a cron',
  request: {
    params: cronIdParams,
    query: z.object({
      limit: z.string().optional().openapi({ description: 'Max rows (default 3, capped at 50).' }),
    }),
  },
  responses: {
    200: { description: 'Array of log rows.', content: jsonContent(z.array(CronLogComponent)) },
  },
});

// POST /api/crons/:id/run
registerPath({
  method: 'post',
  path: '/api/crons/{id}/run',
  tags: ['Crons'],
  summary: 'Trigger an immediate one-shot cron run',
  description: 'Returns immediately; the job runs asynchronously.',
  request: { params: cronIdParams },
  responses: {
    200: { description: 'Run ack.', content: jsonContent(CronRunAckComponent) },
    404: errorResponse('Cron not found.'),
  },
});

// GET /api/crons/:id/thread
registerPath({
  method: 'get',
  path: '/api/crons/{id}/thread',
  tags: ['Crons'],
  summary: 'Fetch the persistent output thread for a cron',
  request: { params: cronIdParams },
  responses: {
    200: {
      description: 'Thread + entries (both null/empty when no run has produced a thread yet).',
      content: jsonContent(CronThreadComponent),
    },
    404: errorResponse('Cron not found.'),
  },
});
