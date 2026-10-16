/**
 * Zod schemas + OpenAPI registrations for `server/routes/routines.ts`
 * (routines drafted from browser demo recordings).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorComponent = registerComponent(
  'RoutineErrorResponse',
  z
    .object({ error: z.string(), code: z.string().optional() })
    .openapi({ description: 'Error envelope for routine routes.' }),
);

export const RoutineDraftRequestSchema = z.object({
  artifactId: z
    .string({ error: 'artifactId is required' })
    .min(1, 'artifactId is required')
    .openapi({ description: 'Id of the browser demo recording artifact in this session.' }),
  goal: z
    .string()
    .max(500, 'goal must be at most 500 characters')
    .optional()
    .openapi({ description: 'Optional one-line description of the task, passed to the agent.' }),
});

const RoutineDraftComponent = registerComponent(
  'RoutineDraft',
  z
    .object({
      projectId: z.string(),
      agentId: z.string(),
      agentName: z.string(),
      artifactId: z.string(),
      steps: z.number().int().openapi({ description: 'Steps in the source recording.' }),
      engine: z.string(),
      model: z.string().nullable(),
      draft: z.object({
        name: z.string().openapi({ description: 'Suggested skill slug.' }),
        description: z.string(),
        body: z.string().openapi({ description: 'SKILL.md Markdown body (no frontmatter).' }),
      }),
    })
    .openapi({
      description:
        'A draft project skill the session agent wrote from the recording. Nothing is saved: the client saves it with `POST /api/projects/{projectId}/skills` and schedules it with `POST /api/crons` (`routine_skill`).',
    }),
);

registerPath({
  method: 'post',
  path: '/api/sessions/{sessionId}/routines/draft',
  tags: ['Routines'],
  summary: 'Draft a routine skill from a browser demo recording',
  description:
    'Reads a browser demo recording artifact from this session and asks the session agent (one model call, as the session owner) to draft a SKILL.md with steps and success checks. Masked recording input is never sent. Responds after the model answers, which can take a few minutes.',
  request: {
    params: z.object({ sessionId: z.string() }),
    body: { content: { 'application/json': { schema: RoutineDraftRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Draft ready for the human to edit.',
      content: { 'application/json': { schema: RoutineDraftComponent } },
    },
    400: {
      description: 'Bad body, not a recording, empty recording, or no engine available.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
    404: {
      description: 'Session or artifact not found / not owned by caller.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
    502: {
      description: 'The model call failed or returned an empty draft.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
    503: {
      description: 'Artifact storage is unavailable.',
      content: { 'application/json': { schema: ErrorComponent } },
    },
  },
});
