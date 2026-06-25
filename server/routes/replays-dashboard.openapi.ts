/**
 * Zod schemas + OpenAPI registration for the Replays Explorer dashboard
 * (`server/routes/replays-dashboard.ts`).
 *
 * A project-scoped, paginated, filterable list of session replays — the
 * Datadog-RUM-Explorer-style table — plus link/unlink endpoints that attach a
 * replay to one of the project's support tickets (the inverse of the
 * ticket-first attribution flow).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const FILTERS = ['all', 'linked', 'unlinked', 'orphans'] as const;
const KINDS = ['all', 'continuous', 'on-error'] as const;

const ErrorResponse = registerComponent(
  'ReplaysDashboardErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

const ReplayListItem = registerComponent(
  'ReplayListItem',
  z
    .object({
      id: z.string(),
      projectId: z.string().nullable(),
      orphaned: z
        .boolean()
        .openapi({ description: 'True when the capture is unattributed (project_id IS NULL).' }),
      createdAt: z.string(),
      updatedAt: z
        .string()
        .openapi({ description: 'Most-recent write (insert or append); falls back to createdAt.' }),
      captureKind: z.enum(KINDS.filter((k) => k !== 'all') as ['continuous', 'on-error']).openapi({
        description:
          'Derived capture tier: `continuous` (whole-session, interval/tail-flushed) vs `on-error` (record-on-error / manual bug-report).',
      }),
      live: z.boolean().openapi({
        description:
          'Best-effort "still streaming" signal: a continuous, unfinalized capture written to within the freshness window. Always false for on-error captures.',
      }),
      durationMs: z.number().int().nonnegative(),
      eventCount: z.number().int().nonnegative(),
      size: z
        .number()
        .int()
        .nonnegative()
        .openapi({ description: 'Compressed blob size (bytes).' }),
      uncompressedSize: z.number().int().nonnegative(),
      supportTicketId: z.string().nullable(),
      cardId: z.string().nullable(),
      pageUrl: z.string().nullable().openapi({ description: 'Recorder-stamped page URL, if any.' }),
      trigger: z.string().nullable(),
      errorMessage: z.string().nullable(),
      meta: z.record(z.string(), z.unknown()).nullable(),
      eventsUrl: z
        .string()
        .openapi({ description: 'Path to the paginated rrweb events endpoint.' }),
      replayRef: z.string().openapi({ description: 'The /uploads/replay-<id>.json ref.' }),
      ticket: z
        .object({
          id: z.string(),
          subject: z.string().nullable(),
          status: z.string().nullable(),
        })
        .nullable(),
    })
    .openapi({ description: 'A session replay enriched with its linked support ticket (if any).' }),
);

const ReplayListResponse = registerComponent(
  'ReplayListResponse',
  z
    .object({
      replays: z.array(ReplayListItem),
      total: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      filter: z.enum(FILTERS),
      kind: z.enum(KINDS).openapi({ description: 'Active capture-kind facet. Default `all`.' }),
      canViewOrphans: z.boolean().openapi({
        description: 'Whether the caller may enumerate the global orphan (unattributed) set.',
      }),
    })
    .openapi({ description: 'A page of replays for the dashboard table.' }),
);

const LinkReplayRequest = registerComponent(
  'LinkReplayRequest',
  z
    .object({
      supportTicketId: z
        .string()
        .openapi({ description: 'Id of a support ticket in the same project to attach to.' }),
    })
    .openapi({ description: 'Body for attaching a replay to a support ticket.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const projectIdParam = z.object({ projectId: z.string() });
const linkParams = z.object({ projectId: z.string(), id: z.string() });

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/replays',
  tags: ['Replays'],
  summary: 'List session replays for the Replays Explorer dashboard',
  description:
    'Paginated, filterable table of a project’s session replays, each row enriched with its linked support ticket. `filter=orphans` lists global unattributed captures and is restricted to privileged callers.',
  request: {
    params: projectIdParam,
    query: z.object({
      filter: z.enum(FILTERS).optional().openapi({ description: 'Default `all`.' }),
      kind: z
        .enum(KINDS)
        .optional()
        .openapi({ description: 'Capture-kind facet (continuous vs on-error). Default `all`.' }),
      limit: z.coerce.number().int().positive().max(200).optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
    }),
  },
  responses: {
    200: { description: 'A page of replays.', content: jsonContent(ReplayListResponse) },
    400: { description: 'Invalid filter or kind.', content: jsonContent(ErrorResponse) },
    403: {
      description: 'Not authorized to view unattributed replays.',
      content: jsonContent(ErrorResponse),
    },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/replays/{id}/link',
  tags: ['Replays'],
  summary: 'Attach a replay to one of the project’s support tickets',
  description:
    'Links a replay to a support ticket using the first-write attribution guard: the replay is attached only if it is unattributed or already owned by this project. Linking to the same ticket is idempotent. A replay already linked to a different ticket — or a ticket already linked to a different replay — is a 409 (unlink first). A capture owned by ANOTHER project is masked as 404 (no cross-project existence probe).',
  request: {
    params: linkParams,
    body: { content: jsonContent(LinkReplayRequest) },
  },
  responses: {
    200: {
      description: 'Linked. Returns the updated replay row and ticket.',
      content: jsonContent(
        z.object({ replay: ReplayListItem, ticket: z.record(z.string(), z.unknown()) }),
      ),
    },
    400: { description: 'Missing supportTicketId.', content: jsonContent(ErrorResponse) },
    404: {
      description:
        'Project, replay, or ticket not found. A replay owned by another project is masked as 404 (not 409) to avoid a cross-project existence probe.',
      content: jsonContent(ErrorResponse),
    },
    409: {
      description:
        'Replay is already linked to a different ticket, the ticket is already linked to a different replay, or the replay could not be attributed to this project.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/replays/{id}/link',
  tags: ['Replays'],
  summary: 'Detach a replay from its support ticket',
  description:
    'Clears the support-ticket link on a replay (and the ticket’s replay_ref). The replay stays attributed to the project.',
  request: { params: linkParams },
  responses: {
    200: {
      description: 'Unlinked. Returns the updated replay row.',
      content: jsonContent(z.object({ replay: ReplayListItem })),
    },
    404: { description: 'Project or replay not found.', content: jsonContent(ErrorResponse) },
  },
});
