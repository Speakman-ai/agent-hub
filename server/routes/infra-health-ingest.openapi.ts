/**
 * Zod schemas + OpenAPI registration for the public AWS Health ingest route.
 *
 * Imported for its side-effect `registerPath` call both by the running route
 * module (`infra-health-ingest.ts`) and by `server/openapi/generate.ts`; ESM
 * module caching makes the double import a no-op.
 *
 * Auth is a write-only `ahhealth_` token presented as a Bearer credential (or
 * `X-AgentHub-Health-Token`); the project is derived from the token, never from
 * the body.
 */
import { z, registerPath, registerComponent, registerSecurityScheme } from '../openapi/registry.js';
import { MAX_HEALTH_EVENT_BATCH } from '../infra/health-event-parse.js';

registerSecurityScheme('infraHealthIngestToken', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Write-only `ahhealth_` AWS Health ingest token (also accepted via `X-AgentHub-Health-Token`). Identifies exactly one project; grants no read, query, or management access.',
});

const SECURITY = [{ infraHealthIngestToken: [] as string[] }];

const HealthEventDetailSchema = z
  .object({
    eventArn: z.string().openapi({
      description:
        'ARN of the Health event. Stable across every update to the same incident, and half of the dedupe key.',
      example:
        'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/AWS_EC2_OPERATIONAL_ISSUE_7f35c8ae',
    }),
    communicationId: z.string().openapi({
      description:
        'Identifies one specific communication about the event. The other half of the dedupe key.',
      example: '01b0993207d81a09dcd552ebd1e633e36cf1f09a-1',
    }),
    service: z.string().optional(),
    eventTypeCode: z.string().openapi({ example: 'AWS_EC2_OPERATIONAL_ISSUE' }),
    eventTypeCategory: z.string().openapi({
      description: '`issue`, `accountNotification`, `scheduledChange`, or `investigation`.',
      example: 'issue',
    }),
    eventScopeCode: z.string().optional().openapi({ example: 'PUBLIC' }),
    statusCode: z.string().optional().openapi({ example: 'open' }),
    eventRegion: z.string().optional().openapi({
      description:
        'The Region actually impacted, which under the backup-Region fan-out often differs from the envelope `region`.',
    }),
    startTime: z.string().optional().openapi({
      description: 'RFC-1123 string, not ISO-8601.',
      example: 'Fri, 27 Jan 2023 06:02:51 GMT',
    }),
    endTime: z.string().optional(),
    lastUpdatedTime: z.string().optional(),
    eventDescription: z
      .array(
        z.object({ language: z.string().optional(), latestDescription: z.string().optional() }),
      )
      .optional(),
    affectedEntities: z
      .array(
        z.object({
          entityValue: z.string().optional(),
          status: z.string().optional(),
          lastUpdatedTime: z.string().optional(),
        }),
      )
      .optional(),
    affectedAccount: z.string().optional(),
    backupEvent: z.string().optional().openapi({
      description: 'Delivered as the string `"true"`/`"false"`, not a boolean.',
    }),
    page: z.string().optional(),
    totalPages: z.string().optional(),
  })
  .passthrough();

const HealthEventEnvelopeSchema = registerComponent(
  'AwsHealthEventEnvelope',
  z
    .object({
      version: z.string().optional(),
      id: z.string().optional().openapi({
        description:
          'EventBridge message id. Unique per delivery, so it is NOT usable for dedupe across the backup Region.',
      }),
      'detail-type': z.string().openapi({
        description: 'Must be `AWS Health Event` or `AWS Health Abuse Event`.',
        example: 'AWS Health Event',
      }),
      source: z.literal('aws.health').openapi({
        description:
          'Must be exactly `aws.health`. AWS documents that a rule pattern using a wildcard such as `aws.health*` never matches.',
      }),
      account: z.string().openapi({ example: '123456789012' }),
      time: z.string().optional().openapi({ example: '2026-01-27T01:43:21Z' }),
      region: z.string().openapi({
        description:
          'The Region the notification was DELIVERED to, not necessarily the impacted one.',
      }),
      resources: z.array(z.string()).optional(),
      detail: HealthEventDetailSchema,
    })
    .passthrough()
    .openapi({ description: 'One AWS Health event as delivered by Amazon EventBridge.' }),
);

