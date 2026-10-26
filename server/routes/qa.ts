/**
 * QA Validation REST surface (`/api/projects/:projectId/qa/plans/...`).
 *
 * Plan / case / run / result CRUD for the QA page and the QA agent's qa.sh
 * wrapper. Every lifecycle rule (approval, freezing, run transitions,
 * sign-off) lives in `qa-status.ts`; this file validates input, scopes rows
 * to the project, and maps `QaStatusError` onto HTTP.
 *
 * Access matches the board routes: the app-level project visibility gate on
 * `/api/projects/:projectId` runs first, then an unknown project 404s here.
 *
 * Every successful mutation broadcasts `qa_update` with `projectId` and
 * `planId`, which the broadcast filter delivers by project visibility.
 */
import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../auth.js';
import { getDb, getStmts } from '../db.js';
import {
  addQaCase,
  approveQaPlan,
  cancelQaRun,
  deleteQaPlan,
  editQaCase,
  finishQaRun,
  markQaRunRunning,
  qaPlanSignOffBlocker,
  QaStatusError,
  recordQaResult,
  removeQaCase,
  reorderQaCases,
  revokeQaPlanApproval,
  signOffQaPlan,
  startQaRun,
  updateQaPlan,
} from '../qa-status.js';
import type {
  QaCaseRow,
  QaLatestVerdictRow,
  QaPlanRow,
  QaResultRow,
  QaRunRow,
  RouteDeps,
} from '../types.js';
import {
  CreateQaCaseRequestSchema,
  CreateQaPlanRequestSchema,
  ListQaPlansQuerySchema,
  RecordQaResultRequestSchema,
  ReorderQaCasesRequestSchema,
  StartQaRunRequestSchema,
  UpdateQaCaseRequestSchema,
  UpdateQaPlanRequestSchema,
} from './qa.openapi.js';

