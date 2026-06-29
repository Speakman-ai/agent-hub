/**
 * Zod schemas + OpenAPI registrations for the support-ticket queue route group.
 *
 * Support tickets are customer support requests persisted in their own
 * project-scoped queue, separate from the kanban board. The list endpoint
 * returns rows ordered by severity (most severe first); the status lifecycle
 * (new → investigating → converted / closed) is distinct from kanban columns.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { KanbanCardComponent, MAX_ASSIGNMENT_COMMENT_LEN } from './board.openapi.js';

const TYPES = ['bug', 'question', 'feature_request', 'incident', 'other'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const STATUSES = ['new', 'investigating', 'converted', 'closed', 'duplicate', 'wont_do'] as const;
const RELEASE_STATES = ['fixed_pending_release', 'released_to_prod', 'customer_notified'] as const;

const SupportTicketReleaseNotificationComponent = registerComponent(
  'SupportTicketReleaseNotification',
  z.object({
    id: z.string(),
    deployment_id: z.string(),
    release_item_id: z.string().nullable(),
    support_ticket_id: z.string().nullable(),
    notification_type: z.enum(['ticket_release', 'release_digest']),
    recipient_type: z.enum(['reporter', 'release_digest']),
    subject: z.string(),
    status: z.enum(['pending', 'sending', 'sent', 'error']),
    attempts: z.number().int(),
    sent_at: z.string().nullable(),
    next_attempt_at: z.string().nullable(),
    error_summary: z.string().nullable(),
    can_retry: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);

const ErrorResponse = registerComponent(
  'SupportTicketErrorResponse',
  z
    .object({ error: z.string() })
    .openapi({ description: 'Error envelope for support-ticket routes.' }),
);

export const SupportTicketComponent = registerComponent(
  'SupportTicket',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      type: z.enum(TYPES),
      severity: z.enum(SEVERITIES),
      status: z.enum(STATUSES),
      subject: z.string(),
      body: z.string(),
      reporter: z.string().nullable(),
      reporter_email: z.string().nullable().openapi({
        description:
          'Protected reporter contact email. Returned in full to Admin/Owner/local callers; masked for lower-privilege responses.',
      }),
      reporter_email_masked: z.boolean().openapi({
        description:
          'True when reporter_email is present but masked for this response. False for privileged full reads or tickets without an email.',
      }),
      ai_summary: z.string().nullable(),
      ai_investigation: z.string().nullable(),
      ai_investigated_at: z.string().nullable(),
      replay_ref: z.string().nullable(),
      screenshot_ref: z
        .string()
        .nullable()
        .openapi({ description: 'Server-relative ref to an attached screenshot, or null.' }),
      converted_card_id: z.string().nullable(),
      wont_do_reason: z.string().nullable().openapi({
        description: "Operator reason the ticket was marked 'wont_do', or null otherwise.",
      }),
      release_state: z.enum(RELEASE_STATES).nullable().openapi({
        description:
          'Derived release-facing state. fixed_pending_release means a linked card reached Done, released_to_prod means a production deployment included the card/ticket, and customer_notified means the reporter notification has been sent.',
      }),
      fixed_at: z.string().nullable().openapi({
        description: 'Timestamp when a linked kanban card first reached Done, or null.',
      }),
      released_to_prod_at: z.string().nullable().openapi({
        description: 'Timestamp when a production deployment released this ticket, or null.',
      }),
      release_deployment_id: z.string().nullable().openapi({
        description: 'Deployment id that first released this ticket to production, or null.',
      }),
      customer_notified_at: z.string().nullable().openapi({
        description: 'Timestamp when a reporter notification was sent, or null.',
      }),
      read_at: z
        .string()
        .nullable()
        .openapi({ description: 'Timestamp the ticket was first read, or null when unread.' }),
      release_notifications: z
        .array(SupportTicketReleaseNotificationComponent)
        .optional()
        .openapi({ description: 'Release notification outbox history for this ticket.' }),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({ description: 'A single support ticket row.' }),
);

export const CreateSupportTicketRequestSchema = z.object({
  body: z.string().min(1, 'body is required'),
  type: z.enum(TYPES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  subject: z.string().optional(),
  reporter: z.string().optional(),
  reporter_email: z.string().email().optional().openapi({
    description:
      'Optional reporter contact email. Stored as a protected support-ticket field for release notifications; omitted/blank remains allowed for anonymous-compatible flows.',
  }),
  replayRef: z.string().optional(),
  screenshot: z.string().optional().openapi({
    description:
      'Optional screenshot as a base64 data URL (data:image/png|jpeg|webp|gif;base64,...). Persisted server-side and exposed via screenshot_ref.',
  }),
});

export const PatchSupportTicketRequestSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    type: z.enum(TYPES).optional().openapi({
      description:
        'Reclassify the ticket request type (bug, question, feature_request, incident, other).',
    }),
    wontDoReason: z.string().nullable().optional().openapi({
      description:
        "Reason the ticket is being marked 'wont_do'. Required (non-empty) when status is 'wont_do'; cleared on any other status transition.",
    }),
    aiSummary: z.string().nullable().optional(),
    aiInvestigation: z.string().nullable().optional(),
    replayRef: z.string().nullable().optional(),
    screenshot: z.string().nullable().optional().openapi({
      description:
        'Attach a screenshot (base64 data URL) or clear it with null. Persisted server-side; exposed via screenshot_ref.',
    }),
  })
  .openapi({
    description: 'Partial update: status/type transition and/or AI/replay/screenshot fields.',
  });

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug or id.' }),
});
const ticketParams = projectIdParams.extend({
  id: z.string().openapi({ description: 'Support ticket id.' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});
const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/support-tickets',
  tags: ['Support'],
  summary: 'List a project’s support tickets, ordered by severity',
  description:
    'Defaults to the open states (new, investigating) — terminal tickets (converted/closed/duplicate/wont_do) are hidden until requested. Pass a comma-separated `status` list (e.g. `converted,closed`) and/or a single `type` to filter.',
  request: {
    params: projectIdParams,
    query: z.object({
      status: z.string().optional().openapi({
        description:
          'Comma-separated lifecycle states to include (new | investigating | converted | closed | duplicate | wont_do). Omit to default to the open states.',
      }),
      type: z
        .enum(TYPES)
        .optional()
        .openapi({ description: 'Filter to a single request type (e.g. bug, feature_request).' }),
    }),
  },
  responses: {
    200: {
      description: 'Tickets ordered by severity (critical → low) then newest.',
      content: jsonContent(z.array(SupportTicketComponent)),
    },
    400: errorResponse('Invalid status or type filter.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/support-tickets/unread-count',
  tags: ['Support'],
  summary: 'Count a project’s unread support tickets',
  description: 'Returns the number of tickets with read_at NULL. Drives the Support sidebar badge.',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Unread ticket count.',
      content: jsonContent(z.object({ count: z.number().int().nonnegative() })),
    },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/support-tickets/{id}',
  tags: ['Support'],
  summary: 'Fetch a single support ticket',
  request: { params: ticketParams },
  responses: {
    200: { description: 'The ticket.', content: jsonContent(SupportTicketComponent) },
    404: errorResponse('Project or ticket not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/support-tickets/read-all',
  tags: ['Support'],
  summary: 'Mark all of a project’s tickets read',
  description: 'Stamps read_at on every unread ticket in the project and clears the sidebar badge.',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Tickets marked read.',
      content: jsonContent(
        z.object({
          marked: z.number().int().nonnegative(),
          unreadCount: z.number().int().nonnegative(),
        }),
      ),
    },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/support-tickets/{id}/read',
  tags: ['Support'],
  summary: 'Mark a support ticket read',
  request: { params: ticketParams },
  responses: {
    200: { description: 'The updated ticket.', content: jsonContent(SupportTicketComponent) },
    404: errorResponse('Project or ticket not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/support-tickets/{id}/unread',
  tags: ['Support'],
  summary: 'Mark a support ticket unread',
  request: { params: ticketParams },
  responses: {
    200: { description: 'The updated ticket.', content: jsonContent(SupportTicketComponent) },
    404: errorResponse('Project or ticket not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/support-tickets',
  tags: ['Support'],
  summary: 'Create a support ticket',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateSupportTicketRequestSchema) },
  },
  responses: {
    201: { description: 'Created ticket.', content: jsonContent(SupportTicketComponent) },
    400: errorResponse('Invalid type/severity or missing body.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'patch',
  path: '/api/projects/{projectId}/support-tickets/{id}',
  tags: ['Support'],
  summary: 'Update a support ticket (status, type, AI investigation, replay ref)',
  request: {
    params: ticketParams,
    body: { content: jsonContent(PatchSupportTicketRequestSchema) },
  },
  responses: {
    200: { description: 'Updated ticket.', content: jsonContent(SupportTicketComponent) },
    400: errorResponse('Invalid status or type.'),
    404: errorResponse('Project or ticket not found.'),
  },
});

const ConvertSupportTicketResponse = registerComponent(
  'ConvertSupportTicketResponse',
  z
    .object({
      card: KanbanCardComponent,
      ticket: SupportTicketComponent.openapi({
        description: "The source ticket, now retained and flagged 'converted'.",
      }),
      ticketId: z.string().openapi({ description: 'Id of the converted source ticket.' }),
      converted: z.literal(true).openapi({
        description: 'Always true — the source ticket is retained and flagged converted.',
      }),
    })
    .openapi({
      description:
        'The kanban card the ticket became, plus the retained source ticket (now converted).',
    }),
);

export const ConvertSupportTicketRequestSchema = z
  .object({
    autoMerge: z.boolean().nullable().optional().openapi({
      description:
        'Per-card auto-merge preference to stamp on the new card. true → the card (and any session later assigned to it) defaults to "Auto Merge"; false → "Build and Push". Carried over to the board so the assign UI pre-populates the checkbox. Omit to leave the card with no explicit preference (project default).',
    }),
    comment: z
      .string()
      .max(
        MAX_ASSIGNMENT_COMMENT_LEN,
        `comment must be ${MAX_ASSIGNMENT_COMMENT_LEN} characters or fewer`,
      )
      .nullable()
      .optional()
      .openapi({
        description: `Optional note (max ${MAX_ASSIGNMENT_COMMENT_LEN} characters) recorded as a comment on the new card (e.g. context for whoever picks it up).`,
      }),
  })
  .openapi({ description: 'Optional auto-merge preference and note to attach to the new card.' });

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/support-tickets/{id}/convert',
  tags: ['Support'],
  summary: 'Convert a support ticket into a To Do kanban card',
  description:
    'Creates a To Do card from the ticket (title/description, severity→priority, support,<type> labels), then flags the source ticket `converted` and marks it read (it is retained, not deleted). Re-converting an already-converted ticket 409s rather than creating a duplicate card. An optional body carries an auto-merge preference and a note onto the new card.',
  request: {
    params: ticketParams,
    body: {
      required: false,
      content: jsonContent(ConvertSupportTicketRequestSchema),
    },
  },
  responses: {
    201: {
      description: 'Ticket converted to a new card; the source ticket is retained as converted.',
      content: jsonContent(ConvertSupportTicketResponse),
    },
    404: errorResponse('Project or ticket not found.'),
    409: errorResponse('Support ticket already converted.'),
    500: errorResponse('Board has no columns to place the card in.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/support-tickets/{id}',
  tags: ['Support'],
  summary: 'Delete a support ticket',
  request: { params: ticketParams },
  responses: {
    200: { description: 'Deleted.', content: jsonContent(z.object({ ok: z.boolean() })) },
    404: errorResponse('Project or ticket not found.'),
  },
});
