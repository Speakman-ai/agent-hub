/**
 * Zod schemas + OpenAPI registrations for the shared organization todos surface
 * (`server/routes/org-todos.ts`).
 *
 * Every endpoint is scoped to an org and readable / writable by every member of
 * that org (there is no per-user ownership). This companion owns the wire shape
 * only; the route file owns behaviour.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'OrgTodosErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for org-todo routes.' }),
);

const TodoStatus = z.enum(['open', 'done']);
const TodoPriority = z.enum(['urgent', 'high', 'medium', 'low']);

export const OrgTodoComponent = registerComponent(
  'OrgTodo',
  z
    .object({
      id: z.string(),
      orgId: z.string(),
      title: z.string(),
      notes: z.string(),
      status: TodoStatus,
      priority: TodoPriority,
      doDate: z.string().nullable().openapi({
        description: 'Day the team plans to work the task (scheduling "do" date, not a deadline).',
      }),
      doStartAt: z.string().nullable(),
      doEndAt: z.string().nullable(),
      position: z.number(),
      createdByUserId: z.string().nullable().openapi({
        description: 'Member who added the todo, or null for apiKey / local-bundled creates.',
      }),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({
      description:
        "A single shared organization todo, visible and editable by every member of the org. A distinct list, not an aggregation of members' personal todos.",
    }),
);

const doDateField = z.string().nullable().optional();

export const CreateOrgTodoRequestSchema = z.object({
  title: z.string().min(1, 'title is required'),
  notes: z.string().optional(),
  priority: TodoPriority.optional(),
  doDate: doDateField.openapi({
    description: 'Day the team plans to work the task (scheduling "do" date, not a deadline).',
  }),
  doStartAt: doDateField,
  doEndAt: doDateField,
});

export const UpdateOrgTodoRequestSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  status: TodoStatus.optional(),
  priority: TodoPriority.optional(),
  doDate: doDateField,
  doStartAt: doDateField,
  doEndAt: doDateField,
});

export const ReorderOrgTodosRequestSchema = z.object({
  orderedIds: z.array(z.string()).openapi({
    description: 'Ids in the desired order. Ids not in this org are ignored.',
  }),
});

const orgParams = z.object({ orgId: z.string().openapi({ description: 'Org id.' }) });
const orgTodoParams = z.object({
  orgId: z.string().openapi({ description: 'Org id.' }),
  id: z.string().openapi({ description: 'Todo id.' }),
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
  path: '/api/orgs/{orgId}/todos',
  tags: ['Org Todos'],
  summary: "List the org's shared todos",
  request: {
    params: orgParams,
    query: z.object({
      status: TodoStatus.optional().openapi({ description: 'Filter to only open or only done.' }),
    }),
  },
  responses: {
    200: {
      description: "The org's shared todos in per-org order.",
      content: jsonContent(z.object({ todos: z.array(OrgTodoComponent) })),
    },
    400: errorResponse('Invalid status filter.'),
    401: errorResponse('Authentication required.'),
    403: errorResponse('Caller is not a member of this org.'),
    404: errorResponse('Org not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/orgs/{orgId}/todos',
  tags: ['Org Todos'],
  summary: 'Create a shared org todo',
  request: {
    params: orgParams,
    body: { content: jsonContent(CreateOrgTodoRequestSchema) },
  },
  responses: {
    201: {
      description: 'Created todo.',
      content: jsonContent(z.object({ todo: OrgTodoComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    403: errorResponse('Caller is not a member of this org.'),
    404: errorResponse('Org not found.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/orgs/{orgId}/todos/{id}',
  tags: ['Org Todos'],
  summary: 'Update a shared org todo (partial)',
  request: {
    params: orgTodoParams,
    body: { content: jsonContent(UpdateOrgTodoRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated todo.',
      content: jsonContent(z.object({ todo: OrgTodoComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    403: errorResponse('Caller is not a member of this org.'),
    404: errorResponse('Org or todo not found.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/orgs/{orgId}/todos/{id}',
  tags: ['Org Todos'],
  summary: 'Delete a shared org todo',
  request: { params: orgTodoParams },
  responses: {
    200: {
      description: 'Deleted.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
    401: errorResponse('Authentication required.'),
    403: errorResponse('Caller is not a member of this org.'),
    404: errorResponse('Org or todo not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/orgs/{orgId}/todos/reorder',
  tags: ['Org Todos'],
  summary: "Reassign the order of the org's shared todos",
  request: {
    params: orgParams,
    body: { content: jsonContent(ReorderOrgTodosRequestSchema) },
  },
  responses: {
    200: {
      description: 'The reordered todo list.',
      content: jsonContent(z.object({ todos: z.array(OrgTodoComponent) })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    403: errorResponse('Caller is not a member of this org.'),
    404: errorResponse('Org not found.'),
  },
});