const IngestRequestSchema = z
  .union([
    HealthEventEnvelopeSchema,
    z.array(HealthEventEnvelopeSchema).max(MAX_HEALTH_EVENT_BATCH),
  ])
  .openapi({
    description: `A single EventBridge envelope (what an API destination sends) or an array of up to ${MAX_HEALTH_EVENT_BATCH} of them.`,
  });

const IngestResponseSchema = registerComponent(
  'InfraHealthIngestResult',
  z.object({
    accepted: z.number().int().openapi({ description: 'Events written for the first time.' }),
    deduped: z.number().int().openapi({
      description:
        'Deliveries suppressed as duplicates of an already-stored (eventArn, communicationId). A steady non-zero count is normal: EventBridge delivery is at-least-once and AWS additionally fans account-specific events out to a backup Region.',
    }),
    rejected: z
      .number()
      .int()
      .openapi({ description: 'Payload entries that were not usable Health events.' }),
    overflow: z
      .number()
      .int()
      .openapi({ description: `Entries dropped beyond the ${MAX_HEALTH_EVENT_BATCH}-event cap.` }),
    reasons: z.array(z.string()).optional().openapi({
      description:
        'Present only when nothing was accepted, to make a misconfigured rule diagnosable.',
    }),
  }),
);

const ErrorEnvelope = z.object({ error: z.string() });

registerPath({
  method: 'post',
  path: '/api/infra/health/ingest',
  tags: ['Infrastructure'],
  summary: 'Ingest an AWS Health event from EventBridge',
  security: SECURITY,
  description:
    'Write-only endpoint targeted by an **operator-created** EventBridge rule in the monitored AWS account, via an API destination using `API_KEY` or Bearer authorization.\n\nAgent Hub deliberately does **not** call the Health API `DescribeEvents`: it requires a Business Support+ / Enterprise / Unified Operations plan and returns `SubscriptionRequiredException` otherwise, while EventBridge delivery of the same events is free to every AWS customer. The Hub creates nothing in the monitored account — setup is entirely operator-performed.\n\nThe rule pattern must match the source **exactly**:\n\n```json\n{ "source": ["aws.health"], "detail-type": ["AWS Health Event", "AWS Health Abuse Event"] }\n```\n\nA wildcard such as `"aws.health*"` silently never matches.\n\n**Duplicates are expected.** EventBridge delivery is at-least-once and AWS fans account-specific events out to a backup Region on purpose, so ingestion dedupes on `eventArn` + `communicationId` (widened by the affected account and page number) and reports the suppressed count as `deduped`.\n\nThe handler performs one bounded SQLite write and returns, because EventBridge times out an API-destination request that takes longer than 5 seconds.',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: IngestRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        'Delivery processed. Inspect `accepted` / `deduped`.\n\nA payload that was not a Health event also returns 200, with `accepted: 0` and a `reasons` array. EventBridge does not retry a plain 4xx, so a 400 would not be re-delivered — it would simply count as a failed invocation, filling the dead-letter queue and firing `FailedInvocations` alarms for deliveries that are merely out of scope. A rule scoped slightly too broadly is a configuration nit, not an outage.',
      content: { 'application/json': { schema: IngestResponseSchema } },
    },
    400: {
      description: 'Malformed JSON body.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    401: {
      description: 'Missing, invalid, or revoked ingest token.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    413: {
      description: 'Request body exceeds the 1 MiB cap.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    429: {
      description:
        'Per-IP or per-project rate limit exceeded. Retry after the `Retry-After` delay.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    503: {
      description:
        'The infrastructure store is unavailable. Retryable — EventBridge redelivers for up to 24 hours.',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});
