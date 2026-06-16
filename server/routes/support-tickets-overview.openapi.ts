/**
 * Zod schemas + OpenAPI registration for the cross-project support overview.
 *
 * `GET /api/support-tickets` aggregates every project's support tickets into a
 * single severity-ordered list (critical → low, then newest), each row enriched
 * with `project_name`, plus the distinct set of projects-with-tickets so the
 * client can render a stable project filter.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { SupportTicketComponent } from './support-tickets.openapi.js';

const STATUSES = ['new', 'investigating', 'converted', 'closed'] as const;

const ErrorResponse = registerComponent(
  'SupportTicketOverviewErrorResponse',
  z
    .object({ error: z.string() })
    .openapi({ description: 'Error envelope for the support-overview route.' }),
);

const SupportTicketWithProject = registerComponent(
  'SupportTicketWithProject',
  SupportTicketComponent.extend({
    project_name: z
      .string()
      .openapi({ description: "Display name of the ticket's project (falls back to its id)." }),
  }).openapi({ description: 'A support ticket enriched with its project name.' }),
);

const SupportOverviewResponse = registerComponent(
  'SupportOverviewResponse',
  z
    .object({
      tickets: z.array(SupportTicketWithProject),
      projects: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            count: z.number().int().nonnegative(),
          }),
        )
        .openapi({
          description:
            'Distinct projects that currently have support tickets, ordered by descending ticket count then name. Always the full unfiltered set so the client filter stays complete.',
        }),
    })
    .openapi({ description: 'Cross-project support tickets plus project filter options.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

registerPath({
  method: 'get',
  path: '/api/support-tickets',
  tags: ['Support'],
  summary: 'List support tickets across all projects, ordered by severity',
  description:
    'Aggregates every project’s support tickets into one severity-ordered list (critical → low, then newest). Optional `status` and `projectId` query filters compose and are applied server-side.',
  request: {
    query: z.object({
      status: z
        .enum(STATUSES)
        .optional()
        .openapi({ description: 'Filter to a single lifecycle status.' }),
      projectId: z
        .string()
        .optional()
        .openapi({ description: 'Scope to a single project (404 if unknown).' }),
    }),
  },
  responses: {
    200: {
      description:
        'Tickets (each with project_name) ordered by severity, plus project filter options.',
      content: jsonContent(SupportOverviewResponse),
    },
    400: { description: 'Invalid status filter.', content: jsonContent(ErrorResponse) },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});
