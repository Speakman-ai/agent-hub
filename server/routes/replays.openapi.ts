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
      retainedUntil: z.string().nullable().openapi({
        description:
          'Extended-retention flag: absolute instant this capture is retained until (SQLite-UTC), or null when on the default window. When in the future the retention sweeper skips the row.',
      }),
      retentionFlaggedAt: z.string().nullable().openapi({
        description:
          'When the extended-retention flag was enabled (the 15-month clock starts here), or null.',
      }),
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
    projectId: z.string().nullable().openapi({
      description:
        'Project the capture is attributed to (from a verified X-RUM-Token), or null when anonymous.',
    }),
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
    'Rate-limited (600 / hour per IP for anonymous ingest). Appends one batch of rrweb events to the replay `id`. The first chunk creates the replay and must include a full snapshot (type 2); later chunks append incremental events. The body is `{ events, meta? }` as raw JSON or gzip-compressed (≤2 MB on the wire, ≤16 MB decompressed). A capture is capped at 20,000 total events. Auth is optional and mirrors the one-shot path: with no `X-RUM-Token` the stream is anonymous and the row left unattributed; with a valid per-project token (minted via `POST /api/projects/{projectId}/rum/clients`) the creating chunk attributes the whole stream to that project and the request is rate-limited 6000 / hour per project instead. Every chunk of a stream should carry the same token. A chunk whose project disagrees with an already-attributed capture (anonymous or foreign token) is rejected 403. Once a replay is triage-linked to a support ticket or card it is finalized and rejects all further chunks (409).',
  request: {
    ...replayIdParam,
    headers: z.object({
      'x-rum-token': z.string().optional().openapi({
        description:
          'Optional per-project RUM ingest token. When present it must be valid, and must match the project of any already-attributed capture.',
      }),
    }),
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
    401: errorResponse('An X-RUM-Token header was supplied but is invalid or revoked.'),
    403: errorResponse(
      'The chunk’s project (anonymous or a different token) disagrees with the capture’s existing attribution.',
    ),
    409: errorResponse(
      'Replay is finalized (triage-linked to a support ticket or card) and cannot accept more events.',
    ),
    413: errorResponse('Decompressed payload or total event count exceeds its cap.'),
    429: errorResponse('Per-IP (anonymous) or per-project (token) rate limit exceeded.'),
    503: errorResponse('The replay’s storage backend could not be resolved.'),
  },
});

const segmentIngestParams = {
  params: z.object({
    sessionId: z
      .string()
      .openapi({ description: 'Client-minted session id (RUM sessionization).' }),
    viewId: z.string().openapi({ description: 'Client-minted view id (per route/navigation).' }),
    index: z.string().openapi({
      description: 'index_in_view — 0 is the view-opening segment (must carry a snapshot).',
    }),
  }),
};

const SegmentIngestSuccessResponse = z
  .object({
    segmentId: z.string().openapi({ description: 'Server-assigned segment id.' }),
    sessionId: z.string(),
    viewId: z.string(),
    indexInView: z.number().openapi({ description: '0-based position within the view.' }),
    hasFullSnapshot: z
      .boolean()
      .openapi({ description: 'True when this segment carries an rrweb full snapshot (type 2).' }),
    projectId: z.string().nullable().openapi({
      description: 'Project the segment is attributed to (from a verified X-RUM-Token), or null.',
    }),
    eventCount: z
      .number()
      .openapi({ description: 'Number of rrweb events stored in the segment.' }),
    byteSize: z.number().openapi({ description: 'Compressed (gzip) object size in bytes.' }),
    startTs: z
      .number()
      .openapi({ description: 'Earliest event timestamp in the segment (ms epoch).' }),
    endTs: z.number().openapi({ description: 'Latest event timestamp in the segment (ms epoch).' }),
  })
  .openapi({ description: 'The persisted segment’s manifest row summary.' });

