/**
 * Zod schemas + OpenAPI registrations for the log-ingest routes (decisions
 * LOG-INGEST / LOG-AUTH / LOG-TRUST). Imported for its side-effect
 * `registerPath` calls both by the running route module (`log-ingest.ts`) and
 * by `server/openapi/generate.ts`; ESM module caching makes the double import a
 * no-op, so paths register exactly once.
 *
 * Auth is a write-only `ahlog_` ingest token presented as a Bearer credential
 * (or `X-AgentHub-Log-Token`); identity is derived from the token, never the
 * body. Documented with the `logIngestToken` bearer scheme.
 */
import { z, registerPath, registerComponent, registerSecurityScheme } from '../openapi/registry.js';
import { MAX_BATCH_RECORDS } from '../logs/logs-schema.js';

registerSecurityScheme('logIngestToken', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Write-only `ahlog_` log ingest token (also accepted via `X-AgentHub-Log-Token`). Identifies exactly one (project, source); grants no read/query/management access.',
});

// ─── Agent Hub JSON batch request ───────────────────────────────────

const AhLogRecordSchema = z
  .object({
    timeUnixNano: z.union([z.number(), z.string()]).optional().openapi({
      description:
        'Event time, Unix nanoseconds. Falls back to `timeUnixMillis`, observed time, then ingest time.',
    }),
    timeUnixMillis: z
      .number()
      .optional()
      .openapi({ description: 'Convenience event time in Unix milliseconds.' }),
    observedTimeUnixNano: z.union([z.number(), z.string()]).optional(),
    severityNumber: z
      .number()
      .int()
      .optional()
      .openapi({ description: 'OTel severity number (1–24).' }),
    severityText: z.string().optional(),
    severity: z
      .string()
      .optional()
      .openapi({ description: 'Free-text level (e.g. "error"); mapped to a severity number.' }),
    body: z
      .unknown()
      .optional()
      .openapi({ description: 'Log body — a string, or any JSON value (stored as JSON text).' }),
    message: z.unknown().optional().openapi({ description: 'Alias for `body`.' }),
    attributes: z.record(z.string(), z.unknown()).optional(),
    resource: z.record(z.string(), z.unknown()).optional(),
    scope: z.record(z.string(), z.unknown()).optional(),
    traceId: z.string().optional(),
    spanId: z.string().optional(),
    service: z
      .string()
      .optional()
      .openapi({ description: 'Convenience `service.name` facet override for this record.' }),
    environment: z
      .string()
      .optional()
      .openapi({ description: 'Convenience `deployment.environment` facet override.' }),
  })
  .openapi({ description: 'One log record in an Agent Hub JSON batch.' });

const AhLogBatchSchema = registerComponent(
  'LogIngestBatch',
  z
    .object({
      resource: z.record(z.string(), z.unknown()).optional().openapi({
        description: 'Batch-level resource attributes merged under each record’s own resource.',
      }),
      records: z
        .array(AhLogRecordSchema)
        .max(MAX_BATCH_RECORDS)
        .openapi({
          description: `Up to ${MAX_BATCH_RECORDS} records; overflow is rejected and counted.`,
        }),
    })
    .openapi({
      description:
        'A simple Agent Hub JSON log batch mapped to the canonical OTel LogRecord model.',
    }),
);

const AhIngestResponse = registerComponent(
  'LogIngestResponse',
  z
    .object({
      accepted: z.number().int().openapi({ description: 'Records persisted.' }),
      rejected: z
        .number()
        .int()
        .openapi({ description: 'Records rejected (batch overflow + oversize).' }),
      redactions: z
        .number()
        .int()
        .openapi({ description: 'Secret substrings/keys masked before persistence.' }),
    })
    .openapi({ description: 'Agent Hub batch ingest result.' }),
);

const OtlpExportResponse = registerComponent(
  'OtlpExportLogsResponse',
  z
    .object({
      partialSuccess: z
        .object({
          rejectedLogRecords: z
            .string()
            .openapi({ description: 'Count of rejected records (int64 as string).' }),
          errorMessage: z.string().optional(),
        })
        .optional()
        .openapi({
          description:
            'Present only when some records were rejected; absent/empty on full success.',
        }),
    })
    .openapi({ description: 'OTLP `ExportLogsServiceResponse` (JSON encoding).' }),
);

const ErrorResponse = registerComponent(
  'LogIngestError',
  z.object({ error: z.string() }).openapi({ description: 'Ingest error envelope.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});
const otlpMalformedResponse = {
  description: 'Malformed JSON/Protobuf body.',
  content: {
    ...jsonContent(ErrorResponse),
    'application/x-protobuf': {
      schema: z.string().openapi({
        type: 'string',
        format: 'binary',
        description: 'Binary-Protobuf `google.rpc.Status` with code `INVALID_ARGUMENT`.',
      }),
    },
  },
};

const TAG = 'Log Ingest';
const SECURITY = [{ logIngestToken: [] as string[] }];

registerPath({
  method: 'post',
  path: '/api/otel/v1/logs',
  tags: [TAG],
  summary: 'OTLP/HTTP logs ingest',
  description:
    'OpenTelemetry OTLP/HTTP logs endpoint. Accepts `application/json` and binary `application/x-protobuf` `ExportLogsServiceRequest` bodies, each optionally gzip-compressed (`Content-Encoding: gzip` or a raw gzip-framed body). Requests are capped at 1 MiB on the wire; batches at 1,000 records; single records at 256 KiB. Rejected records are reported via `partialSuccess` — the HTTP status stays 200 so the source app is never blocked. Fields (severity, timestamps, resource, attributes, scope, trace_id, span_id) are preserved and redacted before persistence.',
  security: SECURITY,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.record(z.string(), z.unknown()).openapi({
            description: 'OTLP `ExportLogsServiceRequest` (`{ resourceLogs: [...] }`).',
          }),
        },
        'application/x-protobuf': {
          schema: z.string().openapi({
            type: 'string',
            format: 'binary',
            description: 'Binary-Protobuf ExportLogsServiceRequest.',
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        'Accepted (possibly partial). `partialSuccess` populated when some records were rejected.',
      content: jsonContent(OtlpExportResponse),
    },
    400: otlpMalformedResponse,
    401: errorResponse('Missing, invalid, or revoked ingest token.'),
    413: errorResponse('Request or decompressed body exceeds the size cap.'),
    429: errorResponse('Per-source or per-IP rate limit exceeded.'),
    503: errorResponse('Log store temporarily unavailable (backpressure).'),
  },
});

registerPath({
  method: 'post',
  path: '/api/logs/ingest',
  tags: [TAG],
  summary: 'Agent Hub JSON log batch ingest',
  description:
    'Simple JSON batch endpoint mapped to the same canonical OTel LogRecord model. Body is `{ resource?, records: [...] }`, optionally gzip-compressed. Same 1 MiB request / 1,000-record batch / 256 KiB record caps, source-token auth, and pre-persistence redaction as the OTLP endpoint.',
  security: SECURITY,
  request: { body: { content: jsonContent(AhLogBatchSchema) } },
  responses: {
    200: {
      description: 'Ingest result (accepted / rejected / redactions).',
      content: jsonContent(AhIngestResponse),
    },
    400: errorResponse('Malformed JSON body or missing `records` array.'),
    401: errorResponse('Missing, invalid, or revoked ingest token.'),
    413: errorResponse('Request or decompressed body exceeds the size cap.'),
    429: errorResponse('Per-source or per-IP rate limit exceeded.'),
    503: errorResponse('Log store temporarily unavailable (backpressure).'),
  },
});
