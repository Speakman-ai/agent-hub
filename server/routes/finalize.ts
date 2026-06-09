/**
 * Finalize routes — the "Finalize Code Changes" pre-PR pipeline surface
 * (see wiki: `finalize-code-changes-architecture-v0`).
 *
 * Mounts:
 *
 *   1. `GET /api/projects/:projectId/finalize/:runId/reviewer-threads`
 *      — primary surface called by the diff-anchored side-panel.
 *
 *   2. `GET /api/sessions/:sessionId/finalize-runs/latest`
 *      — convenience surface so the session-view panel can discover the
 *        active finalize run without subscribing to lifecycle events.
 *
 *   3. `POST /api/projects/:projectId/cards/:cardId/finalize`
 *      — kicks off a Finalize run for a card's session. Idempotent on
 *        (project, branch, head_sha) per §4. Returns 200 with the row id
 *        when the run was created or reused (terminal), 409 when a
 *        non-terminal row already exists for the same key.
 *
 *   3b. `POST /api/projects/:projectId/sessions/:sessionId/finalize`
 *       — same as (3) but ensures a kanban card exists for ad-hoc sessions
 *         before triggering. Creates/links a card on first use.
 *
 *   4. `POST /api/projects/:projectId/finalize/:runId/cancel`
 *      — flips a non-terminal run row to `cancelled`, trips the orchestrator's
 *        in-process `CancelSignal` (via the run-abort registry), kills the
 *        originating session's agent turn, and broadcasts the terminal pair
 *        plus an `interrupted` event so the session falls idle.
 *
 *   4b. `POST /api/projects/:projectId/finalize/:runId/push`
 *       — after review + checks pass (`ready_to_push`), pushes to GitHub
 *         and opens the PR. Separate explicit step from Finalize.
 *
 *   5. `GET /api/sessions/:sessionId/finalize-ship-gate`
 *      — whether `gh pr create` is allowed for this session (Finalize
 *        projects with ci.yaml must ship through the Finalize button).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { userCanReadSession, userOwnsSession } from '../session-ownership.js';
import type {
  FinalizeRunMode,
  FinalizeRunRow,
  FinalizeRunStatus,
  KanbanBoardRow,
  KanbanCardRow,
  ReviewerThreadRow,
  RouteDeps,
  SessionRow,
} from '../types.js';
import { type OrchestratorOutcome } from '../finalize/orchestrator.js';
import { ensureKanbanCardForSession } from '../finalize/ensure-kanban-card.js';
import { triggerFinalizeRun } from '../finalize/trigger-run.js';
import { abortFinalizeRunInProcess } from '../finalize/run-abort-registry.js';
import { cancelSessionChatRun } from '../session-chat-cancel.js';
import { runFinalizePush, runSessionPushToGithub } from '../finalize/push-run.js';
import { evaluateFinalizeShipGate, type FinalizeShipGateAction } from '../finalize/ship-gate.js';
import { resolveSessionPrUrl } from '../session-title-pr.js';
import { listFinalizeRunSteps, loadFinalizeStepOutput } from '../finalize/step-output.js';
import { parseFlakeGate } from '../finalize/flake-recovery.js';
import {
  aggregateMetrics,
  isMetricName,
  METRIC_NAMES,
  parseRange,
  type MetricName,
} from '../finalize/metrics.js';
import type { FinalizeMetricRow } from '../types.js';

const execFileAsync = promisify(execFile);

const TERMINAL_STATUSES: ReadonlySet<FinalizeRunStatus> = new Set<FinalizeRunStatus>([
  'pushed',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
]);

const FINALIZE_RUN_MODES: ReadonlySet<string> = new Set(['full', 'checks', 'review']);

/**
 * Resolve the optional `mode` field on a Finalize trigger request body.
 * Unknown / missing values default to `'full'` (rebase + review + checks)
 * so legacy callers and the automation path are unaffected. The split
 * manual buttons send `'checks'` ("Run Tests") or `'review'` ("Reviewer").
 */
function parseFinalizeModeFromBody(body: unknown): FinalizeRunMode {
  const raw = (body as { mode?: unknown } | null | undefined)?.mode;
  if (typeof raw === 'string' && FINALIZE_RUN_MODES.has(raw)) {
    return raw as FinalizeRunMode;
  }
  return 'full';
}

