/**
 * Zod schemas + OpenAPI registrations for a session's "Run QA Tests"
 * (`server/routes/qa-session-runs.ts`).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { QA_SESSION_REQUEST_STATUSES } from '../qa-schema.js';

export const SetQaSessionRequestArmedSchema = z.object({
  armed: z.boolean().openapi({
    description:
      'true ticks "Run QA Tests": QA runs once the session merges. false unticks it while it is still waiting for the merge.',
  }),
});

const QaSessionRequestComponent = registerComponent(
  'QaSessionRequest',
  z
    .object({
      sessionId: z.string(),
      projectId: z.string(),
      status: z.enum(QA_SESSION_REQUEST_STATUSES),
      planId: z.string().nullable(),
      planTitle: z.string().nullable(),
      runId: z.string().nullable(),
      dueAt: z.string().nullable().openapi({
        description: 'When the run starts: merge time plus the project QA delay.',
      }),
      error: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({
      description:
        "A session's request to QA its work: armed until merge, then the QA agent drafts a plan from the session, the plan is approved, and it runs on the default QA environment.",
    }),
);

const StateResponse = z.object({
  request: QaSessionRequestComponent.nullable(),
  merged: z.boolean().openapi({
    description:
      "Whether the session's pull request merged: the native PR for Hub-hosted repos, or a github.com merge the Hub performed. A kanban card's column does not count.",
  }),
  defaultEnvironment: z
    .object({ id: z.string(), name: z.string(), baseUrl: z.string() })
    .nullable(),
  delayMinutes: z.number().int(),
  hasQaAgent: z.boolean(),
});

const ErrorResponse = z.object({ error: z.string(), code: z.string().optional() });
const json = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const err = (description: string) => ({ description, content: json(ErrorResponse) });
const params = z.object({ sessionId: z.string() });
const PATH = '/api/sessions/{sessionId}/qa-request';
const TAGS = ['QA'];

registerPath({
  method: 'get',
  path: PATH,
  tags: TAGS,
  summary: 'Read the session\'s "Run QA Tests" state',
  request: { params },
  responses: {
    200: { description: 'Current request and what it would use.', content: json(StateResponse) },
    404: err('Session not found.'),
  },
});

registerPath({
  method: 'put',
  path: PATH,
  tags: TAGS,
  summary: 'Tick or untick "Run QA Tests" before the session merges',
  request: { params, body: { content: json(SetQaSessionRequestArmedSchema) } },
  responses: {
    200: { description: 'Updated state.', content: json(StateResponse) },
    400: err('Validation failed.'),
    404: err('Session not found.'),
    409: err('No QA agent or no default QA environment with a base URL.'),
  },
});

registerPath({
  method: 'post',
  path: `${PATH}/run`,
  tags: TAGS,
  summary: 'Run QA tests for the session now',
  description:
    "Creates a plan from the session's context, lets the QA agent draft its cases, approves it, and runs it on the default QA environment once the project's delay after the merge has passed. Auto-rerun and auto-fix stay off.",
  request: { params },
  responses: {
    200: { description: 'Updated state.', content: json(StateResponse) },
    404: err('Session not found.'),
    409: err(
      'The session has not merged (`not_merged`), or no QA agent / default QA environment with a base URL.',
    ),
  },
});
