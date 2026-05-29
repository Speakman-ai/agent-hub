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

// ─── POST /api/projects/:projectId/cards/:cardId/finalize ─────────────

const StartFinalizeRunRequest = registerComponent(
  'StartFinalizeRunRequest',
  z.object({}).openapi({
    description:
      'Body is empty — the run is keyed entirely off the card, its linked session, and the resolved HEAD SHA.',
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
  },
});

// ─── POST /api/projects/:projectId/finalize/:runId/cancel ──────────────

const CancelFinalizeRunRequest = registerComponent(
  'CancelFinalizeRunRequest',
  z.object({}).openapi({ description: 'Body is empty.' }),
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

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/finalize/{runId}/cancel',
  tags: ['Finalize'],
  summary: 'Cancel an in-flight Finalize run',
  description: [
    'Flips the row to `cancelled` and broadcasts `finalize_run_phase_changed`',
    "and `finalize_run_completed`. v0 is UI-only: the orchestrator's in-process",
    '`CancelSignal` is NOT plumbed across requests, so an attempt already in flight',
    'continues until it next checks for cancellation; its DB writes will land on',
    'a row that is already terminal. The UI subscribes to the broadcast pair.',
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
