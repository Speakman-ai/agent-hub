/**
 * OpenAPI registration for the public session-replay ingest endpoint.
 *
 * Unauthenticated, JSON-only, rate-limited per-IP. Accepts a rolling-buffer
 * window of rrweb events flushed by the web client and persists it under
 * `server/uploads/replay-<uuid>.json`, returning the replay id and its
 * `/uploads/...` ref for the support-ticket investigation to read back.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'ReplayIngestErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for replay ingest.' }),
);

export const ReplayIngestRequestSchema = registerComponent(
  'ReplayIngestRequest',
  z
    .object({
      events: z
        .array(
          z.object({
            type: z.number().openapi({ description: 'rrweb EventType.' }),
            timestamp: z.number().openapi({ description: 'Event timestamp (ms epoch).' }),
            data: z.unknown().optional(),
          }),
        )
        .min(1)
        .openapi({ description: 'Trailing rolling-buffer window of rrweb events.' }),
      meta: z
        .record(z.string(), z.unknown())
        .optional()
        .openapi({ description: 'Optional context (trigger, url, ...).' }),
    })
    .openapi({ description: 'A flushed session-replay buffer.' }),
);

const ReplayIngestSuccessResponse = z
  .object({
    replayId: z.string(),
    replayRef: z.string().openapi({ description: 'Local `/uploads/replay-<id>.json` ref.' }),
  })
  .openapi({ description: 'The persisted replay id and its uploads ref.' });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'options',
  path: '/api/replays',
  tags: ['Bug Reports'],
  summary: 'CORS preflight (returns 204)',
  responses: { 204: { description: 'CORS preflight OK.' } },
});

registerPath({
  method: 'post',
  path: '/api/replays',
  tags: ['Bug Reports'],
  summary: 'Public session-replay ingest (JSON)',
  description:
    'Unauthenticated, rate-limited (30 / hour per IP). Body is `application/json` with a non-empty `events` array of rrweb events (≤8 MB). Persists the buffer and returns its `/uploads/replay-<id>.json` ref, usable as a support ticket `replayRef`.',
  request: {
    body: { content: jsonContent(ReplayIngestRequestSchema) },
  },
  responses: {
    201: { description: 'Stored.', content: jsonContent(ReplayIngestSuccessResponse) },
    400: errorResponse('Validation failed (empty events, bad event shape, non-object meta).'),
    429: errorResponse('Per-IP rate limit exceeded.'),
    500: errorResponse('Handler threw while persisting the replay.'),
  },
});
