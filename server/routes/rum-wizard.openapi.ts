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
