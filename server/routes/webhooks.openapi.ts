/**
 * OpenAPI registrations for newer routes in `routes/webhooks.ts`.
 *
 * The legacy routes in `routes/webhooks.ts` predate the OpenAPI registry
 * and live behind the per-file `allowed_unregistered` allowance in
 * `scripts/openapi-coverage-baseline.json`. New routes added to the file
 * MUST be registered here (or inline) — bumping the allowance is not the
 * preferred fix.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const HmacFailureEntry = registerComponent(
  'WebhookHmacFailureEntry',
  z
    .object({
      ts: z.number().int(),
      repoFullName: z.string(),
      eventLabel: z.string(),
      deliveryId: z.string().nullable(),
      triedSources: z.string(),
      isAppDelivery: z.boolean(),
      healAttempted: z.boolean(),
      healResult: z.enum(['ok', 'failed', 'skipped']).optional(),
      healError: z.string().optional(),
    })
    .openapi({
      description:
        'One GitHub webhook delivery that failed HMAC signature verification. ' +
        'Entries are kept in an in-memory ring buffer; restart-volatile.',
    }),
);

const HmacFailureList = registerComponent(
  'WebhookHmacFailureList',
  z.object({
    failures: z.array(HmacFailureEntry),
  }),
);

registerPath({
  method: 'get',
  path: '/api/webhooks/hmac-failures',
  tags: ['Webhooks'],
  summary: 'Recent webhook HMAC verification failures (in-memory ring buffer)',
  description:
    'Returns the most-recent webhook deliveries that the server rejected ' +
    'because neither the per-repo secret nor the GitHub App webhook ' +
    'secret could verify the `x-hub-signature-256` header. Used by the ' +
    'web client to surface a banner when drift is happening live.',
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Up to `limit` (default 20, max 100) recent failures, newest first.',
      content: { 'application/json': { schema: HmacFailureList } },
    },
  },
});
