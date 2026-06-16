/**
 * Zod schemas + OpenAPI registrations for the support-ticket queue route group.
 *
 * Support tickets are customer support requests persisted in their own
 * project-scoped queue, separate from the kanban board. The list endpoint
 * returns rows ordered by severity (most severe first); the status lifecycle
 * (new → investigating → converted / closed) is distinct from kanban columns.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { KanbanCardComponent } from './board.openapi.js';

const TYPES = ['bug', 'question', 'feature_request', 'incident', 'other'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const STATUSES = ['new', 'investigating', 'converted', 'closed'] as const;

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
      ai_summary: z.string().nullable(),
      ai_investigation: z.string().nullable(),
      ai_investigated_at: z.string().nullable(),
      replay_ref: z.string().nullable(),
      screenshot_ref: z
        .string()
        .nullable()
        .openapi({ description: 'Server-relative ref to an attached screenshot, or null.' }),
      converted_card_id: z.string().nullable(),
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
  replayRef: z.string().optional(),
  screenshot: z.string().optional().openapi({
    description:
      'Optional screenshot as a base64 data URL (data:image/png|jpeg|webp|gif;base64,...). Persisted server-side and exposed via screenshot_ref.',
  }),
});

export const PatchSupportTicketRequestSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    aiSummary: z.string().nullable().optional(),
    aiInvestigation: z.string().nullable().optional(),
    replayRef: z.string().nullable().optional(),
    screenshot: z.string().nullable().optional().openapi({
      description:
        'Attach a screenshot (base64 data URL) or clear it with null. Persisted server-side; exposed via screenshot_ref.',
    }),
  })
  .openapi({
    description: 'Partial update: status transition and/or AI/replay/screenshot fields.',
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
  request: {
    params: projectIdParams,
    query: z.object({
      status: z
        .enum(STATUSES)
        .optional()
        .openapi({ description: 'Filter to a single lifecycle status.' }),
    }),
  },
  responses: {
    200: {
      description: 'Tickets ordered by severity (critical → low) then newest.',
      content: jsonContent(z.array(SupportTicketComponent)),
    },
    400: errorResponse('Invalid status filter.'),
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
  summary: 'Update a support ticket (status, AI investigation, replay ref)',
  request: {
    params: ticketParams,
    body: { content: jsonContent(PatchSupportTicketRequestSchema) },
  },
  responses: {
    200: { description: 'Updated ticket.', content: jsonContent(SupportTicketComponent) },
    400: errorResponse('Invalid status.'),
    404: errorResponse('Project or ticket not found.'),
  },
});

const ConvertSupportTicketResponse = registerComponent(
  'ConvertSupportTicketResponse',
  z
    .object({
      ticket: SupportTicketComponent,
      card: KanbanCardComponent,
      alreadyConverted: z
        .boolean()
        .optional()
        .openapi({ description: 'True when the ticket was already linked to an existing card.' }),
    })
    .openapi({ description: 'The converted ticket plus the kanban card it became.' }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/support-tickets/{id}/convert',
  tags: ['Support'],
  summary: 'Convert a support ticket into a To Do kanban card',
  description:
    'Creates a To Do card from the ticket (title/description, severity→priority, support,<type> labels), flips the ticket to converted, and links the card id back. Idempotent: returns the existing card if already converted.',
  request: { params: ticketParams },
  responses: {
    200: {
      description: 'Ticket was already converted; returns the existing card.',
      content: jsonContent(ConvertSupportTicketResponse),
    },
    201: {
      description: 'Ticket converted to a new card.',
      content: jsonContent(ConvertSupportTicketResponse),
    },
    404: errorResponse('Project or ticket not found.'),
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
