/**
 * Zod schemas + OpenAPI registrations for the bell inbox surface
 * (`server/routes/notifications.ts`). Every endpoint scopes to the caller;
 * this companion owns the wire shape only.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { MAX_PAGE_SIZE } from '../notifications-store.js';

const ErrorResponse = registerComponent(
  'NotificationsErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for inbox routes.' }),
);

export const NotificationComponent = registerComponent(
  'InboxNotification',
  z
    .object({
      id: z.string(),
      userId: z.string(),
      orgId: z.string().nullable(),
      projectId: z.string().nullable(),
      category: z.string().openapi({ description: 'Category id from the shared catalog.' }),
      title: z.string(),
      body: z.string(),
      route: z.string().nullable().openapi({ description: 'Client deep-link route.' }),
      data: z.record(z.string(), z.unknown()).nullable(),
      sourceKey: z.string(),
      createdAt: z.string(),
      readAt: z.string().nullable(),
    })
    .openapi({ description: "One row in the caller's notification inbox." }),
);

const booleanQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const ListNotificationsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .openapi({ description: `Page size, 1-${MAX_PAGE_SIZE}. Default 20.` }),
  cursor: z
    .string()
    .min(1)
    .optional()
    .openapi({ description: '`nextCursor` from the previous page.' }),
  unread: booleanQuery
    .optional()
    .openapi({ description: 'When true, return only unread rows.', type: 'string' }),
});

const NotificationPageResponse = z.object({
  items: z.array(NotificationComponent),
  nextCursor: z.string().nullable().openapi({ description: 'Null on the last page.' }),
});

const UnreadCountResponse = z.object({ count: z.number().int() });

const idParams = z.object({ id: z.string().openapi({ description: 'Notification id.' }) });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/notifications',
  tags: ['Notifications'],
  summary: "List the caller's inbox notifications, newest first (cursor paged)",
  request: { query: ListNotificationsQuerySchema },
  responses: {
    200: {
      description: 'One page of notifications.',
      content: jsonContent(NotificationPageResponse),
    },
    400: errorResponse('Invalid query.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/notifications/unread-count',
  tags: ['Notifications'],
  summary: "Count the caller's unread notifications",
  responses: {
    200: { description: 'Unread count.', content: jsonContent(UnreadCountResponse) },
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/notifications/{id}/read',
  tags: ['Notifications'],
  summary: 'Mark one notification read',
  description:
    "Idempotent. Emits a `notification_read` WebSocket event to the caller's clients when the row flips to read.",
  request: { params: idParams },
  responses: {
    200: {
      description: 'The notification and the new unread count.',
      content: jsonContent(
        z.object({ notification: NotificationComponent, unreadCount: z.number().int() }),
      ),
    },
    401: errorResponse('Authentication required.'),
    404: errorResponse('Not found, or owned by another user.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/notifications/read-all',
  tags: ['Notifications'],
  summary: "Mark all of the caller's notifications read",
  description:
    "Emits a `notification_read` WebSocket event (`all: true`) to the caller's clients when any row flipped.",
  responses: {
    200: {
      description: 'Number of rows flipped to read.',
      content: jsonContent(z.object({ updated: z.number().int(), unreadCount: z.number().int() })),
    },
    401: errorResponse('Authentication required.'),
  },
});
