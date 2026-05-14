/**
 * Zod schemas + OpenAPI registrations for the per-project notes route group.
 *
 * Notes are short, FTS-searchable markdown documents distinct from wiki
 * pages and daily memory notes. CRUD lives in `server/notes.ts`; routes
 * here just plumb through.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'NotesErrorResponse',
  z
    .object({
      error: z.string(),
      details: z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          }),
        )
        .optional(),
    })
    .openapi({ description: 'Error envelope for notes routes.' }),
);

export const NoteComponent = registerComponent(
  'Note',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      title: z.string(),
      content: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({ description: 'A single project note row.' }),
);

export const CreateNoteRequestSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  content: z.string().optional(),
});

export const UpdateNoteRequestSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
});

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug or id.' }),
});

const projectAndNoteParams = z.object({
  projectId: z.string(),
  noteId: z.string(),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/notes',
  tags: ['Notes'],
  summary: 'List notes (or FTS search) for a project',
  request: {
    params: projectIdParams,
    query: z.object({
      q: z.string().optional().openapi({ description: 'FTS search query.' }),
      limit: z
        .string()
        .optional()
        .openapi({ description: 'Max results when searching (default 20).' }),
    }),
  },
  responses: {
    200: { description: 'Note rows.', content: jsonContent(z.array(NoteComponent)) },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/notes/{noteId}',
  tags: ['Notes'],
  summary: 'Read a single note',
  request: { params: projectAndNoteParams },
  responses: {
    200: { description: 'Note row.', content: jsonContent(NoteComponent) },
    404: errorResponse('Note not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/notes',
  tags: ['Notes'],
  summary: 'Create a note',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateNoteRequestSchema) },
  },
  responses: {
    201: { description: 'Created note.', content: jsonContent(NoteComponent) },
    400: errorResponse('Title is required.'),
    404: errorResponse('Project not found.'),
    409: errorResponse('Slug collision or constraint violation.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/notes/{noteId}',
  tags: ['Notes'],
  summary: 'Update a note',
  request: {
    params: projectAndNoteParams,
    body: { content: jsonContent(UpdateNoteRequestSchema) },
  },
  responses: {
    200: { description: 'Updated note.', content: jsonContent(NoteComponent) },
    404: errorResponse('Note not found.'),
    500: errorResponse('Update failed.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/notes/{noteId}',
  tags: ['Notes'],
  summary: 'Delete a note',
  request: { params: projectAndNoteParams },
  responses: {
    200: {
      description: 'Deleted.',
      content: jsonContent(z.object({ ok: z.boolean() })),
    },
    404: errorResponse('Note not found.'),
  },
});