/**
 * Detect a now-removed single-job filter on a Finalize trigger body. The
 * "Run Tests" dropdown used to send `{ jobs: ["test", ...] }` to scope a run
 * to specific ci.yaml v2 jobs; that feature is gone (the only run is the full
 * Finalize pipeline). We must NOT silently honor — or silently ignore — a
 * stale `jobs` filter: an old automation caller would otherwise get a 200 for
 * the full rebase+reviewer+checks pipeline instead of the scoped debug run it
 * asked for. Returns true only for a *real* filter (≥1 non-blank string),
 * preserving the legacy semantics where an empty/blank `jobs` array meant "no
 * filter" (a normal full run) and was always accepted.
 */
function finalizeRequestHasJobFilter(body: unknown): boolean {
  const raw = (body as { jobs?: unknown } | null | undefined)?.jobs;
  if (!Array.isArray(raw)) return false;
  return raw.some((j) => typeof j === 'string' && j.trim().length > 0);
}

const JOBS_UNSUPPORTED_BODY = {
  error: 'jobs_unsupported',
  message:
    'Single-job Finalize runs (the `jobs` field) are no longer supported — Finalize always runs the full rebase + reviewer + checks pipeline. Remove `jobs` from the request to run the full pipeline.',
} as const;

/**
 * Compact done-state for one Finalize phase (checks or review), surfaced
 * on the latest-run endpoint so the split buttons can render "Tested" /
 * "Reviewed" independently. `validated_head_sha` lets the client confirm
 * both phases validated the *same* commit before treating the branch as
 * fully validated.
 */
interface FinalizePhaseSummary {
  run_id: string;
  status: FinalizeRunStatus;
  mode: FinalizeRunMode;
  head_sha: string;
  validated_head_sha: string | null;
  ended_at: number | null;
}

function summarizeFinalizePhase(run: FinalizeRunRow | undefined): FinalizePhaseSummary | null {
  if (!run) return null;
  return {
    run_id: run.id,
    status: run.status,
    mode: run.mode,
    head_sha: run.head_sha,
    validated_head_sha: run.validated_head_sha ?? null,
    ended_at: run.ended_at ?? null,
  };
}

