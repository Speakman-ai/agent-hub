/**
 * Zod schemas + OpenAPI registrations for the finalize route group.
 *
 * Surface area at v0 is read-only: the side-panel UI inspects reviewer
 * threads tied to a finalize run, and the session view discovers its
 * most-recent run via a convenience lookup. There are no mutating
 * endpoints here — the orchestrator and the reviewer-dispatch helper
 * own every write to `finalize_runs` and `reviewer_threads`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';

const FINALIZE_RUN_STATUSES = [
  'queued',
  'rebasing',
  'reviewing',
  'running',
  'dispatching',
  'pushing',
  'pushed',
  'failed',
  'timed_out',
  'infra_error',
] as const;

const FINALIZE_RUN_PHASES = ['rebase', 'review', 'tasks', 'dispatching', 'push'] as const;

const TRIGGER_SOURCES = ['ui_button', 'agent_block'] as const;

const ReviewerVerdictEnum = z.enum(['approved', 'changes_requested']);

export const ReviewerThreadComponent = registerComponent(
  'ReviewerThread',
  z
    .object({
      id: z.string(),
      run_id: z.string(),
      file_path: z.string(),
      /** 1-indexed start line in the head revision of `file_path`; null for file-level notes. */
      line_start: z.number().int().nullable(),
      /** 1-indexed end line; equal to `line_start` for single-line notes; null when `line_start` is null. */
      line_end: z.number().int().nullable(),
      body: z.string(),
      author: z.string(),
      created_at: z.number().int(),
    })
    .openapi({
      description:
        'One diff-anchored finding produced by the cold-eye reviewer agent during the review phase of a Finalize run.',
    }),
);

export const ReviewerThreadsResponseSchema = registerComponent(
  'ReviewerThreadsResponse',
  z
    .object({
      run_id: z.string(),
      reviewer_verdict: ReviewerVerdictEnum.nullable().openapi({
        description:
          'Reviewer verdict for the run (`approved` / `changes_requested`); `null` while the review phase is still pending.',
      }),
      threads: z.array(ReviewerThreadComponent),
    })
    .openapi({
      description:
        'All reviewer threads for a finalize run, ordered by `file_path ASC, line_start ASC, created_at ASC` so the side-panel can group by file without re-sorting.',
    }),
);

export const FinalizeRunComponent = registerComponent(
  'FinalizeRun',
  z
    .object({
      id: z.string(),
      card_id: z.string(),
      session_id: z.string().nullable(),
      project_id: z.string(),
      branch: z.string(),
      head_sha: z.string(),
      idempotency_key: z.string(),
      status: z.enum(FINALIZE_RUN_STATUSES),
      phase: z.enum(FINALIZE_RUN_PHASES).nullable(),
      trigger_source: z.enum(TRIGGER_SOURCES),
      worktree_path: z.string().nullable(),
      triggered_by_user_id: z.string(),
      author_name: z.string(),
      author_email: z.string(),
      reviewer_verdict: ReviewerVerdictEnum.nullable(),
      failure_reason: z.string().nullable(),
      failed_step_index: z.number().int().nullable(),
      failed_step_name: z.string().nullable(),
      failed_step_exit_code: z.number().int().nullable(),
      retry_of_run_id: z.string().nullable(),
      active_seconds_consumed: z.number().int(),
      started_at: z.number().int(),
      ended_at: z.number().int().nullable(),
      pr_url: z.string().nullable(),
    })
    .openapi({ description: 'A single finalize_runs row.' }),
);

export const LatestFinalizeRunResponseSchema = registerComponent(
  'LatestFinalizeRunForSessionResponse',
  z
    .object({
      run: FinalizeRunComponent.nullable().openapi({
        description: '`null` when the session has never triggered a Finalize run.',
      }),
    })
    .openapi({ description: 'Latest Finalize run for a given session.' }),
);

const ErrorResponse = registerComponent(
  'FinalizeErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope for finalize routes.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/{runId}/reviewer-threads',
  tags: ['Finalize'],
  summary: 'List reviewer threads for a Finalize run',
  description:
    'Returns every diff-anchored reviewer thread tied to the run, plus the run-level verdict. Read-only at v0 — replies happen in the originating session, not on the threads themselves.',
  request: {
    params: z.object({
      projectId: z.string().openapi({ description: 'Project slug or id.' }),
      runId: z.string().openapi({ description: 'finalize_runs.id.' }),
    }),
  },
  responses: {
    200: {
      description: 'Reviewer threads for the run.',
      content: jsonContent(ReviewerThreadsResponseSchema),
    },
    404: errorResponse('Project not found, or finalize run not found in this project.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/finalize-runs/latest',
  tags: ['Finalize'],
  summary: 'Most-recent Finalize run for a session',
  description:
    'Convenience lookup so the session-view side-panel can resolve a run id from a session id. Returns `{ run: null }` when the session has never triggered a Finalize run (never 404 — "no runs yet" is the normal first-load state).',
  request: {
    params: z.object({
      sessionId: z.string().openapi({ description: 'sessions.id.' }),
    }),
  },
  responses: {
    200: {
      description: 'Latest finalize_runs row for the session, or `null`.',
      content: jsonContent(LatestFinalizeRunResponseSchema),
    },
  },
});
