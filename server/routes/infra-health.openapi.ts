/**
 * Zod schemas + OpenAPI registrations for the Admin-gated AWS Health surface
 * (`server/routes/infra-health.ts`). New route files start at
 * `allowed_unregistered: 0` in the coverage baseline, so every handler added
 * there must be registered here.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import {
  DEFAULT_INFRA_HEALTH_EVENT_LIST_LIMIT,
  INFRA_HEALTH_EVENT_STATUSES,
  MAX_INFRA_HEALTH_EVENT_LIST_LIMIT,
} from '../infra/infra-schema.js';

const ProjectIdParam = z.object({
  projectId: z.string().openapi({ param: { name: 'projectId', in: 'path' }, example: 'agent-hub' }),
});

const ErrorEnvelope = z.object({ error: z.string() });

/** Query validator, also the OpenAPI request-parameter documentation. */
export const HealthEventListParamsSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_INFRA_HEALTH_EVENT_LIST_LIMIT)
    .optional()
    .default(DEFAULT_INFRA_HEALTH_EVENT_LIST_LIMIT)
    .openapi({ description: 'Maximum rows returned.' }),
  latestOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .optional()
    .openapi({
      description:
        'Default `true`: collapse each incident to its newest communication, which is what the Overview timeline shows. Pass `false` to see every update AWS published about an event.',
    }),
  statusCode: z
    .enum(INFRA_HEALTH_EVENT_STATUSES)
    .optional()
    .openapi({ description: 'Restrict to one lifecycle state.' }),
});

const HealthEventSchema = registerComponent(
  'InfraHealthEvent',
  z.object({
    id: z.string(),
    projectId: z.string(),
    eventArn: z.string(),
    communicationId: z.string(),
    region: z
      .string()
      .openapi({ description: 'Impacted Region, falling back to the delivery Region.' }),
    deliveryRegion: z.string(),
    detailType: z.string(),
    service: z.string().nullable(),
    eventTypeCode: z.string(),
    eventTypeCategory: z.string(),
    eventScopeCode: z.string().nullable(),
    statusCode: z.string().nullable(),
    severity: z.enum(['critical', 'warning', 'info']).openapi({
      description: 'Severity this event routes under. `closed` events are downgraded to `info`.',
    }),
    startTime: z.number().nullable().openapi({ description: 'Unix ms; null if unparseable.' }),
    endTime: z.number().nullable(),
    lastUpdated: z.number().nullable(),
    description: z.string().nullable(),
    affectedEntities: z.array(z.record(z.string(), z.unknown())),
    affectedEntityCount: z.number().int(),
    backupEvent: z.boolean().openapi({
      description: 'True when delivered via the backup Region rather than the impacted one.',
    }),
    page: z.number().int(),
    totalPages: z.number().int(),
    eventTime: z.number().nullable(),
    receivedAt: z.number(),
  }),
);

const HealthEventListResponse = registerComponent(
  'InfraHealthEventList',
  z.object({
    events: z.array(HealthEventSchema),
    total: z.number().int(),
    ingestConfigured: z.boolean().openapi({
      description:
        'False when no unrevoked ingest token exists, which distinguishes "no events yet" from "the EventBridge rule was never wired up".',
    }),
  }),
);

const IngestTokenInfo = registerComponent(
  'InfraHealthIngestTokenInfo',
  z
    .object({
      projectId: z.string(),
      tokenPrefix: z
        .string()
        .openapi({ description: 'Non-secret prefix, for identification only.' }),
      createdAt: z.number(),
      rotatedAt: z.number().nullable(),
      revokedAt: z.number().nullable(),
      lastUsedAt: z
        .number()
        .nullable()
        .openapi({ description: 'Last successful ingest, or null if the rule never delivered.' }),
    })
    .nullable(),
);

const EventPattern = z.record(z.string(), z.array(z.string())).openapi({
  description:
    'The literal EventBridge rule pattern to paste into the monitored account. `source` must match `aws.health` exactly — AWS documents that a wildcard such as `aws.health*` never matches.',
  example: {
    source: ['aws.health'],
    'detail-type': ['AWS Health Event', 'AWS Health Abuse Event'],
  },
});

const IngestConfigResponse = registerComponent(
  'InfraHealthIngestConfig',
  z.object({
    token: IngestTokenInfo,
    ingestPath: z.string().openapi({ example: '/api/infra/health/ingest' }),
    eventPattern: EventPattern,
  }),
);

const MintResponse = registerComponent(
  'InfraHealthIngestTokenMint',
  z.object({
    token: z.string().openapi({
      description:
        'Plaintext `ahhealth_` token. Returned exactly once — it is stored only as a SHA-256 digest and cannot be read back.',
    }),
    info: IngestTokenInfo,
    ingestPath: z.string(),
    eventPattern: EventPattern,
  }),
);

const NOT_FOUND = {
  description: 'Project not found, or the caller cannot see it.',
  content: { 'application/json': { schema: ErrorEnvelope } },
};
const UNAVAILABLE = {
  description: 'The infrastructure store is not initialized.',
  content: { 'application/json': { schema: ErrorEnvelope } },
};

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/health-events',
  tags: ['Projects'],
  summary: 'List ingested AWS Health events',
  description:
    'Reads the Health events an operator-created EventBridge rule has delivered to this project. **No AWS call is made** — this is a local read of ingested data, so it is free and works on any AWS support tier.\n\nBy default each incident collapses to its newest communication, which is what the Infrastructure Overview timeline renders.',
  request: { params: ProjectIdParam, query: HealthEventListParamsSchema },
  responses: {
    200: {
      description:
        'Timeline rows, newest first. A project whose infrastructure store never opened returns an empty list rather than an error.',
      content: { 'application/json': { schema: HealthEventListResponse } },
    },
    404: NOT_FOUND,
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/infra/health-ingest',
  tags: ['Projects'],
  summary: 'Read AWS Health ingest configuration',
  description:
    'Returns the non-secret metadata for the project ingest token, the ingest path, and the exact EventBridge rule pattern to create in the monitored account. Never returns the token plaintext.',
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: 'Ingest configuration. `token` is null when none has been minted.',
      content: { 'application/json': { schema: IngestConfigResponse } },
    },
    404: NOT_FOUND,
    503: UNAVAILABLE,
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/infra/health-ingest',
  tags: ['Projects'],
  summary: 'Mint or rotate the AWS Health ingest token',
  description:
    'Creates the project ingest token, or replaces an existing one. Rotation takes effect immediately — there is no grace window, so update the EventBridge connection in the same sitting. Rotating also clears a revocation, so it doubles as re-enable.\n\nThe plaintext is in this response body and nowhere else.',
  request: { params: ProjectIdParam },
  responses: {
    201: {
      description: 'Token minted. Copy the plaintext now.',
      content: { 'application/json': { schema: MintResponse } },
    },
    404: NOT_FOUND,
    503: UNAVAILABLE,
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/infra/health-ingest',
  tags: ['Projects'],
  summary: 'Revoke the AWS Health ingest token',
  description:
    'Disables ingest without destroying the audit trail — the row is kept with `revokedAt` set, and subsequent deliveries are rejected with 401. Idempotent.',
  request: { params: ProjectIdParam },
  responses: {
    200: {
      description: '`revoked` is false when the token was already revoked or never existed.',
      content: {
        'application/json': {
          schema: z.object({ revoked: z.boolean(), token: IngestTokenInfo }),
        },
      },
    },
    404: NOT_FOUND,
    503: UNAVAILABLE,
  },
});
