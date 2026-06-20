/**
 * Zod schemas + OpenAPI registrations for the Skill Builder eval routes
 * (Phase 3 — eval-driven test loop). Side-effect `registerPath` calls land in
 * `docs/api/openapi.yaml` via `server/openapi/generate.ts`, which imports every
 * `routes/*.ts` module. Keeps `routes/skill-evals.ts` focused on handlers.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { EVAL_ASSERTION_TYPES } from '../skill-evals.js';

const AssertionSchema = z
  .object({
    type: z.enum(EVAL_ASSERTION_TYPES).openapi({
      description:
        'Check kind. `contains`/`not_contains` are case-sensitive substring; `icontains` is case-insensitive; `regex` is a JS regular-expression source matched against the output.',
    }),
    value: z.string().openapi({ example: 'cd server && npx vitest' }),
  })
  .strict()
  .openapi({ description: 'One objective pass/fail check applied to a run output.' });

const EvalSchema = z
  .object({
    id: z.string().openapi({
      description: 'Slug id (lowercase letters, digits, hyphens) — lets a single eval be re-run.',
      example: 'happy-path',
    }),
    prompt: z.string().openapi({
      description: 'Realistic user prompt fed identically to the with-skill and baseline runs.',
      example: 'How do I run only the server tests for the file I just edited?',
    }),
    assertions: z.array(AssertionSchema).optional().openapi({
      description:
        'Objective checks. Omit for a subjective eval that only gets a side-by-side diff (no auto pass/fail).',
    }),
  })
  .strict()
  .openapi({
    description:
      'A single eval: one prompt plus optional objective assertions. Unknown fields are rejected (a typo like "assertion" would otherwise silently drop the checks).',
  });

const EvalsBodySchema = registerComponent(
  'SkillEvalsBody',
  z
    .object({
      evals: z.array(EvalSchema),
      version: z.number().int().optional().openapi({
        description:
          'Optional, server-managed. The saved evals.json file carries `version` (currently 1); it is accepted here so the file can be round-tripped back verbatim, but clients normally send only `evals` and the server writes the canonical version.',
      }),
    })
    .openapi({ description: 'The eval suite for a skill (2-3 prompts is typical; max 10).' }),
);

const EvalsListSchema = registerComponent(
  'SkillEvalsList',
  z.object({ evals: z.array(EvalSchema) }).openapi({ description: 'The skill eval suite.' }),
);

const GradeSchema = z.object({
  graded: z.boolean(),
  passed: z.boolean(),
  assertionResults: z.array(
    z.object({
      assertion: AssertionSchema,
      passed: z.boolean(),
      timedOut: z.boolean().optional().openapi({
        description:
          'Set on a regex assertion aborted by the ReDoS time bound (treated as not matched).',
      }),
    }),
  ),
});

const VariantResultSchema = z.object({
  output: z.string(),
  grade: GradeSchema,
  error: z.string().optional(),
});

const EvalRunSummarySchema = registerComponent(
  'SkillEvalRunSummary',
  z
    .object({
      skillId: z.string(),
      total: z.number(),
      graded: z.number().openapi({ description: 'Count of evals with assertions (auto-graded).' }),
      withSkillPassed: z.number(),
      baselinePassed: z.number(),
      improvedCount: z
        .number()
        .openapi({ description: 'Objective evals that went baseline-fail → with-skill-pass.' }),
      results: z.array(
        z.object({
          evalId: z.string(),
          prompt: z.string(),
          graded: z.boolean(),
          withSkill: VariantResultSchema,
          baseline: VariantResultSchema,
          improved: z.boolean().nullable(),
        }),
      ),
      markdown: z
        .string()
        .openapi({ description: 'Rendered side-by-side report the coach surfaces / saves.' }),
      engine: z.string(),
      model: z.string(),
    })
    .openapi({ description: 'With-skill vs baseline run summary plus a Markdown report.' }),
);

const RunBodySchema = registerComponent(
  'SkillEvalRunBody',
  z
    .object({
      evals: z.array(EvalSchema).optional().openapi({
        description:
          'Inline eval suite to run instead of the saved evals.json — iterate on the suite without PUTting it first. Only skips saving the eval suite; the skill itself must already be saved (its SKILL.md is loaded from disk).',
      }),
      evalIds: z.array(z.string()).min(1).optional().openapi({
        description:
          'Restrict the run to these eval ids (single-prompt re-run). Must be non-empty when present — an empty array is a 400, not "run everything" (omit the field to run the whole suite). Every id must exist in the suite — a partial miss is a 400 listing the missing ids, never a silent run of the resolvable subset.',
      }),
      engine: z.enum(['claude-code', 'cursor-agent', 'codex-cli']).optional().openapi({
        description:
          'Engine to run on. Must be an agent CLI — Gemini is excluded. An unknown value is rejected (400). When set, this is the engine the run uses: if it is unavailable the request 400s rather than silently falling back to another CLI (which would make results misleading). Omit to fall back across the agent CLIs.',
      }),
      model: z.string().optional().openapi({ description: 'Model override (non-empty).' }),
      timeoutMs: z.number().int().optional().openapi({
        description:
          'Per-run timeout (ms). Must be an integer in [1000, 600000]; out of range is 400.',
      }),
    })
    .strict()
    .openapi({
      description:
        'Options for an eval run. All fields optional; unknown keys are rejected (400) so a typo cannot silently change the run.',
    }),
);

const ErrorResponse = registerComponent(
  'SkillEvalsError',
  z.object({ error: z.string(), code: z.string().optional() }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const params = z.object({
  projectId: z.string().openapi({ description: 'Project ID (slug).' }),
  skillId: z.string().openapi({ description: 'Project skill slug (folder id).' }),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/skills/{skillId}/evals',
  tags: ['Skills'],
  summary: 'Read a skill eval suite',
  description:
    'Returns the eval suite at `<project.ahw>/skills/<skillId>/evals/evals.json`. An absent file yields `{ evals: [] }`. A present-but-invalid file returns 422.',
  request: { params },
  responses: {
    200: { description: 'The eval suite.', content: jsonContent(EvalsListSchema) },
    400: errorResponse('No workspace / invalid skill id.'),
    404: errorResponse('Project or skill not found.'),
    422: errorResponse('evals.json present but invalid.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/skills/{skillId}/evals',
  tags: ['Skills'],
  summary: 'Write a skill eval suite',
  description:
    'Validates and writes the eval suite to `evals/evals.json`. Eval ids must be unique slugs; each prompt is required; assertions are optional objective checks (`regex` patterns are compiled at write time).',
  request: { params, body: { content: jsonContent(EvalsBodySchema) } },
  responses: {
    200: { description: 'The written eval suite.', content: jsonContent(EvalsListSchema) },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher (project mutation).'),
    404: errorResponse('Project or skill not found.'),
    500: errorResponse('Filesystem write error.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/skills/{skillId}/evals/run',
  tags: ['Skills'],
  summary: 'Run a skill eval suite (with-skill vs baseline)',
  description:
    "Runs each eval prompt twice — once with the skill's SKILL.md injected as the system prompt (with-skill) and once without (baseline) — grades both against the eval assertions, and returns a structured summary plus a rendered Markdown report. Uses the saved evals.json unless an inline `evals` array is supplied. Gemini is excluded from the engine fallback chain.",
  request: { params, body: { content: jsonContent(RunBodySchema) } },
  responses: {
    200: { description: 'Run summary + report.', content: jsonContent(EvalRunSummarySchema) },
    400: errorResponse(
      'No evals defined / body validation failed / unknown evalIds / requested engine unavailable.',
    ),
    401: errorResponse('Authentication required.'),
    403: errorResponse('Requires the Admin role or higher (spawns agent CLIs).'),
    404: errorResponse('Project, skill, or SKILL.md not found.'),
    422: errorResponse('Saved evals.json invalid.'),
    500: errorResponse('Spawn / runtime error.'),
  },
});
