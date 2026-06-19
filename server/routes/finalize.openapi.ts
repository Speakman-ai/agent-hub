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
import { METRIC_NAMES } from '../finalize/metrics.js';

const FINALIZE_RUN_STATUSES = [
  'queued',
  'rebasing',
  'reviewing',
  'running',
  'dispatching',
  'pushing',
  'ready_to_push',
  'pushed',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
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

export const FinalizeRunStepComponent = registerComponent(
  'FinalizeRunStep',
  z
    .object({
      index: z.number().int(),
      name: z.string(),
      state: z.enum(['queued', 'running', 'passed', 'failed', 'skipped']),
      exitCode: z.number().int().nullable(),
      startedAt: z.number().int().nullable(),
      endedAt: z.number().int().nullable(),
    })
    .openapi({ description: 'One CI step row from a Finalize run.' }),
);

export const FinalizePhaseSummaryComponent = registerComponent(
  'FinalizePhaseSummary',
  z
    .object({
      run_id: z.string(),
      status: z.string(),
      mode: z.enum(['full', 'checks', 'review']),
      head_sha: z.string(),
      validated_head_sha: z.string().nullable(),
      ended_at: z.number().int().nullable(),
    })
    .openapi({
      description:
        'Done-state for one Finalize phase (checks or review). Resolved from the latest run that exercised that phase — either a phase-scoped run or a combined `full` run.',
    }),
);

export const LatestFinalizeRunResponseSchema = registerComponent(
  'LatestFinalizeRunForSessionResponse',
  z
    .object({
      run: FinalizeRunComponent.nullable().openapi({
        description: '`null` when the session has never triggered a Finalize run.',
      }),
      steps: z.array(FinalizeRunStepComponent).openapi({
        description: 'Persisted CI step states for the latest run; empty when no run.',
      }),
      currentHeadSha: z.string().nullable().openapi({
        description:
          "The session worktree's live `git rev-parse HEAD` at request time, or `null` when the worktree is missing or HEAD could not be resolved.",
      }),
      stale: z.boolean().openapi({
        description:
          "True when the latest run's `head_sha` no longer matches the worktree's current HEAD — i.e. the agent committed new work after this run finished, so the run's results predate the current code. Clients (and `finalize.sh latest`) should surface this and trigger a fresh run rather than acting on the stale results. Fail-safe `false` when HEAD cannot be resolved.",
      }),
      phases: z
        .object({
          checks: FinalizePhaseSummaryComponent.nullable(),
          review: FinalizePhaseSummaryComponent.nullable(),
        })
        .openapi({
          description:
            'Independent per-phase done-state powering the split "Run Tests" / "Reviewer" buttons. Each is `null` until that phase has run for the session.',
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

// ─── POST /api/projects/:projectId/cards/:cardId/finalize ─────────────

const StartFinalizeRunRequest = registerComponent(
  'StartFinalizeRunRequest',
  z
    .object({
      mode: z.enum(['full', 'checks', 'review']).optional().openapi({
        description:
          'Which phases to run. `full` (default — the one Finalize button) = rebase + reviewer + checks. `checks` / `review` are legacy single-phase modes retained for back-compat and automation; the UI only sends `full`. Folded into the idempotency key so historical single-phase rows keep their own keys.',
      }),
    })
    .openapi({
      description:
        'Optional `mode` selects which phases run (defaults to `full`). The rest of the run is keyed off the card, its linked session, and the resolved HEAD SHA.',
    }),
);

const StartFinalizeRunResponse = registerComponent(
  'StartFinalizeRunResponse',
  z
    .object({
      run_id: z.string().nullable().openapi({
        description:
          'The `finalize_runs.id` for this run. `null` only when the run started but the row was not visible within the synchronous poll window (the 202 fallback).',
      }),
      status: z.enum(FINALIZE_RUN_STATUSES).openapi({
        description: 'Status of the run at response time — `queued` for fresh starts.',
      }),
      reused: z.boolean().openapi({
        description:
          'True when the idempotency key matched an existing terminal row and that row was returned as-is.',
      }),
    })
    .openapi({ description: 'A new or reused Finalize run.' }),
);

const StartFinalizeRunPending = registerComponent(
  'StartFinalizeRunPending',
  z
    .object({
      ok: z.literal(true).openapi({
        description: 'Acknowledgement marker for the 202 fallback envelope.',
      }),
      run_id: z.null().openapi({
        description:
          'Always `null` on the 202 path — the row was not visible within the synchronous poll window. Clients fall back to the WS event stream or `GET /api/sessions/:sessionId/finalize-runs/latest` to discover the id.',
      }),
      status: z.literal('queued').openapi({
        description: 'Always `queued` on the 202 path.',
      }),
      message: z.string().openapi({
        description: 'Human-readable note explaining the fallback.',
      }),
    })
    .openapi({
      description:
        'Fallback envelope returned when the orchestrator fired but the row insert was not visible within ~300ms. Distinct shape from `StartFinalizeRunResponse` so OpenAPI clients can branch on it.',
    }),
);

const StartFinalizeRunInFlight = registerComponent(
  'StartFinalizeRunInFlight',
  z
    .object({
      error: z.literal('in_flight'),
      run_id: z.string(),
      status: z.enum(FINALIZE_RUN_STATUSES),
      message: z.string(),
    })
    .openapi({
      description:
        'Conflict envelope returned when a non-terminal Finalize run already exists for the same (project, branch, head_sha).',
    }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/cards/{cardId}/finalize',
  tags: ['Finalize'],
  summary: 'Start a Finalize Code Changes run for a card',
  description: [
    "Kicks off the Finalize pipeline against the card's linked session.",
    'Idempotent on (project, branch, head_sha) per §4 — clicking the button',
    'twice against the same HEAD returns the same row id.',
    '',
    'Returns 200 with the row id when the run was created (`reused: false`) or',
    'when an idempotency match returned a TERMINAL row (`reused: true`).',
    'Returns 409 when an idempotency match is non-terminal (a run is in flight).',
    '',
    'Requires session ownership — non-owners receive 404 to mask existence.',
  ].join('\n'),
  request: {
    params: z.object({
      projectId: z.string(),
      cardId: z.string(),
    }),
    body: { content: jsonContent(StartFinalizeRunRequest) },
  },
  responses: {
    200: {
      description: 'Run created or terminal row reused.',
      content: jsonContent(StartFinalizeRunResponse),
    },
    202: {
      description:
        'Run started but the row was not visible within the synchronous poll window — clients should fall back to the WS event stream. The 202 body uses a distinct envelope (`StartFinalizeRunPending`) from the 200 path so OpenAPI consumers can discriminate by `run_id: null`.',
      content: jsonContent(StartFinalizeRunPending),
    },
    400: errorResponse(
      'Missing session linkage, missing worktree, missing branch, or HEAD SHA could not be resolved.',
    ),
    404: errorResponse('Project or card not found, or caller does not own the session.'),
    409: {
      description: 'A non-terminal Finalize run already exists for this (branch, head_sha).',
      content: jsonContent(StartFinalizeRunInFlight),
    },
    410: errorResponse(
      'The request body included a `jobs` filter. Single-job Finalize runs were removed — Finalize always runs the full pipeline. Resend without `jobs`. Error code: `jobs_unsupported`.',
    ),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/sessions/{sessionId}/finalize',
  tags: ['Finalize'],
  summary: 'Start Finalize for a session (auto-creates kanban card)',
  description: [
    'Same pipeline as the card-scoped finalize trigger, but accepts a session id',
    'directly. When the session has no linked kanban card, one is created on the',
    'project board (In Progress column, titled from the session name) before the',
    'run starts.',
  ].join('\n'),
  request: {
    params: z.object({
      projectId: z.string(),
      sessionId: z.string(),
    }),
    body: { content: jsonContent(StartFinalizeRunRequest) },
  },
  responses: {
    200: {
      description: 'Run created or terminal row reused. Includes `card_id` and `card_created`.',
      content: jsonContent(
        StartFinalizeRunResponse.extend({
          card_id: z.string(),
          card_created: z.boolean(),
        }),
      ),
    },
    202: {
      description: 'Run started but row not yet visible.',
      content: jsonContent(
        StartFinalizeRunPending.extend({
          card_id: z.string(),
          card_created: z.boolean(),
        }),
      ),
    },
    400: errorResponse('Missing worktree, branch, or HEAD SHA.'),
    404: errorResponse('Project or session not found, or caller does not own the session.'),
    409: {
      description: 'A non-terminal Finalize run already exists for this (branch, head_sha).',
      content: jsonContent(StartFinalizeRunInFlight),
    },
    410: errorResponse(
      'The request body included a `jobs` filter. Single-job Finalize runs were removed — Finalize always runs the full pipeline. Resend without `jobs`. Error code: `jobs_unsupported`.',
    ),
  },
});

// ─── POST /api/projects/:projectId/finalize/:runId/cancel ──────────────

const CancelFinalizeRunRequest = registerComponent(
  'CancelFinalizeRunRequest',
  z.object({}).openapi({ description: 'Body is empty.' }),
);

const PushFinalizeRunRequest = registerComponent(
  'PushFinalizeRunRequest',
  z
    .object({
      force: z.boolean().optional().openapi({
        description: 'Operator override — push even when gates have not passed.',
      }),
    })
    .openapi({ description: 'Optional push overrides.' }),
);

const FinalizeStepOutputLine = registerComponent(
  'FinalizeStepOutputLine',
  z.object({
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
    created_at: z.string(),
  }),
);

const FinalizeStepOutputResponse = registerComponent(
  'FinalizeStepOutputResponse',
  z.object({
    run_id: z.string(),
    step_index: z.number().int(),
    lines: z.array(FinalizeStepOutputLine),
  }),
);

const CancelFinalizeRunResponse = registerComponent(
  'CancelFinalizeRunResponse',
  z
    .object({
      ok: z.literal(true),
      status: z.literal('cancelled'),
    })
    .openapi({ description: 'Cancellation confirmation.' }),
);

const CancelFinalizeRunTerminal = registerComponent(
  'CancelFinalizeRunTerminal',
  z
    .object({
      error: z.literal('terminal'),
      status: z.enum(FINALIZE_RUN_STATUSES),
      message: z.string(),
    })
    .openapi({
      description: 'Conflict envelope returned when the run is already in a terminal state.',
    }),
);

// ─── GET /api/projects/:projectId/finalize/metrics ──────────────────

// Single source of truth — imported directly from the metrics module so
// adding a new metric to the union can't silently drift the OpenAPI
// enum. `z.enum` requires a non-empty readonly tuple, so we re-cast the
// imported readonly array preserving its literal types.
const FINALIZE_METRIC_NAMES = METRIC_NAMES as unknown as readonly [
  (typeof METRIC_NAMES)[number],
  ...(typeof METRIC_NAMES)[number][],
];

const LabelMap = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const HistogramSummarySchema = registerComponent(
  'FinalizeMetricHistogramSummary',
  z
    .object({
      count: z.number().int(),
      min: z.number().nullable(),
      max: z.number().nullable(),
      avg: z.number().nullable(),
      p50: z.number().nullable(),
      p95: z.number().nullable(),
      p99: z.number().nullable(),
    })
    .openapi({
      description:
        'Standard summary for histogram-class metrics. Quantiles use linear interpolation (Type 7). `null` fields signal zero samples in the window.',
    }),
);

const CounterAggregateSchema = registerComponent(
  'FinalizeMetricCounterAggregate',
  z
    .object({
      metric: z.enum(FINALIZE_METRIC_NAMES),
      kind: z.literal('counter'),
      count: z.number().int(),
      groups: z.array(
        z.object({
          labels: LabelMap,
          count: z.number().int(),
        }),
      ),
    })
    .openapi({
      description:
        'Counter aggregate: total `count` of rows in the window plus a breakdown per distinct label combination.',
    }),
);

const HistogramAggregateSchema = registerComponent(
  'FinalizeMetricHistogramAggregate',
  z
    .object({
      metric: z.enum(FINALIZE_METRIC_NAMES),
      kind: z.literal('histogram'),
      summary: HistogramSummarySchema,
      groups: z.array(
        z.object({
          labels: LabelMap,
          summary: HistogramSummarySchema,
        }),
      ),
    })
    .openapi({
      description:
        'Histogram aggregate: summary across all rows in the window plus a per-label-combination breakdown.',
    }),
);

const MetricsResponseSchema = registerComponent(
  'FinalizeMetricsResponse',
  z
    .object({
      project_id: z.string(),
      range: z.object({
        from_ms: z.number().int(),
        to_ms: z.number().int(),
        from_iso: z.string(),
        to_iso: z.string(),
      }),
      sample_count: z.number().int().openapi({
        description: 'Number of metric event rows the read query touched.',
      }),
      metrics: z.array(z.union([CounterAggregateSchema, HistogramAggregateSchema])),
    })
    .openapi({
      description:
        'Aggregated adoption metrics for the requested time window. Counter and histogram metrics share the same `metrics` array; clients discriminate via the `kind` field.',
    }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/metrics',
  tags: ['Finalize'],
  summary: 'Aggregated Finalize adoption metrics for a project',
  description: [
    'Counters and histogram summaries over the requested time window.',
    'See wiki `finalize-code-changes-architecture-v0` §14 for the metric',
    'vocabulary. No dashboard at v0 — the endpoint plus ad-hoc SQL is the',
    'dogfood-window read surface.',
    '',
    'Range syntax: `<N><m|h|d>` for a relative window ending now (e.g. `24h`,',
    '`7d`), or `<isoFrom>..<isoTo>` for an explicit half-open `[from, to)`',
    'interval (the `..` separator avoids collision with ISO8601 colons).',
    'Defaults to the last 24 hours.',
    '',
    'Optional `metrics=...` filter accepts a comma-separated subset of metric',
    'names. Unknown names are silently dropped; every requested known name',
    'is present in the response, even when zero rows landed.',
  ].join('\n'),
  request: {
    params: z.object({
      projectId: z.string(),
    }),
    query: z.object({
      range: z.string().optional().openapi({ description: 'Time window. See description.' }),
      metrics: z
        .string()
        .optional()
        .openapi({
          description: `Comma-separated subset: ${FINALIZE_METRIC_NAMES.join(', ')}.`,
        }),
    }),
  },
  responses: {
    200: {
      description: 'Aggregated metrics for the window.',
      content: jsonContent(MetricsResponseSchema),
    },
    400: errorResponse('Range or metrics filter could not be parsed.'),
    404: errorResponse('Project not found.'),
  },
});

const JobResourcesResponseSchema = registerComponent(
  'FinalizeJobResourcesResponse',
  z
    .object({
      project_id: z.string(),
      run_id: z.string(),
      jobs: z.array(
        z.object({
          job_name: z.string(),
          matrix_key: z.string(),
          peak_mem_bytes: z.number().nullable(),
          mem_total_bytes: z.number().nullable(),
          peak_cpu_percent: z.number().nullable(),
          observed_at: z.number(),
        }),
      ),
    })
    .openapi({
      description:
        'Per-CI-job resource high-water marks (peak host memory + peak CPU) for one Finalize run, reported by the runner at job end. One entry per (job_name, matrix_key).',
    }),
);

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/{runId}/job-resources',
  tags: ['Finalize'],
  summary: 'Per-job resource usage for a Finalize run',
  description:
    'Peak host memory and peak CPU each CI job reached during the run. One job per host on the fleet, so host memory == job memory. Empty `jobs` when no runner reported a summary (e.g. Hub-local runs or older runs).',
  request: {
    params: z.object({ projectId: z.string(), runId: z.string() }),
  },
  responses: {
    200: {
      description: 'Per-job resource high-water marks.',
      content: jsonContent(JobResourcesResponseSchema),
    },
    404: errorResponse('Project not found.'),
    500: errorResponse('Resource rows could not be read.'),
  },
});

const FinalizeShipGateResponseSchema = registerComponent(
  'FinalizeShipGateResponse',
  z
    .object({
      allowed: z.boolean(),
      code: z.string(),
      message: z.string(),
      run_id: z.string().nullable().optional(),
      failure_reason: z.string().nullable().optional(),
    })
    .openapi({
      description:
        'Whether `gh pr create` is permitted for this session. Projects with `.agent-hub/ci.yaml` must ship via Finalize.',
    }),
);

registerPath({
  method: 'get',
  path: '/api/sessions/{sessionId}/finalize-ship-gate',
  tags: ['Finalize'],
  summary: 'Check whether direct PR creation is allowed',
  description:
    'Returns whether spawned agents may run `gh pr create` for this session. Blocked when Finalize is configured and the run has not completed successfully.',
  request: {
    params: z.object({ sessionId: z.string() }),
  },
  responses: {
    200: {
      description: 'Ship-gate decision.',
      content: jsonContent(FinalizeShipGateResponseSchema),
    },
    404: errorResponse('Session not found or not readable.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/sessions/{sessionId}/finalize',
  tags: ['Finalize'],
  summary: 'Start Finalize for a session (auto-creates kanban card)',
  description: [
    'Same pipeline as the card-scoped finalize trigger, but accepts a session id',
    'directly. When the session has no linked kanban card, one is created on the',
    'project board (In Progress column, titled from the session name) before the',
    'run starts.',
  ].join('\n'),
  request: {
    params: z.object({
      projectId: z.string(),
      sessionId: z.string(),
    }),
    body: { content: jsonContent(StartFinalizeRunRequest) },
  },
  responses: {
    200: {
      description: 'Run created or terminal row reused. Includes `card_id` and `card_created`.',
      content: jsonContent(
        StartFinalizeRunResponse.extend({
          card_id: z.string(),
          card_created: z.boolean(),
        }),
      ),
    },
    202: {
      description: 'Run started but row not yet visible.',
      content: jsonContent(
        StartFinalizeRunPending.extend({
          card_id: z.string(),
          card_created: z.boolean(),
        }),
      ),
    },
    400: errorResponse('Missing worktree, branch, or HEAD SHA.'),
    404: errorResponse('Project or session not found, or caller does not own the session.'),
    409: {
      description: 'A non-terminal Finalize run already exists for this (branch, head_sha).',
      content: jsonContent(StartFinalizeRunInFlight),
    },
    410: errorResponse(
      'The request body included a `jobs` filter. Single-job Finalize runs were removed — Finalize always runs the full pipeline. Resend without `jobs`. Error code: `jobs_unsupported`.',
    ),
  },
});

const PushFinalizeRunResponse = registerComponent(
  'PushFinalizeRunResponse',
  z
    .object({
      ok: z.literal(true),
      pr_url: z.string(),
      status: z.literal('pushed'),
    })
    .openapi({ description: 'Push + PR creation succeeded.' }),
);

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/{runId}/push',
  tags: ['Finalize'],
  summary: 'Push to GitHub after checks pass',
  description:
    'Runs git push + gh pr create for a `ready_to_push` finalize run. Requires an explicit operator click — Finalize itself does not push.',
  request: {
    params: z.object({ projectId: z.string(), runId: z.string() }),
    body: { content: jsonContent(PushFinalizeRunRequest) },
  },
  responses: {
    200: {
      description: 'PR opened.',
      content: jsonContent(PushFinalizeRunResponse),
    },
    404: errorResponse('Project, run, or session not found.'),
    409: errorResponse(
      'Run is not ready_to_push (unless force=true), or HEAD moved since checks passed.',
    ),
    502: errorResponse('GitHub push or PR creation failed.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/finalize/{runId}/steps/{stepIndex}/output',
  tags: ['Finalize'],
  summary: 'CI step output log',
  description: 'Returns streamed stdout/stderr lines captured for one finalize CI step.',
  request: {
    params: z.object({
      projectId: z.string(),
      runId: z.string(),
      stepIndex: z.coerce.number().int().min(1),
    }),
  },
  responses: {
    200: {
      description: 'Step log lines.',
      content: jsonContent(FinalizeStepOutputResponse),
    },
    404: errorResponse('Project or run not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/sessions/{sessionId}/push-to-github',
  tags: ['Finalize'],
  summary: 'Push session work to GitHub',
  description:
    'Operator-initiated push for a session worktree. Uses the latest finalize run when ready; `force: true` bypasses gate checks.',
  request: {
    params: z.object({ projectId: z.string(), sessionId: z.string() }),
    body: { content: jsonContent(PushFinalizeRunRequest) },
  },
  responses: {
    200: {
      description: 'PR opened.',
      content: jsonContent(PushFinalizeRunResponse),
    },
    404: errorResponse('Project or session not found.'),
    409: errorResponse('Finalize checks have not passed (confirm with force=true).'),
    502: errorResponse('GitHub push or PR creation failed.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/{runId}/cancel',
  tags: ['Finalize'],
  summary: 'Cancel an in-flight Finalize run',
  description: [
    'Flips the row to `cancelled` and broadcasts `finalize_run_phase_changed`',
    "and `finalize_run_completed`. Trips the orchestrator's in-process",
    '`CancelSignal` (via the run-abort registry) so the fix-dispatch loop and any',
    'in-flight reviewer turn stop instead of dispatching another fix, kills the',
    "originating session's agent turn, and broadcasts an `interrupted` event so",
    'the session falls idle and waits for user input. The UI subscribes to the',
    'broadcast pair.',
  ].join('\n'),
  request: {
    params: z.object({
      projectId: z.string(),
      runId: z.string(),
    }),
    body: { content: jsonContent(CancelFinalizeRunRequest) },
  },
  responses: {
    200: {
      description: 'Run was flipped to cancelled.',
      content: jsonContent(CancelFinalizeRunResponse),
    },
    404: errorResponse(
      'Project not found, run not found, run belongs to a different project, or caller does not own the linked session.',
    ),
    409: {
      description: 'Run is already terminal.',
      content: jsonContent(CancelFinalizeRunTerminal),
    },
  },
});
