/**
 * `GET /api/projects/:projectId/finalize/default-branch-health`
 *
 * Whether the project's default branch is red according to the full push-CI
 * run after each merge: the instances still failing, and the open breakage
 * with its kanban card. Rows are written by
 * `server/finalize/default-branch-health.ts`; this route only reads them.
 */
import { Router, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { RouteDeps } from '../types.js';
import { getDb } from '../db.js';
import type {
  DefaultBranchBreakageRow,
  DefaultBranchCiStateRow,
  DefaultBranchFailureRow,
} from '../finalize/default-branch-health.js';

export interface DefaultBranchHealthRouteOpts {
  db?: () => Database.Database;
}

export interface DefaultBranchHealthResponse {
  project_id: string;
  state: 'green' | 'red' | 'unknown';
  branch: string | null;
  last_sha: string | null;
  last_status: 'succeeded' | 'failed' | null;
  updated_at: number | null;
  breakage: {
    id: string;
    card_id: string | null;
    first_failing_sha: string;
    last_failing_sha: string;
    created_at: number;
  } | null;
  failures: Array<{
    job_id: string;
    matrix_key: string;
    first_failing_sha: string;
    last_failing_sha: string;
    last_run_id: string | null;
  }>;
}

export function readDefaultBranchHealth(
  db: Database.Database,
  projectId: string,
): DefaultBranchHealthResponse {
  const state = db
    .prepare(`SELECT * FROM default_branch_ci_state WHERE project_id = ?`)
    .get(projectId) as DefaultBranchCiStateRow | undefined;
  const failures = db
    .prepare(
      `SELECT * FROM default_branch_failures WHERE project_id = ? ORDER BY job_id, matrix_key`,
    )
    .all(projectId) as DefaultBranchFailureRow[];
  const breakage = db
    .prepare(
      `SELECT * FROM default_branch_breakages
        WHERE project_id = ? AND status = 'open'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(projectId) as DefaultBranchBreakageRow | undefined;
  const red = failures.length > 0 || !!breakage;
  return {
    project_id: projectId,
    state: red ? 'red' : state ? 'green' : 'unknown',
    branch: state?.branch ?? breakage?.branch ?? failures[0]?.branch ?? null,
    last_sha: state?.last_sha ?? null,
    last_status: state?.last_status ?? null,
    updated_at: state?.updated_at ?? null,
    breakage: breakage
      ? {
          id: breakage.id,
          card_id: breakage.card_id,
          first_failing_sha: breakage.first_failing_sha,
          last_failing_sha: breakage.last_failing_sha,
          created_at: breakage.created_at,
        }
      : null,
    failures: failures.map((f) => ({
      job_id: f.job_id,
      matrix_key: f.matrix_key,
      first_failing_sha: f.first_failing_sha,
      last_failing_sha: f.last_failing_sha,
      last_run_id: f.last_run_id,
    })),
  };
}

export default function createDefaultBranchHealthRoutes(
  deps: Pick<RouteDeps, 'findProject'>,
  opts: DefaultBranchHealthRouteOpts = {},
): Router {
  const router = Router();
  router.get(
    '/api/projects/:projectId/finalize/default-branch-health',
    (req: Request, res: Response) => {
      const project = deps.findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      try {
        return res.json(readDefaultBranchHealth((opts.db ?? getDb)(), project.id));
      } catch (err) {
        console.warn(
          `[default-branch-health] read failed for project=${project.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return res.status(500).json({ error: 'default_branch_health_read_failed' });
      }
    },
  );
  return router;
}
