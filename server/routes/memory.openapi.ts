/**
 * Zod schemas + OpenAPI registrations for memory + note-processing routes.
 *
 * Daily notes (under `<projectAhw>/memory/<date>.md`) can be processed
 * by a docs agent into wiki pages, MEMORY.md updates, or kanban cards.
 * `/api/memory/reconcile` is a manual trigger for the wiki↔memory sync
 * heartbeat.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'MemoryErrorResponse',
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
    .openapi({ description: 'Error envelope for memory routes.' }),
);

const NoteTarget = z.enum(['auto', 'wiki', 'memory', 'plan']);

export const NoteProcessingComponent = registerComponent(
  'NoteProcessing',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      date: z.string(),
      excerpt: z.string(),
      target: NoteTarget,
      session_id: z.string(),
      status: z.enum(['queued', 'running', 'success', 'error']).or(z.string()),
      result: z.string().nullable().optional(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
    })
    .passthrough()
    .openapi({ description: 'A single note-processing run row.' }),
);

export const ProcessNoteRequestSchema = z.object({
  target: NoteTarget.optional().openapi({
    description: 'Where to write the extracted knowledge. Defaults to `auto`.',
  }),
  excerpt: z.string().optional().openapi({
    description:
      'Override the note content with an explicit excerpt (used when the user has already trimmed the note).',
  }),
});

const projectAndDateParams = z.object({
  projectId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format. Use YYYY-MM-DD.'),
});

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project slug or id.' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'post',
  path: '/api/memory/reconcile',
  tags: ['Memory'],
  summary: 'Manually trigger the wiki ↔ memory reconciliation sweep',
  responses: {
    200: {
      description: 'Sweep started (runs async).',
      content: jsonContent(z.object({ status: z.literal('running') })),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/notes/{date}/process',
  tags: ['Memory'],
  summary: "Hand a daily note to the project's docs agent for processing",
  description:
    "Spawns a session for the project's docs agent with a target-specific prompt. The session id is included in the response so callers can stream the result.",
  request: {
    params: projectAndDateParams,
    body: { content: jsonContent(ProcessNoteRequestSchema) },
  },
  responses: {
    201: { description: 'Processing row created.', content: jsonContent(NoteProcessingComponent) },
    400: errorResponse('Invalid date or target, or empty note.'),
    404: errorResponse('Project / note / docs agent not found.'),
    500: errorResponse('Failed to read note from disk.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/notes/processings',
  tags: ['Memory'],
  summary: 'List recent note-processing runs for a project',
  request: {
    params: projectIdParams,
    query: z.object({
      limit: z.string().optional().openapi({ description: 'Max rows (default 50, cap 200).' }),
    }),
  },
  responses: {
    200: {
      description: 'Processing rows.',
      content: jsonContent(z.array(NoteProcessingComponent)),
    },
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/notes/{date}/processings',
  tags: ['Memory'],
  summary: 'List processing runs for a specific daily note',
  request: { params: projectAndDateParams },
  responses: {
    200: {
      description: 'Processing rows.',
      content: jsonContent(z.array(NoteProcessingComponent)),
    },
    400: errorResponse('Invalid date format.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/notes/processings/{processingId}',
  tags: ['Memory'],
  summary: 'Read a single note-processing run',
  request: {
    params: z.object({ projectId: z.string(), processingId: z.string() }),
  },
  responses: {
    200: { description: 'Processing row.', content: jsonContent(NoteProcessingComponent) },
    404: errorResponse('Processing not found.'),
  },
});
