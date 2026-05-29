/**
 * Zod schemas + OpenAPI registrations for the Finalize ci.yaml setup
 * wizard routes (mirrors preview-wizard's split).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'FinalizeWizardErrorResponse',
  z
    .object({ error: z.string(), message: z.string().optional() })
    .openapi({ description: 'Error envelope for finalize wizard routes.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

// ─── /finalize/setup-wizard ──────────────────────────────────────────

const FinalizeSetupSubproject = registerComponent(
  'FinalizeSetupSubproject',
  z
    .object({
      path: z.string().openapi({ description: '`"."` for the root, else POSIX-relative.' }),
      manifest: z.string(),
      manager: z.enum(['npm', 'pnpm', 'yarn', 'pip', 'poetry', 'cargo', 'go']).nullable(),
    })
    .openapi({ description: 'A detected sub-project (root + apps/* + packages/*).' }),
);

const FinalizeNpmScriptHit = registerComponent(
  'FinalizeNpmScriptHit',
  z
    .object({
      name: z.string(),
      body: z.string(),
      kind: z.enum(['test', 'lint', 'typecheck', 'build', 'format', 'other']),
    })
    .openapi({ description: 'Top-level package.json script bucketed by name + body.' }),
);

const FinalizeSetupDraftSchema = registerComponent(
  'FinalizeSetupDraft',
  z
    .object({
      existingCi: z.boolean(),
      existingCiContent: z.string().nullable(),
      stack: z.enum(['node', 'python', 'rust', 'go', 'mixed', 'unknown']),
      packageManager: z.enum(['npm', 'pnpm', 'yarn', 'pip', 'poetry', 'cargo', 'go']).nullable(),
      isMonorepo: z.boolean(),
      subprojects: z.array(FinalizeSetupSubproject),
      githubWorkflows: z.array(z.string()),
      makefileTargets: z.array(z.string()),
      npmScripts: z.array(FinalizeNpmScriptHit),
      readme: z.object({
        readmePath: z.string().nullable(),
        setupExcerpt: z.string().nullable(),
        hasDockerHints: z.boolean(),
        envKeysFromReadme: z.array(z.string()),
      }),
      envVars: z.array(
        z.object({
          key: z.string(),
          sources: z.array(z.string()),
          required: z.boolean(),
        }),
      ),
      proposedCiYaml: z.string(),
    })
    .openapi({
      description:
        'Server-precomputed signal for the Finalize ci.yaml setup wizard. `proposedCiYaml` always parses against the v1 schema.',
    }),
);

const FinalizeWizardStartResponse = registerComponent(
  'FinalizeWizardStartResponse',
  z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      draft: FinalizeSetupDraftSchema,
      session: z
        .unknown()
        .openapi({ description: 'Raw `sessions` row for the spawned wizard session.' }),
    })
    .openapi({ description: 'Wizard session spawned successfully.' }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/setup-wizard',
  tags: ['Finalize'],
  summary: 'Spawn the Finalize ci.yaml setup wizard',
  description: [
    'Admin+. Scans the project (README, package manifests, .github/workflows,',
    'Makefile, package.json scripts) and spawns a one-shot chat session loaded',
    'with the `finalize-setup` skill. The pre-built `proposedCiYaml` always',
    'parses against the v1 schema.',
  ].join('\n'),
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(z.object({}).openapi({ description: 'Body is empty.' })) },
  },
  responses: {
    201: {
      description: 'Wizard session spawned.',
      content: jsonContent(FinalizeWizardStartResponse),
    },
    400: errorResponse('Project has no cwd configured, or no agents to host the wizard.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Wizard agent could not be resolved.'),
  },
});

// ─── /finalize/setup-apply ───────────────────────────────────────────

const FinalizeSetupApplyRequest = registerComponent(
  'FinalizeSetupApplyRequest',
  z
    .object({
      ci_yaml_content: z.string().openapi({
        description: 'Verbatim `.agent-hub/ci.yaml` to commit. Validated against the v1 parser.',
      }),
      session_id: z.string().optional().openapi({
        description:
          'Optional explicit target session id. When omitted the server picks the most-recent project session that has a worktree.',
      }),
    })
    .openapi({ description: 'Apply payload for the Finalize ci.yaml wizard.' }),
);

const FinalizeSetupApplyResponse = registerComponent(
  'FinalizeSetupApplyResponse',
  z
    .object({
      ok: z.literal(true),
      file: z.string().openapi({ description: 'Relative path of the committed file.' }),
      commit_sha: z.string(),
      branch: z.string(),
      session_id: z.string(),
    })
    .openapi({ description: 'Commit landed on the worktree branch.' }),
);

const FinalizeSetupApplyInvalidConfig = registerComponent(
  'FinalizeSetupApplyInvalidConfig',
  z
    .object({
      error: z.literal('ci_config_invalid'),
      code: z.string(),
      message: z.string(),
      path: z.string().nullable(),
    })
    .openapi({
      description:
        'YAML failed the v1 schema. `code` is the `CiConfigErrorCode` from `server/finalize/ci-config.ts`; `path` is the offending dotted field path when meaningful.',
    }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/setup-apply',
  tags: ['Finalize'],
  summary: 'Commit a wizard-generated ci.yaml to the worktree',
  description: [
    'Admin+. Validates `ci_yaml_content` against the v1 schema, writes',
    '`<worktree>/.agent-hub/ci.yaml`, and commits the file to the worktree',
    "branch. The target worktree is the request body's `session_id` when",
    'supplied, else the most-recent project session that has one.',
  ].join('\n'),
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(FinalizeSetupApplyRequest) },
  },
  responses: {
    200: {
      description: 'Committed.',
      content: jsonContent(FinalizeSetupApplyResponse),
    },
    400: {
      description:
        'Payload invalid: missing content, invalid v1 schema, no worktree-bearing session found, or worktree path is unreadable.',
      content: jsonContent(z.union([ErrorResponse, FinalizeSetupApplyInvalidConfig])),
    },
    404: errorResponse('Project not found.'),
    500: errorResponse('Write or commit failed.'),
  },
});

// ─── /finalize/wizard-complete ───────────────────────────────────────

const FinalizeWizardCompleteResponse = registerComponent(
  'FinalizeWizardCompleteResponse',
  z.object({ ok: z.literal(true) }).openapi({ description: 'Acknowledgement envelope.' }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/wizard-complete',
  tags: ['Finalize'],
  summary: 'Notify the UI that the Finalize wizard has finished',
  description:
    'User+. Broadcasts `finalize_wizard_complete` for the Settings panel so it can refresh state.',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(z.object({}).openapi({ description: 'Body is empty.' })) },
  },
  responses: {
    200: {
      description: 'Acknowledged.',
      content: jsonContent(FinalizeWizardCompleteResponse),
    },
    404: errorResponse('Project not found (silent — broadcast is a no-op).'),
  },
});
