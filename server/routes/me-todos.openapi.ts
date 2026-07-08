/**
 * Zod schemas + OpenAPI registrations for the cross-project personal todos
 * surface (`server/routes/me-todos.ts`).
 *
 * Every endpoint scopes to `req.authUserId` — a user only ever sees their own
 * todos (spec TODO-MODEL). This companion owns the wire shape only; the route
 * file owns behaviour.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { TODO_SOURCE_TYPES } from '../source-provenance.js';
import { KanbanCardComponent } from './board.openapi.js';

const ErrorResponse = registerComponent(
  'MeTodosErrorResponse',
  z
    .object({ error: z.string() })
    .openapi({ description: 'Error envelope for personal-todo routes.' }),
);

const TodoStatus = z.enum(['open', 'done']);
const TodoPriority = z.enum(['urgent', 'high', 'medium', 'low']);
const TodoLinkType = z.enum(['card', 'epic', 'session']);
const TodoSourceType = z.enum([...TODO_SOURCE_TYPES]);

export const UserTodoComponent = registerComponent(
  'UserTodo',
  z
    .object({
      id: z.string(),
      userId: z.string(),
      title: z.string(),
      notes: z.string(),
      status: TodoStatus,
      priority: TodoPriority,
      doDate: z.string().nullable().openapi({
        description: 'Day the user plans to work the task (scheduling "do" date, not a deadline).',
      }),
      doStartAt: z.string().nullable(),
      doEndAt: z.string().nullable(),
      dueAt: z.string().nullable().openapi({
        description: 'Deprecated: retained for back-compat. Prefer doDate.',
      }),
      position: z.number(),
      sourceType: TodoSourceType,
      sourceId: z.string().nullable(),
      sourceMeta: z.record(z.string(), z.unknown()).nullable(),
      linkedType: TodoLinkType.nullable(),
      linkedId: z.string().nullable(),
      linkedProjectId: z.string().nullable(),
      linkedCardId: z.string().nullable().openapi({
        description: 'Deprecated: superseded by linkedType/linkedId. Kept in sync for a card link.',
      }),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({
      description:
        'A single cross-project personal todo owned by one Hub user. Independent of any project board.',
    }),
);

const doDateField = z.string().nullable().optional();
const linkedTypeField = TodoLinkType.nullable().optional().openapi({
  description:
    'Polymorphic link target type. Co-dependent with linkedId; an explicit null clears the link.',
});
const linkedIdField = z.string().nullable().optional().openapi({
  description: 'Linked entity id. Required when linkedType is set.',
});
const linkedProjectIdField = z.string().nullable().optional().openapi({
  description: 'Scopes a project-bound link target (card / epic). Ignored for a session link.',
});

export const CreateTodoRequestSchema = z.object({
  title: z.string().min(1, 'title is required'),
  notes: z.string().optional(),
  priority: TodoPriority.optional(),
  doDate: doDateField.openapi({
    description: 'Day the user plans to work the task (scheduling "do" date, not a deadline).',
  }),
  doStartAt: doDateField,
  doEndAt: doDateField,
  dueAt: z.string().nullable().optional(),
  sourceType: TodoSourceType.optional(),
  sourceId: z.string().nullable().optional(),
  sourceMeta: z.record(z.string(), z.unknown()).optional(),
  linkedType: linkedTypeField,
  linkedId: linkedIdField,
  linkedProjectId: linkedProjectIdField,
});

export const UpdateTodoRequestSchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  status: TodoStatus.optional(),
  priority: TodoPriority.optional(),
  doDate: doDateField,
  doStartAt: doDateField,
  doEndAt: doDateField,
  dueAt: z.string().nullable().optional(),
  linkedType: linkedTypeField,
  linkedId: linkedIdField,
  linkedProjectId: linkedProjectIdField,
});

export const ReorderTodosRequestSchema = z.object({
  orderedIds: z.array(z.string()).openapi({
    description: 'Ids in the desired order. Ids the caller does not own are ignored.',
  }),
});

export const PromoteTodoRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId is required'),
  columnId: z.string().min(1).optional(),
  epicId: z.string().min(1).optional(),
  priority: TodoPriority.optional().openapi({
    description: "Overrides the created card's priority. Omit to carry over the todo priority.",
  }),
});

export const LinkTodoRequestSchema = z.object({
  targetType: TodoLinkType.openapi({
    description: 'Existing entity to link to: a kanban card, an epic, or a session.',
  }),
  targetId: z.string().min(1, 'targetId is required'),
  projectId: z.string().min(1).optional().openapi({
    description:
      'Required for a card / epic target (scopes and RBAC-gates the project). Ignored for a session.',
  }),
});

export const LinkedTodosQuerySchema = z.object({
  targetType: TodoLinkType.openapi({ description: 'Target entity type.' }),
  targetId: z.string().min(1).openapi({ description: 'Target entity id.' }),
  projectId: z
    .string()
    .min(1)
    .optional()
    .openapi({ description: 'Project of a card / epic target. Ignored for a session.' }),
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
  path: '/api/me/todos/{id}/promote',
  tags: ['Personal Todos'],
  summary: 'Promote a personal todo to a project kanban card',
  description:
    'Creates a real kanban card in the target project (To Do by default), stamps card provenance back to the source todo, and links the todo to the created card.',
  request: {
    params: idParams,
    body: { content: jsonContent(PromoteTodoRequestSchema) },
  },
  responses: {
    200: {
      description: 'Todo was already promoted; returning the existing linked card.',
      content: jsonContent(z.object({ todo: UserTodoComponent, card: KanbanCardComponent })),
    },
    201: {
      description: 'Created card and updated todo link.',
      content: jsonContent(z.object({ todo: UserTodoComponent, card: KanbanCardComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('Todo, project, column, or epic not found.'),
    409: errorResponse('Todo is already linked to a different or missing card.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/me/todos/linked',
  tags: ['Personal Todos'],
  summary: "The caller's todos linked to a given card / epic / session",
  description:
    "Reverse side of the polymorphic link: returns the calling user's own todos that point at the target entity (bidirectional display). Todos are private, so this never surfaces another user's from-todo.",
  request: { query: LinkedTodosQuerySchema },
  responses: {
    200: {
      description: "The caller's todos linked to the target.",
      content: jsonContent(z.object({ todos: z.array(UserTodoComponent) })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('Target not found or not visible to the caller.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/me/todos/{id}/link',
  tags: ['Personal Todos'],
  summary: 'Link a personal todo to an existing card / epic / session',
  description:
    'Associates the todo with an existing entity without creating anything. The caller must be able to see the target (project visibility for a card / epic, session ownership for a session), else 404.',
  request: {
    params: idParams,
    body: { content: jsonContent(LinkTodoRequestSchema) },
  },
  responses: {
    200: {
      description: 'Linked todo.',
      content: jsonContent(z.object({ todo: UserTodoComponent })),
    },
    400: errorResponse('Validation failed.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('Todo or target not found (or not visible to the caller).'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/me/todos/{id}/link',
  tags: ['Personal Todos'],
  summary: "Clear a personal todo's link",
  request: { params: idParams },
  responses: {
    200: {
      description: 'Unlinked todo.',
      content: jsonContent(z.object({ todo: UserTodoComponent })),
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
