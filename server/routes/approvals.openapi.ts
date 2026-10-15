/**
 * Zod schemas + OpenAPI registrations for agent approvals
 * (`server/routes/approvals.ts`).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'ApprovalErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

export const ApprovalStatusSchema = z.enum(['pending', 'allowed', 'denied', 'cancelled']);
export const ApprovalResolutionSchema = z.enum([
  'allow_once',
  'always_allow',
  'auto_allowed',
  'deny',
  'timeout',
  'aborted',
]);
export const ApprovalDecisionSchema = z.enum(['allow_once', 'always_allow', 'deny']);

export const ApprovalSchema = registerComponent(
  'Approval',
  z
    .object({
      id: z.string(),
      sessionId: z.string(),
      agentId: z.string(),
      projectId: z.string().nullable(),
      action: z
        .string()
        .openapi({ description: 'Normalized verb, e.g. `send`, `delete`, `purchase`.' }),
      target: z.string().openapi({ description: 'What the action affects (URL, recipient, ...).' }),
      domain: z
        .string()
        .nullable()
        .openapi({ description: 'Site the request is about; null for free-text targets.' }),
      details: z.string(),
      status: ApprovalStatusSchema,
      resolution: ApprovalResolutionSchema.nullable(),
      ruleId: z
        .string()
        .nullable()
        .openapi({ description: 'Rule saved by, or that auto-allowed, this request.' }),
      canRemember: z.boolean().openapi({
        description: 'Always allow will save a rule (the request has a domain and an owner).',
      }),
      requestedAt: z.number().int().openapi({ description: 'Epoch ms.' }),
      expiresAt: z
        .number()
        .int()
        .openapi({ description: 'Epoch ms; unanswered requests are denied then.' }),
      resolvedAt: z.number().int().nullable(),
    })
    .openapi({ description: 'An agent request to perform an irreversible action.' }),
);

export const ApprovalRuleSchema = registerComponent(
  'ApprovalRule',
  z.object({
    id: z.string(),
    profileId: z.string().openapi({ description: 'Browser profile the rule is scoped to.' }),
    userId: z.string(),
    domain: z.string(),
    action: z.string(),
    effect: z.enum(['allow', 'require']).openapi({
      description: '`require` always asks, even when an `allow` rule matches.',
    }),
    sourceRequestId: z.string().nullable(),
    createdAt: z.string(),
  }),
);

const ApprovalIdParams = z.object({ approvalId: z.string() });
const RuleIdParams = z.object({ ruleId: z.string() });

const unauthenticated = {
  description: 'Not authenticated.',
  content: { 'application/json': { schema: ErrorResponse } },
};
const agentCaller = {
  description:
    'Called with agent credentials (global API key, spawn key, or X-Agent-Hub-Session-Id). Only people answer approvals.',
  content: { 'application/json': { schema: ErrorResponse } },
};
const notFound = {
  description: 'No approval with this id is visible to the caller.',
  content: { 'application/json': { schema: ErrorResponse } },
};

registerPath({
  method: 'get',
  path: '/api/me/approvals',
  tags: ['Approvals'],
  summary: 'List approvals raised by the caller sessions',
  request: {
    query: z.object({
      status: ApprovalStatusSchema.optional(),
      sessionId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Newest first, up to 100.',
      content: { 'application/json': { schema: z.object({ approvals: z.array(ApprovalSchema) }) } },
    },
    400: {
      description: 'Unknown status filter.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: unauthenticated,
    403: agentCaller,
  },
});

registerPath({
  method: 'get',
  path: '/api/me/approvals/{approvalId}',
  tags: ['Approvals'],
  summary: 'Read one approval',
  request: { params: ApprovalIdParams },
  responses: {
    200: {
      description: 'The approval.',
      content: { 'application/json': { schema: ApprovalSchema } },
    },
    401: unauthenticated,
    403: agentCaller,
    404: notFound,
  },
});

registerPath({
  method: 'post',
  path: '/api/me/approvals/{approvalId}/answer',
  tags: ['Approvals'],
  summary: 'Answer a pending approval',
  description:
    'Resumes the agent turn waiting on it. `always_allow` also saves a rule for (browser profile, domain, action) so later matching requests are approved without asking; requests without a domain cannot be remembered.',
  request: {
    params: ApprovalIdParams,
    body: {
      content: { 'application/json': { schema: z.object({ decision: ApprovalDecisionSchema }) } },
    },
  },
  responses: {
    200: {
      description: 'Answered.',
      content: {
        'application/json': {
          schema: z.object({ approval: ApprovalSchema, ruleId: z.string().nullable() }),
        },
      },
    },
    400: {
      description: 'Invalid decision.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: unauthenticated,
    403: agentCaller,
    404: notFound,
    409: {
      description:
        'Already answered, expired (denied), or its turn is gone (stopped or the Hub restarted).',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), approval: ApprovalSchema.optional() }),
        },
      },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/me/approval-rules',
  tags: ['Approvals'],
  summary: 'List the caller remembered approval rules',
  responses: {
    200: {
      description: 'Rules ordered by domain then action.',
      content: { 'application/json': { schema: z.object({ rules: z.array(ApprovalRuleSchema) }) } },
    },
    401: unauthenticated,
    403: agentCaller,
  },
});

registerPath({
  method: 'post',
  path: '/api/me/approval-rules',
  tags: ['Approvals'],
  summary: 'Save an approval rule on one of the caller browser profiles',
  description:
    'A `require` rule makes the matching action ask every time, beating any always-allow rule and an `allow` domain policy. It also covers subdomains, and `action: "*"` matches every action. `allow` rules match the exact host and action. Idempotent: saving an existing rule returns it.',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            profileId: z.string(),
            domain: z.string().openapi({ description: 'Hostname or URL; reduced to the host.' }),
            action: z.string().openapi({
              description: 'Verb such as `click`, `type`, `send`, or `*` (require only).',
            }),
            effect: z
              .enum(['allow', 'require'])
              .optional()
              .openapi({ description: 'Default `require`.' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'The saved rule.',
      content: { 'application/json': { schema: z.object({ rule: ApprovalRuleSchema }) } },
    },
    400: {
      description: 'Bad effect, domain or action.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: unauthenticated,
    403: agentCaller,
    404: {
      description: 'No browser profile with this id belongs to the caller.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/me/approval-rules/{ruleId}',
  tags: ['Approvals'],
  summary: 'Delete one of the caller approval rules',
  request: { params: RuleIdParams },
  responses: {
    200: {
      description: 'Deleted.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: unauthenticated,
    403: agentCaller,
    404: {
      description: 'No rule with this id belongs to the caller.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});
