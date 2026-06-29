import { z, registerComponent, registerPath } from '../openapi/registry.js';

const DeploymentStatusEnum = z.enum([
  'pending',
  'awaiting_approval',
  'running',
  'success',
  'error',
  'cancelled',
]);

const DeploymentStepStatusEnum = z.enum([
  'pending',
  'running',
  'success',
  'error',
  'skipped',
  'cancelled',
]);

export const TriggerDeploymentRequestSchema = z.object({
  environment: z.string().min(1),
  ref: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  meta: z.unknown().optional(),
});

export const DeploymentListQuerySchema = z.object({
  environment: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const ApproveDeploymentRequestSchema = z.object({
  note: z.string().max(2000).optional(),
});

export const CancelDeploymentRequestSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export const RollbackDeploymentRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  meta: z.unknown().optional(),
});

export const DeploymentSchema = registerComponent(
  'Deployment',
  z.object({
    id: z.string(),
    project_id: z.string(),
    environment: z.string(),
    ref: z.string(),
    status: DeploymentStatusEnum,
    trigger: z.string(),
    triggered_by: z.string().nullable(),
    source_deployment_id: z.string().nullable(),
    runner_job_id: z.string().nullable(),
    error: z.string().nullable(),
    meta: z.unknown().nullable(),
    created_at: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    updated_at: z.string(),
  }),
);

