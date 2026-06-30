/**
 * Zod schemas + OpenAPI registrations for the threads route group.
 *
 * `server/openapi/generate.ts` walks `server/routes/*.ts` and imports every
 * module to trigger the side-effect `registerPath(...)` calls below, so this
 * companion is what documents the threads section of `docs/api/openapi.yaml`.
 *
 * Today only the per-entry forward route is registered here; the rest of the
 * threads CRUD surface is tracked as pre-existing migration debt in
 * `scripts/openapi-coverage-baseline.json` (`threads.allowed_unregistered`).
 */

import { z, registerPath } from '../openapi/registry.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorSchema = z
  .object({ error: z.string() })
  .openapi('ThreadsErrorResponse', { description: 'Error envelope.' });

/** Request body for POST /api/threads/:threadId/entries/:entryId/forward. */
export const ForwardThreadEntryRequestSchema = z
  .object({
    targetAgentId: z
      .string({ error: 'targetAgentId is required' })
      .min(1, 'targetAgentId is required')
      .openapi({
        description:
          'Agent to forward the thread entry to. May belong to a different project; the caller must be able to view the target agent’s project.',
      }),
    prompt: z.string().max(50_000).optional().openapi({
      description: 'Extra instructions prepended to the forwarded entry (max 50k chars).',
    }),
    autoStart: z.boolean().optional().openapi({
      description:
        'When true, immediately dispatch the forwarded message to the target agent’s CLI (fire-and-forget).',
    }),
  })
  .openapi('ForwardThreadEntryRequest');

const ForwardThreadEntryResponseSchema = z
  .object({
    session: z.record(z.string(), z.unknown()).openapi({
      description: 'The newly created session for the target agent (client-enriched shape).',
    }),
    forwardedMessageId: z.string().nullable().openapi({
      description:
        'ID of the pre-stored forwarded user message, or null when autoStart dispatched the turn instead.',
    }),
  })
  .openapi('ForwardThreadEntryResponse');

const threadEntryForwardParams = z.object({
  threadId: z.string().openapi({ description: 'Thread UUID.' }),
  entryId: z.string().openapi({ description: 'Thread entry UUID to forward.' }),
});

registerPath({
  method: 'post',
  path: '/api/threads/{threadId}/entries/{entryId}/forward',
  tags: ['Threads'],
  summary: 'Forward a single thread entry to an agent',
  description:
    'Creates a new session for the target agent seeded with the given thread entry as the initial user message. The new session is owned by the caller.',
  request: {
    params: threadEntryForwardParams,
    body: { content: jsonContent(ForwardThreadEntryRequestSchema) },
  },
  responses: {
    201: {
      description: 'Forwarded session created.',
      content: jsonContent(ForwardThreadEntryResponseSchema),
    },
    400: { description: 'Validation failed.', content: jsonContent(ErrorSchema) },
    404: {
      description: 'Thread, entry, or target agent not found / not visible.',
      content: jsonContent(ErrorSchema),
    },
    503: {
      description: 'Auto-start requested but chat handler unavailable.',
      content: jsonContent(ErrorSchema),
    },
  },
});
