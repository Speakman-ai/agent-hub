/**
 * OpenAPI + request schemas for the Server Agent proactive routes.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import {
  PROACTIVE_AREAS,
  PROACTIVE_INTERVAL_HOURS,
  PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT,
  PROACTIVE_OFFER_ACTIONS,
  PROACTIVE_OFFER_KIND_IDS,
  PROACTIVE_OFFER_STATUSES,
  PROACTIVE_TARGET_KEYS,
  PROACTIVE_URGENCIES,
} from '../../shared/utils/serverAgentProactive.js';

const kindEnum = z.enum(PROACTIVE_OFFER_KIND_IDS as [string, ...string[]]);
const areaEnum = z.enum(PROACTIVE_AREAS);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

const ErrorResponse = registerComponent(
  'ServerAgentProactiveError',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

export const ProactiveOfferSchema = registerComponent(
  'ServerAgentOffer',
  z
    .object({
      id: z.string(),
      kind: kindEnum,
      area: areaEnum,
      title: z.string(),
      reason: z.string(),
      action: z.string(),
      urgency: z.enum(PROACTIVE_URGENCIES),
      status: z.enum(PROACTIVE_OFFER_STATUSES),
      source: z.enum(['scheduled', 'event', 'manual']),
      target: z
        .object(
          Object.fromEntries(
            PROACTIVE_TARGET_KEYS.map((k) => [k, z.string().optional()]),
          ) as Record<(typeof PROACTIVE_TARGET_KEYS)[number], z.ZodOptional<z.ZodString>>,
        )
        .openapi({ description: 'Typed ids of the subject, taken from the fact.' }),
      createdAt: z.string(),
      updatedAt: z.string(),
      expiresAt: z.string().nullable(),
      snoozedUntil: z.string().nullable(),
      actedAt: z.string().nullable(),
      actionSessionId: z.string().nullable(),
      revision: z
        .number()
        .int()
        .openapi({ description: 'Bumped on every write; newer wins for one offer.' }),
    })
    .openapi({ description: 'Something the Server Agent offered to do for the caller.' }),
);

export const ProactivePrefsSchema = registerComponent(
  'ServerAgentProactivePrefs',
  z
    .object({
      enabled: z.boolean(),
      intervalHours: z.number().int(),
      timeZone: z.string(),
      quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
      areas: z.object({
        dev: z.boolean(),
        google: z.boolean(),
        infra: z.boolean(),
        todos: z.boolean(),
      }),
      maxOffersPerDay: z.number().int(),
      push: z.boolean(),
    })
    .openapi({ description: 'Proactive mode settings for the caller’s Server Agent.' }),
);

/** PUT body: every field optional; omitted fields keep their value. */
export const ProactivePrefsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalHours: z
      .number()
      .int()
      .refine((n) => (PROACTIVE_INTERVAL_HOURS as readonly number[]).includes(n), {
        message: `intervalHours must be one of ${PROACTIVE_INTERVAL_HOURS.join(', ')}`,
      })
      .optional(),
    timeZone: z.string().min(1).max(100).optional(),
    quietHours: z
      .object({ enabled: z.boolean().optional(), start: hhmm.optional(), end: hhmm.optional() })
      .optional(),
    areas: z
      .object({
        dev: z.boolean().optional(),
        google: z.boolean().optional(),
        infra: z.boolean().optional(),
        todos: z.boolean().optional(),
      })
      .optional(),
    maxOffersPerDay: z.number().int().min(1).max(PROACTIVE_MAX_OFFERS_PER_DAY_LIMIT).optional(),
    push: z.boolean().optional(),
  })
  .strict();