export default function createFinalizeRoutes(deps: RouteDeps): Router {
  const { stmts, findProject } = deps;
  const router = Router();

  // ───────────────────────────────────────────────────────────────
  // GET /api/projects/:projectId/finalize/:runId/reviewer-threads
  // ───────────────────────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/finalize/:runId/reviewer-threads',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const runId = req.params.runId as string;

      const project = findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const run = stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
      if (!run) return res.status(404).json({ error: 'Finalize run not found' });

      if (run.project_id !== project.id) {
        return res.status(404).json({ error: 'Finalize run not found' });
      }

      const threads = stmts.listReviewerThreadsForRun.all(runId) as ReviewerThreadRow[];
      return res.json({
        run_id: runId,
        reviewer_verdict: run.reviewer_verdict ?? null,
        threads,
      });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // GET /api/sessions/:sessionId/finalize-runs/latest
  // ───────────────────────────────────────────────────────────────
  router.get('/api/sessions/:sessionId/finalize-runs/latest', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    if (!userCanReadSession(req as AuthenticatedRequest, sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const run = stmts.getLatestFinalizeRunForSession.get(sessionId) as FinalizeRunRow | undefined;
    const steps = run ? listFinalizeRunSteps(stmts, run.id) : [];
    // Per-phase done-state for the split "Run Tests" / "Reviewer" buttons.
    // Each phase may be satisfied by its own phase-scoped run OR by a
    // combined 'full' run, so they're resolved independently here rather
    // than read off the single latest row.
    const checksRun = stmts.getLatestChecksRunForSession.get(sessionId) as
      | FinalizeRunRow
      | undefined;
    const reviewRun = stmts.getLatestReviewRunForSession.get(sessionId) as
      | FinalizeRunRow
      | undefined;
    // Flake gate: `status` is 'clean' | 'flake_recovered' | 'blocked'. A
    // non-clean status means auto-merge is withheld and a manual push is
    // required — 'flake_recovered' lists the offending jobs, 'blocked' means
    // the gate could not verify the run is clean. Parsed off
    // run.flake_recovered_jobs for client convenience.
    const flakeGate = parseFlakeGate(run?.flake_recovered_jobs);
    return res.json({
      run: run ?? null,
      steps,
      flakeRecovered: flakeGate.jobs,
      flakeGate: { status: flakeGate.status, reason: flakeGate.reason ?? null },
      phases: {
        checks: summarizeFinalizePhase(checksRun),
        review: summarizeFinalizePhase(reviewRun),
      },
    });
  });

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/cards/:cardId/finalize
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/cards/:cardId/finalize',
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const cardId = req.params.cardId as string;

      // Reject stale single-job requests before any lookup/side effect.
      if (finalizeRequestHasJobFilter(req.body)) {
        return res.status(410).json(JOBS_UNSUPPORTED_BODY);
      }

      const project = findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const card = stmts.getKanbanCard.get(cardId) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });

      // Verify the card belongs to a board owned by this project.
      const board = stmts.getKanbanBoard.get(projectId) as KanbanBoardRow | undefined;
      if (!board || board.id !== card.board_id) {
        return res.status(404).json({ error: 'Card not found' });
      }

      // Card must be tied to a session — Finalize runs against an open
      // worktree, and the session owns the worktree.
      if (!card.session_id) {
        return res
          .status(400)
          .json({ error: 'no_session', message: 'Card has no linked session.' });
      }

      // Auth: owner of the session, or implicit pass under "no auth"
      // (userOwnsSession returns true). We mask non-owners as 404 to keep
      // the cross-tenant surface uniform with the GET endpoints.
      if (!userOwnsSession(req as AuthenticatedRequest, card.session_id)) {
        return res.status(404).json({ error: 'Card not found' });
      }

      const session = stmts.getSession.get(card.session_id) as SessionRow | undefined;
      if (!session) {
        return res
          .status(400)
          .json({ error: 'no_session', message: 'Linked session was not found.' });
      }

      const outcome = await triggerFinalizeRun(deps, {
        req: req as AuthenticatedRequest,
        project,
        card,
        session,
        mode: parseFinalizeModeFromBody(req.body),
      });
      return res.status(outcome.httpStatus).json(outcome.body);
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/sessions/:sessionId/finalize
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/sessions/:sessionId/finalize',
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const sessionId = req.params.sessionId as string;

      // Reject stale single-job requests before any lookup/card creation.
      if (finalizeRequestHasJobFilter(req.body)) {
        return res.status(410).json(JOBS_UNSUPPORTED_BODY);
      }

      const project = findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const lookup = deps.findAgent(session.agent_id);
      if (!lookup || lookup.project.id !== project.id) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const { card, created: cardCreated } = ensureKanbanCardForSession(
        { stmts, broadcast: deps.broadcast, findAgent: deps.findAgent },
        {
          projectId: project.id,
          session,
          createdBy: (req as AuthenticatedRequest).authUserId ?? null,
        },
      );

      const outcome = await triggerFinalizeRun(deps, {
        req: req as AuthenticatedRequest,
        project,
        card,
        session,
        mode: parseFinalizeModeFromBody(req.body),
      });
      return res.status(outcome.httpStatus).json({ ...outcome.body, card_created: cardCreated });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/finalize/:runId/cancel
  // ───────────────────────────────────────────────────────────────
  router.post('/api/projects/:projectId/finalize/:runId/cancel', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const runId = req.params.runId as string;

    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const run = stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
    if (!run || run.project_id !== project.id) {
      return res.status(404).json({ error: 'Finalize run not found' });
    }

    if (run.session_id && !userOwnsSession(req as AuthenticatedRequest, run.session_id)) {
      return res.status(404).json({ error: 'Finalize run not found' });
    }

    if (TERMINAL_STATUSES.has(run.status)) {
      return res.status(409).json({
        error: 'terminal',
        status: run.status,
        message: 'Run is already terminal.',
      });
    }

    // Trip the orchestrator's in-process CancelSignal (if the run is owned by
    // this process) so the fix-dispatch loop and any in-flight reviewer turn
    // stop instead of dispatching another fix. The DB flip below is still the
    // authoritative UI signal even when no live handle is registered.
    abortFinalizeRunInProcess(runId);

    // Halt the originating session's agent turn so the session falls idle and
    // waits for user input. Aborting the orchestrator stops it from waiting,
    // but the dev-agent's fix turn keeps running until its process is killed.
    if (run.session_id) {
      try {
        cancelSessionChatRun({ sessionId: run.session_id, activeProcesses: deps.activeProcesses });
      } catch (err) {
        console.warn(
          `[finalize] session turn halt failed for session=${run.session_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Flip status → cancelled. The UI subscribes to the broadcast pair below.
    try {
      stmts.failFinalizeRun.run('cancelled', 'cancelled', runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[finalize] cancel write failed for run=${runId}: ${msg}`);
      return res.status(500).json({ error: 'cancel_failed', message: msg });
    }
    deps.broadcast({
      type: 'finalize_run_phase_changed',
      run_id: runId,
      ...(run.session_id ? { session_id: run.session_id } : {}),
      phase: null,
      status: 'cancelled',
      failure_reason: 'cancelled',
    });
    deps.broadcast({
      type: 'finalize_run_completed',
      run_id: runId,
      ...(run.session_id ? { session_id: run.session_id } : {}),
      status: 'cancelled',
    });
    // Tell the session UI the agent turn was interrupted so it stops streaming
    // and waits for user input.
    if (run.session_id) {
      deps.broadcast({ type: 'interrupted', sessionId: run.session_id });
    }
    return res.json({ ok: true, status: 'cancelled' });
  });

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/finalize/:runId/push
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/finalize/:runId/push',
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const runId = req.params.runId as string;

      const project = findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const run = stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
      if (!run || run.project_id !== project.id) {
        return res.status(404).json({ error: 'Finalize run not found' });
      }

      if (run.session_id && !userOwnsSession(req as AuthenticatedRequest, run.session_id)) {
        return res.status(404).json({ error: 'Finalize run not found' });
      }

      const card = stmts.getKanbanCard.get(run.card_id) as KanbanCardRow | undefined;
      if (!card) return res.status(404).json({ error: 'Card not found' });

      const sessionId = run.session_id ?? card.session_id;
      if (!sessionId) {
        return res.status(400).json({ error: 'no_session', message: 'Run has no linked session.' });
      }

      const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) {
        return res
          .status(400)
          .json({ error: 'no_session', message: 'Linked session was not found.' });
      }

      const force = req.body?.force === true;
      const outcome = await runFinalizePush({ deps, project, run, card, session, force });
      if (!outcome.ok) {
        return res.status(outcome.httpStatus).json({
          error: outcome.error,
          message: outcome.message,
        });
      }
      return res.json({ ok: true, pr_url: outcome.prUrl, status: 'pushed' });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // GET /api/projects/:projectId/finalize/:runId/steps/:stepIndex/output
  // ───────────────────────────────────────────────────────────────
  router.get(
    '/api/projects/:projectId/finalize/:runId/steps/:stepIndex/output',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const runId = req.params.runId as string;
      const stepIndex = Number.parseInt(String(req.params.stepIndex), 10);

      const project = findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!Number.isFinite(stepIndex) || stepIndex < 1) {
        return res.status(400).json({ error: 'invalid_step_index' });
      }

      const run = stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
      if (!run || run.project_id !== project.id) {
        return res.status(404).json({ error: 'Finalize run not found' });
      }

      const sessionId = run.session_id;
      if (!sessionId) {
        return res.json({ run_id: runId, step_index: stepIndex, lines: [] });
      }
      if (!userCanReadSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const lines = loadFinalizeStepOutput(stmts, { sessionId, runId, stepIndex });
      return res.json({ run_id: runId, step_index: stepIndex, lines });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/sessions/:sessionId/push-to-github
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/sessions/:sessionId/push-to-github',
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const sessionId = req.params.sessionId as string;
      const force = req.body?.force === true;

      const project = findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!userOwnsSession(req as AuthenticatedRequest, sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const { card } = ensureKanbanCardForSession(
        { stmts, broadcast: deps.broadcast, findAgent: deps.findAgent },
        {
          projectId: project.id,
          session,
          createdBy: (req as AuthenticatedRequest).authUserId ?? null,
        },
      );

      const run = stmts.getLatestFinalizeRunForSession.get(sessionId) as FinalizeRunRow | undefined;
      if (run) {
        if (run.status === 'ready_to_push') {
          const outcome = await runFinalizePush({ deps, project, run, card, session });
          if (!outcome.ok) {
            return res.status(outcome.httpStatus).json({
              error: outcome.error,
              message: outcome.message,
            });
          }
          return res.json({ ok: true, pr_url: outcome.prUrl, status: 'pushed' });
        }
        if (force) {
          const outcome = await runFinalizePush({ deps, project, run, card, session, force: true });
          if (!outcome.ok) {
            return res.status(outcome.httpStatus).json({
              error: outcome.error,
              message: outcome.message,
            });
          }
          return res.json({ ok: true, pr_url: outcome.prUrl, status: 'pushed' });
        }
        return res.status(409).json({
          error: 'not_ready_to_push',
          message: 'Finalize checks have not passed. Confirm to push anyway.',
        });
      }

      if (!force) {
        return res.status(409).json({
          error: 'not_ready_to_push',
          message: 'Finalize checks have not passed. Confirm to push anyway.',
        });
      }

      const outcome = await runSessionPushToGithub({ deps, project, session, card });
      if (!outcome.ok) {
        return res.status(outcome.httpStatus).json({
          error: outcome.error,
          message: outcome.message,
        });
      }
      return res.json({ ok: true, pr_url: outcome.prUrl, status: 'pushed' });
    },
  );

  // ───────────────────────────────────────────────────────────────
  // GET /api/projects/:projectId/finalize/metrics
  // ───────────────────────────────────────────────────────────────
  //
  // Adoption-metrics surface for the Finalize Code Changes dogfood
  // window. Returns aggregated counters and histogram summaries for the
  // requested time range. See `server/finalize/metrics.ts` for the
  // metric vocabulary and the wiki entry
  // `finalize-code-changes-architecture-v0` §14 for the design.
  //
  // Query string:
  //   - `range`: optional. Either `<N><m|h|d>` (e.g. `7d`, `24h`) or
  //     `<isoFrom>..<isoTo>`. Defaults to the last 24 hours. The `..`
  //     separator is used (not `:`) because ISO8601 timestamps contain
  //     colons; see `parseRange` in `server/finalize/metrics.ts`.
  //   - `metrics`: optional comma-separated subset of metric names.
  //     Unknown names are ignored (the response still includes every
  //     requested known name, even with zero rows).
  router.get('/api/projects/:projectId/finalize/metrics', (req: Request, res: Response) => {
    const projectId = req.params.projectId as string;
    const project = findProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const range = parseRange(typeof req.query.range === 'string' ? req.query.range : null);
    if (!range) {
      return res.status(400).json({
        error: 'invalid_range',
        message:
          'range must be `<N><m|h|d>` (e.g. `7d`, `24h`) or `<isoFrom>..<isoTo>` with from < to.',
      });
    }

    let metricsFilter: MetricName[] | undefined;
    if (typeof req.query.metrics === 'string' && req.query.metrics.trim().length > 0) {
      const parts = req.query.metrics
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      metricsFilter = parts.filter(isMetricName);
      if (metricsFilter.length === 0) {
        return res.status(400).json({
          error: 'invalid_metrics',
          message: `metrics must be a comma-separated subset of: ${METRIC_NAMES.join(', ')}`,
        });
      }
    }

    let rows: FinalizeMetricRow[];
    try {
      rows = stmts.listAllFinalizeMetricsInRange.all(
        project.id,
        range.fromMs,
        range.toMs,
      ) as FinalizeMetricRow[];
    } catch (err) {
      console.warn(
        `[finalize-metrics] read failed for project=${project.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return res.status(500).json({ error: 'metrics_read_failed' });
    }

    const aggregates = aggregateMetrics(rows, { metrics: metricsFilter });
    return res.json({
      project_id: project.id,
      range: {
        from_ms: range.fromMs,
        to_ms: range.toMs,
        from_iso: new Date(range.fromMs).toISOString(),
        to_iso: new Date(range.toMs).toISOString(),
      },
      sample_count: rows.length,
      metrics: aggregates,
    });
  });

  // ───────────────────────────────────────────────────────────────
  // GET /api/sessions/:sessionId/finalize-ship-gate
  // ───────────────────────────────────────────────────────────────
  router.get('/api/sessions/:sessionId/finalize-ship-gate', async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    if (!userCanReadSession(req as AuthenticatedRequest, sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = stmts.getSession.get(sessionId) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const lookup = deps.findAgent(session.agent_id);
    if (!lookup) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    let headSha: string | null = null;
    if (session.worktree_path) {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: session.worktree_path,
          timeout: 30_000,
          maxBuffer: 1 * 1024 * 1024,
        });
        headSha = stdout.trim() || null;
      } catch {
        headSha = null;
      }
    }

    // Surface any PR already open for this branch (linked card or session
    // title) so the gate can let `git push` attach commits to it. Mirrors the
    // PR resolution used by the session summary / header.
    const githubRepo =
      lookup.project && typeof lookup.project.githubRepo === 'string'
        ? lookup.project.githubRepo
        : null;
    const linkedCard = stmts.getKanbanCardBySession.get(sessionId) as KanbanCardRow | undefined;
    const existingPrUrl = resolveSessionPrUrl({
      sessionName: session.name,
      githubRepo,
      cardPrUrl: linkedCard?.pr_url ?? null,
    });

    const action: FinalizeShipGateAction =
      req.query.action === 'git_push' ? 'git_push' : 'gh_pr_create';

    const gate = await evaluateFinalizeShipGate(
      { stmts },
      { session, projectId: lookup.project.id, headSha, action, existingPrUrl },
    );
    return res.json(gate);
  });

  return router;
}

// Re-export for tests so route-test integration can mock runFinalize.
export const __test = { TERMINAL_STATUSES };
export type { OrchestratorOutcome };
