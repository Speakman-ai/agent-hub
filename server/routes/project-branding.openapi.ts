import { z, registerComponent, registerPath } from '../openapi/registry.js';
import { PROJECT_EMAIL_LOGO_ALLOWED_TYPES } from '../project-branding.js';

export const ProjectEmailLogoSchema = registerComponent(
  'ProjectEmailLogo',
  z.object({
    filename: z.string(),
    contentType: z.string(),
    size: z.number().int(),
    updatedAt: z.string(),
  }),
);

const ProjectEmailLogoResponse = registerComponent(
  'ProjectEmailLogoResponse',
  z.object({ emailLogo: ProjectEmailLogoSchema.nullable() }),
);

const ProjectEmailLogoDeleteResponse = registerComponent(
  'ProjectEmailLogoDeleteResponse',
  z.object({ ok: z.boolean(), emailLogo: z.null() }),
);

const ErrorResponse = registerComponent(
  'ProjectBrandingErrorResponse',
  z.object({ error: z.string() }),
);

const ReleaseEmailPreviewResponse = registerComponent(
  'ReleaseEmailPreviewResponse',
  z.object({
    html: z.string().openapi({ description: 'Fully rendered branded email HTML for preview.' }),
    subject: z.string(),
    usingProjectLogo: z
      .boolean()
      .openapi({ description: 'True when the preview used the per-project logo override.' }),
  }),
);

export const UpdateProjectEmailLogoRequestSchema = z.object({
  dataUrl: z
    .string()
    .min(1)
    .openapi({
      description: `Base64 \`data:\` URL of the image. Allowed types: ${PROJECT_EMAIL_LOGO_ALLOWED_TYPES.join(
        ', ',
      )}. Max 2MB.`,
    }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const projectParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug.' }),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/email-logo',
  tags: ['Projects'],
  summary: 'Read the project email logo metadata',
  description:
    "Returns the project's per-project release/deployment email logo override metadata, or null when the project uses the global Agent Hub logo.",
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Project email logo metadata.',
      content: jsonContent(ProjectEmailLogoResponse),
    },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/email-logo/raw',
  tags: ['Projects'],
  summary: 'Fetch the project email logo image bytes',
  description:
    'Streams the stored project email logo image (for settings preview). 404 when the project has no override.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Image bytes.',
      content: { 'image/*': { schema: z.string().openapi({ format: 'binary' }) } },
    },
    404: {
      description: 'No logo set or file missing.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/release-email-preview',
  tags: ['Projects'],
  summary: 'Render a branded release/deployment email preview',
  description:
    'Returns the exact branded email shell a release/deployment notification uses, with the project logo (or global default, or wordmark fallback) inlined and a representative digest body, so an admin can preview logo + messaging before a real deployment ships.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Rendered email preview.',
      content: jsonContent(ReleaseEmailPreviewResponse),
    },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/email-logo',
  tags: ['Projects'],
  summary: 'Upload a project email logo',
  description:
    'Admin+ only. Stores a per-project override for the branded release/deployment email logo. Replaces any prior logo. The global `emailLogoEnabled` switch still disables branding entirely.',
  request: {
    params: projectParams,
    body: { content: jsonContent(UpdateProjectEmailLogoRequestSchema) },
  },
  responses: {
    200: {
      description: 'Stored project email logo metadata.',
      content: jsonContent(ProjectEmailLogoResponse),
    },
    400: {
      description: 'Malformed data URL, unsupported type, or too large.',
      content: jsonContent(ErrorResponse),
    },
    403: { description: 'Caller is below Admin role.', content: jsonContent(ErrorResponse) },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/email-logo',
  tags: ['Projects'],
  summary: 'Remove the project email logo',
  description:
    'Admin+ only. Clears the per-project override so the project falls back to the global Agent Hub email logo.',
  request: { params: projectParams },
  responses: {
    200: {
      description: 'Override removed.',
      content: jsonContent(ProjectEmailLogoDeleteResponse),
    },
    403: { description: 'Caller is below Admin role.', content: jsonContent(ErrorResponse) },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});
