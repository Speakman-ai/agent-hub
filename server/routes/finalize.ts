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
 *   4. `POST /api/projects/:projectId/finalize/:runId/cancel`
 *      — flips a non-terminal run row to `cancelled` and broadcasts the
 *        terminal pair. v0 is UI-only (the orchestrator's in-process
 *        `CancelSignal` is NOT honored across requests — see §12).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth.js';
import { userCanReadSession, userOwnsSession } from '../session-ownership.js';
import type {
  FinalizeRunRow,
  FinalizeRunStatus,
  KanbanBoardRow,
  KanbanCardRow,
  ReviewerThreadRow,
  RouteDeps,
  SessionRow,
} from '../types.js';
import {
  computeIdempotencyKey,
  runFinalize,
  type OrchestratorOutcome,
} from '../finalize/orchestrator.js';
import { buildOrchestratorDeps } from '../finalize/orchestrator-deps.js';
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

/** Max time we'll poll for the inserted finalize_runs row before responding. */
const ROW_VISIBILITY_POLL_INTERVAL_MS = 20;
const ROW_VISIBILITY_POLL_MAX_ATTEMPTS = 15; // 15 * 20ms = 300ms cap

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    return res.json({ run: run ?? null });
  });

  // ───────────────────────────────────────────────────────────────
  // POST /api/projects/:projectId/cards/:cardId/finalize
  // ───────────────────────────────────────────────────────────────
  router.post(
    '/api/projects/:projectId/cards/:cardId/finalize',
    async (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const cardId = req.params.cardId as string;

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
      if (!session.worktree_path) {
        return res
          .status(400)
          .json({ error: 'no_worktree', message: 'Session has no worktree_path.' });
      }
      if (!session.worktree_branch) {
        return res
          .status(400)
          .json({ error: 'no_branch', message: 'Session has no worktree_branch.' });
      }

      // Resolve HEAD SHA inside the worktree.
      let headSha: string;
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: session.worktree_path,
          timeout: 30_000,
          maxBuffer: 1 * 1024 * 1024,
        });
        headSha = stdout.trim();
        if (!headSha) throw new Error('empty rev-parse output');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res
          .status(400)
          .json({ error: 'no_head_sha', message: `Could not resolve HEAD: ${msg}` });
      }

      // Compute idempotency key + check for an existing row. Two outcomes:
      //   - existing & non-terminal → 409 in_flight
      //   - existing & terminal → treat as reused (200, reused: true)
      //   - missing → fire runFinalize() in the background and poll for the
      //     row to appear so we can respond with its id
      const idempotencyKey = computeIdempotencyKey({
        projectId: project.id,
        branch: session.worktree_branch,
        headSha,
      });
      const existing = stmts.getFinalizeRunByIdempotencyKey.get(idempotencyKey) as
        | FinalizeRunRow
        | undefined;
      if (existing) {
        if (!TERMINAL_STATUSES.has(existing.status)) {
          return res.status(409).json({
            error: 'in_flight',
            run_id: existing.id,
            status: existing.status,
            message: 'A Finalize run is already in flight for this branch + head SHA.',
          });
        }
        // Terminal row — treat as reused; clicking again on a terminal run
        // is a no-op without churn (the orchestrator would also short-circuit
        // here via its own `getFinalizeRunByIdempotencyKey` check).
        return res.status(200).json({ run_id: existing.id, status: existing.status, reused: true });
      }

      // Background-fire the orchestrator. The row insert happens inside
      // runFinalize; we poll for it so the HTTP response can carry the
      // row id. Errors during the background run are logged — they'll
      // surface as terminal status writes on the row.
      const orchestratorDeps = buildOrchestratorDeps(deps, card, project.id);
      const ownerId = (req as AuthenticatedRequest).authUserId ?? card.created_by ?? 'unknown';
      const orchestratorPromise = runFinalize(orchestratorDeps, {
        card,
        project,
        branch: session.worktree_branch,
        headSha,
        baseBranch: card.pr_base_branch ?? 'main',
        worktreePath: session.worktree_path,
        sessionId: session.id,
        triggerSource: 'ui_button',
        triggeredByUserId: ownerId,
        // We don't have author identity readily available here; use the
        // owner id as a stable placeholder. The orchestrator stores
        // these on the row for provenance; the push step uses git's
        // own configured identity inside the worktree at push time.
        authorName: ownerId,
        authorEmail: `${ownerId}@local`,
      });
      // Detach: never await. Catch swallowed — the orchestrator is non-throwing.
      orchestratorPromise.catch((err: unknown) => {
        console.warn(
          `[finalize] background runFinalize threw for card=${cardId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });

      // Poll for the row to appear so we can return its id synchronously.
      for (let i = 0; i < ROW_VISIBILITY_POLL_MAX_ATTEMPTS; i++) {
        const created = stmts.getFinalizeRunByIdempotencyKey.get(idempotencyKey) as
          | FinalizeRunRow
          | undefined;
        if (created) {
          return res
            .status(200)
            .json({ run_id: created.id, status: created.status, reused: false });
        }
        await sleep(ROW_VISIBILITY_POLL_INTERVAL_MS);
      }

      // The poll timed out — the run started but the row was not visible
      // within ~300ms. The client can fall back to the WS event stream or
      // re-query latest.
      return res.status(202).json({
        ok: true,
        run_id: null,
        status: 'queued',
        message: 'Finalize run started; row not yet visible.',
      });
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

    // Flip status → cancelled. The orchestrator's in-process CancelSignal
    // is NOT plumbed across requests at v0 (§12) — this DB write is the
    // authoritative cancel signal for the UI, and the orchestrator's
    // own attempts will continue but their writes will land on a row
    // already in terminal state. The UI subscribes to the broadcast pair
    // we emit below.
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
      phase: null,
      status: 'cancelled',
      failure_reason: 'cancelled',
    });
    deps.broadcast({
      type: 'finalize_run_completed',
      run_id: runId,
      status: 'cancelled',
    });
    return res.json({ ok: true, status: 'cancelled' });
  });

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

  return router;
}

// Re-export for tests so route-test integration can mock runFinalize.
export const __test = { TERMINAL_STATUSES };
export type { OrchestratorOutcome };