/** GET /offers query; the route parses with this same schema. */
export const OfferListQuerySchema = z
  .object({
    status: z.enum([...PROACTIVE_OFFER_STATUSES, 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const OfferActBodySchema = z
  .object({
    action: z.enum(PROACTIVE_OFFER_ACTIONS),
    /** "Not now" length; defaults to 24h. */
    snoozeHours: z
      .number()
      .min(1)
      .max(24 * 14)
      .optional(),
  })
  .strict();

const SuppressionSchema = registerComponent(
  'ServerAgentOfferSuppression',
  z.object({ id: z.string(), kind: kindEnum, label: z.string(), createdAt: z.string() }),
);

const StateSchema = z.object({
  lastCheckAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  lastModelAt: z.string().nullable(),
});

const json = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const err = (description: string) => ({ description, content: json(ErrorResponse) });

registerPath({
  method: 'get',
  path: '/api/me/server-agent/offers',
  tags: ['Hub'],
  summary: "List the caller's Server Agent offers",
  description: 'Open offers by default, newest first. `status=all` includes acted-on ones.',
  request: {
    query: OfferListQuerySchema,
  },
  responses: {
    200: {
      description: 'Offers.',
      content: json(z.object({ offers: z.array(ProactiveOfferSchema) })),
    },
    400: err('Invalid query.'),
    401: err('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/server-agent/offers/{id}/act',
  tags: ['Hub'],
  summary: 'Accept, snooze or suppress an offer',
  description:
    '`accept` (Do it) posts the offer to the caller’s Server Agent session, which starts the work ' +
    '(if that dispatch fails the offer reopens and the route returns 502); ' +
    'irreversible steps still ask through the approval gate. `snooze` (Not now) hides the offer’s ' +
    'subject for `snoozeHours` (default 24). `never` (Never for this kind) adds a suppression rule ' +
    'and retires every open offer of that kind.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: json(OfferActBodySchema) },
  },
  responses: {
    200: {
      description: 'Updated offer.',
      content: json(
        z.object({
          offer: ProactiveOfferSchema,
          sessionId: z.string().nullable(),
          suppression: SuppressionSchema.nullable(),
        }),
      ),
    },
    400: err('Invalid body.'),
    401: err('Authentication required.'),
    404: err('Offer not found.'),
    409: err('Offer is no longer open.'),
    502: {
      description: 'Do it could not start the work. The offer is open again so the user can retry.',
      content: json(z.object({ error: z.string(), offer: ProactiveOfferSchema.nullable() })),
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/me/server-agent/suppressions',
  tags: ['Hub'],
  summary: '"Never for this kind" rules',
  responses: {
    200: {
      description: 'Suppression rules.',
      content: json(z.object({ suppressions: z.array(SuppressionSchema) })),
    },
    401: err('Authentication required.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/me/server-agent/suppressions/{id}',
  tags: ['Hub'],
  summary: 'Remove a suppression rule',
  description: 'Accepts the rule id or the offer kind.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'Removed.', content: json(z.object({ ok: z.literal(true) })) },
    401: err('Authentication required.'),
    404: err('Rule not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/me/server-agent/proactive',
  tags: ['Hub'],
  summary: 'Proactive mode settings and last check',
  responses: {
    200: {
      description: 'Settings (defaults when never saved) and last check status.',
      content: json(z.object({ prefs: ProactivePrefsSchema, state: StateSchema })),
    },
    401: err('Authentication required.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/me/server-agent/proactive',
  tags: ['Hub'],
  summary: 'Update proactive mode settings',
  description: 'Partial update; omitted fields keep their value. Off by default until enabled.',
  request: { body: { content: json(ProactivePrefsPatchSchema) } },
  responses: {
    200: {
      description: 'Saved settings.',
      content: json(z.object({ prefs: ProactivePrefsSchema })),
    },
    400: err('Invalid body.'),
    401: err('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/server-agent/proactive/check',
  tags: ['Hub'],
  summary: 'Run a proactive check now',
  description:
    'Runs a full snapshot check immediately, ignoring quiet hours and the unchanged-snapshot skip. ' +
    'Suppressions, snoozes and the daily cap still apply.',
  responses: {
    200: {
      description: 'Check result.',
      content: json(
        z.object({
          status: z.string(),
          ranModel: z.boolean(),
          eligible: z.number().int(),
          offers: z.array(ProactiveOfferSchema),
          error: z.string().optional(),
        }),
      ),
    },
    401: err('Authentication required.'),
    409: err('A check is already running.'),
  },
});
