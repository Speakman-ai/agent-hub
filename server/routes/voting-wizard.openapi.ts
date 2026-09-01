/**
 * Zod schemas + OpenAPI registrations for the voting scaffolder spawn route.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { MAX_PAGE_NAME_HINT_LEN } from '../voting-integration/task-pack.js';

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = registerComponent(
  'VotingWizardErrorResponse',
  z.object({ error: z.string(), message: z.string().optional() }).openapi({
    description: 'Error envelope for the voting scaffolder spawn route.',
  }),
);

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

const ProjectIdParam = z.object({
  projectId: z.string().openapi({
    description: 'Target project slug. The session is spawned in this project workspace.',
  }),
});

const VotingWizardStartRequest = registerComponent(
  'VotingWizardStartRequest',
  z
    .object({
      agentId: z.string().min(1).openapi({
        description: 'Agent in the target project that will host the scaffolder session.',
      }),
      pageNameHint: z.string().max(MAX_PAGE_NAME_HINT_LEN).optional().openapi({
        description:
          'Optional page/route name hint (untrusted). Sanitized before it is interpolated into the task pack.',
      }),
    })
    .openapi({ description: 'Body for spawning a voting scaffolder session.' }),
);

const VotingWizardStartResponse = registerComponent(
  'VotingWizardStartResponse',
  z
    .object({
      sessionId: z.string().openapi({ description: 'Id of the spawned `[Voting Setup]` session.' }),
      agentId: z.string().openapi({ description: 'Agent the session was created on.' }),
      session: z
        .unknown()
        .openapi({ description: 'Raw `sessions` row for the spawned scaffolder session.' }),
    })
    .openapi({ description: 'Voting scaffolder session spawned successfully.' }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/voting/setup-wizard',
  tags: ['Support'],
  summary: 'Spawn a voting-integration scaffolder session',
  description: [
    'User+. Spawns a **worktree-backed** chat session named `[Voting Setup] <project>`',
    'on the chosen agent, seeded with the versioned voting integration task pack',
    'as the first user message. The agent inspects the target app, asks where the',
    'voting page should live, and generates a score-sorted list + up/down votes +',
    'anonymous comment thread wired to the public voting API of this project.',
  ].join('\n'),
  request: {
    params: ProjectIdParam,
    body: { content: jsonContent(VotingWizardStartRequest) },
  },
  responses: {
    201: {
      description: 'Scaffolder session spawned.',
      content: jsonContent(VotingWizardStartResponse),
    },
    400: errorResponse(
      'Missing agentId, agent not in this project, inactive or reviewer agent, or project has no cwd.',
    ),
    404: errorResponse('Project not found.'),
    500: errorResponse(
      'The seeded first turn was not accepted. The session row is deleted so a retry cannot leave an empty [Voting Setup] session.',
    ),
  },
});
