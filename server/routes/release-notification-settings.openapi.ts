import { z, registerComponent, registerPath } from '../openapi/registry.js';
import {
  RELEASE_DIGEST_PROMPT_MAX_LENGTH,
  RELEASE_DIGEST_RECIPIENT_LABEL_MAX_LENGTH,
} from '../release-notification-settings.js';

export const ReleaseDigestRecipientSchema = registerComponent(
  'ReleaseDigestRecipient',
  z.object({
    id: z.string(),
    projectId: z.string(),
    email: z.string().email(),
    displayLabel: z.string().nullable(),
    enabled: z.boolean(),
    createdBy: z.string().nullable(),
    updatedBy: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const ReleaseNotificationSettingsSchema = registerComponent(
  'ReleaseNotificationSettings',
  z.object({
    projectId: z.string(),
    releaseDigestPrompt: z.string(),
    defaultReleaseDigestPrompt: z.string(),
    isDefault: z.boolean(),
    promptMaxLength: z.number().int(),
    factBoundedSystemTemplate: z.string().openapi({
      description:
        'Server-owned release digest generation boundary. The editable prompt is guidance only and cannot expand the allowed source facts.',
    }),
    updatedBy: z.string().nullable(),
    updatedAt: z.string().nullable(),
    releaseDigestRecipients: z.array(ReleaseDigestRecipientSchema).optional().openapi({
      description: 'Admin-only release digest recipient list. Omitted for non-admin callers.',
    }),
  }),
);

export const UpdateReleaseNotificationSettingsRequestSchema = z.object({
  releaseDigestPrompt: z.string().trim().min(1).max(RELEASE_DIGEST_PROMPT_MAX_LENGTH),
});

export const CreateReleaseDigestRecipientRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  displayLabel: z
    .string()
    .trim()
    .max(RELEASE_DIGEST_RECIPIENT_LABEL_MAX_LENGTH)
    .nullable()
    .optional(),
  enabled: z.boolean().optional(),
});

export const PatchReleaseDigestRecipientRequestSchema = z
  .object({
    displayLabel: z
      .string()
      .trim()
      .max(RELEASE_DIGEST_RECIPIENT_LABEL_MAX_LENGTH)
      .nullable()
      .optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => body.displayLabel !== undefined || body.enabled !== undefined, {
    message: 'At least one field is required.',
  });

const ReleaseDigestRecipientsResponse = registerComponent(
  'ReleaseDigestRecipientsResponse',
  z.object({ recipients: z.array(ReleaseDigestRecipientSchema) }),
);

const ReleaseDigestRecipientDeleteResponse = registerComponent(
  'ReleaseDigestRecipientDeleteResponse',
  z.object({ ok: z.boolean() }),
);

const ErrorResponse = registerComponent(
  'ReleaseNotificationSettingsErrorResponse',
  z.object({ error: z.string() }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const projectParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

const recipientParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
  recipientId: z.string().openapi({ description: 'Release digest recipient id.' }),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/release-notification-settings',
  tags: ['Deployments'],
  summary: 'Read release notification settings',
  description:
    'Returns per-project release notification settings, including the editable release digest guidance prompt and the fixed fact-bounded generation template. Admin+ callers also receive release digest recipients; non-admin callers never receive recipient data.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Release notification settings.',
      content: jsonContent(ReleaseNotificationSettingsSchema),
    },
    404: {
      description: 'Project not found.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/release-notification-settings/recipients',
  tags: ['Deployments'],
  summary: 'List release digest recipients',
  description:
    'Admin+ only. Lists project-scoped release digest recipients, including disabled rows for audit and re-enable workflows.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Release digest recipients.',
      content: jsonContent(ReleaseDigestRecipientsResponse),
    },
    403: {
      description: 'Caller is below Admin role.',
      content: jsonContent(ErrorResponse),
    },
    404: {
      description: 'Project not found.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/release-notification-settings/recipients',
  tags: ['Deployments'],
  summary: 'Add a release digest recipient',
  description:
    'Admin+ only. Adds a project-scoped release digest recipient. Email uniqueness is enforced case-insensitively per project.',
  request: {
    params: projectParams,
    body: { content: jsonContent(CreateReleaseDigestRecipientRequestSchema) },
  },
  responses: {
    201: {
      description: 'Created release digest recipient.',
      content: jsonContent(ReleaseDigestRecipientSchema),
    },
    400: {
      description: 'Malformed or invalid recipient.',
      content: jsonContent(ErrorResponse),
    },
    403: {
      description: 'Caller is below Admin role.',
      content: jsonContent(ErrorResponse),
    },
    404: {
      description: 'Project not found.',
      content: jsonContent(ErrorResponse),
    },
    409: {
      description: 'Recipient email already exists for this project.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'patch',
  path: '/api/projects/{projectId}/release-notification-settings/recipients/{recipientId}',
  tags: ['Deployments'],
  summary: 'Update a release digest recipient',
  description:
    'Admin+ only. Updates a recipient display label and enabled state. Email addresses are immutable; remove and add a recipient to change the address.',
  request: {
    params: recipientParams,
    body: { content: jsonContent(PatchReleaseDigestRecipientRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated release digest recipient.',
      content: jsonContent(ReleaseDigestRecipientSchema),
    },
    400: {
      description: 'Malformed or invalid patch.',
      content: jsonContent(ErrorResponse),
    },
    403: {
      description: 'Caller is below Admin role.',
      content: jsonContent(ErrorResponse),
    },
    404: {
      description: 'Project or recipient not found.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/release-notification-settings/recipients/{recipientId}',
  tags: ['Deployments'],
  summary: 'Remove a release digest recipient',
  description: 'Admin+ only. Removes a recipient from the project release digest list.',
  request: { params: recipientParams },
  responses: {
    200: {
      description: 'Recipient removed.',
      content: jsonContent(ReleaseDigestRecipientDeleteResponse),
    },
    403: {
      description: 'Caller is below Admin role.',
      content: jsonContent(ErrorResponse),
    },
    404: {
      description: 'Project or recipient not found.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/release-notification-settings',
  tags: ['Deployments'],
  summary: 'Update release notification settings',
  description:
    'Admin+ only. Stores the operator guidance prompt used by release digest generation. The prompt is always applied inside the server-owned fact-bounded template.',
  request: {
    params: projectParams,
    body: { content: jsonContent(UpdateReleaseNotificationSettingsRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated release notification settings.',
      content: jsonContent(ReleaseNotificationSettingsSchema),
    },
    400: {
      description: 'Malformed or invalid prompt.',
      content: jsonContent(ErrorResponse),
    },
    403: {
      description: 'Caller is below Admin role.',
      content: jsonContent(ErrorResponse),
    },
    404: {
      description: 'Project not found.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/release-notification-settings/reset',
  tags: ['Deployments'],
  summary: 'Reset release notification settings',
  description:
    'Admin+ only. Clears the stored release digest prompt so the project uses the safe server default.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Settings reset to the default prompt.',
      content: jsonContent(ReleaseNotificationSettingsSchema),
    },
    403: {
      description: 'Caller is below Admin role.',
      content: jsonContent(ErrorResponse),
    },
    404: {
      description: 'Project not found.',
      content: jsonContent(ErrorResponse),
    },
  },
});
