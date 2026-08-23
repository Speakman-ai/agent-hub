/**
 * Zod schemas + OpenAPI registrations for the session-artifacts route group
 * (server/routes/artifacts.ts).
 *
 * Imported by `server/openapi/generate.ts` (walks routes/) so the side-effect
 * `registerPath` calls land in docs/api/openapi.yaml. Artifacts are
 * agent-generated documents (PDFs, scripts, reports, …) stored in object
 * storage and surfaced in the session's Artifacts panel.
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const sessionIdParam = z.object({
  sessionId: z.string().openapi({ description: 'Session ID.' }),
});

const artifactIdParam = sessionIdParam.extend({
  artifactId: z.string().openapi({ description: 'Artifact ID.' }),
});

export const ArtifactComponent = registerComponent(
  'Artifact',
  z
    .object({
      id: z.string(),
      sessionId: z.string(),
      filename: z.string(),
      contentType: z.string(),
      size: z.number().int(),
      storageKind: z.enum(['local', 's3']),
      createdBy: z.string().nullable(),
      createdAt: z.string(),
      url: z.string().openapi({ description: 'Relative URL to download/view the artifact bytes.' }),
    })
    .openapi({ description: 'Metadata for one session artifact.' }),
);

const ArtifactListComponent = registerComponent(
  'ArtifactList',
  z.object({ artifacts: z.array(ArtifactComponent) }).openapi({
    description: 'All artifacts generated in a session, newest first.',
  }),
);

const ErrorComponent = registerComponent(
  'ArtifactErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorComponent),
});

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/artifacts',
  tags: ['Artifacts'],
  summary: 'List a session’s generated artifacts',
  description:
    'Returns metadata for every document an agent generated in this session, newest first. The bytes are fetched separately via the per-artifact content endpoint.',
  request: { params: sessionIdParam },
  responses: {
    200: { description: 'Artifact list.', content: jsonContent(ArtifactListComponent) },
    404: errorResponse('Session not found / not owned by caller.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/artifacts',
  tags: ['Artifacts'],
  summary: 'Upload an artifact to a session',
  description:
    'Stores a raw file body as a session artifact. Send the bytes as the request body with `Content-Type` set to the file’s MIME type and `x-filename` set to the display name. Agents can set `x-artifact-presentation: inline` for user-requested deliverables that should open automatically in the active session viewer. Used by agents (via the agent-hub artifact script) and the web UI. Rejects executables/native binaries and bodies over 100 MB.',
  request: {
    params: sessionIdParam,
    headers: z.object({
      'x-filename': z.string().optional().openapi({ description: 'Artifact display filename.' }),
      'x-agent-id': z.string().optional().openapi({ description: 'Creating agent ID.' }),
      'x-artifact-presentation': z.enum(['inline']).optional().openapi({
        description:
          'Requests automatic opening in the active session viewer after the upload completes.',
      }),
    }),
    body: {
      content: {
        'application/octet-stream': {
          schema: z.string().openapi({ format: 'binary', description: 'Raw file bytes.' }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Created artifact metadata.', content: jsonContent(ArtifactComponent) },
    400: errorResponse('Empty body or rejected content type.'),
    404: errorResponse('Session not found / not owned by caller.'),
    413: errorResponse('File exceeds the 100 MB limit.'),
    500: errorResponse('Storage write failed.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/artifacts/{artifactId}/content',
  tags: ['Artifacts'],
  summary: 'Download or view an artifact’s bytes',
  description:
    'Streams the artifact bytes with `X-Content-Type-Options: nosniff`. Inert types render inline by default; pass `?download=1` for an attachment disposition. Active/scriptable content (HTML, SVG, XML, JS) is always forced to download with a neutral `application/octet-stream` type so it cannot execute in the app origin. When the backend is S3 and `?redirect=1` is set (non-active content only), responds 302 to a short-lived presigned URL instead of proxying the bytes. The store is resolved from the artifact row’s recorded backend, so reads survive a later storage reconfiguration.',
  request: { params: artifactIdParam },
  responses: {
    200: { description: 'Artifact bytes.' },
    302: { description: 'Redirect to a presigned download URL (S3 backend, redirect=1).' },
    404: errorResponse('Session or artifact not found.'),
    500: errorResponse('Storage read failed.'),
    503: errorResponse('Artifact’s recorded storage backend is unavailable / unrecoverable.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/sessions/{sessionId}/artifacts/{artifactId}',
  tags: ['Artifacts'],
  summary: 'Delete an artifact',
  description:
    'Deletes the artifact bytes from object storage FIRST, then removes the metadata row. If the storage delete fails the request fails (502) and nothing is removed, so the bytes are never orphaned without a record to retry. Resolves the row’s recorded backend, so it works after a storage reconfiguration.',
  request: { params: artifactIdParam },
  responses: {
    200: {
      description: 'Deleted.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
    404: errorResponse('Session or artifact not found.'),
    502: errorResponse('Object-store deletion failed; nothing was removed (safe to retry).'),
    503: errorResponse('Artifact’s recorded storage backend is unavailable / unrecoverable.'),
  },
});
