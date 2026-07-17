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

const FinalizeWizardResolvedTarget = registerComponent(
  'FinalizeWizardResolvedTarget',
  z
    .object({
      sessionId: z.string(),
      branch: z.string(),
      worktreePath: z.string(),
    })
    .openapi({
      description:
        'Legacy shape retained for response compatibility. The setup wizard now always returns `target: null` because the spawned session owns its own worktree (`use_worktree=1`) and passes its own `session_id` to `setup-apply`.',
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
      target: FinalizeWizardResolvedTarget.nullable().openapi({
        description:
          'Always `null`. The setup session owns its own worktree; there is no separate commit target to surface.',
      }),
    })
    .openapi({ description: 'Wizard session spawned successfully.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/environment-draft',
  tags: ['Finalize'],
  summary: 'Scan project for Finalize ci.yaml setup signals',
  description:
    'Admin+. Returns the same draft shape embedded in the setup wizard kickoff (stack, workflows, env vars, proposed ci.yaml). Used by Settings → Finalize to show required secrets without spawning a wizard session.',
  request: {
    params: z.object({ projectId: z.string() }),
  },
  responses: {
    200: {
      description: 'Draft scan result.',
      content: jsonContent(
        z.object({
          draft: FinalizeSetupDraftSchema,
          projectId: z.string(),
        }),
      ),
    },
    400: errorResponse('Project has no cwd configured.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/setup-wizard',
  tags: ['Finalize'],
  summary: 'Spawn the Finalize ci.yaml setup wizard',
  description: [
    'Admin+. Scans the project (README, package manifests, .github/workflows,',
    'Makefile, package.json scripts) and spawns a **worktree-backed** chat',
    'session (`use_worktree=1`) loaded with the `finalize-setup` skill. The',
    'session provisions its own git clone on a fresh `agent-hub/…` branch so',
    'the agent can author `.agent-hub/ci.yaml`, verify the pipeline locally,',
    'push, and open a PR. The pre-built `proposedCiYaml` is embedded in the',
    'kickoff prompt.',
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
          'Target session id whose worktree receives the commit. The setup wizard passes its own session id. When omitted the server picks the most-recent project session that has a worktree, or auto-provisions a dedicated `[Finalize Config]` worktree on a fresh branch when none exists.',
      }),
      secrets: z
        .object({
          env: z.string().openapi({ description: 'Dotenv blob (`KEY=value` lines).' }),
          mode: z.enum(['merge', 'replace']).optional(),
          defaultKind: z.enum(['plain', 'secret']).optional(),
        })
        .optional()
        .openapi({
          description:
            'Optional project secrets to persist (same shape as preview setup-apply). Merged into Finalize step runs.',
        }),
      storage: z.enum(['committed', 'server']).optional().openapi({
        description:
          "Where the config lives. Default 'committed' writes + commits `.agent-hub/ci.yaml`. 'server' stores it on the Agent Hub server (no file, no commit) — the response omits commit/branch fields.",
      }),
      server_scope: z.enum(['project', 'personal']).optional().openapi({
        description:
          "Only for `storage: 'server'`. 'project' (default) is the shared config; 'personal' is an override keyed to the calling user.",
      }),
    })
    .openapi({ description: 'Apply payload for the Finalize ci.yaml wizard.' }),
);

const FinalizeSetupApplyServerResponse = registerComponent(
  'FinalizeSetupApplyServerResponse',
  z
    .object({
      ok: z.literal(true),
      storage: z.literal('server'),
      server_scope: z.enum(['project', 'personal']),
      secrets_imported: z.number().int(),
    })
    .openapi({ description: 'Config stored on the Agent Hub server (no commit).' }),
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
      secrets_imported: z.number().int().openapi({
        description: 'Count of secret keys imported from an optional `secrets` payload.',
      }),
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
    'Admin+. Validates `ci_yaml_content` against the v1/v2 schema, writes',
    '`<worktree>/.agent-hub/ci.yaml`, and commits the file to the worktree',
    "branch. Target resolution order: (1) request body's `session_id` when",
    'supplied (the setup wizard passes its own id), (2) the most-recent',
    'project session that has a worktree, (3) auto-provision a dedicated',
    '`[Finalize Config]` session + worktree when none exists.',
  ].join('\n'),
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(FinalizeSetupApplyRequest) },
  },
  responses: {
    200: {
      description: "Committed to the worktree, or stored on the server (`storage: 'server'`).",
      content: jsonContent(z.union([FinalizeSetupApplyResponse, FinalizeSetupApplyServerResponse])),
    },
    400: {
      description:
        'Payload invalid: missing content, invalid v1 schema, bad server_scope, no worktree-bearing session found, or worktree path is unreadable.',
      content: jsonContent(z.union([ErrorResponse, FinalizeSetupApplyInvalidConfig])),
    },
    404: errorResponse('Project not found.'),
    500: errorResponse('Write, commit, or server store failed.'),
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
