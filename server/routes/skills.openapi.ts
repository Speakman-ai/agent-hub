/**
 * Zod schemas + OpenAPI registrations for the write-side project skill routes
 * (Skill Builder, Phase 1).
 *
 * Imported for two reasons (same contract as the other `*.openapi.ts`
 * companions):
 *   1. `server/openapi/generate.ts` imports every `routes/*.ts` module so the
 *      side-effect `registerPath` calls land in `docs/api/openapi.yaml`.
 *   2. Keeps `routes/skills.ts` readable — the route file owns the handlers,
 *      this file owns the published contract.
 *
 * Only the new POST/PUT write routes are registered here; the legacy
 * read/delete/toggle routes remain pre-existing coverage debt tracked in
 * `scripts/openapi-coverage-baseline.json`.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { ALLOWED_SKILL_CATEGORIES } from '../skill-write.js';

const SkillCredentialSpecSchema = z
  .object({
    name: z.string().openapi({
      description: 'POSIX env var name the credential is injected as.',
      example: 'LINEAR_API_KEY',
    }),
    label: z.string().optional(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    type: z.enum(['string', 'secret', 'file', 'json']).optional(),
    docs_url: z.string().optional(),
  })
  .openapi({ description: 'A single declarative credential the skill needs at spawn time.' });

// ─── Field fragments shared by every request variant ────────────────────
//
// The runtime contract (`validateAndComposeSkill`) accepts the skill identity
// (`name`) + `description` either as explicit structured fields OR parsed out
// of a raw `content` SKILL.md string. The published schema must model that as
// a union so generated clients/docs don't reject a valid `content`-only
// request — making the two identity fields blanket-required misrepresents the
// API. `z.union` emits an `anyOf` (not `oneOf`), which is the correct operator
// here: a body that carries BOTH structured fields and `content` legitimately
// satisfies both variants, and `oneOf` would reject that as ambiguous. Each
// variant below sets only the fields it genuinely requires; the rest are
// shared optionals.

const nameField = z.string().openapi({
  description:
    'Skill slug + frontmatter name: lowercase letters, digits and hyphens. On PUT it must match the `:skillId` path segment (rename is not supported).',
  example: 'jira-triage',
});
const descriptionField = z.string().openapi({
  description:
    'Trigger text — the single most important field. State WHAT the skill does and WHEN to use it.',
  example: 'Triage Jira issues. TRIGGER when the user mentions Jira tickets or sprint triage.',
});
const contentField = z.string().openapi({
  description:
    'Raw SKILL.md text (frontmatter + body). Its parsed frontmatter supplies any structured field omitted from the body; explicit fields win. Lets a minimal editor post a single textarea. The frontmatter MUST still yield a valid `name` (slug) and `description`. Frontmatter keys the server does not manage (anything other than name/description/category/version/credentials/keep-coding-instructions) are preserved verbatim, so fetching the raw file and PUTting it back is lossless.',
});

// Optional fields common to every variant (kept as a spreadable shape).
const sharedOptionalFields = {
  category: z
    .enum(ALLOWED_SKILL_CATEGORIES)
    .optional()
    .openapi({ description: 'Skill category. Defaults to `general`.' }),
  version: z.string().optional().openapi({ description: 'Optional semver-ish version string.' }),
  body: z
    .string()
    .optional()
    .openapi({ description: 'Markdown body of SKILL.md (no YAML frontmatter block).' }),
  keepCodingInstructions: z
    .boolean()
    .optional()
    .openapi({ description: 'Emit `keep-coding-instructions: true` in the frontmatter.' }),
  credentials: z
    .array(SkillCredentialSpecSchema)
    .optional()
    .openapi({ description: 'Optional declarative credentials injected at spawn time.' }),
};

// Variant A — structured fields supply the identity. `content` may still be
// included (explicit fields win over its parsed frontmatter).
const StructuredCreateVariant = z
  .object({
    name: nameField,
    description: descriptionField,
    content: contentField.optional(),
    ...sharedOptionalFields,
  })
  .openapi({
    title: 'StructuredSkillWrite',
    description: 'Structured form: `name` and `description` supplied explicitly.',
  });

// Variant B — a raw `content` SKILL.md supplies the identity via frontmatter.
// Structured fields are optional overrides.
const RawContentVariant = z
  .object({
    content: contentField,
    name: nameField.optional(),
    description: descriptionField.optional(),
    ...sharedOptionalFields,
  })
  .openapi({
    title: 'RawContentSkillWrite',
    description:
      'Raw form: a `content` SKILL.md string whose frontmatter carries name/description.',
  });

const CreateSkillBodySchema = registerComponent(
  'CreateSkillBody',
  z.union([StructuredCreateVariant, RawContentVariant]).openapi({
    description:
      'Create a project skill. Provide EITHER structured fields (`name` + `description` required) OR a raw `content` SKILL.md whose frontmatter yields a valid `name` + `description`. Either way the server validates the resolved frontmatter and returns 400 on a missing/invalid `name` or `description`.',
  }),
);

// On PUT the folder id comes from the `:skillId` path, so `name` need not be
// repeated in the structured form (when present it must match the path).
const StructuredUpdateVariant = z
  .object({
    description: descriptionField,
    name: nameField.optional(),
    content: contentField.optional(),
    ...sharedOptionalFields,
  })
  .openapi({
    title: 'StructuredSkillUpdate',
    description:
      'Structured form: `description` required; `name` optional (resolved from the path, must match when given).',
  });

const UpdateSkillBodySchema = registerComponent(
  'UpdateSkillBody',
  z.union([StructuredUpdateVariant, RawContentVariant]).openapi({
    description:
      'Update a project skill. Provide EITHER structured fields (`description` required; `name` optional, resolved from the path) OR a raw `content` SKILL.md. The resolved frontmatter is validated and returns 400 on a missing/invalid `description` (or a `name` that disagrees with the path).',
  }),
);

const SkillWriteResultSchema = registerComponent(
  'SkillWriteResult',
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      path: z.string().openapi({ description: 'Absolute path to the skill directory on disk.' }),
    })
    .openapi({ description: 'The created / updated project skill.' }),
);

const SkillErrorResponse = registerComponent(
  'SkillWriteError',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(SkillErrorResponse),
});

const projectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project ID (slug).' }),
});

const ProjectSkillListItemSchema = registerComponent(
  'ProjectSkillListItem',
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      category: z.string().optional(),
      source: z.enum(['project', 'global', 'default']),
    })
    .openapi({
      description: 'A project-authored skill in `<dataDir>/project-skills/<projectId>`.',
    }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/skills',
  tags: ['Skills'],
  summary: 'List project skills library',
  description:
    'Returns project-authored skills only (`<dataDir>/project-skills/<projectId>`). Built-in and shared global skills are listed via `GET /api/global-skills`.',
  request: { params: projectIdParam },
  responses: {
    200: {
      description: 'Project-authored skills.',
      content: jsonContent(z.array(ProjectSkillListItemSchema)),
    },
    404: errorResponse('Project not found.'),
    500: errorResponse('Filesystem read error.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/skills',
  tags: ['Skills'],
  summary: 'Create a project skill',
  description:
    'Validates the author payload, composes a canonical `SKILL.md` (YAML frontmatter + Markdown body), and writes it to `<dataDir>/project-skills/<projectId>/<slug>/SKILL.md`. Accepts EITHER structured fields (`name` + `description`) OR a raw `content` SKILL.md whose frontmatter carries them. Rejects a slug that shadows a bundled default skill (409) or an already-existing project skill (409 — use PUT). Invalid frontmatter (bad slug, missing description, disallowed category, malformed credentials) returns 400.',
  request: { params: projectIdParam, body: { content: jsonContent(CreateSkillBodySchema) } },
  responses: {
    201: { description: 'Skill created.', content: jsonContent(SkillWriteResultSchema) },
    400: errorResponse('Request body validation failed.'),
    404: errorResponse('Project not found.'),
    409: errorResponse('Slug collides with a bundled default or an existing project skill.'),
    500: errorResponse('Filesystem write error.'),
  },
});

// ─── Global (shared) skills ───────────────────────────────────────────────
// Same write contract as project skills, but the skill lands in the writable
// global tier (`<dataDir>/skills/<slug>`) and is visible to every agent in
// every project. Precedence on a same-id conflict: project > global > bundled
// default. See server/global-skills-dir.ts.

const GlobalSkillListItemSchema = registerComponent(
  'GlobalSkillListItem',
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      path: z.string(),
      source: z.enum(['global', 'default']),
    })
    .openapi({ description: 'A built-in or user-authored global (shared) skill.' }),
);

const GlobalSkillDetailSchema = registerComponent(
  'GlobalSkillDetail',
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      content: z.string().openapi({ description: 'Raw SKILL.md text (frontmatter + body).' }),
      path: z.string(),
      credentials: z.array(SkillCredentialSpecSchema),
      source: z.literal('global'),
    })
    .openapi({ description: 'A single global skill with its raw SKILL.md content.' }),
);

const GlobalSkillWriteResultSchema = registerComponent(
  'GlobalSkillWriteResult',
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      path: z.string().openapi({ description: 'Absolute path to the skill directory on disk.' }),
      source: z
        .literal('global')
        .openapi({ description: 'Always `global` — lets clients pick the global delete path.' }),
    })
    .openapi({ description: 'The created / updated global (shared) skill.' }),
);

const skillIdParam = z.object({
  skillId: z.string().openapi({ description: 'Global skill slug (folder id).' }),
});

registerPath({
  method: 'get',
  path: '/api/global-skills',
  tags: ['Skills'],
  summary: 'List global skills catalog',
  description:
    'Returns the shared skills catalog: user-authored global skills (`<dataDir>/skills`) plus bundled built-in defaults. Project-authored skills are listed per project via `GET /api/projects/{projectId}/skills`.',
  responses: {
    200: {
      description: 'Global skills catalog (shared + built-in).',
      content: jsonContent(z.array(GlobalSkillListItemSchema)),
    },
    500: errorResponse('Filesystem read error.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/global-skills/{skillId}',
  tags: ['Skills'],
  summary: 'Get a global skill',
  description: "Returns a single global skill's raw SKILL.md content (for editing).",
  request: { params: skillIdParam },
  responses: {
    200: { description: 'Global skill.', content: jsonContent(GlobalSkillDetailSchema) },
    400: errorResponse('Invalid skill id or malformed credentials frontmatter.'),
    404: errorResponse('Global skill not found.'),
    500: errorResponse('Filesystem read error.'),
    503: errorResponse('Global skills directory unavailable (server data dir not configured).'),
  },
});

registerPath({
  method: 'post',
  path: '/api/global-skills',
  tags: ['Skills'],
  summary: 'Create a global (shared) skill',
  description:
    'Validates the author payload, composes a canonical `SKILL.md`, and writes it to `<dataDir>/skills/<slug>/SKILL.md`. Accepts EITHER structured fields (`name` + `description`) OR a raw `content` SKILL.md. Rejects a slug that shadows a bundled default skill (409) or an existing global skill (409 — use PUT). Invalid frontmatter returns 400.',
  request: { body: { content: jsonContent(CreateSkillBodySchema) } },
  responses: {
    201: { description: 'Skill created.', content: jsonContent(GlobalSkillWriteResultSchema) },
    400: errorResponse('Request body validation failed.'),
    409: errorResponse('Slug collides with a bundled default or an existing global skill.'),
    500: errorResponse('Filesystem write error.'),
    503: errorResponse('Global skills directory unavailable (server data dir not configured).'),
  },
});

registerPath({
  method: 'put',
  path: '/api/global-skills/{skillId}',
  tags: ['Skills'],
  summary: 'Update a global (shared) skill',
  description:
    "Rewrites an existing global skill's `SKILL.md`. A body `name` (or `content` frontmatter name) must equal the `:skillId` path segment — rename is not supported. Rejects bundled-default ids (409) and unknown global skills (404). Invalid frontmatter returns 400.",
  request: { params: skillIdParam, body: { content: jsonContent(UpdateSkillBodySchema) } },
  responses: {
    200: { description: 'Skill updated.', content: jsonContent(GlobalSkillWriteResultSchema) },
    400: errorResponse('Request body validation failed.'),
    404: errorResponse('Global skill not found.'),
    409: errorResponse('Slug is a bundled default skill.'),
    500: errorResponse('Filesystem write error.'),
    503: errorResponse('Global skills directory unavailable (server data dir not configured).'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/global-skills/{skillId}',
  tags: ['Skills'],
  summary: 'Delete a global (shared) skill',
  description: 'Removes a global skill directory from `<dataDir>/skills`.',
  request: { params: skillIdParam },
  responses: {
    200: { description: 'Deleted.', content: jsonContent(z.object({ ok: z.boolean() })) },
    400: errorResponse('Invalid skill id.'),
    500: errorResponse('Filesystem error.'),
    503: errorResponse('Global skills directory unavailable (server data dir not configured).'),
  },
});

const ProjectSkillDetailSchema = registerComponent(
  'ProjectSkillDetail',
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      content: z.string().openapi({ description: 'Raw SKILL.md text (frontmatter + body).' }),
      path: z.string(),
      credentials: z.array(SkillCredentialSpecSchema),
      source: z.literal('project'),
    })
    .openapi({ description: 'A single project-authored skill with its raw SKILL.md content.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/skills/{skillId}',
  tags: ['Skills'],
  summary: 'Read a project skill',
  description:
    "Returns a single project-authored skill's raw `SKILL.md` (frontmatter + body) plus its credential schema. Project-owned read — does NOT require an agent and does NOT fall back to bundled defaults, so the editor can load a project skill even for an agentless project. Resolves directory (`<slug>/SKILL.md`) or flat (`<slug>.md`) form.",
  request: {
    params: projectIdParam.extend({
      skillId: z.string().openapi({ description: 'Project skill slug (folder id).' }),
    }),
  },
  responses: {
    200: {
      description: 'The project skill with its raw SKILL.md content.',
      content: jsonContent(ProjectSkillDetailSchema),
    },
    400: errorResponse('Invalid skill id or malformed credentials frontmatter.'),
    404: errorResponse('Project or project skill not found.'),
    500: errorResponse('Filesystem read error.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/skills/{skillId}',
  tags: ['Skills'],
  summary: 'Update a project skill',
  description:
    "Rewrites an existing project skill's `SKILL.md` (frontmatter + body). Accepts EITHER structured fields (`description` required; `name` optional, resolved from the path) OR a raw `content` SKILL.md. A body `name` (or `content` frontmatter name) must equal the `:skillId` path segment — rename is not supported. Rejects bundled-default ids (409) and unknown project skills (404). Invalid frontmatter returns 400.",
  request: {
    params: projectIdParam.extend({
      skillId: z.string().openapi({ description: 'Project skill slug (folder id).' }),
    }),
    body: { content: jsonContent(UpdateSkillBodySchema) },
  },
  responses: {
    200: { description: 'Skill updated.', content: jsonContent(SkillWriteResultSchema) },
    400: errorResponse('Request body validation failed.'),
    404: errorResponse('Project or project skill not found.'),
    409: errorResponse('Slug is a bundled default skill.'),
    500: errorResponse('Filesystem write error.'),
  },
});
