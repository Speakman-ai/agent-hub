/**
 * Zod schemas + OpenAPI registrations for the QA Validation surface
 * (`server/routes/qa.ts`). This companion owns the wire shape; lifecycle
 * rules live in `server/qa-status.ts`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import {
  QA_AUTO_RERUN_DELAY_MAX,
  QA_AUTO_RERUN_DELAY_MIN,
  QA_AUTO_RERUN_TRIGGERS,
  QA_PLAN_STATUSES,
  QA_RUN_SCOPES,
  QA_RUN_STATUSES,
  QA_VERDICTS,
} from '../qa-schema.js';

const AutoRerunTrigger = z.enum(QA_AUTO_RERUN_TRIGGERS).openapi({
  description:
    'What auto-rerun waits on once every finding card is Done: a successful deployment to deployEnvironment, a pull request merged into autoRerunBranch, or nothing more (fixes_merged: the finding cards reaching Done, which happens when their sessions, tickets, or epics merge). merge and fixes_merged then wait autoRerunDelayMinutes.',
});

const AutoRerunDelay = z
  .number()
  .int()
  .refine((n) => n === 0 || (n >= QA_AUTO_RERUN_DELAY_MIN && n <= QA_AUTO_RERUN_DELAY_MAX), {
    message: `autoRerunDelayMinutes must be 0 or ${QA_AUTO_RERUN_DELAY_MIN}-${QA_AUTO_RERUN_DELAY_MAX}`,
  });

const AutoRerunFields = {
  autoRerunTrigger: AutoRerunTrigger.optional(),
  autoRerunBranch: z.string().trim().min(1).nullable().optional(),
  autoRerunDelayMinutes: AutoRerunDelay.optional(),
};

const ErrorResponse = registerComponent(
  'QaErrorResponse',
  z
    .object({
      error: z.string(),
      code: z.string().optional().openapi({
        description:
          'Lifecycle error code from qa-status (e.g. not_approved, run_active, plan_done, not_all_pass, edit_conflict).',
      }),
      conflicts: z
        .array(z.enum(['title', 'steps', 'expected']))
        .optional()
        .openapi({
          description: 'edit_conflict only: fields that changed since they were edited.',
        }),
      case: z
        .object({ title: z.string(), steps: z.string(), expected: z.string() })
        .optional()
        .openapi({ description: 'edit_conflict only: the saved text of the case now.' }),
      details: z.array(z.object({ path: z.array(z.any()), message: z.string() })).optional(),
    })
    .openapi({ description: 'Error envelope for QA routes.' }),
);

const PlanStatus = z.enum(QA_PLAN_STATUSES);
const RunScope = z.enum(QA_RUN_SCOPES);
const RunStatus = z.enum(QA_RUN_STATUSES);
const Verdict = z.enum(QA_VERDICTS);

export const QaPlanComponent = registerComponent(
  'QaPlan',
  z
    .object({
      id: z.string(),
      projectId: z.string(),
      title: z.string(),
      goal: z.string(),
      targetUrl: z.string(),
      epicId: z.string().nullable(),
      cardId: z.string().nullable(),
      deployEnvironment: z.string().nullable().openapi({
        description:
          'Deployment environment the deployment trigger waits on. Null means an inbox notice instead of a rerun.',
      }),
      status: PlanStatus.openapi({
        description: 'Derived by the server: new (never run), in_progress, done (signed off).',
      }),
      approved: z.boolean(),
      approvedAt: z.string().nullable(),
      approvedBy: z.string().nullable(),
      approvalSeq: z.number().int(),
      signedOffAt: z.string().nullable(),
      signedOffBy: z.string().nullable(),
      autoRerun: z.boolean(),
      autoRerunTrigger: AutoRerunTrigger,
      autoRerunBranch: z.string().nullable().openapi({
        description:
          'Branch the merge trigger waits on. Null means an inbox notice instead of a rerun.',
      }),
      autoRerunDelayMinutes: z.number().int().openapi({
        description: 'Minutes the merge trigger waits after the merge before rerunning. 0 = none.',
      }),
      maxIterations: z.number().int(),
      createdBy: z.string().nullable(),
      authoringSessionId: z.string().nullable().openapi({
        description: 'QA session where the cases were drafted. Null until one is opened.',
      }),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .openapi({ description: 'A QA validation plan for one target.' }),
);

const LatestVerdict = z
  .object({
    verdict: Verdict,
    caseVersion: z.number().int(),
    current: z.boolean().openapi({
      description: 'False when the case was edited after this verdict was recorded.',
    }),
    runId: z.string(),
    iteration: z.number().int(),
  })
  .nullable();

export const QaCaseComponent = registerComponent(
  'QaCase',
  z.object({
    id: z.string(),
    planId: z.string(),
    position: z.number().int(),
    title: z.string(),
    steps: z.string(),
    expected: z.string(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    latestVerdict: LatestVerdict.optional().openapi({
      description: 'Newest non-cancelled verdict for this case. Present on plan detail only.',
    }),
  }),
);

export const QaRunComponent = registerComponent(
  'QaRun',
  z.object({
    id: z.string(),
    planId: z.string(),
    iteration: z.number().int(),
    scope: RunScope,
    status: RunStatus,
    approvalSeq: z.number().int(),
    caseIds: z.array(z.string()).openapi({
      description: 'Case ids in scope, fixed when the run is queued.',
    }),
    previewSessionId: z.string().nullable().openapi({
      description: 'Session whose preview the run drives, when the target is a session preview.',
    }),
    sessionId: z.string().nullable(),
    startedBy: z.string().nullable(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    createdAt: z.string(),
  }),
);

export const QaResultComponent = registerComponent(
  'QaResult',
  z.object({
    id: z.string(),
    runId: z.string(),
    caseId: z.string(),
    caseVersion: z.number().int(),
    verdict: Verdict,
    actual: z.string(),
    notes: z.string(),
    screenshotArtifactIds: z.array(z.string()).openapi({
      description:
        "Artifact ids uploaded by the run's session. Ids from any other session are refused (400, code `artifact_not_owned`).",
    }),
    screenshots: z
      .array(z.object({ id: z.string(), filename: z.string(), contentType: z.string() }))
      .openapi({
        description:
          "Metadata for screenshotArtifactIds still present in the run session's artifacts, in order. Open each through that session's artifact content route.",
      }),
    findingCardId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const nullableId = z.string().min(1).nullable().optional();

/** The QA agent drives the target in a browser, so only http(s) URLs make sense. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const TargetUrl = z
  .string()
  .trim()
  .refine(isHttpUrl, { message: 'targetUrl must be an http(s) URL' });

export const CreateQaPlanRequestSchema = z.object({
  title: z.string().trim().min(1, 'title is required'),
  targetUrl: TargetUrl,
  goal: z.string().optional(),
  epicId: nullableId,
  cardId: nullableId,
  deployEnvironment: z.string().min(1).nullable().optional(),
  autoRerun: z.boolean().optional(),
  ...AutoRerunFields,
  maxIterations: z.number().int().min(1).max(100).optional(),
});

export const UpdateQaPlanRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  targetUrl: TargetUrl.optional().openapi({
    description: 'Changing the target revokes approval and is refused while done or running.',
  }),
  goal: z.string().optional(),
  epicId: nullableId,
  cardId: nullableId,
  deployEnvironment: z.string().min(1).nullable().optional(),
  autoRerun: z.boolean().optional(),
  ...AutoRerunFields,
  maxIterations: z.number().int().min(1).max(100).optional(),
});

export const CreateQaCaseRequestSchema = z.object({
  title: z.string().trim().min(1, 'title is required'),
  steps: z.string().optional(),
  expected: z.string().optional(),
});

export const UpdateQaCaseRequestSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    steps: z.string().optional(),
    expected: z.string().optional(),
    expectedBase: z
      .object({
        title: z.string().optional(),
        steps: z.string().optional(),
        expected: z.string().optional(),
      })
      .optional()
      .openapi({
        description:
          'Optional precondition: the saved text each edited field was edited against. ' +
          'When a listed field has since changed to something other than the new value, the ' +
          'edit is refused with 409 `edit_conflict`, `conflicts`, and the current `case` text.',
      }),
  })
  .refine((v) => v.title !== undefined || v.steps !== undefined || v.expected !== undefined, {
    message: 'Provide at least one of title, steps, expected',
  });

export const ReorderQaCasesRequestSchema = z.object({
  orderedIds: z.array(z.string()).openapi({
    description: 'Every case id in the plan, once each, in the desired order.',
  }),
});

export const StartQaRunRequestSchema = z.object({
  scope: RunScope.optional().openapi({ description: 'Defaults to full.' }),
});

export const RecordQaResultRequestSchema = z.object({
  caseId: z.string().min(1, 'caseId is required'),
  verdict: Verdict,
  actual: z.string().optional(),
  notes: z.string().optional(),
  screenshotArtifactIds: z.array(z.string()).optional(),
  findingCardId: z.string().min(1).nullable().optional(),
});

export const ListQaPlansQuerySchema = z.object({
  status: PlanStatus.optional(),
});

const projectParams = z.object({ projectId: z.string() });
const planParams = projectParams.extend({ planId: z.string() });
const caseParams = planParams.extend({ caseId: z.string() });
const runParams = planParams.extend({ runId: z.string() });

const json = <T extends z.ZodTypeAny>(schema: T) => ({ 'application/json': { schema } });
const err = (description: string) => ({ description, content: json(ErrorResponse) });
const ok = <T extends z.ZodTypeAny>(description: string, schema: T) => ({
  description,
  content: json(schema),
});

const TAGS = ['QA'];
const BASE = '/api/projects/{projectId}/qa/plans';
const notFound = err('Project, plan, case, or run not found.');
const conflict = err('Refused by the plan or run lifecycle (see `code`).');
const invalid = err('Validation failed.');

const VerdictCounts = z.object({
  pass: z.number().int(),
  fail: z.number().int(),
  needs_change: z.number().int(),
  blocked: z.number().int(),
});

export const QaPlanListItemComponent = registerComponent(
  'QaPlanListItem',
  QaPlanComponent.extend({
    summary: z
      .object({
        caseCount: z.number().int(),
        latestRun: z
          .object({
            id: z.string(),
            iteration: z.number().int(),
            status: RunStatus,
            scope: RunScope,
            finishedAt: z.string().nullable(),
            verdicts: VerdictCounts.openapi({
              description: 'Result count per verdict recorded in this run.',
            }),
          })
          .nullable()
          .openapi({ description: 'Highest-iteration run, or null when the plan never ran.' }),
        epic: z.object({ id: z.string(), name: z.string() }).nullable(),
        card: z.object({ id: z.string(), title: z.string() }).nullable(),
      })
      .openapi({ description: 'List-row extras for the QA page.' }),
  }).openapi({ description: 'A QA plan as returned by the list endpoint.' }),
);

const PlanEnvelope = z.object({ plan: QaPlanComponent });
const AuthoringSessionResponse = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  created: z.boolean(),
});
const RunEnvelope = z.object({ run: QaRunComponent });

registerPath({
  method: 'get',
  path: BASE,
  tags: TAGS,
  summary: "List the project's QA plans",
  request: { params: projectParams, query: ListQaPlansQuerySchema },
  responses: {
    200: ok(
      'Plans (newest first) plus per-status counts across the whole project.',
      z.object({
        plans: z.array(QaPlanListItemComponent),
        counts: z.object({ new: z.number(), in_progress: z.number(), done: z.number() }),
      }),
    ),
    400: invalid,
    404: notFound,
  },
});

registerPath({
  method: 'post',
  path: BASE,
  tags: TAGS,
  summary: 'Create a draft QA plan',
  request: { params: projectParams, body: { content: json(CreateQaPlanRequestSchema) } },
  responses: { 201: ok('Created plan.', PlanEnvelope), 400: invalid, 404: notFound },
});

registerPath({
  method: 'get',
  path: `${BASE}/{planId}`,
  tags: TAGS,
  summary: 'Get a QA plan with cases, latest verdicts, and runs',
  request: { params: planParams },
  responses: {
    200: ok(
      'Plan detail.',
      z.object({
        plan: QaPlanComponent,
        links: z
          .object({
            epic: z.object({ id: z.string(), name: z.string() }).nullable(),
            card: z.object({ id: z.string(), title: z.string() }).nullable(),
          })
          .openapi({ description: 'Linked epic / card names, null when unlinked or gone.' }),
        cases: z.array(QaCaseComponent),
        runs: z
          .array(
            QaRunComponent.extend({
              sessionAgentId: z.string().nullable().openapi({
                description: 'Agent that owns the run session, null before a session exists.',
              }),
              results: z.array(QaResultComponent).openapi({
                description: 'Results recorded in this run, one per case.',
              }),
            }),
          )
          .openapi({ description: 'Newest iteration first.' }),
        signOffBlocker: z.string().nullable().openapi({
          description: 'Why the plan cannot be signed off, or null when it can.',
        }),
        autoRerun: z
          .object({
            kind: z.string().openapi({
              description:
                'wait_fixes, wait_deploy, wait_merge, wait_delay, notify_manual, cap_reached, rerun, or rerun_failed.',
            }),
            message: z.string(),
          })
          .nullable()
          .openapi({
            description:
              'Where the auto-rerun loop stands after a failed run, or null when auto-rerun is off or has nothing pending.',
          }),
      }),
    ),
    404: notFound,
  },
});

registerPath({
  method: 'patch',
  path: `${BASE}/{planId}`,
  tags: TAGS,
  summary: 'Update a QA plan',
  request: { params: planParams, body: { content: json(UpdateQaPlanRequestSchema) } },
  responses: {
    200: ok('Updated plan.', PlanEnvelope),
    400: invalid,
    404: notFound,
    409: conflict,
  },
});

registerPath({
  method: 'delete',
  path: `${BASE}/{planId}`,
  tags: TAGS,
  summary: 'Delete a QA plan and its history',
  request: { params: planParams },
  responses: {
    200: ok('Deleted.', z.object({ ok: z.boolean() })),
    404: notFound,
    409: err('A run is queued or running.'),
  },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/cases`,
  tags: TAGS,
  summary: 'Append a case (revokes approval)',
  request: { params: planParams, body: { content: json(CreateQaCaseRequestSchema) } },
  responses: {
    201: ok(
      'Created case and the updated plan.',
      z.object({ case: QaCaseComponent, plan: QaPlanComponent }),
    ),
    400: invalid,
    404: notFound,
    409: conflict,
  },
});

registerPath({
  method: 'patch',
  path: `${BASE}/{planId}/cases/{caseId}`,
  tags: TAGS,
  summary: 'Edit a case (bumps its version, revokes approval)',
  request: { params: caseParams, body: { content: json(UpdateQaCaseRequestSchema) } },
  responses: {
    200: ok('Updated case and plan.', z.object({ case: QaCaseComponent, plan: QaPlanComponent })),
    400: invalid,
    404: notFound,
    409: conflict,
  },
});

registerPath({
  method: 'delete',
  path: `${BASE}/{planId}/cases/{caseId}`,
  tags: TAGS,
  summary: 'Remove a case (revokes approval)',
  request: { params: caseParams },
  responses: {
    200: ok(
      'Deleted; returns the updated plan.',
      z.object({ ok: z.boolean(), plan: QaPlanComponent }),
    ),
    404: notFound,
    409: conflict,
  },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/cases/reorder`,
  tags: TAGS,
  summary: 'Reorder the case list (keeps approval)',
  request: { params: planParams, body: { content: json(ReorderQaCasesRequestSchema) } },
  responses: {
    200: ok('Cases in their new order.', z.object({ cases: z.array(QaCaseComponent) })),
    400: err('orderedIds does not list every case exactly once.'),
    404: notFound,
    409: conflict,
  },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/approve`,
  tags: TAGS,
  summary: 'Approve the case list',
  request: { params: planParams },
  responses: { 200: ok('Approved plan.', PlanEnvelope), 404: notFound, 409: conflict },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/authoring-session`,
  tags: TAGS,
  summary: "Open the plan's authoring session with the project's QA agent",
  description:
    'The first call creates a QA-mode session seeded with the plan id, target URL, goal, and the ' +
    'linked epic / card descriptions, and records it on the plan. Later calls return that session ' +
    'while it is live (200, `created: false`).',
  request: { params: planParams },
  responses: {
    200: ok('Existing authoring session.', AuthoringSessionResponse),
    201: ok('New seeded authoring session.', AuthoringSessionResponse),
    404: notFound,
    409: err('The project has no QA agent (`code: no_qa_agent`).'),
    502: err('The seeded first turn was not accepted.'),
  },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/revoke-approval`,
  tags: TAGS,
  summary: 'Return the plan to draft',
  request: { params: planParams },
  responses: { 200: ok('Draft plan.', PlanEnvelope), 404: notFound, 409: conflict },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/sign-off`,
  tags: TAGS,
  summary: 'Human sign-off: moves an all-pass plan to done',
  request: { params: planParams },
  responses: { 200: ok('Signed-off plan.', PlanEnvelope), 404: notFound, 409: conflict },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/runs`,
  tags: TAGS,
  summary: 'Start a run in a new QA agent session',
  description:
    'Queues the run, opens a QA session seeded with the in-scope cases, target URL, and the tool to drive it with (`preview` for loopback, private, or session-preview targets, `browser` otherwise), and marks it running. 409 when unapproved, a run is active, the project has no QA agent (`no_qa_agent`), a preview-routed target is not served by a session preview in this project (`target_unreachable`), or a failed_only run has nothing to rerun (`nothing_to_rerun`). If the session cannot start, the run is cancelled and the route answers 502.',
  request: { params: planParams, body: { content: json(StartQaRunRequestSchema) } },
  responses: {
    201: ok(
      'Running run, the updated plan, and the session executing it.',
      z.object({
        plan: QaPlanComponent,
        run: QaRunComponent,
        sessionId: z.string(),
        agentId: z.string(),
      }),
    ),
    400: invalid,
    404: notFound,
    409: conflict,
    502: err('The run session could not be started; the run was cancelled.'),
    503: err('Chat is unavailable on this server.'),
  },
});

registerPath({
  method: 'get',
  path: `${BASE}/{planId}/runs/{runId}`,
  tags: TAGS,
  summary: 'Get a run with its results',
  request: { params: runParams },
  responses: {
    200: ok('Run detail.', z.object({ run: QaRunComponent, results: z.array(QaResultComponent) })),
    404: notFound,
  },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/runs/{runId}/begin`,
  tags: TAGS,
  summary: 'Mark a queued run as running (no-op when already running)',
  request: { params: runParams },
  responses: { 200: ok('Updated run.', RunEnvelope), 404: notFound, 409: conflict },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/runs/{runId}/finish`,
  tags: TAGS,
  summary: 'Finish a running run; passed/failed is derived from the verdicts',
  request: { params: runParams },
  responses: { 200: ok('Updated run.', RunEnvelope), 404: notFound, 409: conflict },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/runs/{runId}/cancel`,
  tags: TAGS,
  summary: 'Cancel a queued or running run and stop its session',
  request: { params: runParams },
  responses: { 200: ok('Updated run.', RunEnvelope), 404: notFound, 409: conflict },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/runs/{runId}/results`,
  tags: TAGS,
  summary: 'Record or replace the verdict for one case in a running run',
  description:
    'Once every in-scope case has a result the run finishes on its own, passed when all verdicts are `pass`, and the run session gets a chat summary. 409 `out_of_scope` for a case outside the run; 400 `artifact_not_owned` when a screenshot id was not uploaded by the run session.',
  request: { params: runParams, body: { content: json(RecordQaResultRequestSchema) } },
  responses: {
    200: ok(
      'Stored result and the run, finished when this was the last in-scope case.',
      z.object({ result: QaResultComponent, run: QaRunComponent }),
    ),
    400: invalid,
    404: notFound,
    409: conflict,
  },
});

const TroubleshootSessionResponse = z.object({
  sessionId: z.string(),
  agentId: z.string(),
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/runs/{runId}/results/{caseId}/troubleshoot`,
  tags: TAGS,
  summary: 'Open a dev-agent session to troubleshoot one failed or blocked result',
  description:
    "Creates a session on the project's main dev agent seeded with the case steps, expected and " +
    'actual results, QA notes, screenshot artifact ids, the run session to read, and any finding ' +
    'card. Only `fail`, `needs_change`, and `blocked` results qualify. Every call opens a new session.',
  request: { params: runParams.extend({ caseId: z.string() }) },
  responses: {
    201: ok('New seeded troubleshoot session.', TroubleshootSessionResponse),
    404: notFound,
    409: err(
      'The result is not troubleshootable (`code: not_troubleshootable`) or the project has no dev agent (`code: no_dev_agent`).',
    ),
    502: err('The seeded first turn was not accepted.'),
  },
});
