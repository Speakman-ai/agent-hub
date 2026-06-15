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
    body: { content: jsonContent(z.object({}).openapi({ description: 'Body is empty.' })) },
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
