/**
 * Zod schemas and OpenAPI registrations for Experimental Project Autopilot.
 */

import { z, registerComponent, registerPath } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'AutopilotErrorResponse',
  z.object({
    error: z.string(),
    code: z.string().optional(),
  }),
);

export const AutopilotLimitsSchema = registerComponent(
  'AutopilotLimits',
  z.object({
    cycleMode: z.enum(['continuous', 'finite']),
    maxCycles: z.number().int().positive().nullable(),
    maxWallTimeMs: z.number().positive(),
    maxStageTimeoutMs: z.number().positive(),
    maxRetriesPerStage: z.number().int().min(0).max(2),
    maxCostUsd: z.number().positive().nullable(),
  }),
);

export const AutopilotEvaluatorPolicySchema = registerComponent(
  'AutopilotEvaluatorPolicy',
  z.object({
    version: z.number().int().positive(),
  }),
);

export const AutopilotWorkerAuthoritySchema = registerComponent(
  'AutopilotWorkerAuthority',
  z.object({
    keyName: z.string().nullable(),
    keyId: z.string().nullable(),
  }),
);

export const AutopilotTargetSchema = registerComponent(
  'AutopilotTarget',
  z.object({
    targetId: z.string().min(1),
    readinessProbeUrl: z.string().nullable(),
    origin: z.string().nullable(),
  }),
);

export const AutopilotUsageSchema = registerComponent(
  'AutopilotUsage',
  z.object({
    wallTimeMs: z.number(),
    costUsd: z.number().nullable(),
    costAvailable: z.boolean(),
  }),
);

export const AutopilotConfigSchema = registerComponent(
  'AutopilotProjectConfig',
  z.object({
    projectId: z.string(),
    enabled: z.boolean(),
    disabling: z.boolean(),
    briefId: z.string().nullable(),
    brief: z.string().nullable(),
    briefRevision: z.number().int().nullable(),
    target: AutopilotTargetSchema.nullable(),
    limits: AutopilotLimitsSchema.nullable(),
    evaluatorPolicy: AutopilotEvaluatorPolicySchema,
    credentialOwnerUserId: z.string().nullable(),
    updatedAt: z.string(),
    updatedBy: z.string().nullable(),
  }),
);

const AutopilotStageEnum = z.enum([
  'planning',
  'implementing',
  'finalizing',
  'deploying',
  'verifying',
  'documenting',
  'selecting-next',
]);

const AutopilotControlStateEnum = z.enum([
  'running',
  'pausing',
  'paused',
  'stopping',
  'stopped',
  'failed',
]);

export const AutopilotRunSchema = registerComponent(
  'AutopilotRun',
  z.object({
    id: z.string(),
    projectId: z.string(),
    controlState: AutopilotControlStateEnum,
    stage: AutopilotStageEnum.nullable(),
    fencingGeneration: z.number().int(),
    briefId: z.string().nullable(),
    briefRevision: z.number().int().nullable(),
    cycleNumber: z.number().int(),
    pauseReason: z.string().nullable(),
    failureReason: z.string().nullable(),
    lastVerifiedSha: z.string().nullable(),
    lastDeploymentId: z.string().nullable(),
    credentialOwnerUserId: z.string().nullable(),
    targetId: z.string().nullable(),
    limits: AutopilotLimitsSchema,
    usage: AutopilotUsageSchema,
    workerAuthority: AutopilotWorkerAuthoritySchema,
    startedBy: z.string().nullable(),
    startedAt: z.string(),
    stoppedAt: z.string().nullable(),
    updatedAt: z.string(),
  }),
);

export const AutopilotCycleSchema = registerComponent(
  'AutopilotCycle',
  z.object({
    id: z.string(),
    runId: z.string(),
    cycleNumber: z.number().int(),
    briefRevision: z.number().int(),
    specRevision: z.number().int().nullable(),
    cardId: z.string().nullable(),
    sessionId: z.string().nullable(),
    testedCommitSha: z.string().nullable(),
    finalizeRunId: z.string().nullable(),
    deploymentId: z.string().nullable(),
    verification: z.unknown().nullable(),
    documentation: z.unknown().nullable(),
    selectedImprovement: z.string().nullable(),
    outcome: z.string().nullable(),
    status: z.enum(['active', 'succeeded', 'failed', 'cancelled']),
    createdAt: z.string(),
  }),
);

