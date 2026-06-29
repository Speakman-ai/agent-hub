import { z, registerComponent, registerPath } from '../openapi/registry.js';
import { RELEASE_DIGEST_PROMPT_MAX_LENGTH } from '../release-notification-settings.js';

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
  }),
);

export const UpdateReleaseNotificationSettingsRequestSchema = z.object({
  releaseDigestPrompt: z.string().trim().min(1).max(RELEASE_DIGEST_PROMPT_MAX_LENGTH),
});

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

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/release-notification-settings',
  tags: ['Deployments'],
  summary: 'Read release notification settings',
  description:
    'Returns per-project release notification settings, including the editable release digest guidance prompt and the fixed fact-bounded generation template.',
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
