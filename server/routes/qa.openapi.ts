/**
 * Zod schemas + OpenAPI registrations for the QA Validation surface
 * (`server/routes/qa.ts`). This companion owns the wire shape; lifecycle
 * rules live in `server/qa-status.ts`.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { QA_PLAN_STATUSES, QA_RUN_SCOPES, QA_RUN_STATUSES, QA_VERDICTS } from '../qa-schema.js';

const ErrorResponse = registerComponent(
  'QaErrorResponse',
  z
    .object({
      error: z.string(),
      code: z.string().optional().openapi({
        description:
          'Lifecycle error code from qa-status (e.g. not_approved, run_active, plan_done, not_all_pass).',
      }),
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
        description: 'Deployment environment auto-rerun waits on. Null disables auto-rerun.',
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
      maxIterations: z.number().int(),
      createdBy: z.string().nullable(),
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
    screenshotArtifactIds: z.array(z.string()),
    findingCardId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

const nullableId = z.string().min(1).nullable().optional();

export const CreateQaPlanRequestSchema = z.object({
  title: z.string().trim().min(1, 'title is required'),
  targetUrl: z.string().url('targetUrl must be a valid URL'),
  goal: z.string().optional(),
  epicId: nullableId,
  cardId: nullableId,
  deployEnvironment: z.string().min(1).nullable().optional(),
  autoRerun: z.boolean().optional(),
  maxIterations: z.number().int().min(1).max(100).optional(),
});

export const UpdateQaPlanRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  targetUrl: z.string().url('targetUrl must be a valid URL').optional().openapi({
    description: 'Changing the target revokes approval and is refused while done or running.',
  }),
  goal: z.string().optional(),
  epicId: nullableId,
  cardId: nullableId,
  deployEnvironment: z.string().min(1).nullable().optional(),
  autoRerun: z.boolean().optional(),
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

const PlanEnvelope = z.object({ plan: QaPlanComponent });
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
        plans: z.array(QaPlanComponent),
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
        cases: z.array(QaCaseComponent),
        runs: z.array(QaRunComponent).openapi({ description: 'Newest iteration first.' }),
        signOffBlocker: z.string().nullable().openapi({
          description: 'Why the plan cannot be signed off, or null when it can.',
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
  summary: 'Queue a run (409 when unapproved or a run is active)',
  request: { params: planParams, body: { content: json(StartQaRunRequestSchema) } },
  responses: {
    201: ok(
      'Queued run and the updated plan.',
      z.object({ plan: QaPlanComponent, run: QaRunComponent }),
    ),
    400: invalid,
    404: notFound,
    409: conflict,
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
  summary: 'Mark a queued run as running',
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
  summary: 'Cancel a queued or running run',
  request: { params: runParams },
  responses: { 200: ok('Updated run.', RunEnvelope), 404: notFound, 409: conflict },
});

registerPath({
  method: 'post',
  path: `${BASE}/{planId}/runs/{runId}/results`,
  tags: TAGS,
  summary: 'Record or replace the verdict for one case in a running run',
  request: { params: runParams, body: { content: json(RecordQaResultRequestSchema) } },
  responses: {
    200: ok('Stored result.', z.object({ result: QaResultComponent })),
    400: invalid,
    404: notFound,
    409: conflict,
  },
});