registerPath({
  method: 'options',
  path: '/api/replays/sessions/{sessionId}/views/{viewId}/segments/{index}',
  tags: ['Bug Reports'],
  summary: 'CORS preflight for view-scoped segment ingest (returns 204)',
  request: segmentIngestParams,
  responses: { 204: { description: 'CORS preflight OK.' } },
});

registerPath({
  method: 'post',
  path: '/api/replays/sessions/{sessionId}/views/{viewId}/segments/{index}',
  tags: ['Bug Reports'],
  summary: 'Public view-scoped segment ingest (Datadog segment write path)',
  description:
    'Appends ONE view-scoped replay segment — a single gzipped object per `(sessionId, viewId, index_in_view)` slot, an O(1) append indexed by the `rum_segments` manifest. The view-opening segment (index 0) must carry a full snapshot (type 2); later indices append incremental events. The body is `{ events, meta? }` as raw JSON or gzip-compressed (≤16 MB decompressed), capped at 10,000 events per segment. Auth is optional and mirrors the chunked path: with no `X-RUM-Token` the segment is anonymous and rate-limited per IP; with a valid per-project token it is attributed to that project and rate-limited per project instead. Re-writing an already-stored `(session, view, index)` slot is rejected 409.',
  request: {
    ...segmentIngestParams,
    headers: z.object({
      'x-rum-token': z.string().optional().openapi({
        description: 'Optional per-project RUM ingest token. When present it must be valid.',
      }),
    }),
    body: {
      description:
        'Either a raw JSON `ReplayBatchIngestRequest` body, or its gzip-compressed bytes sent as `application/octet-stream` (a gzip-framed body the server inflates transparently).',
      content: replayIngestContent(ReplayBatchRequestSchema),
    },
  },
  responses: {
    201: { description: 'Segment stored.', content: jsonContent(SegmentIngestSuccessResponse) },
    400: errorResponse(
      'Bad session/view id or index, undecodable body, validation failure, or a view-opening segment (index 0) with no full snapshot.',
    ),
    401: errorResponse('An X-RUM-Token header was supplied but is invalid or revoked.'),
    409: errorResponse('The `(session, view, index)` slot has already been written.'),
    429: errorResponse('Per-IP (anonymous) or per-project (token) rate limit exceeded.'),
    503: errorResponse('The segment storage backend could not be resolved.'),
    500: errorResponse('Handler threw while persisting the segment.'),
  },
});

const ReplayPolicyResponse = registerComponent(
  'ResolvedReplayPolicy',
  z
    .object({
      sampleRate: z.number().nullable().openapi({
        description:
          'Continuous-tier session sample rate in [0, 1], or null when the project has not set one (the recorder keeps its built-in default rather than treating unset as off).',
      }),
      continuous: z.boolean().openapi({
        description: 'Whether the continuous-capture tier is enabled for the project.',
      }),
      maskAllEnforced: z.boolean().openapi({
        description:
          'When true the recorder must mask all text + inputs and the UI must not offer a relaxed masking mode. A strong default whenever continuous capture is on — true unless an Admin has explicitly opted the project out (project `replay.maskAllEnforced === false`).',
      }),
      flushIntervalMs: z.number().openapi({
        description:
          'Cadence (ms) the continuous recorder flushes appended chunks at. Always present; defaults to 5 min and is clamped to a >=60s floor (no sub-minute cadence on the monolithic-append MVP storage).',
      }),
      sessionSampleRate: z.number().nullable().openapi({
        description:
          'Datadog-style two-level sampling, level 1: fraction of sessions tracked in [0, 1], or null when unset (recorder keeps its built-in default).',
      }),
      sessionReplaySampleRate: z.number().nullable().openapi({
        description:
          'Two-level sampling, level 2: fraction OF the sampled sessions that also record a replay, in [0, 1], or null when unset. Nested under sessionSampleRate (a percentage of already-sampled sessions), not an independent gate.',
      }),
      effectiveReplaySampleRate: z.number().nullable().openapi({
        description:
          'Precomputed effective replay probability: the product of the two nested rates (an unset level counts as 1). Null only when both nested rates are unset, so the recorder keeps its built-in default rather than reading null as off.',
      }),
    })
    .openapi({ description: 'Server-delivered per-project session-replay policy.' }),
);

