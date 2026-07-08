/**
 * Zod schemas + OpenAPI registration for the RUM Session Explorer
 * (`server/routes/rum-sessions.ts`).
 *
 * A project-scoped, paginated, filterable list of the `rum_sessions` rollup —
 * the Datadog-parity, session-grain dashboard table. Every filter maps to a
 * first-class indexed column on `rum_sessions`.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'RumSessionsErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

const RumSessionListItem = registerComponent(
  'RumSessionListItem',
  z
    .object({
      sessionId: z.string().openapi({ description: 'Client-minted session id.' }),
      projectId: z.string().nullable(),
      startedAt: z
        .number()
        .int()
        .nullable()
        .openapi({ description: 'Earliest event timestamp across the session, epoch ms.' }),
      endedAt: z
        .number()
        .int()
        .nullable()
        .openapi({ description: 'Latest event timestamp across the session, epoch ms.' }),
      timeSpent: z
        .number()
        .int()
        .nonnegative()
        .openapi({ description: 'Session duration, ms (endedAt - startedAt).' }),
      viewCount: z.number().int().nonnegative(),
      actionCount: z.number().int().nonnegative(),
      errorCount: z.number().int().nonnegative(),
      frustrationCount: z
        .number()
        .int()
        .nonnegative()
        .openapi({ description: 'Rolled-up rage/dead/error-click count.' }),
      usrId: z.string().nullable(),
      usrEmail: z.string().nullable(),
      usrName: z.string().nullable(),
      usrAttributes: z
        .record(z.string(), z.unknown())
        .nullable()
        .openapi({ description: 'Custom (non-standard) user attributes; null when none.' }),
      deviceType: z.string().nullable(),
      browser: z.string().nullable(),
      os: z.string().nullable(),
      geoCountry: z
        .string()
        .nullable()
        .openapi({ description: 'ISO 3166-1 alpha-2 country from the ingest client IP.' }),
      firstSeenAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({ description: 'A session-grain rollup row for the RUM Session Explorer.' }),
);

const RumSessionListResponse = registerComponent(
  'RumSessionListResponse',
  z
    .object({
      sessions: z.array(RumSessionListItem),
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    })
    .openapi({ description: 'A page of RUM sessions for the Explorer table.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/rum/sessions',
  tags: ['Replays'],
  summary: 'List RUM sessions for the Session Explorer dashboard',
  description:
    'Paginated, filterable table of a project’s RUM sessions (the `rum_sessions` session-grain rollup). All facets are optional and AND together; each maps to an indexed column. Text facets are exact-match; count/duration facets are range bounds; the started-at window is inclusive.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      usrEmail: z.string().optional().openapi({ description: 'Exact user email facet.' }),
      usrName: z.string().optional().openapi({ description: 'Exact user name facet.' }),
      usrId: z.string().optional().openapi({ description: 'Exact user id facet.' }),
      deviceType: z.string().optional().openapi({ description: 'Exact device class facet.' }),
      browser: z.string().optional().openapi({ description: 'Exact browser family facet.' }),
      os: z.string().optional().openapi({ description: 'Exact OS family facet.' }),
      geoCountry: z.string().optional().openapi({ description: 'Exact country (alpha-2) facet.' }),
      durationMinMs: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .openapi({ description: 'Minimum session duration, ms (time_spent >=).' }),
      durationMaxMs: z.coerce
        .number()
        .int()
        .nonnegative()
        .optional()
        .openapi({ description: 'Maximum session duration, ms (time_spent <=).' }),
      viewCountMin: z.coerce.number().int().nonnegative().optional(),
      actionCountMin: z.coerce.number().int().nonnegative().optional(),
      errorCountMin: z.coerce.number().int().nonnegative().optional(),
      frustrationCountMin: z.coerce.number().int().nonnegative().optional(),
      from: z.coerce
        .number()
        .int()
        .optional()
        .openapi({ description: 'Inclusive started-at lower bound, epoch ms.' }),
      to: z.coerce
        .number()
        .int()
        .optional()
        .openapi({ description: 'Inclusive started-at upper bound, epoch ms.' }),
      limit: z.coerce.number().int().positive().max(200).optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
    }),
  },
  responses: {
    200: { description: 'A page of RUM sessions.', content: jsonContent(RumSessionListResponse) },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});
