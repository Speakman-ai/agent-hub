/**
 * Zod schemas + OpenAPI registrations for the hooks route group.
 *
 * Currently a single endpoint — `POST /api/hooks/stop` — invoked by the
 * Claude Code CLI when a session ends. Auto-commit / `changes_ready`
 * runs from `chat.ts` proc.on('close'); this hook is informational only.
 *
 * Imported from `server/routes/hooks.ts` for body validation; also
 * loaded by `server/openapi/generate.ts` to populate the spec.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'HooksErrorResponse',
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
    .openapi({ description: 'Error envelope for hook routes.' }),
);

export const HookStopRequestSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

const StopResponse = z
  .object({
    ok: z.boolean(),
    sessionId: z.string(),
  })
  .openapi({ description: 'Acknowledgment that the stop hook was received.' });

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

registerPath({
  method: 'post',
  path: '/api/hooks/stop',
  tags: ['Hooks'],
  summary: 'CLI session-stop hook',
  description:
    'Invoked by the Claude Code CLI when a session ends. The actual auto-commit / changes_ready logic runs from `chat.ts` proc.on("close"); this endpoint exists for the CLI contract and is informational only.',
  request: { body: { content: jsonContent(HookStopRequestSchema) } },
  responses: {
    200: { description: 'Hook acknowledged.', content: jsonContent(StopResponse) },
    400: { description: 'Missing sessionId.', content: jsonContent(ErrorResponse) },
    404: { description: 'Session not found.', content: jsonContent(ErrorResponse) },
  },
});
