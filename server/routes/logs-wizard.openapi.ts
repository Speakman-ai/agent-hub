/**
 * Zod schemas + OpenAPI registrations for the AI logs setup wizard routes.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = registerComponent(
  'LogsWizardErrorResponse',
  z.object({ error: z.string(), message: z.string().optional() }).openapi({
    description: 'Error envelope for logs wizard routes.',
  }),
);

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const LogsEntryCandidate = registerComponent(
  'LogsEntryCandidate',
  z.object({
    path: z.string(),
    kind: z.enum(['entrypoint', 'logger-config', 'bootstrap']),
  }),
);

const LogsWizardSource = registerComponent(
  'LogsWizardSource',
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      name: z.string(),
      serviceName: z.string().nullable(),
      environment: z.string().nullable(),
      tokenPrefix: z.string().nullable(),
      status: z.enum(['active', 'revoked']),
      createdAt: z.number().int(),
      rotatedAt: z.number().int().nullable(),
      revokedAt: z.number().int().nullable(),
      lastIngestAt: z.number().int().nullable(),
    })
    .openapi({ description: 'Existing log source metadata (never carries token material).' }),
);

const LogsSetupDraft = registerComponent(
  'LogsSetupDraft',
  z
    .object({
      ingestOrigin: z.string(),
      otlpEndpoint: z.string(),
      batchEndpoint: z.string(),
      stack: z.enum(['node', 'python', 'go', 'ruby', 'java', 'mixed', 'unknown']),
      packageManager: z
        .enum(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'poetry', 'go', 'bundler', 'maven', 'gradle'])
        .nullable(),
      loggingLibraries: z.array(z.string()),
      hasOtelSdk: z.boolean(),
      hasOtelCollectorConfig: z.boolean(),
      collectorConfigPaths: z.array(z.string()),
      entryCandidates: z.array(LogsEntryCandidate),
      recommendedApproach: z.enum(['collector', 'otel-sdk', 'json-batch']),
      suggestedServiceName: z.string().nullable(),
      envExampleKeys: z.array(z.string()),
      readme: z.unknown(),
      notes: z.array(z.string()),
      existingSources: z.array(LogsWizardSource),
    })
    .openapi({
      description:
        'Server-precomputed logs-instrumentation scan: detected stack, logging libraries, existing OpenTelemetry setup, exporter target candidates, a recommended ingest approach, the Hub ingest endpoints, and the project’s existing log sources.',
    }),
);

const LogsSetupDraftResponse = registerComponent(
  'LogsSetupDraftResponse',
  z
    .object({
      projectId: z.string(),
      draft: LogsSetupDraft,
    })
    .openapi({ description: 'Logs-instrumentation detection result for a project.' }),
);

const LogsWizardStartResponse = registerComponent(
  'LogsWizardStartResponse',
  z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      draft: LogsSetupDraft,
      session: z
        .unknown()
        .openapi({ description: 'Raw `sessions` row for the spawned wizard session.' }),
    })
    .openapi({ description: 'Logs setup wizard session spawned successfully.' }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/logs/setup-draft',
  tags: ['Logs'],
  summary: 'Scan a project for log-instrumentation signal',
  description:
    'Admin+. Reads the project working copy and returns the draft the logs setup wizard needs: language stack, existing logging libraries and OpenTelemetry setup, exporter target candidates, a recommended ingest approach, the Hub ingest endpoints, and the project’s existing log sources (metadata only). Read-only — no session is spawned and no files are written.',
  request: {
    params: ProjectIdParam,
  },
  responses: {
    200: {
      description: 'Detection draft computed.',
      content: jsonContent(LogsSetupDraftResponse),
    },
    400: errorResponse('Project has no cwd configured.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/logs/setup-wizard',
  tags: ['Logs'],
  summary: 'Spawn the AI logs setup wizard',
  description: [
    'Admin+. Scans the project and spawns a **worktree-backed** chat session',
    '(`use_worktree=1`) loaded with the `logs-setup` skill. The detection draft',
    '(stack, recommended approach, exporter target candidates, ingest endpoints,',
    'existing sources) is embedded in the kickoff prompt. The agent creates a',
    'log source (minting an `ahlog_` token via the Hub API), wires an',
    'OTLP/JSON-batch exporter into the app referencing the token as an env var,',
    'commits to its branch, and uses Finalize Code Changes to push and open a PR.',
  ].join('\n'),
  request: {
    params: ProjectIdParam,
    body: {
      content: jsonContent(
        z.object({}).openapi({ description: 'No body fields; send an empty object.' }),
      ),
    },
  },
  responses: {
    201: {
      description: 'Wizard session spawned.',
      content: jsonContent(LogsWizardStartResponse),
    },
    400: errorResponse('Project has no cwd configured, or no agents to host the wizard.'),
    404: errorResponse('Project not found.'),
    500: errorResponse('Wizard agent could not be resolved.'),
  },
});