export function serializeQaPlan(p: QaPlanRow) {
  return {
    id: p.id,
    projectId: p.project_id,
    title: p.title,
    goal: p.goal,
    targetUrl: p.target_url,
    epicId: p.epic_id,
    cardId: p.card_id,
    deployEnvironment: p.deploy_environment,
    status: p.status,
    approved: p.approved_at !== null,
    approvedAt: p.approved_at,
    approvedBy: p.approved_by,
    approvalSeq: p.approval_seq,
    signedOffAt: p.signed_off_at,
    signedOffBy: p.signed_off_by,
    autoRerun: p.auto_rerun === 1,
    maxIterations: p.max_iterations,
    createdBy: p.created_by,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export function serializeQaCase(c: QaCaseRow, latest?: QaLatestVerdictRow | null) {
  return {
    id: c.id,
    planId: c.plan_id,
    position: c.position,
    title: c.title,
    steps: c.steps,
    expected: c.expected,
    version: c.version,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    ...(latest !== undefined && {
      latestVerdict: latest
        ? {
            verdict: latest.verdict,
            caseVersion: latest.case_version,
            current: latest.case_version === c.version,
            runId: latest.run_id,
            iteration: latest.iteration,
          }
        : null,
    }),
  };
}

export function serializeQaRun(r: QaRunRow) {
  return {
    id: r.id,
    planId: r.plan_id,
    iteration: r.iteration,
    scope: r.scope,
    status: r.status,
    approvalSeq: r.approval_seq,
    sessionId: r.session_id,
    startedBy: r.started_by,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

function parseArtifactIds(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function serializeQaResult(r: QaResultRow) {
  return {
    id: r.id,
    runId: r.run_id,
    caseId: r.case_id,
    caseVersion: r.case_version,
    verdict: r.verdict,
    actual: r.actual,
    notes: r.notes,
    screenshotArtifactIds: parseArtifactIds(r.screenshot_artifact_ids),
    findingCardId: r.finding_card_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  res: Response,
): z.infer<T> | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    res.status(400).json({
      error: first?.message ?? 'Validation failed',
      details: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

const notFound = (res: Response, what: string) =>
  res.status(404).json({ error: `${what} not found` });

export default function createQaRoutes(deps: RouteDeps): Router {
  const { findProject, broadcast } = deps;
  const router = Router();

  const userId = (req: Request): string | null => (req as AuthenticatedRequest).authUserId ?? null;

  const emit = (projectId: string, planId: string, extra: Record<string, unknown> = {}) =>
    broadcast({ type: 'qa_update', projectId, planId, ...extra });

  /** Map lifecycle errors to HTTP; rethrow anything else. */
  const guard =
    (fn: (req: Request, res: Response) => void) =>
    (req: Request, res: Response): void => {
      try {
        fn(req, res);
      } catch (e) {
        if (e instanceof QaStatusError) {
          res.status(e.status).json({ error: e.message, code: e.code });
          return;
        }
        console.error('[qa] route error:', e);
        res.status(500).json({ error: 'Internal error' });
      }
    };

  /** The plan when it exists in this project; otherwise answers 404. */
  const loadPlan = (req: Request, res: Response): QaPlanRow | undefined => {
    const projectId = req.params.projectId as string;
    if (!findProject(projectId)) {
      notFound(res, 'Project');
      return undefined;
    }
    const plan = getStmts().getQaPlan.get(req.params.planId as string);
    if (!plan || plan.project_id !== projectId) {
      notFound(res, 'QA plan');
      return undefined;
    }
    return plan;
  };

  const loadCase = (req: Request, res: Response, plan: QaPlanRow): QaCaseRow | undefined => {
    const qaCase = getStmts().getQaCase.get(req.params.caseId as string);
    if (!qaCase || qaCase.plan_id !== plan.id) {
      notFound(res, 'QA case');
      return undefined;
    }
    return qaCase;
  };

  const loadRun = (req: Request, res: Response, plan: QaPlanRow): QaRunRow | undefined => {
    const run = getStmts().getQaRun.get(req.params.runId as string);
    if (!run || run.plan_id !== plan.id) {
      notFound(res, 'QA run');
      return undefined;
    }
    return run;
  };

  const epicInProject = (epicId: string, projectId: string): boolean =>
    !!getDb()
      .prepare(
        `SELECT 1 FROM kanban_epics e JOIN kanban_boards b ON b.id = e.board_id
          WHERE e.id = ? AND b.project_id = ?`,
      )
      .get(epicId, projectId);

  const cardInProject = (cardId: string, projectId: string): boolean =>
    !!getDb()
      .prepare(
        `SELECT 1 FROM kanban_cards c JOIN kanban_boards b ON b.id = c.board_id
          WHERE c.id = ? AND b.project_id = ?`,
      )
      .get(cardId, projectId);

  /** Linked epic / card must belong to this project. Answers 404 when not. */
  const checkLinks = (
    res: Response,
    projectId: string,
    links: { epicId?: string | null; cardId?: string | null },
  ): boolean => {
    if (links.epicId && !epicInProject(links.epicId, projectId)) {
      notFound(res, 'Epic');
      return false;
    }
    if (links.cardId && !cardInProject(links.cardId, projectId)) {
      notFound(res, 'Card');
      return false;
    }
    return true;
  };

  const BASE = '/api/projects/:projectId/qa/plans';

  router.get(
    BASE,
    guard((req, res) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) return void notFound(res, 'Project');
      const query = parse(ListQaPlansQuerySchema, req.query, res);
      if (!query) return;
      const s = getStmts();
      const all = s.listQaPlansByProject.all(projectId);
      const counts = { new: 0, in_progress: 0, done: 0 };
      for (const p of all) counts[p.status] += 1;
      const plans = query.status ? all.filter((p) => p.status === query.status) : all;
      res.json({ plans: plans.map(serializeQaPlan), counts });
    }),
  );

  router.post(
    BASE,
    guard((req, res) => {
      const projectId = req.params.projectId as string;
      if (!findProject(projectId)) return void notFound(res, 'Project');
      const body = parse(CreateQaPlanRequestSchema, req.body, res);
      if (!body) return;
      if (!checkLinks(res, projectId, body)) return;
      const id = randomUUID();
      getStmts().insertQaPlan.run(
        id,
        projectId,
        body.title,
        body.goal ?? '',
        body.targetUrl,
        body.epicId ?? null,
        body.cardId ?? null,
        body.deployEnvironment ?? null,
        body.autoRerun === false ? 0 : 1,
        body.maxIterations ?? 5,
        userId(req),
      );
      const plan = getStmts().getQaPlan.get(id)!;
      emit(projectId, id, { action: 'plan_created' });
      res.status(201).json({ plan: serializeQaPlan(plan) });
    }),
  );

  router.get(
    `${BASE}/:planId`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const s = getStmts();
      const latest = new Map(s.listLatestQaVerdictsByPlan.all(plan.id).map((v) => [v.case_id, v]));
      res.json({
        plan: serializeQaPlan(plan),
        cases: s.listQaCasesByPlan
          .all(plan.id)
          .map((c) => serializeQaCase(c, latest.get(c.id) ?? null)),
        runs: s.listQaRunsByPlan.all(plan.id).map(serializeQaRun),
        signOffBlocker: qaPlanSignOffBlocker(plan.id),
      });
    }),
  );

  router.patch(
    `${BASE}/:planId`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const body = parse(UpdateQaPlanRequestSchema, req.body, res);
      if (!body) return;
      if (!checkLinks(res, plan.project_id, body)) return;
      const updated = updateQaPlan(plan.id, body);
      emit(plan.project_id, plan.id, { action: 'plan_updated' });
      res.json({ plan: serializeQaPlan(updated) });
    }),
  );

  router.delete(
    `${BASE}/:planId`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      deleteQaPlan(plan.id);
      emit(plan.project_id, plan.id, { action: 'plan_deleted' });
      res.json({ ok: true });
    }),
  );

  router.post(
    `${BASE}/:planId/cases`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const body = parse(CreateQaCaseRequestSchema, req.body, res);
      if (!body) return;
      const qaCase = addQaCase(plan.id, body);
      emit(plan.project_id, plan.id, { action: 'case_created' });
      res.status(201).json({
        case: serializeQaCase(qaCase),
        plan: serializeQaPlan(getStmts().getQaPlan.get(plan.id)!),
      });
    }),
  );

  // Registered before /cases/:caseId so "reorder" is never read as a case id.
  router.post(
    `${BASE}/:planId/cases/reorder`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const body = parse(ReorderQaCasesRequestSchema, req.body, res);
      if (!body) return;
      const cases = reorderQaCases(plan.id, body.orderedIds);
      emit(plan.project_id, plan.id, { action: 'cases_reordered' });
      res.json({ cases: cases.map((c) => serializeQaCase(c)) });
    }),
  );

  router.patch(
    `${BASE}/:planId/cases/:caseId`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      if (!loadCase(req, res, plan)) return;
      const body = parse(UpdateQaCaseRequestSchema, req.body, res);
      if (!body) return;
      const qaCase = editQaCase(req.params.caseId as string, body);
      emit(plan.project_id, plan.id, { action: 'case_updated' });
      res.json({
        case: serializeQaCase(qaCase),
        plan: serializeQaPlan(getStmts().getQaPlan.get(plan.id)!),
      });
    }),
  );

  router.delete(
    `${BASE}/:planId/cases/:caseId`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      if (!loadCase(req, res, plan)) return;
      removeQaCase(req.params.caseId as string);
      emit(plan.project_id, plan.id, { action: 'case_deleted' });
      res.json({ ok: true, plan: serializeQaPlan(getStmts().getQaPlan.get(plan.id)!) });
    }),
  );

  const planAction = (
    path: string,
    action: string,
    run: (plan: QaPlanRow, req: Request) => QaPlanRow,
  ) =>
    router.post(
      `${BASE}/:planId/${path}`,
      guard((req, res) => {
        const plan = loadPlan(req, res);
        if (!plan) return;
        const updated = run(plan, req);
        emit(plan.project_id, plan.id, { action });
        res.json({ plan: serializeQaPlan(updated) });
      }),
    );

  planAction('approve', 'plan_approved', (plan, req) => approveQaPlan(plan.id, userId(req)));
  planAction('revoke-approval', 'plan_unapproved', (plan) => revokeQaPlanApproval(plan.id));
  planAction('sign-off', 'plan_signed_off', (plan, req) => signOffQaPlan(plan.id, userId(req)));

  router.post(
    `${BASE}/:planId/runs`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const body = parse(StartQaRunRequestSchema, req.body ?? {}, res);
      if (!body) return;
      const started = startQaRun(plan.id, { scope: body.scope, startedBy: userId(req) });
      emit(plan.project_id, plan.id, { action: 'run_started', runId: started.run.id });
      res
        .status(201)
        .json({ plan: serializeQaPlan(started.plan), run: serializeQaRun(started.run) });
    }),
  );

  router.get(
    `${BASE}/:planId/runs/:runId`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const run = loadRun(req, res, plan);
      if (!run) return;
      res.json({
        run: serializeQaRun(run),
        results: getStmts().listQaResultsByRun.all(run.id).map(serializeQaResult),
      });
    }),
  );

  const runAction = (path: string, action: string, apply: (runId: string) => QaRunRow) =>
    router.post(
      `${BASE}/:planId/runs/:runId/${path}`,
      guard((req, res) => {
        const plan = loadPlan(req, res);
        if (!plan) return;
        const run = loadRun(req, res, plan);
        if (!run) return;
        const updated = apply(run.id);
        emit(plan.project_id, plan.id, { action, runId: run.id });
        res.json({ run: serializeQaRun(updated) });
      }),
    );

  runAction('begin', 'run_running', markQaRunRunning);
  runAction('finish', 'run_finished', finishQaRun);
  runAction('cancel', 'run_cancelled', cancelQaRun);

  router.post(
    `${BASE}/:planId/runs/:runId/results`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const run = loadRun(req, res, plan);
      if (!run) return;
      const body = parse(RecordQaResultRequestSchema, req.body, res);
      if (!body) return;
      if (body.findingCardId && !cardInProject(body.findingCardId, plan.project_id)) {
        return void notFound(res, 'Card');
      }
      const { caseId, ...input } = body;
      const result = recordQaResult(run.id, caseId, input);
      emit(plan.project_id, plan.id, { action: 'result_recorded', runId: run.id, caseId });
      res.json({ result: serializeQaResult(result) });
    }),
  );

  return router;
}
