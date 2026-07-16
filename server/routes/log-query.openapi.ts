/** Zod and OpenAPI contract for project-scoped customer-log reads. */
import { z, registerComponent, registerPath } from '../openapi/registry.js';
import { MAX_QUERY_LIMIT } from '../logs/logs-schema.js';

const finiteInt = z.coerce.number().int().finite();

export const LogQueryParamsSchema = z.object({
  startTimeUnixNano: finiteInt.nonnegative().optional(),
  endTimeUnixNano: finiteInt.nonnegative().optional(),
  sourceId: z.string().min(1).max(200).optional(),
  serviceName: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(200).optional(),
  minSeverityNumber: finiteInt.min(0).max(24).optional(),
  text: z.string().min(1).max(500).optional(),
  traceId: z.string().min(1).max(256).optional(),
  fingerprint: z.string().min(1).max(256).optional(),
  cursor: finiteInt.positive().optional(),
  limit: finiteInt.min(1).max(MAX_QUERY_LIMIT).optional(),
});

const LogRecordComponent = registerComponent(
  'LogRecord',
  z.object({
    id: z.number().int(),
    projectId: z.string(),
    sourceId: z.string(),
    timeUnixNano: z.number().int(),
    observedTimeUnixNano: z.number().int().nullable(),
    severityNumber: z.number().int(),
    severityText: z.string().nullable(),
    body: z.string().nullable(),
    serviceName: z.string().nullable(),
    environment: z.string().nullable(),
    traceId: z.string().nullable(),
    spanId: z.string().nullable(),
    fingerprint: z.string().nullable(),
    resourceJson: z.string().nullable(),
    attributesJson: z.string().nullable(),
    scopeJson: z.string().nullable(),
    byteSize: z.number().int(),
    ingestedAt: z.number().int(),
  }),
);

const LogQueryResponse = registerComponent(
  'LogQueryResponse',
  z.object({
    records: z.array(LogRecordComponent),
    nextCursor: z.number().int().nullable(),
  }),
);

const ErrorResponse = registerComponent('LogQueryErrorResponse', z.object({ error: z.string() }));

const LogPurgeResponse = registerComponent(
  'LogPurgeResponse',
  z.object({ purged: z.number().int().nonnegative() }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/logs',
  tags: ['Logs'],
  summary: 'Query project logs',
  description:
    'Returns a bounded newest-first page. Every filter and cursor is scoped to the path project; a cursor from another project cannot reveal records.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: LogQueryParamsSchema,
  },
  responses: {
    200: {
      description: 'Log page.',
      content: { 'application/json': { schema: LogQueryResponse } },
    },
    400: {
      description: 'Malformed query parameters.',
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
  method: 'delete',
  path: '/api/projects/{projectId}/logs',
  tags: ['Logs'],
  summary: 'Clear all project logs',
  description:
    'Purges every ingested log record (and its full-text index row) for the project in one transaction, returning the number removed. Destructive and Admin-gated. Grouped error Issues are a separate surface and are left intact.',
  request: {
    params: z.object({ projectId: z.string() }),
  },
  responses: {
    200: {
      description: 'Records purged.',
      content: { 'application/json': { schema: LogPurgeResponse } },
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
