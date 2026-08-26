/** Zod request/response schemas and OpenAPI registration for upload routes. */
import { z, registerComponent, registerPath } from '../openapi/registry.js';

export const UploadRequestSchema = z.object({
  dataUrl: z.string().min(1),
  filename: z.string().min(1),
});

export const UploadFileHeadersSchema = z.object({
  'x-filename': z.string().optional(),
  'content-type': z.string().optional(),
});

const UploadResponse = registerComponent(
  'UploadResponse',
  z.object({
    id: z.string(),
    filename: z.string(),
    originalName: z.string(),
    contentType: z.string(),
    url: z.string().openapi({ description: 'Stable server-relative `/uploads/<filename>` ref.' }),
  }),
);

const UploadError = registerComponent('UploadErrorResponse', z.object({ error: z.string() }));

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

registerPath({
  method: 'post',
  path: '/api/upload',
  tags: ['Uploads'],
  summary: 'Upload a data-URL attachment',
  description:
    'Validates and stores a base64 data URL. AWS deployments use the configured artifact S3 bucket; local installs use the uploads directory. The returned `/uploads` ref is backend-independent.',
  request: { body: { content: { 'application/json': { schema: UploadRequestSchema } } } },
  responses: {
    200: { description: 'Attachment stored.', content: jsonContent(UploadResponse) },
    400: { description: 'Invalid or unsafe attachment.', content: jsonContent(UploadError) },
    500: { description: 'Storage write failed.', content: jsonContent(UploadError) },
  },
});

registerPath({
  method: 'post',
  path: '/api/upload/file',
  tags: ['Uploads'],
  summary: 'Upload a raw binary attachment',
  description:
    'Stores a raw attachment body up to 100 MB. AWS deployments use the configured artifact S3 bucket; local installs use the uploads directory.',
  request: {
    headers: UploadFileHeadersSchema,
    body: {
      content: {
        'application/octet-stream': {
          schema: z.string().openapi({ format: 'binary', description: 'Raw attachment bytes.' }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Attachment stored.', content: jsonContent(UploadResponse) },
    400: {
      description: 'Empty, invalid, or unsafe attachment.',
      content: jsonContent(UploadError),
    },
    413: { description: 'Attachment exceeds 100 MB.', content: jsonContent(UploadError) },
    500: { description: 'Storage write failed.', content: jsonContent(UploadError) },
  },
});
