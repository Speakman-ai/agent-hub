/**
 * Zod schemas + OpenAPI registrations for the escalations route group.
 *
 * Escalations track urgent items (merge conflicts, CI failures, blockers,
 * review-needed) that warrant operator attention. Routes wrap CRUD over
 * the `escalations` table; broadcast + Slack notifications happen in the
 * handler.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const VALID_TYPES = ['merge_conflict', 'ci_failure', 'review_needed', 'blocker'] as const;

const ErrorResponse = registerComponent(
  'EscalationsErrorResponse',
  z
    .object({
      error: z.string(),
      details: z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          }),
        )
        .optional(),
    })
    .openapi({ description: 'Error envelope for escalation routes.' }),
);

export const EscalationComponent = registerComponent(
  'Escalation',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      type: z.enum(VALID_TYPES),
      title: z.string(),
      description: z.string().nullable(),
      pr_number: z.number().int().nullable(),
      pr_url: z.string().nullable(),
      card_id: z.string().nullable(),
      source: z.string().nullable(),
      acknowledged_at: z.string().nullable(),
      created_at: z.string(),
    })
    .passthrough()
    .openapi({ description: 'A single escalation row.' }),
);

export const CreateEscalationRequestSchema = z.object({
  type: z.enum(VALID_TYPES, {
    message: `type must be one of: ${VALID_TYPES.join(', ')}`,
  }),
  title: z.string().min(1, 'title is required'),
  description: z.string().optional(),
  prNumber: z.number().int().optional(),
  prUrl: z.string().optional(),
  cardId: z.string().optional(),
  source: z.string().optional(),
});

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug or id.' }),
});

const idParams = z.object({ id: z.string().openapi({ description: 'Escalation id.' }) });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/escalations',
  tags: ['Escalations'],
  summary: 'List active escalations across every project',
  responses: {
    200: { description: 'Active escalations.', content: jsonContent(z.array(EscalationComponent)) },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/escalations',
  tags: ['Escalations'],
  summary: 'List escalations for a project',
  request: {
    params: projectIdParams,
    query: z.object({
      active: z
        .enum(['true', 'false'])
        .optional()
        .openapi({ description: 'When `true`, only unacknowledged rows.' }),
    }),
  },
  responses: {
    200: { description: 'Escalation rows.', content: jsonContent(z.array(EscalationComponent)) },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/escalations',
  tags: ['Escalations'],
  summary: 'Create an escalation',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateEscalationRequestSchema) },
  },
  responses: {
    201: { description: 'Created escalation.', content: jsonContent(EscalationComponent) },
    400: errorResponse('Invalid type or missing title.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/escalations/{id}/acknowledge',
  tags: ['Escalations'],
  summary: 'Mark an escalation acknowledged',
  request: { params: idParams },
  responses: {
    200: { description: 'Acknowledged escalation.', content: jsonContent(EscalationComponent) },
    404: errorResponse('Escalation not found.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/escalations/{id}',
  tags: ['Escalations'],
  summary: 'Dismiss / delete an escalation',
  request: { params: idParams },
  responses: {
    200: {
      description: 'Dismissed.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
    404: errorResponse('Escalation not found.'),
  },
});
