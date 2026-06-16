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
    .openapi({
      description:
        'A flushed session-replay buffer. May be sent as raw JSON or gzip-compressed bytes (`Content-Encoding: gzip` or a gzip-framed body).',
    }),
);

const ReplayIngestSuccessResponse = z
  .object({
    replayId: z.string(),
    replayRef: z.string().openapi({ description: 'Local `/uploads/replay-<id>.json` ref.' }),
    projectId: z.string().nullable().openapi({
      description:
        'Project the capture was attributed to via a valid `X-RUM-Token`, or null for anonymous ingest.',
    }),
    size: z.number().openapi({ description: 'Compressed (gzip) blob size in bytes.' }),
    eventCount: z.number().openapi({ description: 'Number of rrweb events stored.' }),
    durationMs: z
      .number()
      .openapi({ description: 'Span between first and last event timestamp (ms).' }),
  })
  .openapi({ description: 'The persisted replay id, its uploads ref, and blob stats.' });

const ReplayMetadataResponse = registerComponent(
  'SessionReplayMetadata',
  z
    .object({
      id: z.string(),
      projectId: z.string().nullable(),
      createdAt: z.string(),
      durationMs: z.number(),
      eventCount: z.number(),
      size: z.number().openapi({ description: 'Compressed blob size in bytes.' }),
      uncompressedSize: z.number().openapi({ description: 'Raw JSON length in bytes.' }),
      supportTicketId: z.string().nullable(),
      cardId: z.string().nullable(),
      meta: z.record(z.string(), z.unknown()).nullable(),
      eventsUrl: z.string().openapi({ description: 'Paginated events endpoint for this replay.' }),
      defaultPageSize: z.number(),
    })
    .openapi({ description: 'Session-replay metadata row.' }),
);

const ReplayEventsPageResponse = z
  .object({
    replayId: z.string(),
    events: z
      .array(
        z.object({
          type: z.number(),
          timestamp: z.number(),
          data: z.unknown().optional(),
        }),
      )
      .openapi({ description: 'One page of rrweb events.' }),
    total: z.number().openapi({ description: 'Total events in the capture.' }),
    offset: z.number().openapi({ description: 'Applied (clamped) offset.' }),
    limit: z.number().openapi({ description: 'Applied (clamped) page size.' }),
    hasMore: z.boolean().openapi({ description: 'True when more events follow this page.' }),
  })
  .openapi({ description: 'A paginated window of a replay’s events.' });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

// Replay ingest accepts the JSON body OR its gzip-compressed bytes
// (`application/octet-stream`, gzip-framed; the server inflates transparently).
// Advertise both content types so a client generated from the spec can produce
// the compressed happy path the recorder actually uses.
const replayIngestContent = <T extends z.ZodTypeAny>(schema: T) => ({
  ...jsonContent(schema),
  'application/octet-stream': {
    schema: z.string().openapi({
      type: 'string',
      format: 'binary',
      description: 'gzip-compressed request JSON (gzip-framed bytes).',
    }),
  },
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
  summary: 'Public session-replay ingest (JSON or gzip)',
  description:
    'Body carries a non-empty `events` array of rrweb events. May be sent as raw `application/json` or gzip-compressed bytes (a gzip-framed `application/octet-stream` body, or `Content-Encoding: gzip`) — compression is recommended since rrweb JSON is large and the decompressed payload is bounded at 16 MB. Persists the buffer and returns its `/uploads/replay-<id>.json` ref, usable as a support ticket `replayRef`. Auth is optional: with no `X-RUM-Token` the request is anonymous, rate-limited 30 / hour per IP, and the row is left unattributed. With a valid per-project `X-RUM-Token` (minted via `POST /api/projects/{projectId}/rum/clients`) the capture is attributed to that project and rate-limited 600 / hour per project instead; an invalid token is rejected 401.',
  request: {
    headers: z.object({
      'x-rum-token': z.string().optional().openapi({
        description: 'Optional per-project RUM ingest token. When present it must be valid.',
      }),
    }),
    body: {
      description:
        'Either a raw JSON `ReplayIngestRequest` body, or its gzip-compressed bytes sent as `application/octet-stream` (a gzip-framed body the server inflates transparently).',
      content: replayIngestContent(ReplayIngestRequestSchema),
    },
  },
  responses: {
    201: { description: 'Stored.', content: jsonContent(ReplayIngestSuccessResponse) },
    400: errorResponse(
      'Validation failed (empty events, bad event shape, non-object meta), or a malformed JSON / gzip body.',
    ),
    401: errorResponse('An X-RUM-Token header was supplied but is invalid or revoked.'),
    413: errorResponse('Request body (or its decompressed size) exceeds the 16 MB limit.'),
    429: errorResponse('Per-IP (anonymous) or per-project (token) rate limit exceeded.'),
    500: errorResponse('Handler threw while persisting the replay.'),
  },
});

