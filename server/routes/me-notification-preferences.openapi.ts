/**
 * Zod schemas + OpenAPI registrations for the caller's notification
 * preferences (`server/routes/me-notification-preferences.ts`).
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import {
  NOTIFICATION_CATEGORY_IDS,
  NOTIFICATION_SECTIONS,
} from '../../shared/utils/notificationCategories.js';

const ErrorResponse = registerComponent(
  'NotificationPreferencesErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

const CategoryIdSchema = z.enum(NOTIFICATION_CATEGORY_IDS as unknown as [string, ...string[]]);
const SectionIdSchema = z.enum(
  NOTIFICATION_SECTIONS.map((s) => s.id) as unknown as [string, ...string[]],
);

export const ChannelPatchSchema = z
  .object({
    in_app: z.boolean().optional(),
    desktop: z.boolean().optional(),
    push: z.boolean().optional(),
  })
  .strict();

export const UpdateNotificationPreferencesRequestSchema = registerComponent(
  'UpdateNotificationPreferencesRequest',
  z
    .object({
      categories: z.partialRecord(CategoryIdSchema, ChannelPatchSchema).openapi({
        description:
          'Category id → channel switches to change. Omitted categories and channels keep their current value.',
      }),
    })
    .strict()
    .openapi({ description: 'Partial update of the caller notification preferences.' }),
);

const CategoryPrefsSchema = z
  .object({
    category: CategoryIdSchema,
    section: SectionIdSchema,
    label: z.string(),
    description: z.string(),
    in_app: z.boolean(),
    desktop: z.boolean(),
    push: z.boolean(),
    defaults: z.object({ in_app: z.boolean(), desktop: z.boolean(), push: z.boolean() }),
    isDefault: z.boolean().openapi({
      description: 'True when nothing is stored and the values are the catalog defaults.',
    }),
  })
  .openapi({ description: 'One category row of the preferences matrix.' });

export const NotificationPreferencesResponseSchema = registerComponent(
  'NotificationPreferences',
  z
    .object({
      channels: z.array(z.enum(['in_app', 'desktop', 'push'])),
      sections: z.array(
        z.object({ id: SectionIdSchema, label: z.string(), categories: z.array(CategoryIdSchema) }),
      ),
      categories: z.array(CategoryPrefsSchema),
    })
    .openapi({
      description:
        'The caller per-category, per-channel notification matrix. Every catalog category is present; unset ones carry catalog defaults.',
    }),
);

registerPath({
  method: 'get',
  path: '/api/me/notification-preferences',
  tags: ['Notifications'],
  summary: "Get the calling user's notification preferences",
  responses: {
    200: {
      description: 'Full preferences matrix.',
      content: { 'application/json': { schema: NotificationPreferencesResponseSchema } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'put',
  path: '/api/me/notification-preferences',
  tags: ['Notifications'],
  summary: "Update the calling user's notification preferences",
  request: {
    body: {
      content: { 'application/json': { schema: UpdateNotificationPreferencesRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Preferences after the update.',
      content: { 'application/json': { schema: NotificationPreferencesResponseSchema } },
    },
    400: {
      description: 'Unknown category or channel, or a non-boolean value.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});
