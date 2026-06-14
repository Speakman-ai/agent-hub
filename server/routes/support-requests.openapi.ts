/**
 * OpenAPI registration for the public, project-scoped support-request
 * intake endpoint.
 *
 * The endpoint is unauthenticated, multipart-only, and rate-limited
 * per-IP. It accepts a support `type` (`bug` | `feature_request`), a
 * `severity` used for queue ordering, and — for `bug` requests — an
 * optional session-replay reference / attachment. The handler parses
 * multipart by hand (no multer), so Zod can't validate the raw `Buffer`
 * body; we document the field set here for spec consumers while runtime
 * validation lives inline in `support-requests.ts`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'SupportRequestsErrorResponse',
  z
    .object({ error: z.string() })
    .openapi({ description: 'Error envelope for support-request intake.' }),
);

const VALID_TYPES = ['bug', 'feature_request'] as const;
const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const VALID_CLIENT_TYPES = ['web', 'electron', 'mobile'] as const;

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug or id.' }),
});

// Documentation-only schema — the actual handler parses multipart bytes.
export const SupportRequestFormFieldsComponent = registerComponent(
  'SupportRequestFormFields',
  z
    .object({
      type: z.enum(VALID_TYPES).openapi({
        description: 'Kind of support request.',
      }),
      title: z.string().min(1).max(200),
      severity: z.enum(VALID_SEVERITIES).default('medium').openapi({
        description: 'Used for support-queue ordering (critical first).',
      }),
      description: z.string().optional(),
      sourceUrl: z.string().optional(),
      userAgent: z.string().optional(),
      appVersion: z.string().optional(),
      clientType: z.enum(VALID_CLIENT_TYPES).optional(),
      contactEmail: z.string().optional(),
      currentAgentId: z.string().optional(),
      sessionReplayUrl: z.string().optional().openapi({
        description: 'Reference (URL/id) to a session replay. Only valid when `type` is `bug`.',
      }),
      sessionReplay: z.string().optional().openapi({
        description:
          'Optional session-replay attachment (rrweb JSON, zip, or short capture, ≤25 MB). Sent as a binary file part. Only valid when `type` is `bug`.',
        format: 'binary',
      }),
    })
    .openapi({
      description:
        'Multipart form fields for the support-request intake. Documentation-only; the handler reads multipart bytes directly because the body is `application/octet-stream` to express.',
    }),
);

const SupportRequestSuccessResponse = z
  .object({
    sessionId: z.string(),
    status: z.literal('dispatched'),
  })
  .openapi({
    description:
      'The intake session has been spawned. Result is the session id; the kanban card lands when the session completes.',
  });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'options',
  path: '/api/projects/{projectId}/support-requests',
  tags: ['Support Requests'],
  summary: 'CORS preflight (returns 204)',
  request: { params: projectIdParams },
  responses: { 204: { description: 'CORS preflight OK.' } },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/support-requests',
  tags: ['Support Requests'],
  summary: 'Public support-request intake (multipart)',
  description:
    'Unauthenticated, rate-limited (10 / hour per IP). Body must be `multipart/form-data` with at minimum `type` (`bug` | `feature_request`) and `title`. `severity` drives support-queue ordering. For `bug` requests, an optional `sessionReplayUrl` reference and/or `sessionReplay` attachment (≤25 MB) may be supplied. Spawns a session for the project `intake` agent to land a kanban card under the `support-request` epic.',
  request: {
    params: projectIdParams,
    body: {
      content: {
        'multipart/form-data': { schema: SupportRequestFormFieldsComponent },
      },
    },
  },
  responses: {
    202: { description: 'Dispatched.', content: jsonContent(SupportRequestSuccessResponse) },
    400: errorResponse(
      'Validation failed (bad/missing type, missing title, bad severity, session replay on a non-bug request, malformed multipart).',
    ),
    404: errorResponse('Project not found.'),
    413: errorResponse(
      'Payload too large — session-replay attachment over 25 MB, or the whole multipart body over 26 MB.',
    ),
    429: errorResponse('Per-IP rate limit exceeded.'),
    500: errorResponse('Project has no intake agent or handler threw.'),
  },
});
