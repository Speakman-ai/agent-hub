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
import { resolveAgentSpawnEngineAndModel } from '../effective-model.js';
import {
  buildQaAuthoringSeed,
  findProjectQaAgent,
  loadQaAuthoringContext,
} from '../qa-authoring.js';
import { launchQaRun } from '../qa-run-launch.js';
import { listQaEnvironments } from '../qa-environments.js';
import { maybeArchiveQaRunSession } from '../qa-run-session-archive.js';
import { describeQaAutoRerun, processQaAutoRerun } from '../qa-auto-rerun.js';
import { abandonUnseededSession, kickoffSeededTurn } from '../seeded-session-kickoff.js';
import { broadcastSessionCreated } from '../session-checkpoint-rewind.js';
import { resolveOwnerUserId, setSessionOwner } from '../session-ownership.js';
import { QA_VERDICTS } from '../qa-schema.js';
import { fileQaFindingCards, isQaFindingVerdict, noteQaVerdictOverride } from '../qa-findings.js';
import { startQaTroubleshootSession } from '../qa-troubleshoot.js';
import {
  parseQaArtifactIds,
  postQaRunSummary,
  qaScreenshotsBySession,
  type QaScreenshot,
} from '../qa-results.js';
import {
  addQaCase,
  approveQaPlan,
  cancelQaRun,
  completeQaRunIfCovered,
  deleteQaPlan,
  editQaCase,
  finishQaRun,
  markQaRunRunning,
  overrideQaResult,
  qaPlanSignOffBlocker,
  qaRunCaseIds,
  QaStatusError,
  recordQaResult,
  removeQaCase,
  reorderQaCases,
  revokeQaPlanApproval,
  signOffQaPlan,
  updateQaPlan,
} from '../qa-status.js';
import type {
  QaCaseRow,
  QaLatestVerdictRow,
  QaPlanRow,
  QaResultRow,
  QaRunRow,
  RouteDeps,
  SessionRow,
} from '../types.js';
import {
  CreateQaCaseRequestSchema,
  CreateQaPlanRequestSchema,
  ListQaPlansQuerySchema,
  OverrideQaResultRequestSchema,
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
    autoRerunTrigger: p.auto_rerun_trigger,
    autoRerunBranch: p.auto_rerun_branch,
    autoRerunDelayMinutes: p.auto_rerun_delay_minutes,
    maxIterations: p.max_iterations,
    createdBy: p.created_by,
    authoringSessionId: p.authoring_session_id ?? null,
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
    caseIds: qaRunCaseIds(r),
    previewSessionId: r.preview_session_id ?? null,
    sessionId: r.session_id,
    startedBy: r.started_by,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

export function serializeQaResult(r: QaResultRow, screenshots?: Map<string, QaScreenshot>) {
  const ids = parseQaArtifactIds(r.screenshot_artifact_ids);
  return {
    id: r.id,
    runId: r.run_id,
    caseId: r.case_id,
    caseVersion: r.case_version,
    verdict: r.verdict,
    actual: r.actual,
    notes: r.notes,
    screenshotArtifactIds: ids,
    screenshots: screenshots
      ? ids.map((id) => screenshots.get(id)).filter((x): x is QaScreenshot => !!x)
      : [],
    findingCardId: r.finding_card_id,
    override: r.original_verdict
      ? { originalVerdict: r.original_verdict, by: r.overridden_by, at: r.overridden_at }
      : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A run's results with screenshot metadata from the run session's artifacts. */
export function serializeQaRunResults(run: QaRunRow) {
  const results = getStmts().listQaResultsByRun.all(run.id);
  const screenshots = qaScreenshotsBySession(
    run.session_id,
    results.flatMap((r) => parseQaArtifactIds(r.screenshot_artifact_ids)),
  );
  return results.map((r) => serializeQaResult(r, screenshots));
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

type QaVerdictCounts = Record<(typeof QA_VERDICTS)[number], number>;

export interface QaPlanSummary {
  caseCount: number;
  latestRun: {
    id: string;
    iteration: number;
    status: QaRunRow['status'];
    scope: QaRunRow['scope'];
    finishedAt: string | null;
    verdicts: QaVerdictCounts;
  } | null;
  epic: { id: string; name: string } | null;
  card: { id: string; title: string } | null;
}

export const emptyPlanSummary = (): QaPlanSummary => ({
  caseCount: 0,
  latestRun: null,
  epic: null,
  card: null,
});

const emptyVerdicts = (): QaVerdictCounts => ({ pass: 0, fail: 0, needs_change: 0, blocked: 0 });

/**
 * List-row extras for every plan in a project: case count, the latest run with
 * its verdict tally, and linked epic/card names. Set-based so the list stays
 * one query per facet rather than per plan.
 */
export function listPlanSummaries(projectId: string): Map<string, QaPlanSummary> {
  const db = getDb();
  const out = new Map<string, QaPlanSummary>();
  const links = db
    .prepare(
      `SELECT p.id, p.epic_id, e.name AS epic_name, p.card_id, c.title AS card_title,
              (SELECT COUNT(*) FROM qa_cases qc WHERE qc.plan_id = p.id) AS case_count
         FROM qa_plans p
         LEFT JOIN kanban_epics e ON e.id = p.epic_id
         LEFT JOIN kanban_cards c ON c.id = p.card_id
        WHERE p.project_id = ?`,
    )
    .all(projectId) as Array<{
    id: string;
    epic_id: string | null;
    epic_name: string | null;
    card_id: string | null;
    card_title: string | null;
    case_count: number;
  }>;
  for (const l of links) {
    out.set(l.id, {
      caseCount: l.case_count,
      latestRun: null,
      epic: l.epic_id && l.epic_name !== null ? { id: l.epic_id, name: l.epic_name } : null,
      card: l.card_id && l.card_title !== null ? { id: l.card_id, title: l.card_title } : null,
    });
  }
  const runs = db
    .prepare(
      `SELECT r.* FROM qa_runs r JOIN qa_plans p ON p.id = r.plan_id
        WHERE p.project_id = ?
          AND r.iteration = (SELECT MAX(iteration) FROM qa_runs r2 WHERE r2.plan_id = r.plan_id)`,
    )
    .all(projectId) as QaRunRow[];
  const byRun = new Map<string, QaVerdictCounts>();
  for (const r of runs) {
    const summary = out.get(r.plan_id);
    if (!summary) continue;
    const verdicts = emptyVerdicts();
    byRun.set(r.id, verdicts);
    summary.latestRun = {
      id: r.id,
      iteration: r.iteration,
      status: r.status,
      scope: r.scope,
      finishedAt: r.finished_at,
      verdicts,
    };
  }
  if (byRun.size > 0) {
    const tallies = db
      .prepare(
        `SELECT res.run_id, res.verdict, COUNT(*) AS n
           FROM qa_results res
           JOIN qa_runs r ON r.id = res.run_id
           JOIN qa_plans p ON p.id = r.plan_id
          WHERE p.project_id = ?
          GROUP BY res.run_id, res.verdict`,
      )
      .all(projectId) as Array<{ run_id: string; verdict: keyof QaVerdictCounts; n: number }>;
    for (const t of tallies) {
      const v = byRun.get(t.run_id);
      if (v && t.verdict in v) v[t.verdict] = t.n;
    }
  }
  return out;
}

/** Linked epic / card names for the plan detail header chips. */
export function planLinks(plan: QaPlanRow): Pick<QaPlanSummary, 'epic' | 'card'> {
  const db = getDb();
  const epic = plan.epic_id
    ? (db.prepare('SELECT id, name FROM kanban_epics WHERE id = ?').get(plan.epic_id) as
        | { id: string; name: string }
        | undefined)
    : undefined;
  const card = plan.card_id
    ? (db.prepare('SELECT id, title FROM kanban_cards WHERE id = ?').get(plan.card_id) as
        | { id: string; title: string }
        | undefined)
    : undefined;
  return { epic: epic ?? null, card: card ?? null };
}

/**
 * Agent that owns each live run session, so the UI can open the session in its
 * agent. Archived run sessions are absent: the run is over and its results live
 * on the QA page.
 */
function runSessionAgents(planId: string): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT r.id AS run_id, s.agent_id FROM qa_runs r
         JOIN sessions s ON s.id = r.session_id
        WHERE r.plan_id = ? AND s.deleted_at IS NULL`,
    )
    .all(planId) as Array<{ run_id: string; agent_id: string }>;
  return new Map(rows.map((r) => [r.run_id, r.agent_id]));
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
          res.status(e.status).json({ ...e.details, error: e.message, code: e.code });
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

  /**
   * A run just finished: file finding cards, then post the run summary. Card
   * rows and result links are written before the first await inside
   * `fileQaFindingCards`, so the summary already links them; assignment (the
   * fix-session spawn) completes in the background.
   */
  const afterRunFinished = (plan: QaPlanRow, runId: string): void => {
    fileQaFindingCards(deps, runId)
      .then((outcomes) => {
        if (outcomes.length > 0) {
          emit(plan.project_id, plan.id, { action: 'findings_filed', runId });
        }
      })
      .catch((err) => console.error(`[qa] filing finding cards failed run=${runId}:`, err));
    postQaRunSummary({ broadcast, project: findProject(plan.project_id)! }, runId);
    // A failed run at the iteration cap notifies the owner now; the other
    // trigger conditions wait on card and deployment updates.
    void processQaAutoRerun(deps, plan.id);
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
      const summaries = listPlanSummaries(projectId);
      res.json({
        plans: plans.map((p) => ({
          ...serializeQaPlan(p),
          summary: summaries.get(p.id) ?? emptyPlanSummary(),
        })),
        counts,
      });
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
      const plan = getDb().transaction(() => {
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
        return updateQaPlan(id, {
          autoRerunTrigger: body.autoRerunTrigger,
          autoRerunBranch: body.autoRerunBranch,
          autoRerunDelayMinutes: body.autoRerunDelayMinutes,
        });
      })();
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
      const agents = runSessionAgents(plan.id);
      res.json({
        plan: serializeQaPlan(plan),
        links: planLinks(plan),
        cases: s.listQaCasesByPlan
          .all(plan.id)
          .map((c) => serializeQaCase(c, latest.get(c.id) ?? null)),
        runs: s.listQaRunsByPlan.all(plan.id).map((r) => ({
          ...serializeQaRun(r),
          sessionAgentId: agents.get(r.id) ?? null,
          results: serializeQaRunResults(r),
        })),
        signOffBlocker: qaPlanSignOffBlocker(plan.id),
        autoRerun: describeQaAutoRerun(plan.id),
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
      const { expectedBase, ...fields } = body;
      const qaCase = editQaCase(req.params.caseId as string, fields, expectedBase);
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

  type AuthoringOutcome = { status: number; body: Record<string, unknown> };

  /**
   * Seeds in flight, by plan id. A second open while the first seed is still
   * pending waits for that outcome instead of creating another session or
   * reporting a session whose seed may still fail.
   */
  const authoringInFlight = new Map<string, Promise<AuthoringOutcome>>();

  const startAuthoringSession = async (
    plan: QaPlanRow,
    project: NonNullable<ReturnType<typeof findProject>>,
    ownerUserId: string | null,
  ): Promise<AuthoringOutcome> => {
    const s = getStmts();
    const agent = findProjectQaAgent(project);
    if (!agent) {
      return {
        status: 409,
        body: {
          error: 'This project has no QA agent. Add an agent with the qa role first.',
          code: 'no_qa_agent',
        },
      };
    }
    if (!deps.handleChat) {
      return { status: 503, body: { error: 'Chat is unavailable on this server' } };
    }
    const seed = buildQaAuthoringSeed({
      project,
      plan,
      context: loadQaAuthoringContext(plan),
      environments: listQaEnvironments(project.id),
    });
    const sessionId = randomUUID();
    try {
      const { engine, model } = resolveAgentSpawnEngineAndModel(deps.config, agent, ownerUserId);
      // QA sessions never get a worktree: they are read-only on code.
      s.createSession.run(
        sessionId,
        agent.id,
        `[QA plan] ${plan.title}`.slice(0, 100),
        engine,
        model,
        0,
        0,
        1,
      );
      setSessionOwner(sessionId, ownerUserId);
      s.updateSessionMode.run('qa', sessionId);
      await kickoffSeededTurn({
        handleChat: deps.handleChat,
        agentId: agent.id,
        sessionId,
        content: seed,
      });
    } catch (e) {
      console.error('[qa] authoring session failed to start:', e);
      abandonUnseededSession(s, sessionId);
      return { status: 502, body: { error: 'Failed to start the QA authoring session' } };
    }
    // Linked only once the seed is accepted, so the plan never points at a
    // session that is about to be dropped.
    s.setQaPlanAuthoringSession.run(sessionId, plan.id);
    const session = s.getSession.get(sessionId) as SessionRow;
    broadcastSessionCreated(broadcast, agent.id, session, s, project);
    emit(plan.project_id, plan.id, { action: 'authoring_session_opened' });
    return { status: 201, body: { sessionId, agentId: agent.id, created: true } };
  };

  /**
   * Open (or reopen) the plan's authoring conversation with the project's QA
   * agent. The first call creates a QA session seeded with the plan and its
   * linked epic / card; later calls return that session while it is live.
   */
  router.post(`${BASE}/:planId/authoring-session`, async (req: Request, res: Response) => {
    try {
      const plan = loadPlan(req, res);
      if (!plan) return;

      const pending = authoringInFlight.get(plan.id);
      if (pending) {
        const outcome = await pending;
        if (outcome.status === 201) {
          res.json({ ...outcome.body, created: false });
        } else {
          res.status(outcome.status).json(outcome.body);
        }
        return;
      }

      const existing = plan.authoring_session_id
        ? (getStmts().getSession.get(plan.authoring_session_id) as SessionRow | undefined)
        : undefined;
      if (existing && !existing.deleted_at) {
        res.json({ sessionId: existing.id, agentId: existing.agent_id, created: false });
        return;
      }

      const project = findProject(plan.project_id)!;
      const ownerUserId = resolveOwnerUserId(req as AuthenticatedRequest);
      const started = startAuthoringSession(plan, project, ownerUserId);
      authoringInFlight.set(plan.id, started);
      let outcome: AuthoringOutcome;
      try {
        outcome = await started;
      } finally {
        authoringInFlight.delete(plan.id);
      }
      res.status(outcome.status).json(outcome.body);
    } catch (e) {
      console.error('[qa] route error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  planAction('approve', 'plan_approved', (plan, req) => approveQaPlan(plan.id, userId(req)));
  planAction('revoke-approval', 'plan_unapproved', (plan) => revokeQaPlanApproval(plan.id));
  planAction('sign-off', 'plan_signed_off', (plan, req) => signOffQaPlan(plan.id, userId(req)));

  /**
   * Start a run: queue it, open a fresh QA session seeded with the in-scope
   * cases, target URL, and the tool to drive it with, then mark it running.
   * Answers 201 once the seed is accepted. If the session cannot be started
   * the run is cancelled, so it never blocks the plan as a phantom active run.
   */
  router.post(`${BASE}/:planId/runs`, async (req: Request, res: Response) => {
    try {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const body = parse(StartQaRunRequestSchema, req.body ?? {}, res);
      if (!body) return;
      const result = await launchQaRun(deps, plan, {
        scope: body.scope,
        startedBy: userId(req),
        ownerUserId: resolveOwnerUserId(req as AuthenticatedRequest),
      });
      if (!result.ok) {
        const { status, error, code, runId } = result;
        res
          .status(status)
          .json(
            code === 'spawn_failed'
              ? { error, runId }
              : code === 'chat_unavailable' || code === 'no_project'
                ? { error }
                : { error, code },
          );
        return;
      }
      res.status(201).json({
        plan: serializeQaPlan(result.plan),
        run: serializeQaRun(result.run),
        sessionId: result.sessionId,
        agentId: result.agentId,
      });
    } catch (e) {
      if (e instanceof QaStatusError) {
        res.status(e.status).json({ ...e.details, error: e.message, code: e.code });
        return;
      }
      console.error('[qa] route error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get(
    `${BASE}/:planId/runs/:runId`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const run = loadRun(req, res, plan);
      if (!run) return;
      res.json({
        run: serializeQaRun(run),
        results: serializeQaRunResults(run),
      });
    }),
  );

  const runAction = (
    path: string,
    action: string,
    apply: (runId: string) => QaRunRow,
    after?: (plan: QaPlanRow, run: QaRunRow) => void,
  ) =>
    router.post(
      `${BASE}/:planId/runs/:runId/${path}`,
      guard((req, res) => {
        const plan = loadPlan(req, res);
        if (!plan) return;
        const run = loadRun(req, res, plan);
        if (!run) return;
        const updated = apply(run.id);
        emit(plan.project_id, plan.id, { action, runId: run.id });
        after?.(plan, updated);
        res.json({ run: serializeQaRun(updated) });
      }),
    );

  runAction('begin', 'run_running', markQaRunRunning);
  runAction('finish', 'run_finished', finishQaRun, (plan, run) => afterRunFinished(plan, run.id));
  // Cancelling also stops the run's session, so the agent stops driving the target.
  runAction('cancel', 'run_cancelled', (runId) => {
    const cancelled = cancelQaRun(runId);
    if (cancelled.session_id) {
      deps.handleCancel?.(cancelled.session_id);
      maybeArchiveQaRunSession(
        { stmts: getStmts(), broadcast },
        { sessionId: cancelled.session_id },
      );
    }
    return cancelled;
  });

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
      const finished = completeQaRunIfCovered(run.id);
      if (finished) {
        emit(plan.project_id, plan.id, { action: 'run_finished', runId: run.id });
        afterRunFinished(plan, run.id);
      }
      res.json({
        result: serializeQaRunResults(finished ?? run).find((r) => r.id === result.id)!,
        run: serializeQaRun(finished ?? getStmts().getQaRun.get(run.id)!),
      });
    }),
  );

  /**
   * A person overrides one verdict of a finished run. A result that already
   * has a finding card gets a note on it, so whoever is fixing it knows; a
   * new fail / needs_change files its card like a finished run does.
   */
  router.post(
    `${BASE}/:planId/runs/:runId/results/:caseId/override`,
    guard((req, res) => {
      const plan = loadPlan(req, res);
      if (!plan) return;
      const run = loadRun(req, res, plan);
      if (!run) return;
      const qaCase = loadCase(req, res, plan);
      if (!qaCase) return;
      const body = parse(OverrideQaResultRequestSchema, req.body, res);
      if (!body) return;
      const outcome = overrideQaResult(run.id, qaCase.id, body.verdict, userId(req));
      const changed = outcome.previousVerdict !== outcome.result.verdict;
      if (changed) {
        emit(plan.project_id, plan.id, {
          action: 'result_overridden',
          runId: run.id,
          caseId: qaCase.id,
        });
        if (outcome.result.finding_card_id) {
          noteQaVerdictOverride(broadcast, plan.project_id, outcome.result.finding_card_id, {
            caseTitle: qaCase.title,
            iteration: run.iteration,
            from: outcome.previousVerdict,
            to: outcome.result.verdict,
          });
        } else if (isQaFindingVerdict(outcome.result.verdict)) {
          fileQaFindingCards(deps, run.id)
            .then((filed) => {
              if (filed.length > 0) {
                emit(plan.project_id, plan.id, { action: 'findings_filed', runId: run.id });
              }
            })
            .catch((err) => console.error(`[qa] filing finding cards failed run=${run.id}:`, err));
        }
        // A failed run that is now passed has nothing to rerun; one that is
        // now failed may be at the iteration cap.
        if (outcome.runStatusChanged) void processQaAutoRerun(deps, plan.id);
      }
      res.json({
        result: serializeQaRunResults(outcome.run).find((r) => r.id === outcome.result.id)!,
        run: serializeQaRun(outcome.run),
      });
    }),
  );

  /**
   * Open a dev-agent session seeded with one failed / blocked result so a
   * human can troubleshoot it. Each call opens a new session.
   */
  router.post(
    `${BASE}/:planId/runs/:runId/results/:caseId/troubleshoot`,
    async (req: Request, res: Response) => {
      try {
        const plan = loadPlan(req, res);
        if (!plan) return;
        const run = loadRun(req, res, plan);
        if (!run) return;
        const qaCase = loadCase(req, res, plan);
        if (!qaCase) return;
        const result = getStmts()
          .listQaResultsByRun.all(run.id)
          .find((r) => r.case_id === qaCase.id);
        if (!result) return void notFound(res, 'QA result');
        const outcome = await startQaTroubleshootSession(deps, {
          project: findProject(plan.project_id)!,
          plan,
          run,
          qaCase,
          result,
          ownerUserId: resolveOwnerUserId(req as AuthenticatedRequest),
        });
        if (!outcome.ok) {
          const { status, error, code } = outcome;
          res.status(status).json(code ? { error, code } : { error });
          return;
        }
        res.status(201).json({ sessionId: outcome.sessionId, agentId: outcome.agentId });
      } catch (e) {
        console.error('[qa] route error:', e);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  return router;
}
