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

export const AdjustDeploymentReleaseItemRequestSchema = z.object({
  inclusionStatus: z.enum(['included', 'excluded']),
  reason: z.string().trim().min(1).max(2000),
  supportTicketId: z.string().min(1).nullable().optional(),
});

const ReleaseNotificationTypeEnum = z.enum(['ticket_release', 'release_digest']);
const ReleaseNotificationStatusEnum = z.enum(['pending', 'sending', 'sent', 'error']);

const ReleaseNotificationHistoryItemSchema = registerComponent(
  'ReleaseNotificationHistoryItem',
  z.object({
    id: z.string(),
    deployment_id: z.string(),
    release_item_id: z.string().nullable(),
    support_ticket_id: z.string().nullable(),
    notification_type: ReleaseNotificationTypeEnum,
    recipient_type: z.enum(['reporter', 'release_digest']),
    subject: z.string(),
    status: ReleaseNotificationStatusEnum,
    attempts: z.number().int(),
    sent_at: z.string().nullable(),
    next_attempt_at: z.string().nullable(),
    error_summary: z.string().nullable(),
    can_retry: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);

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

export const DeploymentReleaseItemReviewSchema = registerComponent(
  'DeploymentReleaseItemReview',
  DeploymentReleaseItemSchema.extend({
    card: z.object({
      id: z.string(),
      title: z.string(),
      shortId: z.number().int().nullable(),
      priority: z.string().nullable(),
      columnName: z.string().nullable(),
    }),
    supportTicket: z
      .object({
        id: z.string(),
        subject: z.string().nullable(),
        status: z.string().nullable(),
        type: z.string().nullable(),
        releaseState: z
          .enum(['fixed_pending_release', 'released_to_prod', 'customer_notified'])
          .nullable(),
      })
      .nullable(),
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
    releaseItems: z.array(DeploymentReleaseItemReviewSchema),
    releaseNotifications: z.array(ReleaseNotificationHistoryItemSchema),
    environment: DeploymentEnvironmentSchema.nullable(),
    history: z.array(DeploymentSchema),
    logs: z.array(z.object({}).passthrough()),
  }),
);

const DeploymentReleaseItemListResponseSchema = registerComponent(
  'DeploymentReleaseItemListResponse',
  z.object({
    releaseItems: z.array(DeploymentReleaseItemReviewSchema),
  }),
);

const DeploymentReleaseItemResponseSchema = registerComponent(
  'DeploymentReleaseItemResponse',
  z.object({
    releaseItem: DeploymentReleaseItemReviewSchema,
    releaseItems: z.array(DeploymentReleaseItemReviewSchema),
  }),
);

const DeploymentReleaseDigestResponseSchema = registerComponent(
  'DeploymentReleaseDigestResponse',
  z.object({
    digestMarkdown: z.string(),
    settings: z.object({
      isDefault: z.boolean(),
      updatedAt: z.string().nullable(),
    }),
  }),
);

const ReleaseNotificationRetryResponseSchema = registerComponent(
  'ReleaseNotificationRetryResponse',
  z.object({
    notification: ReleaseNotificationHistoryItemSchema,
    releaseNotifications: z.array(ReleaseNotificationHistoryItemSchema),
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
const deploymentReleaseItemParams = z.object({
  projectId: z.string(),
  deploymentId: z.string(),
  cardId: z.string(),
});
const deploymentReleaseNotificationParams = z.object({
  projectId: z.string(),
  deploymentId: z.string(),
  notificationId: z.string(),
});

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
  path: '/api/projects/{projectId}/deployments/{deploymentId}/release-notifications/{notificationId}/retry',
  tags: ['Deployments'],
  summary: 'Retry a failed release notification',
  description:
    'Admin+. Requeues the existing failed release notification outbox row. Sent rows are never duplicated.',
  request: {
    params: deploymentReleaseNotificationParams,
    body: { content: jsonContent(z.object({}).passthrough()) },
  },
  responses: {
    200: {
      description: 'Existing notification row requeued for delivery.',
      content: jsonContent(ReleaseNotificationRetryResponseSchema),
    },
    403: errorResponse('Admin role required.'),
    404: errorResponse('Project, deployment, or release notification not found.'),
    409: errorResponse('Notification is already sent or not failed.'),
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
  method: 'get',
  path: '/api/projects/{projectId}/deployments/{deploymentId}/release-items',
  tags: ['Deployments'],
  summary: 'List reviewed release items for a deployment',
  request: { params: deploymentParams },
  responses: {
    200: {
      description: 'Release items with card and support-ticket review context.',
      content: jsonContent(DeploymentReleaseItemListResponseSchema),
    },
    404: errorResponse('Project or deployment not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/deployments/{deploymentId}/release-digest',
  tags: ['Deployments'],
  summary: 'Generate a deployment release digest draft',
  description:
    'Admin+. Generates a customer-facing markdown release digest draft from included release items. The model prompt always wraps the stored project release digest prompt inside the fixed fact-bounded generation template.',
  request: {
    params: deploymentParams,
    body: { content: jsonContent(z.object({}).passthrough()) },
  },
  responses: {
    200: {
      description: 'Generated release digest draft.',
      content: jsonContent(DeploymentReleaseDigestResponseSchema),
    },
    403: errorResponse('Admin role required.'),
    404: errorResponse('Project or deployment not found.'),
    500: errorResponse('Digest generation failed.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/deployments/{deploymentId}/release-items/{cardId}',
  tags: ['Deployments'],
  summary: 'Include or exclude a linked card in a deployment release',
  description:
    'Admin+. Creates a release item for a missed card or updates an existing item, stamping operator audit fields with the caller, timestamp, and reason.',
  request: {
    params: deploymentReleaseItemParams,
    body: { content: jsonContent(AdjustDeploymentReleaseItemRequestSchema) },
  },
  responses: {
    200: {
      description: 'Adjusted release item and refreshed release item list.',
      content: jsonContent(DeploymentReleaseItemResponseSchema),
    },
    400: errorResponse('Invalid request body or support-ticket link.'),
    403: errorResponse('Admin role required.'),
    404: errorResponse('Project, deployment, or card not found.'),
    409: errorResponse('Deployment release items are no longer reviewable.'),
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
