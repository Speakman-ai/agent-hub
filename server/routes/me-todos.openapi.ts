/**
 * Zod schemas + OpenAPI registrations for the cross-project personal todos
 * surface (`server/routes/me-todos.ts`).
 *
 * Every endpoint scopes to `req.authUserId` — a user only ever sees their own
 * todos (spec TODO-MODEL). This companion owns the wire shape only; the route
 * file owns behaviour.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'MeTodosErrorResponse',
  z
    .object({ error: z.string() })
    .openapi({ description: 'Error envelope for personal-todo routes.' }),
);

const TodoStatus = z.enum(['open', 'done']);
const TodoSourceType = z.enum(['manual', 'email', 'calendar']);

export const UserTodoComponent = registerComponent(
  'UserTodo',
  z
    .object({
      id: z.string(),
      userId: z.string(),
      title: z.string(),
      notes: z.string(),
      status: TodoStatus,
      dueAt: z.string().nullable(),
      position: z.number(),
      sourceType: TodoSourceType,
      sourceId: z.string().nullable(),
      sourceMeta: z.record(z.string(), z.unknown()).nullable(),
      linkedCardId: z.string().nullable(),
      linkedProjectId: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({
      description:
        'A single cross-project personal todo owned by one Hub user. Independent of any project board.',
    }),
);

export const CreateTodoRequestSchema = z.object({
  title: z.string().min(1, 'title is required'),
  notes: z.string().optional(),
  dueAt: z.string().nullable().optional(),
  sourceType: TodoSourceType.optional(),
  sourceId: z.string().nullable().optional(),
  sourceMeta: z.record(z.string(), z.unknown()).optional(),
});

export const UpdateTodoRequestSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  status: TodoStatus.optional(),
  dueAt: z.string().nullable().optional(),
});

export const ReorderTodosRequestSchema = z.object({
  orderedIds: z.array(z.string()).openapi({
    description: 'Ids in the desired order. Ids the caller does not own are ignored.',
  }),
});

const idParams = z.object({ id: z.string().openapi({ description: 'Todo id.' }) });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/me/todos',
  tags: ['Personal Todos'],
  summary: "List the calling user's personal todos",
  request: {
    query: z.object({
      status: TodoStatus.optional().openapi({ description: 'Filter to only open or only done.' }),
    }),
  },
  responses: {
    200: {
      description: "The caller's todos in per-user order.",
      content: jsonContent(z.object({ todos: z.array(UserTodoComponent) })),
    },
    400: errorResponse('Invalid status filter.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/todos',
  tags: ['Personal Todos'],
  summary: 'Create a personal todo',
  request: { body: { content: jsonContent(CreateTodoRequestSchema) } },
  responses: {
    201: {
      description: 'Created todo.',
      content: jsonContent(z.object({ todo: UserTodoComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/me/todos/{id}',
  tags: ['Personal Todos'],
  summary: 'Update a personal todo (partial)',
  request: {
    params: idParams,
    body: { content: jsonContent(UpdateTodoRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated todo.',
      content: jsonContent(z.object({ todo: UserTodoComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('Todo not found (or not owned by caller).'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/me/todos/{id}',
  tags: ['Personal Todos'],
  summary: 'Delete a personal todo',
  request: { params: idParams },
  responses: {
    200: {
      description: 'Deleted.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
    401: errorResponse('Authentication required.'),
    404: errorResponse('Todo not found (or not owned by caller).'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/todos/reorder',
  tags: ['Personal Todos'],
  summary: "Reassign the per-user order of the caller's todos",
  request: { body: { content: jsonContent(ReorderTodosRequestSchema) } },
  responses: {
    200: {
      description: 'The reordered todo list.',
      content: jsonContent(z.object({ todos: z.array(UserTodoComponent) })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
  },
});
