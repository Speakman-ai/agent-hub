/** Zod + OpenAPI contract for project-scoped error-issue grouping (LOG-GROUP). */
import { z, registerComponent, registerPath } from '../openapi/registry.js';
import { MAX_ISSUE_LIST_LIMIT, ISSUE_STATUSES } from '../logs/log-issues-store.js';

const finiteInt = z.coerce.number().int().finite();

export const IssueListParamsSchema = z.object({
  status: z.enum(ISSUE_STATUSES as unknown as [string, ...string[]]).optional(),
  limit: finiteInt.min(1).max(MAX_ISSUE_LIST_LIMIT).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

const LogIssueRelease = registerComponent(
  'LogIssueRelease',
  z.object({
    release: z.string().nullable(),
    commitSha: z.string().nullable(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    eventCount: z.number().int(),
  }),
);

const LogIssue = registerComponent(
  'LogIssue',
  z.object({
    id: z.string(),
    projectId: z.string(),
    fingerprint: z.string(),
    title: z.string(),
    service: z.string().nullable(),
    environment: z.string().nullable(),
    exceptionType: z.string().nullable(),
    messageTemplate: z.string().nullable(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    eventCount: z.number().int(),
    status: z.enum(ISSUE_STATUSES as unknown as [string, ...string[]]),
    statusUpdatedAt: z.number().int().nullable(),
    statusUpdatedBy: z.string().nullable(),
    firstRecordId: z.number().int().nullable(),
    lastRecordId: z.number().int().nullable(),
    analyzeSessionId: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  }),
);

const LogIssueDetail = registerComponent(
  'LogIssueDetail',
  LogIssue.extend({
    releases: z.array(LogIssueRelease),
    samples: z.array(z.record(z.string(), z.unknown())),
  }),
);

const LogIssueListResponse = registerComponent(
  'LogIssueListResponse',
  z.object({
    issues: z.array(LogIssue),
    nextCursor: z.string().nullable(),
  }),
);

const ErrorResponse = registerComponent('LogIssueErrorResponse', z.object({ error: z.string() }));

const projectParam = z.object({ projectId: z.string() });
const issueParam = z.object({ projectId: z.string(), issueId: z.string() });

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/logs/issues',
  tags: ['Logs'],
  summary: 'List grouped error issues',
  description:
    'Project-scoped, newest-activity-first, cursor-paginated. Filter by lifecycle status (open/resolved/ignored). A cursor from another project cannot reveal its issues.',
  request: { params: projectParam, query: IssueListParamsSchema },
  responses: {
    200: {
      description: 'Issue page.',
      content: { 'application/json': { schema: LogIssueListResponse } },
    },
    400: {
      description: 'Malformed query.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Project not found or not visible.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/logs/issues/{issueId}',
  tags: ['Logs'],
  summary: 'Get an error issue with release facets and sample records',
  request: { params: issueParam },
  responses: {
    200: {
      description: 'Issue detail.',
      content: { 'application/json': { schema: LogIssueDetail } },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Project or issue not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

const transitionResponses = {
  200: { description: 'Updated issue.', content: { 'application/json': { schema: LogIssue } } },
  403: {
    description: 'Insufficient role.',
    content: { 'application/json': { schema: ErrorResponse } },
  },
  404: {
    description: 'Project or issue not found.',
    content: { 'application/json': { schema: ErrorResponse } },
  },
} as const;

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/logs/issues/{issueId}/resolve',
  tags: ['Logs'],
  summary: 'Resolve an error issue',
  request: { params: issueParam },
  responses: transitionResponses,
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/logs/issues/{issueId}/ignore',
  tags: ['Logs'],
  summary: 'Ignore (mute) an error issue',
  request: { params: issueParam },
  responses: transitionResponses,
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/logs/issues/{issueId}/reopen',
  tags: ['Logs'],
  summary: 'Reopen an error issue',
  request: { params: issueParam },
  responses: transitionResponses,
});

const AnalyzeResponse = registerComponent(
  'LogIssueAnalyzeResponse',
  z.object({
    sessionId: z.string(),
    agentId: z.string(),
    reused: z.boolean(),
    issue: LogIssue,
  }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/logs/issues/{issueId}/analyze',
  tags: ['Logs'],
  summary: 'Start (or reopen) a read-only Analyze chat session for an error issue',
  description:
    'Idempotently starts a normal chat session on the project default dev/lead agent, seeded with a bounded, redacted, fenced log context pack and a read-only investigation brief (finalize_automation=manual, isolated worktree when supported). While a live linked session exists, repeat calls return it (`reused: true`). The linked session id is exposed as `analyzeSessionId` on issue detail.',
  request: { params: issueParam },
  responses: {
    200: {
      description: 'The linked Analyze session (newly started or reused).',
      content: { 'application/json': { schema: AnalyzeResponse } },
    },
    400: {
      description: 'No eligible agent for the project.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    403: {
      description: 'Insufficient role.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    404: {
      description: 'Project or issue not found.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});