registerPath({
  method: 'options',
  path: '/api/replays/config',
  tags: ['Bug Reports'],
  summary: 'CORS preflight (returns 204)',
  responses: { 204: { description: 'CORS preflight OK.' } },
});

registerPath({
  method: 'get',
  path: '/api/replays/config',
  tags: ['Bug Reports'],
  summary: 'Per-project replay policy (public)',
  description:
    'Returns the server-delivered replay policy (sample rate, continuous opt-in, mask-all enforcement) for the project resolved from a valid `X-RUM-Token` header, else the `projectId` query param. No/unknown project resolves to the default policy (sampleRate null, continuous off) so it is not an existence oracle. Public and CORS `*` — the policy carries no secrets.',
  request: {
    query: z.object({
      projectId: z
        .string()
        .optional()
        .openapi({ description: 'Project slug to resolve the policy for (when no RUM token).' }),
    }),
  },
  responses: {
    200: { description: 'The resolved policy.', content: jsonContent(ReplayPolicyResponse) },
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
  method: 'post',
  path: '/api/replays/{id}/retention',
  tags: ['Bug Reports'],
  summary: 'Flag / unflag a capture for extended retention (authenticated)',
  description:
    'Two-tier retention: keep an individual session past the default window (up to 15 months). `{ extend: true }` stamps an absolute `retainedUntil` = now + the tenant’s extension window (project `replay.extendedRetentionMonths`, clamped [1,15] months, default 15) — the clock starts at enable time, not capture — and the retention sweeper skips the row until that instant passes. `{ extend: false }` clears the flag so the row rejoins the default sweep. Same per-replay authorization as the metadata endpoint; unauthorized access is masked as 404. Returns the updated metadata row.',
  request: {
    ...replayIdParam,
    body: {
      description: 'Whether to extend (flag) or clear the capture’s extended retention.',
      content: jsonContent(
        z
          .object({
            extend: z
              .boolean()
              .openapi({ description: 'true to flag for extended retention; false to clear.' }),
          })
          .openapi({ description: 'Extended-retention flag toggle.' }),
      ),
    },
  },
  responses: {
    200: { description: 'Updated metadata.', content: jsonContent(ReplayMetadataResponse) },
    400: errorResponse('Body is not { extend: boolean }.'),
    404: errorResponse('No replay with that id, or the caller is not authorized to manage it.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/replays/{id}/events',
  tags: ['Bug Reports'],
  summary: 'Paginated session-replay events (authenticated)',
  description:
    'Returns one page of the gunzipped rrweb event array, sliced by `offset`/`limit` (defaults applied + capped server-side) so large captures never load in one request. The page carries `total`/`hasMore` for walking. Same per-replay authorization as the metadata endpoint — unauthorized access is masked as 404. This endpoint serves `monolithic` (single-blob) captures only; a `segmented` capture (per the `storage_layout` discriminator) has no monolithic blob to paginate and is rejected 409 — read it via the session segments playback API instead.',
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
    409: errorResponse(
      'The replay is `segmented`; read it via `GET /api/replays/sessions/{sessionId}/segments`.',
    ),
    500: errorResponse('Failed to read the stored blob.'),
    503: errorResponse('The replay’s storage backend could not be resolved.'),
  },
});

// ── Segmented-capture playback API ────────────────────────────────
// A `segmented` capture stores its bytes as append-only per-segment objects
// (rum_segments) keyed by the client-minted session id, not a session_replays
// row. Playback lists the ordered manifest, then fetches each segment's events.

const SegmentManifestEntrySchema = z
  .object({
    segmentId: z.string(),
    viewId: z
      .string()
      .openapi({ description: 'Client-minted view id; segments never span views.' }),
    indexInView: z.number().openapi({ description: '0-based position within the view.' }),
    hasFullSnapshot: z
      .boolean()
      .openapi({ description: 'True when the segment carries an rrweb full snapshot (type 2).' }),
    startTs: z.number().openapi({ description: 'Earliest event timestamp in the segment (ms).' }),
    endTs: z.number().openapi({ description: 'Latest event timestamp in the segment (ms).' }),
    eventCount: z.number(),
    byteSize: z.number().openapi({ description: 'Gzipped object size in bytes.' }),
    eventsUrl: z
      .string()
      .openapi({ description: 'Per-segment events endpoint the player fetches to concat.' }),
  })
  .openapi({ description: 'One playback-manifest segment pointer.' });

const SessionSegmentManifestResponse = registerComponent(
  'SessionSegmentManifest',
  z
    .object({
      sessionId: z.string(),
      storageLayout: z.literal('segmented'),
      projectId: z.string().nullable().openapi({
        description: 'Attribution shared by the session’s segments (null = anonymous).',
      }),
      segmentCount: z.number(),
      durationMs: z.number().openapi({
        description: 'Span from the earliest segment start to the latest segment end (ms).',
      }),
      segments: z.array(SegmentManifestEntrySchema).openapi({
        description: 'Segments in playback order (chronological, then index within a view).',
      }),
    })
    .openapi({ description: 'Segmented-capture playback manifest for a session.' }),
);

const SegmentEventsResponse = registerComponent(
  'SegmentEvents',
  z
    .object({
      sessionId: z.string(),
      segmentId: z.string(),
      viewId: z.string(),
      indexInView: z.number(),
      hasFullSnapshot: z.boolean(),
      events: z
        .array(
          z.object({
            type: z.number(),
            timestamp: z.number(),
            data: z.unknown().optional(),
          }),
        )
        .openapi({ description: 'The decoded rrweb events for this one segment.' }),
      eventCount: z.number(),
    })
    .openapi({ description: 'One segment’s decoded rrweb events, for client-side concat.' }),
);

const sessionIdParam = {
  params: z.object({
    sessionId: z.string().openapi({ description: 'Client-minted RUM session id.' }),
  }),
};

registerPath({
  method: 'get',
  path: '/api/replays/sessions/{sessionId}/segments',
  tags: ['Bug Reports'],
  summary: 'Segmented-capture playback manifest (authenticated)',
  description:
    'Lists a session’s replay segments in playback order (chronological by segment start, then by index within a view) so the player can fetch and concatenate them. Each entry carries a per-segment `eventsUrl`. Authenticated and authorized per-session on the segments’ shared `project_id` (same rule as the monolithic replay read); a session with no segments, or one the caller cannot view, is masked as 404.',
  request: sessionIdParam,
  responses: {
    200: {
      description: 'The playback manifest.',
      content: jsonContent(SessionSegmentManifestResponse),
    },
    404: errorResponse(
      'No segments for that session id, or the caller is not authorized to read them.',
    ),
  },
});

registerPath({
  method: 'get',
  path: '/api/replays/sessions/{sessionId}/segments/{segmentId}/events',
  tags: ['Bug Reports'],
  summary: 'One replay segment’s decoded events (authenticated)',
  description:
    'Returns the decoded rrweb events for a single segment, which the player concatenates client-side. The segment must belong to the path `sessionId` and is authorized on its own `project_id`; not-found, wrong-session, and unauthorized all collapse to 404.',
  request: {
    params: z.object({
      sessionId: z.string().openapi({ description: 'Client-minted RUM session id.' }),
      segmentId: z.string().openapi({ description: 'Segment id from the manifest.' }),
    }),
  },
  responses: {
    200: { description: 'The segment’s events.', content: jsonContent(SegmentEventsResponse) },
    404: errorResponse(
      'No such segment, it does not belong to the session, or the caller is not authorized.',
    ),
    500: errorResponse('Failed to read the segment object.'),
    503: errorResponse('The segment’s storage backend could not be resolved.'),
  },
});
