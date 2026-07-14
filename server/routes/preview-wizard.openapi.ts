/**
 * Zod schemas + OpenAPI registrations for the Preview setup wizard routes.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = registerComponent(
  'PreviewWizardErrorResponse',
  z.object({ error: z.string(), message: z.string().optional() }).openapi({
    description: 'Error envelope for preview wizard routes.',
  }),
);

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const PreviewSetupEnvVar = registerComponent(
  'PreviewSetupEnvVar',
  z.object({
    key: z.string(),
    sources: z.array(z.string()),
    required: z.boolean(),
  }),
);

const PreviewSetupComposeCandidate = registerComponent(
  'PreviewSetupComposeCandidate',
  z.object({
    file: z.string(),
    services: z.array(z.string()),
    ports: z.array(z.number().int()),
  }),
);

const PreviewSetupDraft = registerComponent(
  'PreviewSetupDraft',
  z
    .object({
      phase: z.enum(['bootstrap_compose', 'confirm_compose']),
      isMonorepo: z.boolean(),
      composeCandidates: z.array(PreviewSetupComposeCandidate),
      envVars: z.array(PreviewSetupEnvVar),
      detected: z.unknown().nullable(),
      bootstrap: z.unknown().nullable(),
      readme: z.unknown(),
      scriptHints: z.array(z.unknown()),
      composeChecklist: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .openapi({
      description:
        'Server-precomputed Preview setup scan. Extra fields are intentionally allowed because the draft is scanner-owned and grows with preview detection.',
    }),
);

const PreviewWizardStartResponse = registerComponent(
  'PreviewWizardStartResponse',
  z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      draft: PreviewSetupDraft,
      session: z.unknown().openapi({
        description:
          'Raw `sessions` row for the spawned wizard session. New Preview setup sessions are worktree-backed (`use_worktree=1`) so repo edits can be finalized like normal code changes.',
      }),
    })
    .openapi({ description: 'Preview setup wizard session spawned successfully.' }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/preview/setup-wizard',
  tags: ['Preview'],
  summary: 'Spawn the Preview setup wizard',
  description:
    'Admin+. Scans the project for compose files, ports, README hints, and env vars, then spawns a worktree-backed chat session loaded with the `preview-setup` skill. The agent can author compose files on its branch and use Finalize Code Changes like any other coding session.',
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(z.object({}).openapi({ description: 'Body is empty.' })) },
  },
  responses: {
    201: {
      description: 'Wizard session spawned.',
      content: jsonContent(PreviewWizardStartResponse),
    },
    400: errorResponse('Project has no cwd configured, or no agents to host the wizard.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Wizard agent could not be resolved.'),
  },
});

const PreviewSetupComposeBootstrapRequest = registerComponent(
  'PreviewSetupComposeBootstrapRequest',
  z.object({
    session_id: z.string().optional().openapi({
      description:
        'Optional setup session id. When supplied, the compose file is written in that session worktree instead of the primary project checkout.',
    }),
    file: z
      .enum(['docker-compose.yml', 'compose.yml', 'docker-compose.yaml', 'compose.yaml'])
      .optional(),
    content: z.string(),
    overwrite: z.boolean().optional(),
  }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/preview/setup-compose-bootstrap',
  tags: ['Preview'],
  summary: 'Write a starter compose file for Preview setup',
  description:
    'Admin+. Writes one root-level compose file after user approval and returns a refreshed Preview setup draft.',
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(PreviewSetupComposeBootstrapRequest) },
  },
  responses: {
    200: {
      description: 'Compose file written.',
      content: jsonContent(
        z.object({
          ok: z.literal(true),
          file: z.string(),
          draft: PreviewSetupDraft,
        }),
      ),
    },
    400: errorResponse('Invalid file name or empty compose YAML.'),
    404: errorResponse('Project not found.'),
    409: errorResponse('Compose file already exists and overwrite was not confirmed.'),
    500: errorResponse('Compose file write failed.'),
  },
});

const WizardSecrets = z.object({
  env: z.string(),
  mode: z.enum(['merge', 'replace']).optional(),
  defaultKind: z.enum(['plain', 'secret']).optional(),
});

const PreviewSetupApplyRequest = registerComponent(
  'PreviewSetupApplyRequest',
  z
    .object({
      session_id: z.string().optional().openapi({
        description:
          'Optional setup session id. When supplied, setup-apply writes and commits `.agent-hub/preview.json` in that session worktree so Finalize controls can run tests, review, and push the setup branch.',
      }),
      enabled: z.boolean().optional(),
      preview: z.unknown().optional(),
      devServer: z.unknown().optional(),
      secrets: WizardSecrets.optional(),
    })
    .passthrough()
    .openapi({
      description:
        'Apply payload for Preview setup. `preview.compose` is persisted into the project preview config; `devServer` persists the managed dev-server config (compose for backing services only); at least one of the two is required when enabled. Optional secrets are imported into project secrets.',
    }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/preview/setup-apply',
  tags: ['Preview'],
  summary: 'Persist Preview setup config and optional secrets',
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(PreviewSetupApplyRequest) },
  },
  responses: {
    200: {
      description: 'Preview config persisted.',
      content: jsonContent(
        z.object({
          ok: z.literal(true),
          secretsImported: z.number().int(),
          file: z.string().optional(),
          commit_sha: z.string().optional(),
          branch: z.string().optional(),
          session_id: z.string().optional(),
        }),
      ),
    },
    400: errorResponse('Preview config or secrets payload is invalid.'),
    404: errorResponse('Project not found.'),
  },
});

const DevServerPortMapEntrySchema = registerComponent(
  'DevServerPortMapEntry',
  z.object({
    internalPort: z.number().int(),
    label: z.string(),
    primary: z.boolean().optional(),
  }),
);

const DevServerConfigSchema = registerComponent(
  'DevServerConfig',
  z
    .object({
      startCommand: z.string(),
      env: z.record(z.string(), z.string()),
      secretKeys: z.array(z.string()),
      portMap: z.array(DevServerPortMapEntrySchema),
      healthPath: z.string().optional(),
      readyTimeoutMs: z.number().int().optional(),
      cwd: z.string().optional(),
    })
    .openapi({
      description: 'Managed dev-server config (`prEnv.devServer`).',
    }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/preview/migrate-devserver-plan',
  tags: ['Preview'],
  summary: 'Compute a compose→devServer migration plan',
  description:
    "Maps the project's existing compose app-wrapping preview config to the equivalent managed dev-server config. The generated `startCommand` runs `docker compose up -d --wait` for backing services then the app dev command. Read-only — does not persist; POST the returned `devServer` to `setup-apply` to adopt it.",
  request: {
    params: ProjectIdParam,
    query: z.object({
      appDevCommand: z
        .string()
        .optional()
        .openapi({ description: 'App dev command appended after the compose services come up.' }),
      services: z
        .string()
        .optional()
        .openapi({ description: 'Comma-separated backing-service names to bring up explicitly.' }),
    }),
  },
  responses: {
    200: {
      description: 'Migration plan computed.',
      content: jsonContent(
        z.object({
          ok: z.literal(true),
          devServer: DevServerConfigSchema,
          startCommand: z.string(),
          warnings: z.array(z.string()),
        }),
      ),
    },
    400: errorResponse('Project has no compose preview config to migrate.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/preview/wizard-complete',
  tags: ['Preview'],
  summary: 'Mark the Preview setup wizard complete',
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(z.object({}).openapi({ description: 'Body is empty.' })) },
  },
  responses: {
    200: {
      description: 'Completion event broadcast when the project exists.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
  },
});
