/**
 * Zod schemas + OpenAPI registrations for the personal dashboard aggregation
 * (`server/routes/me-dashboard.ts`). Wire shape only — the route file owns
 * behaviour, the aggregation lives in `server/me-dashboard.ts`.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { UserTodoComponent } from './me-todos.openapi.js';

const ErrorResponse = registerComponent(
  'MeDashboardErrorResponse',
  z
    .object({ error: z.string() })
    .openapi({ description: 'Error envelope for personal dashboard routes.' }),
);

const CardPriority = z.enum(['urgent', 'high', 'medium', 'low']);

const DashboardWorkCard = registerComponent(
  'DashboardWorkCard',
  z
    .object({
      id: z.string(),
      shortId: z.number().nullable(),
      title: z.string(),
      priority: CardPriority,
      columnId: z.string(),
      columnName: z.string(),
      isDone: z.boolean(),
      projectId: z.string(),
      projectName: z.string(),
      boardId: z.string(),
      epicId: z.string().nullable(),
      prUrl: z.string().nullable(),
      reviewStatus: z.string().nullable(),
      sessionId: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({
      description: 'A kanban card assigned to the calling user on a board they can view.',
    }),
);

const DashboardWork = registerComponent(
  'DashboardWork',
  z
    .object({
      cards: z.array(DashboardWorkCard),
      counts: z.object({
        total: z.number(),
        open: z.number(),
        byPriority: z.object({
          urgent: z.number(),
          high: z.number(),
          medium: z.number(),
          low: z.number(),
        }),
      }),
    })
    .openapi({
      description: "The caller's assigned cards across every visible board, plus open-work counts.",
    }),
);

const DashboardCalendar = z.object({
  scopeGranted: z.boolean(),
  date: z.string().nullable(),
  timeZone: z.string().nullable(),
  events: z.array(
    z.object({
      id: z.string().nullable(),
      summary: z.string().nullable(),
      location: z.string().nullable(),
      allDay: z.boolean(),
      start: z.string().nullable(),
      end: z.string().nullable(),
      htmlLink: z.string().nullable(),
      hangoutLink: z.string().nullable(),
    }),
  ),
  error: z.string().nullable(),
});

const DashboardMail = z.object({
  scopeGranted: z.boolean(),
  unread: z.number().nullable(),
  starred: z.number().nullable(),
  important: z.number().nullable(),
  messages: z.array(
    z.object({
      id: z.string().nullable(),
      threadId: z.string().nullable(),
      from: z.string().nullable(),
      subject: z.string().nullable(),
      snippet: z.string().nullable(),
      date: z.string().nullable(),
      internalDate: z.string().nullable(),
      unread: z.boolean(),
    }),
  ),
  error: z.string().nullable(),
});

const DashboardGoogle = registerComponent(
  'DashboardGoogle',
  z
    .object({
      configured: z.boolean(),
      connected: z.boolean(),
      email: z.string().nullable(),
      reconnectRequired: z.boolean(),
      calendar: DashboardCalendar,
      mail: DashboardMail,
    })
    .openapi({
      description:
        "The caller's Google slice (today's calendar + flagged-mail counts). Soft-degrades: unconfigured / unlinked / missing-scope all render as false blocks.",
    }),
);

const MeDashboardResponse = registerComponent(
  'MeDashboardResponse',
  z
    .object({
      generatedAt: z.string(),
      work: DashboardWork,
      todos: z.object({
        open: z.array(UserTodoComponent),
        openCount: z.number(),
      }),
      google: DashboardGoogle,
    })
    .openapi({ description: 'Aggregated personal dashboard for the authenticated user.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/me/dashboard',
  tags: ['Personal Todos'],
  summary: "Aggregate the calling user's cross-project dashboard",
  description:
    "Server-side per-uid fan-out across every board the caller can view: assigned cards, open todos, today's Google calendar, and flagged-mail counts. Cached per user; pass ?fresh=1 to bypass.",
  request: {
    query: z.object({
      fresh: z
        .string()
        .optional()
        .openapi({ description: 'Set to 1/true to bypass the per-uid cache.' }),
      date: z
        .string()
        .optional()
        .openapi({ description: 'YYYY-MM-DD day for the calendar read (default: today, UTC).' }),
      tz: z
        .string()
        .optional()
        .openapi({ description: 'IANA time zone passed to Google for calendar display.' }),
    }),
  },
  responses: {
    200: {
      description: 'The aggregated dashboard payload.',
      content: jsonContent(MeDashboardResponse),
    },
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/me/work',
  tags: ['Personal Todos'],
  summary: "List the calling user's assigned cards across visible boards",
  description:
    "The 'My Work' slice: kanban cards whose assigned_user_id is the caller, from every project they can view (RBAC-filtered). Read-only, always fresh.",
  responses: {
    200: {
      description: 'Assigned cards + open-work counts.',
      content: jsonContent(DashboardWork),
    },
    401: errorResponse('Authentication required.'),
  },
});