const replayIdParam = {
  params: z.object({
    id: z.string().openapi({ description: 'Replay id (uuid).' }),
  }),
};

const ReplayBatchRequestSchema = registerComponent(
  'ReplayBatchIngestRequest',
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
        .openapi({ description: 'One batch (chunk) of rrweb events.' }),
      meta: z
        .record(z.string(), z.unknown())
        .optional()
        .openapi({ description: 'Optional context, honored on the first chunk only.' }),
    })
    .openapi({
      description:
        'A chunk of a streamed replay. May be sent as raw JSON or gzip-compressed bytes (`Content-Encoding: gzip` or a gzip-framed body).',
    }),
);

const ReplayBatchSuccessResponse = z
  .object({
    replayId: z.string(),
    created: z.boolean().openapi({ description: 'True when this chunk created the replay.' }),
    eventCount: z.number().openapi({ description: 'Total events stored after this chunk.' }),
    size: z.number().openapi({ description: 'Compressed (gzip) blob size in bytes.' }),
    durationMs: z.number().openapi({ description: 'Span across all stored events (ms).' }),
  })
  .openapi({ description: 'Running totals for the replay after appending this chunk.' });

registerPath({
  method: 'options',
  path: '/api/replays/{id}/events',
  tags: ['Bug Reports'],
  summary: 'CORS preflight for chunked replay ingest (returns 204)',
  request: replayIdParam,
  responses: { 204: { description: 'CORS preflight OK.' } },
});

registerPath({
  method: 'post',
  path: '/api/replays/{id}/events',
  tags: ['Bug Reports'],
  summary: 'Public chunked session-replay ingest',
  description:
    'Unauthenticated, rate-limited (600 / hour per IP). Appends one batch of rrweb events to the replay `id`. The first chunk creates the replay and must include a full snapshot (type 2); later chunks append incremental events. The body is `{ events, meta? }` as raw JSON or gzip-compressed (≤2 MB on the wire, ≤16 MB decompressed). A capture is capped at 20,000 total events. Once a replay is attributed to a project / ticket / card it is finalized and rejects further chunks (409).',
  request: {
    ...replayIdParam,
    body: {
      description:
        'Either a raw JSON `ReplayBatchIngestRequest` body, or its gzip-compressed bytes sent as `application/octet-stream` (a gzip-framed body the server inflates transparently).',
      content: replayIngestContent(ReplayBatchRequestSchema),
    },
  },
  responses: {
    200: { description: 'Chunk appended.', content: jsonContent(ReplayBatchSuccessResponse) },
    201: { description: 'Replay created.', content: jsonContent(ReplayBatchSuccessResponse) },
    400: errorResponse('Bad id, undecodable body, or validation failure.'),
    409: errorResponse('Replay is finalized (already attributed) and cannot accept more events.'),
    413: errorResponse('Decompressed payload or total event count exceeds its cap.'),
    429: errorResponse('Per-IP rate limit exceeded.'),
    503: errorResponse('The replay’s storage backend could not be resolved.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/replays/{id}',
  tags: ['Bug Reports'],
  summary: 'Session-replay metadata (authenticated)',
  description:
    'Returns the `session_replays` metadata row (duration, sizes, ticket/card links, events URL). Authenticated, and authorized per-replay: a replay linked to a project is readable only by callers who can view that project; an unattributed replay is readable only by a privileged caller. Unauthorized access is masked as 404.',
  request: replayIdParam,
  responses: {
    200: { description: 'Metadata.', content: jsonContent(ReplayMetadataResponse) },
    404: errorResponse('No replay with that id, or the caller is not authorized to read it.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/replays/{id}/events',
  tags: ['Bug Reports'],
  summary: 'Paginated session-replay events (authenticated)',
  description:
    'Returns one page of the gunzipped rrweb event array, sliced by `offset`/`limit` (defaults applied + capped server-side) so large captures never load in one request. The page carries `total`/`hasMore` for walking. Same per-replay authorization as the metadata endpoint — unauthorized access is masked as 404.',
  request: {
    ...replayIdParam,
    query: z.object({
      offset: z.coerce.number().optional().openapi({ description: 'Start index (default 0).' }),
      limit: z.coerce
        .number()
        .optional()
        .openapi({ description: 'Page size (default 500, max 5000).' }),
    }),
  },
  responses: {
    200: { description: 'A page of events.', content: jsonContent(ReplayEventsPageResponse) },
    404: errorResponse('No replay with that id, or the caller is not authorized to read it.'),
    500: errorResponse('Failed to read the stored blob.'),
    503: errorResponse('The replay’s storage backend could not be resolved.'),
  },
});
