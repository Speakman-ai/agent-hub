/**
 * Zod schemas + OpenAPI registrations for the AI RUM setup wizard routes.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = registerComponent(
  'RumWizardErrorResponse',
  z.object({ error: z.string(), message: z.string().optional() }).openapi({
    description: 'Error envelope for RUM wizard routes.',
  }),
);

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const RumEntryCandidate = registerComponent(
  'RumEntryCandidate',
  z.object({
    path: z.string(),
    kind: z.enum(['root-layout', 'app-entry', 'html-entry', 'document']),
  }),
);

const RumCspHit = registerComponent(
  'RumCspHit',
  z.object({
    path: z.string(),
    source: z.enum(['meta', 'header']),
  }),
);

const RumInstrumentationPlan = registerComponent(
  'RumInstrumentationPlan',
  z.object({
    alreadyInstrumented: z.boolean(),
    targetFile: z.string().nullable(),
    injectionStyle: z.enum(['module-init', 'client-component', 'script-tag']).nullable(),
    recommendedConnectSrc: z.string(),
    notes: z.array(z.string()),
  }),
);

const RumSetupDraft = registerComponent(
  'RumSetupDraft',
  z
    .object({
      framework: z.enum([
        'next',
        'nuxt',
        'sveltekit',
        'remix',
        'astro',
        'vue',
        'angular',
        'react',
        'vanilla',
        'unknown',
      ]),
      frameworkEvidence: z.array(z.string()),
      packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']).nullable(),
      typescript: z.boolean(),
      entryCandidates: z.array(RumEntryCandidate),
      cspHits: z.array(RumCspHit),
      recorder: z.object({
        dependencyPresent: z.boolean(),
        initDetected: z.boolean(),
      }),
      plan: RumInstrumentationPlan,
      readme: z.unknown(),
    })
    .openapi({
      description:
        'Server-precomputed RUM instrumentation scan: detected framework, injection-target candidates, existing CSP locations, recorder state, and a recommended instrumentation plan.',
    }),
);

const RumSetupDraftResponse = registerComponent(
  'RumSetupDraftResponse',
  z
    .object({
      projectId: z.string(),
      draft: RumSetupDraft,
    })
    .openapi({ description: 'RUM instrumentation detection result for a project.' }),
);

const RumWizardStartResponse = registerComponent(
  'RumWizardStartResponse',
  z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      draft: RumSetupDraft,
      session: z
        .unknown()
        .openapi({ description: 'Raw `sessions` row for the spawned wizard session.' }),
    })
    .openapi({ description: 'RUM recorder-injection wizard session spawned successfully.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/rum/setup-draft',
  tags: ['RUM'],
  summary: 'Scan a project for RUM instrumentation signal',
  description:
    'Admin+. Reads the project working copy and returns the detection draft the RUM recorder-injection wizard needs: frontend framework, injection-target candidates, existing Content-Security-Policy locations, recorder state, and a recommended plan. Read-only — no session is spawned and no files are written.',
  request: {
    params: ProjectIdParam,
  },
  responses: {
    200: {
      description: 'Detection draft computed.',
      content: jsonContent(RumSetupDraftResponse),
    },
    400: errorResponse('Project has no cwd configured.'),
    404: errorResponse('Project not found.'),
  },
});

const RumSetupApplyRequest = registerComponent(
  'RumSetupApplyRequest',
  z
    .object({
      files: z.array(z.string()).min(1).openapi({
        description:
          'Relative paths (inside the worktree) of the instrumentation files the wizard edited or created: the recorder target, any new client component, and each CSP file. Only these paths are staged + committed. Absolute paths and paths escaping the worktree are rejected.',
      }),
      session_id: z.string().optional().openapi({
        description:
          'Target session id whose worktree receives the commit. The wizard passes its own session id. When omitted the server picks the most-recent project session that has a worktree, or auto-provisions a dedicated `[RUM Config]` worktree on a fresh branch when none exists.',
      }),
      message: z.string().optional().openapi({
        description:
          'Optional commit message override. Defaults to a fixed RUM instrumentation title.',
      }),
    })
    .openapi({ description: 'Apply payload for the RUM instrumentation wizard.' }),
);

const RumSetupApplyResponse = registerComponent(
  'RumSetupApplyResponse',
  z
    .object({
      ok: z.literal(true),
      files: z.array(z.string()).openapi({
        description: 'Normalized relative paths that were committed.',
      }),
      commit_sha: z.string(),
      branch: z.string(),
      session_id: z.string(),
    })
    .openapi({ description: 'Instrumentation commit landed on the worktree branch.' }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/rum/setup-apply',
  tags: ['RUM'],
  summary: 'Commit wizard instrumentation edits to the worktree',
  description: [
    'Admin+. Stages and commits the instrumentation files the recorder-',
    'injection wizard edited (`files[]`) into the session worktree branch',
    'with `git commit -o` (only the listed paths — unrelated pre-staged',
    'work is left intact), then lets the existing Finalize Code Changes /',
    'pulls flow push and open the PR. Target resolution order: (1) request',
    "body's `session_id` when supplied (the wizard passes its own id), (2)",
    'the most-recent project session that has a worktree, (3) auto-provision',
    'a dedicated `[RUM Config]` session + worktree when none exists.',
  ].join('\n'),
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(RumSetupApplyRequest) },
  },
  responses: {
    200: {
      description: 'Committed.',
      content: jsonContent(RumSetupApplyResponse),
    },
    400: errorResponse(
      'Payload invalid: empty/invalid files list, a listed path missing from the worktree or not a regular file, nothing to commit, or no worktree-bearing session found.',
    ),
    404: errorResponse('Project not found.'),
    500: errorResponse('Stage or commit failed.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/rum/setup-wizard',
  tags: ['RUM'],
  summary: 'Spawn the RUM recorder-injection wizard',
  description: [
    'Admin+. Scans the project and spawns a **worktree-backed** chat session',
    '(`use_worktree=1`) loaded with the `rum-setup` skill. The detection draft',
    '(framework, target file, injection style, CSP hits, recommended',
    '`connect-src`) is embedded in the kickoff prompt. The agent injects the',
    'rrweb recorder init into `draft.plan.targetFile` using',
    '`draft.plan.injectionStyle`, extends any `draft.cspHits` with the ingest',
    'origin, commits to its branch, and uses Finalize Code Changes to push and',
    'open a PR.',
  ].join('\n'),
  request: {
    params: ProjectIdParam,
    body: {
      content: jsonContent(
        z
          .object({
            maskAllText: z.boolean().optional().openapi({
              description:
                "Masking policy for the injected recorder, chosen per target app at setup time. `false` (default) masks password + PII fields only and records other inputs/text verbatim — the right default for instrumenting third-party apps. `true` masks ALL text and inputs (only structure/layout/timing recorded). Baked into the recorder init the wizard writes; it is NOT Agent Hub's own self-recording setting.",
            }),
          })
          .openapi({ description: 'Optional masking policy for the injected recorder.' }),
      ),
    },
  },
  responses: {
    201: {
      description: 'Wizard session spawned.',
      content: jsonContent(RumWizardStartResponse),
    },
    400: errorResponse('Project has no cwd configured, or no agents to host the wizard.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Wizard agent could not be resolved.'),
  },
});
