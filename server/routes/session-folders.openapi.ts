/**
 * Zod schemas + OpenAPI registrations for per-user session folders
 * (`server/routes/session-folders.ts`).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { SESSION_FOLDER_NAME_MAX } from '../session-folders-store.js';

const ErrorResponse = registerComponent(
  'SessionFolderErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

const AgentIdParam = z.object({ agentId: z.string().openapi({ description: 'Agent id.' }) });
const FolderIdParam = z.object({
  folderId: z.string().openapi({ description: 'Session folder id.' }),
});
const SessionIdParam = z.object({
  sessionId: z.string().openapi({ description: 'Chat session id.' }),
});

export const SessionFolderSchema = registerComponent(
  'SessionFolder',
  z
    .object({
      id: z.string(),
      agentId: z.string(),
      name: z.string(),
      position: z.number().int(),
      createdAt: z.string(),
    })
    .openapi({ description: "A folder in the caller's sidebar list for one agent." }),
);

export const SessionFolderListingSchema = registerComponent(
  'SessionFolderListing',
  z
    .object({
      folders: z.array(SessionFolderSchema),
      assignments: z.record(z.string(), z.string()).openapi({
        description: 'Session id to folder id for the sessions the caller has filed.',
      }),
    })
    .openapi({ description: "The caller's folders for one agent and which sessions are in them." }),
);

const FolderName = z.string().trim().min(1).max(SESSION_FOLDER_NAME_MAX);

export const CreateSessionFolderRequestSchema = registerComponent(
  'CreateSessionFolderRequest',
  z.object({ name: FolderName }).strict(),
);

export const RenameSessionFolderRequestSchema = registerComponent(
  'RenameSessionFolderRequest',
  z.object({ name: FolderName }).strict(),
);

export const SetSessionFolderRequestSchema = registerComponent(
  'SetSessionFolderRequest',
  z
    .object({
      folderId: z
        .string()
        .nullable()
        .openapi({ description: 'Folder to file the session into, or null to unfile it.' }),
    })
    .strict(),
);

const errors = {
  400: { description: 'Invalid body.', content: { 'application/json': { schema: ErrorResponse } } },
  401: {
    description: 'Not authenticated.',
    content: { 'application/json': { schema: ErrorResponse } },
  },
  404: {
    description: 'Agent, folder, or session not found.',
    content: { 'application/json': { schema: ErrorResponse } },
  },
};

registerPath({
  method: 'get',
  path: '/api/agents/{agentId}/session-folders',
  tags: ['Sessions'],
  summary: "List the caller's session folders for an agent",
  request: { params: AgentIdParam },
  responses: {
    200: {
      description: 'Folders in display order plus session filing.',
      content: { 'application/json': { schema: SessionFolderListingSchema } },
    },
    401: errors[401],
    404: errors[404],
  },
});

registerPath({
  method: 'post',
  path: '/api/agents/{agentId}/session-folders',
  tags: ['Sessions'],
  summary: 'Create a session folder',
  request: {
    params: AgentIdParam,
    body: { content: { 'application/json': { schema: CreateSessionFolderRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Folder created at the end of the list.',
      content: { 'application/json': { schema: z.object({ folder: SessionFolderSchema }) } },
    },
    ...errors,
  },
});

registerPath({
  method: 'patch',
  path: '/api/session-folders/{folderId}',
  tags: ['Sessions'],
  summary: 'Rename a session folder',
  request: {
    params: FolderIdParam,
    body: { content: { 'application/json': { schema: RenameSessionFolderRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Renamed folder.',
      content: { 'application/json': { schema: z.object({ folder: SessionFolderSchema }) } },
    },
    ...errors,
  },
});

registerPath({
  method: 'delete',
  path: '/api/session-folders/{folderId}',
  tags: ['Sessions'],
  summary: 'Delete a session folder',
  description: 'Sessions in the folder are kept and return to the unfiled list.',
  request: { params: FolderIdParam },
  responses: {
    200: {
      description: 'Folder deleted.',
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
    },
    401: errors[401],
    404: errors[404],
  },
});

registerPath({
  method: 'put',
  path: '/api/sessions/{sessionId}/folder',
  tags: ['Sessions'],
  summary: 'Move a session into a folder or out of one',
  description: "Filing is per user. The folder must belong to the caller and the session's agent.",
  request: {
    params: SessionIdParam,
    body: { content: { 'application/json': { schema: SetSessionFolderRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Session filing after the change.',
      content: {
        'application/json': {
          schema: z.object({ sessionId: z.string(), folderId: z.string().nullable() }),
        },
      },
    },
    ...errors,
  },
});
