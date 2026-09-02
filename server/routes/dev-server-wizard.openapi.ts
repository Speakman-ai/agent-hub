/**
 * Zod schemas + OpenAPI registrations for the AI-assisted Dev Server setup
 * wizard routes (see dev-server-wizard.ts).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = registerComponent(
  'DevServerWizardErrorResponse',
  z.object({ error: z.string(), message: z.string().optional() }).openapi({
    description: 'Error envelope for Dev Server wizard routes.',
  }),
);

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const DevServerStartCommandCandidate = registerComponent(
  'DevServerStartCommandCandidate',
  z.object({
    command: z.string(),
    script: z.string(),
    raw: z.string(),
    recommended: z.boolean(),
  }),
);

const DevServerPortGuess = registerComponent(
  'DevServerPortGuess',
  z.object({
    internalPort: z.number().int(),
    label: z.string(),
    source: z.string(),
  }),
);

const DevServerSetupDraft = registerComponent(
  'DevServerSetupDraft',
  z
    .object({
      cwd: z.string(),
      packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).nullable(),
      isMonorepo: z.boolean(),
      monorepoDirs: z.array(z.string()),
      startCommandCandidates: z.array(DevServerStartCommandCandidate),
      frameworks: z.array(z.string()),
      portGuesses: z.array(DevServerPortGuess),
      healthPathGuess: z.string(),
      existing: z.unknown().openapi({ description: 'Current `prEnv.devServer` config, or null.' }),
      readme: z.object({
        path: z.string().nullable(),
        excerpt: z.string().nullable(),
      }),
    })
    .openapi({
      description:
        'Server-precomputed Dev Server scan: start-command candidates, package manager, monorepo layout, framework/port guesses, health-path default, existing config, and a README excerpt.',
    }),
);

const DevServerSetupDraftResponse = registerComponent(
  'DevServerSetupDraftResponse',
  z
    .object({
      projectId: z.string(),
      draft: DevServerSetupDraft,
    })
    .openapi({ description: 'Dev Server detection result for a project.' }),
);

const DevServerWizardStartResponse = registerComponent(
  'DevServerWizardStartResponse',
  z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      draft: DevServerSetupDraft,
      session: z
        .unknown()
        .openapi({ description: 'Raw `sessions` row for the spawned wizard session.' }),
    })
    .openapi({ description: 'Dev Server setup wizard session spawned successfully.' }),
);

const DevServerSetupApplyRequest = registerComponent(
  'DevServerSetupApplyRequest',
  z
    .object({
      devServer: z.record(z.string(), z.unknown()).openapi({
        description:
          'The authored `prEnv.devServer` block (buildCommand, startCommand, stopCommand, env, secretKeys, portMap, healthPath, readyTimeoutMs, cwd, aptPackages). Validated by parseDevServerConfig; the first `prEnv.devServer.<path>` issue is returned as a 400.',
      }),
      secrets: z
        .object({
          env: z.string().openapi({ description: 'Dotenv `KEY=value` lines of secret values.' }),
          mode: z.enum(['merge', 'replace']).optional(),
          defaultKind: z.enum(['plain', 'secret']).optional(),
        })
        .optional()
        .openapi({
          description:
            'Freshly-typed secret values to store encrypted. The config references these by name via `devServer.secretKeys`; plaintext values never live in the config.',
        }),
    })
    .openapi({ description: 'Persist payload for the Dev Server setup wizard.' }),
);

const DevServerSetupApplyResponse = registerComponent(
  'DevServerSetupApplyResponse',
  z
    .object({
      ok: z.literal(true),
      secretsImported: z.number().int(),
    })
    .openapi({ description: 'Dev-server config persisted to the project record.' }),
);

const OkResponse = registerComponent(
  'DevServerWizardOkResponse',
  z.object({ ok: z.literal(true) }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/dev-server/setup-draft',
  tags: ['Dev Server'],
  summary: 'Scan a project for dev-server setup signal',
  description:
    'Admin+. Reads the project working copy and returns the detection draft the Dev Server setup wizard needs: start-command candidates from `package.json` scripts, package manager, monorepo layout, framework/port guesses, a health-path default, the existing config, and a README excerpt. Read-only — no session spawn, no writes.',
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Detection draft computed.',
      content: jsonContent(DevServerSetupDraftResponse),
    },
    400: errorResponse('Project has no cwd configured.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/dev-server/setup-wizard',
  tags: ['Dev Server'],
  summary: 'Spawn the Dev Server setup wizard',
  description:
    'Admin+. Scans the project and spawns a worktree-backed `[Dev Server Setup]` chat session loaded with the `dev-server-setup` skill, the draft embedded in the kickoff prompt. The agent walks the user through authoring `prEnv.devServer` (start command, port map, env, secret references, health path, monorepo cwd) and calls setup-apply to persist it.',
  request: { params: ProjectIdParam },
  responses: {
    201: {
      description: 'Wizard session spawned.',
      content: jsonContent(DevServerWizardStartResponse),
    },
    400: errorResponse('Project has no cwd configured, or no agents to host the wizard.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Wizard agent could not be resolved.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/dev-server/setup-apply',
  tags: ['Dev Server'],
  summary: 'Persist the authored dev-server config',
  description:
    'Admin+. Validates and persists the authored `prEnv.devServer` config (and optional secret values) to the project record. Unlike preview/rum setup this touches no repo file — dev-server config lives in `projects.json` — so there is no git commit step. Secret values are stored encrypted; the config references them by name via `devServer.secretKeys`.',
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(DevServerSetupApplyRequest) },
  },
  responses: {
    200: {
      description: 'Config persisted.',
      content: jsonContent(DevServerSetupApplyResponse),
    },
    400: errorResponse(
      'devServer missing/invalid, or a `prEnv.devServer.<path>` validation error.',
    ),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/dev-server/wizard-complete',
  tags: ['Dev Server'],
  summary: 'Signal Dev Server wizard completion',
  description:
    'User+. Broadcasts `dev_server_wizard_complete` so the Settings panel refetches the project record after the wizard persists config.',
  request: { params: ProjectIdParam },
  responses: {
    200: { description: 'Completion broadcast (idempotent).', content: jsonContent(OkResponse) },
  },
});
