/**
 * Finalize routes — read-only inspection surface for the "Finalize Code
 * Changes" pre-PR pipeline (see wiki: `finalize-code-changes-architecture-v0`).
 *
 * At v0 this file exposes two endpoints, both read-only:
 *
 *   1. `GET /api/projects/:projectId/finalize/:runId/reviewer-threads`
 *      — primary surface called by the diff-anchored side-panel.
 *        Returns every reviewer thread tied to the given run id, ordered
 *        by `file_path ASC, line_start ASC, created_at ASC` so the UI can
 *        group by `file_path` without re-sorting client-side.
 *
 *   2. `GET /api/sessions/:sessionId/finalize-runs/latest`
 *      — convenience surface so the session-view panel can discover the
 *        active finalize run without subscribing to lifecycle events. The
 *        response is the most-recent `finalize_runs` row for the session
 *        (HTTP 200 with `null` when none exists) — never a 404, because
 *        "no runs yet" is the normal first-load state for any session.
 *
 * Replies, resolves, and any other mutating operations are intentionally
 * out of scope at v0: reviewer comments are *also* dispatched into the
 * originating session as part of the fix-dispatch message body, and that
 * session is where the conversation actually happens. The threads table
 * is a parallel store that powers a read-only side panel only.
 */
import { Router, Request, Response } from 'express';
import type { FinalizeRunRow, ReviewerThreadRow, RouteDeps } from '../types.js';

export default function createFinalizeRoutes(deps: RouteDeps): Router {
  const { stmts, findProject } = deps;
  const router = Router();

  // Per-run reviewer threads (primary surface).
  router.get(
    '/api/projects/:projectId/finalize/:runId/reviewer-threads',
    (req: Request, res: Response) => {
      const projectId = req.params.projectId as string;
      const runId = req.params.runId as string;

      const project = findProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const run = stmts.getFinalizeRun.get(runId) as FinalizeRunRow | undefined;
      if (!run) return res.status(404).json({ error: 'Finalize run not found' });

      // Cross-project lookups are masked as 404 (not 403) — we don't want
      // to leak the existence of runs that belong to other projects.
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

  // Latest finalize run for a session (convenience for the panel).
  router.get('/api/sessions/:sessionId/finalize-runs/latest', (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string;
    const run = stmts.getLatestFinalizeRunForSession.get(sessionId) as FinalizeRunRow | undefined;
    // "no runs yet" is a normal first-load state — we return 200 + null
    // rather than 404 so the client can branch cleanly on a single shape.
    return res.json({ run: run ?? null });
  });

  return router;
}