export const AutopilotStageSchema = registerComponent(
  'AutopilotStageRecord',
  z.object({
    id: z.string(),
    cycleId: z.string(),
    stage: AutopilotStageEnum,
    status: z.enum(['pending', 'in_progress', 'succeeded', 'failed', 'cancelled']),
    attempt: z.number().int(),
    operationId: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    result: z.unknown().nullable(),
  }),
);

export const AutopilotOperationSchema = registerComponent(
  'AutopilotOperation',
  z.object({
    id: z.string(),
    runId: z.string(),
    cycleId: z.string().nullable(),
    kind: z.string(),
    status: z.enum(['pending', 'in_flight', 'succeeded', 'failed', 'cancelled', 'ambiguous']),
    fencingGeneration: z.number().int(),
    intent: z.unknown(),
    result: z.unknown().nullable(),
    sessionId: z.string().nullable(),
    finalizeRunId: z.string().nullable(),
    deploymentId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const AutopilotEventSchema = registerComponent(
  'AutopilotEvent',
  z.object({
    id: z.string(),
    runId: z.string(),
    cycleId: z.string().nullable(),
    operationId: z.string().nullable(),
    type: z.string(),
    payload: z.unknown(),
    fencingGeneration: z.number().int().nullable(),
    createdAt: z.string(),
    seq: z.number().int(),
  }),
);

export const AutopilotLeaseSchema = registerComponent(
  'AutopilotLease',
  z.object({
    projectId: z.string(),
    runId: z.string(),
    fencingGeneration: z.number().int(),
    holderId: z.string(),
    leasedAt: z.string(),
  }),
);

export const AutopilotRunSnapshotSchema = registerComponent(
  'AutopilotRunSnapshot',
  z.object({
    run: AutopilotRunSchema,
    cycle: AutopilotCycleSchema.nullable(),
    stages: z.array(AutopilotStageSchema),
    operations: z.array(AutopilotOperationSchema),
    events: z.array(AutopilotEventSchema),
    lease: AutopilotLeaseSchema.nullable(),
  }),
);

export const AutopilotProjectStateSchema = registerComponent(
  'AutopilotProjectState',
  z.object({
    serverEnabled: z.boolean(),
    config: AutopilotConfigSchema,
    activeRun: AutopilotRunSnapshotSchema.nullable(),
  }),
);

export const PutAutopilotConfigRequestSchema = z.object({
  enabled: z.boolean().optional(),
  brief: z.string().nullable().optional(),
  target: z
    .object({
      targetId: z.string().min(1).optional(),
      readinessProbeUrl: z.string().nullable().optional(),
      origin: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  limits: z
    .object({
      cycleMode: z.enum(['continuous', 'finite']).optional(),
      maxCycles: z.number().int().positive().nullable().optional(),
      maxWallTimeMs: z.number().positive().optional(),
      maxStageTimeoutMs: z.number().positive().optional(),
      maxRetriesPerStage: z.number().int().min(0).max(2).optional(),
      maxCostUsd: z.number().positive().nullable().optional(),
    })
    .optional(),
  evaluatorPolicy: z
    .object({
      version: z.number().int().positive().optional(),
    })
    .nullable()
    .optional(),
  credentialOwnerUserId: z.string().nullable().optional(),
});

export const StartAutopilotRequestSchema = z.object({
  brief: z.string().optional(),
  target: z
    .object({
      targetId: z.string().min(1).optional(),
      readinessProbeUrl: z.string().nullable().optional(),
      origin: z.string().nullable().optional(),
    })
    .optional(),
  limits: z
    .object({
      cycleMode: z.enum(['continuous', 'finite']).optional(),
      maxCycles: z.number().int().positive().nullable().optional(),
      maxWallTimeMs: z.number().positive().optional(),
      maxStageTimeoutMs: z.number().positive().optional(),
      maxRetriesPerStage: z.number().int().min(0).max(2).optional(),
      maxCostUsd: z.number().positive().nullable().optional(),
    })
    .optional(),
  credentialOwnerUserId: z.string().optional(),
});

export const CompleteAutopilotOperationRequestSchema = z.object({
  fencingGeneration: z.number().int(),
  outcome: z.enum(['succeeded', 'failed', 'ambiguous']),
  result: z.unknown().optional(),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const projectParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const runParams = projectParams.extend({
  runId: z.string().openapi({ description: 'Autopilot run id.' }),
});

const operationParams = projectParams.extend({
  operationId: z.string().openapi({ description: 'Stable Autopilot operation id.' }),
});

const errorResponses = {
  400: { description: 'Invalid request.', content: jsonContent(ErrorResponse) },
  403: { description: 'Autopilot is disabled.', content: jsonContent(ErrorResponse) },
  404: { description: 'Project or run not found.', content: jsonContent(ErrorResponse) },
  409: {
    description: 'Conflict with persisted Autopilot state.',
    content: jsonContent(ErrorResponse),
  },
};

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/autopilot',
  tags: ['Autopilot'],
  summary: 'Read Autopilot project state',
  description:
    'Returns the project Autopilot configuration, whether the operator server setting is on, and the active run snapshot when one exists.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Autopilot project state.',
      content: jsonContent(AutopilotProjectStateSchema),
    },
    404: errorResponses[404],
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/autopilot/config',
  tags: ['Autopilot'],
  summary: 'Save Autopilot project configuration',
  description:
    'Persists the project opt-in, versioned brief, local target, limits and credential owner. Enabling requires every field. Does not start a run.',
  request: {
    params: projectParams,
    body: { content: jsonContent(PutAutopilotConfigRequestSchema) },
  },
  responses: {
    200: { description: 'Saved configuration.', content: jsonContent(AutopilotConfigSchema) },
    ...errorResponses,
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/autopilot/start',
  tags: ['Autopilot'],
  summary: 'Start an Autopilot run',
  description:
    'Starts the single active Autopilot run for the project. Duplicate start is rejected. Requires the server operator setting, project opt-in, scoped worker credentials, and enforceable runtime containment.',
  request: {
    params: projectParams,
    body: { content: jsonContent(StartAutopilotRequestSchema), required: false },
  },
  responses: {
    201: { description: 'Run started.', content: jsonContent(AutopilotRunSnapshotSchema) },
    ...errorResponses,
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/autopilot/runs/{runId}',
  tags: ['Autopilot'],
  summary: 'Read an Autopilot run',
  request: { params: runParams },
  responses: {
    200: { description: 'Run snapshot.', content: jsonContent(AutopilotRunSnapshotSchema) },
    404: errorResponses[404],
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/autopilot/pause',
  tags: ['Autopilot'],
  summary: 'Pause an Autopilot run',
  description:
    'Drains the active cycle without starting another. Returns pausing until in-flight operations settle, then paused.',
  request: { params: projectParams },
  responses: {
    200: { description: 'Pause accepted.', content: jsonContent(AutopilotRunSnapshotSchema) },
    ...errorResponses,
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/autopilot/resume',
  tags: ['Autopilot'],
  summary: 'Resume a paused Autopilot run',
  description:
    'Rechecks ownership, limits and the deployed revision before returning the run to running. Stopped runs cannot be resumed.',
  request: { params: projectParams },
  responses: {
    200: { description: 'Run resumed.', content: jsonContent(AutopilotRunSnapshotSchema) },
    ...errorResponses,
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/autopilot/stop',
  tags: ['Autopilot'],
  summary: 'Stop an Autopilot run',
  description:
    'Persists cancellation before cancelling sessions, Finalize, deploy and tests. Late callbacks cannot advance the stopped generation. Idempotent.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Run stopped or stopping finished.',
      content: jsonContent(AutopilotRunSnapshotSchema),
    },
    ...errorResponses,
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/autopilot/disable',
  tags: ['Autopilot'],
  summary: 'Disable Autopilot for a project',
  description: 'Clears the project opt-in and invokes Stop when a run is active.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Project Autopilot disabled.',
      content: jsonContent(AutopilotProjectStateSchema),
    },
    ...errorResponses,
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/autopilot/operations/{operationId}/complete',
  tags: ['Autopilot', 'internal'],
  summary: 'Complete an Autopilot operation',
  description:
    'Worker callback. Rejected when the fencing generation is stale or the run is stopping/stopped.',
  request: {
    params: operationParams,
    body: { content: jsonContent(CompleteAutopilotOperationRequestSchema) },
  },
  responses: {
    200: { description: 'Operation settled.', content: jsonContent(AutopilotOperationSchema) },
    ...errorResponses,
  },
});
