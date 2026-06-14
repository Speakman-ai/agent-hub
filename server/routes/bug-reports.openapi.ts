/**
 * OpenAPI registration for the public bug-report intake endpoint.
 *
 * The endpoint is unauthenticated, multipart-only, and rate-limited
 * per-IP. It accepts an optional PNG/JPEG screenshot, persists fields,
 * and dispatches a session to the `agent-hub-intake` agent.
 *
 * The handler parses multipart by hand (no multer) — Zod can't validate
 * the raw `Buffer` body. We document the field set here for spec
 * consumers; runtime validation lives inline in `bug-reports.ts`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'BugReportsErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for bug-report intake.' }),
);

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const VALID_CLIENT_TYPES = ['web', 'electron', 'mobile'] as const;

// Documentation-only schema — the actual handler parses multipart bytes.
export const BugReportFormFieldsComponent = registerComponent(
  'BugReportFormFields',
  z
    .object({
      title: z.string().min(1).max(200),
      severity: z.enum(VALID_SEVERITIES).default('medium'),
      description: z.string().optional(),
      sourceUrl: z.string().optional(),
      userAgent: z.string().optional(),
      appVersion: z.string().optional(),
      clientType: z.enum(VALID_CLIENT_TYPES).optional(),
      currentProjectId: z.string().optional(),
      currentAgentId: z.string().optional(),
      replayRef: z.string().optional().openapi({
        description:
          'Optional session-replay ref from POST /api/replays (`/uploads/replay-<id>.json`). Surfaced to the intake agent for investigation.',
      }),
      screenshot: z.string().optional().openapi({
        description:
          'Optional PNG or JPEG (≤5 MB). Sent as a binary file part in the multipart body.',
        format: 'binary',
      }),
    })
    .openapi({
      description:
        'Multipart form fields for the bug-report intake. Documentation-only; the handler reads multipart bytes directly because the body is `application/octet-stream` to express.',
    }),
);

const BugReportSuccessResponse = z
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
  path: '/api/bug-reports',
  tags: ['Bug Reports'],
  summary: 'CORS preflight (returns 204)',
  responses: { 204: { description: 'CORS preflight OK.' } },
});

registerPath({
  method: 'post',
  path: '/api/bug-reports',
  tags: ['Bug Reports'],
  summary: 'Public bug-report intake (multipart)',
  description:
    'Unauthenticated, rate-limited (10 / hour per IP). Body must be `multipart/form-data` with at minimum a `title` field. Optional `screenshot` is a PNG or JPEG up to 5 MB. Spawns a session for `agent-hub-intake` to land a kanban card under the `user-request` epic.',
  request: {
    body: {
      content: {
        'multipart/form-data': { schema: BugReportFormFieldsComponent },
      },
    },
  },
  responses: {
    202: { description: 'Dispatched.', content: jsonContent(BugReportSuccessResponse) },
    400: errorResponse('Validation failed (missing title, bad severity, malformed multipart).'),
    413: errorResponse('Screenshot exceeds 5 MB.'),
    429: errorResponse('Per-IP rate limit exceeded.'),
    500: errorResponse('Intake agent missing or handler threw.'),
  },
});