export const DeploymentStepSchema = registerComponent(
  'DeploymentStep',
  z.object({
    id: z.string(),
    deployment_id: z.string(),
    name: z.string(),
    step_order: z.number().int(),
    status: DeploymentStepStatusEnum,
    exit_code: z.number().int().nullable(),
    error: z.string().nullable(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    created_at: z.string(),
  }),
);

export const DeploymentApprovalSchema = registerComponent(
  'DeploymentApproval',
  z.object({
    id: z.string(),
    deployment_id: z.string(),
    approver_user_id: z.string(),
    approver_role: z.string(),
    decision: z.enum(['approved', 'rejected']),
    note: z.string().nullable(),
    created_at: z.string(),
  }),
);

export const DeploymentReleaseItemSchema = registerComponent(
  'DeploymentReleaseItem',
  z.object({
    id: z.string(),
    deployment_id: z.string(),
    card_id: z.string(),
    support_ticket_id: z.string().nullable(),
    source: z.enum(['derived', 'operator']),
    inclusion_status: z.enum(['included', 'excluded']),
    operator_adjusted_by: z.string().nullable(),
    operator_adjustment_note: z.string().nullable(),
    operator_adjustment_meta: z.string().nullable(),
    operator_adjusted_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);

export const DeploymentEnvironmentSchema = registerComponent(
  'DeploymentEnvironment',
  z.object({
    id: z.string(),
    project_id: z.string(),
    name: z.string(),
    current_ref: z.string().nullable(),
    current_deployment_id: z.string().nullable(),
    active_deployment_id: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);

const DeployConfigStepSchema = registerComponent(
  'DeployConfigStep',
  z.object({
    name: z.string(),
    run: z.string(),
  }),
);

const DeployConfigEnvironmentSchema = registerComponent(
  'DeployConfigEnvironment',
  z.object({
    name: z.string(),
    approval: z.boolean(),
    runsOn: z.string(),
    timeoutMinutes: z.number().int(),
    steps: z.array(DeployConfigStepSchema),
    currentRef: z.string().nullable(),
    currentDeploymentId: z.string().nullable(),
    activeDeploymentId: z.string().nullable(),
    activeDeployment: DeploymentSchema.nullable(),
    currentDeployment: DeploymentSchema.nullable(),
    lastDeployment: DeploymentSchema.nullable(),
    rollbackTarget: DeploymentSchema.nullable(),
  }),
);

const DeployConfigResponseSchema = registerComponent(
  'DeployConfigResponse',
  z.object({
    projectId: z.string(),
    configPath: z.string(),
    environments: z.array(DeployConfigEnvironmentSchema),
  }),
);

const DeploySetupWizardResponseSchema = registerComponent(
  'DeploySetupWizardResponse',
  z.object({
    sessionId: z.string(),
    agentId: z.string(),
    session: z.object({}).passthrough(),
    configPath: z.string(),
  }),
);

const DeploymentListResponseSchema = registerComponent(
  'DeploymentListResponse',
  z.object({
    deployments: z.array(DeploymentSchema),
    limit: z.number().int(),
    offset: z.number().int(),
  }),
);

const DeploymentDetailResponseSchema = registerComponent(
  'DeploymentDetailResponse',
  z.object({
    deployment: DeploymentSchema,
    steps: z.array(DeploymentStepSchema),
    approvals: z.array(DeploymentApprovalSchema),
    releaseItems: z.array(DeploymentReleaseItemSchema),
    environment: DeploymentEnvironmentSchema.nullable(),
    history: z.array(DeploymentSchema),
    logs: z.array(z.object({}).passthrough()),
  }),
);

const DeploymentActionResponseSchema = registerComponent(
  'DeploymentActionResponse',
  z.object({
    deployment: DeploymentSchema,
    steps: z.array(DeploymentStepSchema),
    approvals: z.array(DeploymentApprovalSchema),
  }),
);

const ErrorResponse = registerComponent('DeploymentErrorResponse', z.object({ error: z.string() }));

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const projectParams = z.object({ projectId: z.string() });
const deploymentParams = z.object({ projectId: z.string(), deploymentId: z.string() });

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/deploy/setup-wizard',
  tags: ['Deployments'],
  summary: 'Start an AI deploy.yaml setup workflow',
  description:
    'Admin+. Spawns a worktree-backed setup session loaded with the `deploy-setup` skill so an agent can author `.agent-hub/deploy.yaml` on a reviewable branch.',
  request: {
    params: projectParams,
    body: { content: jsonContent(z.object({}).passthrough()) },
  },
  responses: {
    201: {
      description: 'Deploy setup wizard session created.',
      content: jsonContent(DeploySetupWizardResponseSchema),
    },
    400: errorResponse('Project has no cwd or no agent to host the wizard.'),
    403: errorResponse('Admin role required.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/deploy/config',
  tags: ['Deployments'],
  summary: 'Read deploy.yaml environments and live deployment state',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Deployment environments configured in deploy.yaml with live state.',
      content: jsonContent(DeployConfigResponseSchema),
    },
    400: errorResponse('Invalid deploy.yaml.'),
    404: errorResponse('Project or deploy.yaml not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/deployments',
  tags: ['Deployments'],
  summary: 'List deployments',
  request: { params: projectParams, query: DeploymentListQuerySchema },
  responses: {
    200: { description: 'Deployment history.', content: jsonContent(DeploymentListResponseSchema) },
    400: errorResponse('Invalid query.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/deployments',
  tags: ['Deployments'],
  summary: 'Trigger a deployment',
  request: {
    params: projectParams,
    body: { content: jsonContent(TriggerDeploymentRequestSchema) },
  },
  responses: {
    202: {
      description: 'Deployment accepted.',
      content: jsonContent(DeploymentActionResponseSchema),
    },
    400: errorResponse('Invalid body, deploy.yaml, or ref.'),
    404: errorResponse('Project or environment not found.'),
    409: errorResponse('Environment is already busy.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/deployments/{deploymentId}',
  tags: ['Deployments'],
  summary: 'Get deployment status',
  request: { params: deploymentParams },
  responses: {
    200: {
      description: 'Deployment detail.',
      content: jsonContent(DeploymentDetailResponseSchema),
    },
    404: errorResponse('Project or deployment not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/deployments/{deploymentId}/cancel',
  tags: ['Deployments'],
  summary: 'Cancel a deployment',
  request: {
    params: deploymentParams,
    body: { content: jsonContent(CancelDeploymentRequestSchema) },
  },
  responses: {
    202: { description: 'Action accepted.', content: jsonContent(DeploymentActionResponseSchema) },
    400: errorResponse('Invalid request or action is not applicable.'),
    403: errorResponse('Admin role required.'),
    404: errorResponse('Project or deployment not found.'),
    409: errorResponse('Deployment is no longer actionable.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/deployments/{deploymentId}/approve',
  tags: ['Deployments'],
  summary: 'Approve a gated deployment',
  request: {
    params: deploymentParams,
    body: { content: jsonContent(ApproveDeploymentRequestSchema) },
  },
  responses: {
    202: { description: 'Action accepted.', content: jsonContent(DeploymentActionResponseSchema) },
    400: errorResponse('Invalid request or action is not applicable.'),
    403: errorResponse('Admin role required.'),
    404: errorResponse('Project or deployment not found.'),
    409: errorResponse('Deployment is no longer awaiting approval.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/deployments/{deploymentId}/rollback',
  tags: ['Deployments'],
  summary: 'Rollback by redeploying a historical ref',
  request: {
    params: deploymentParams,
    body: { content: jsonContent(RollbackDeploymentRequestSchema) },
  },
  responses: {
    202: { description: 'Action accepted.', content: jsonContent(DeploymentActionResponseSchema) },
    400: errorResponse('Invalid request or action is not applicable.'),
    403: errorResponse('Admin role required.'),
    404: errorResponse('Project or deployment not found.'),
    409: errorResponse('Environment is already busy.'),
  },
});
