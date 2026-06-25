/**
 * ci-runs.ts — run-history read surface for the Runners page.
 *
 * Lists past CI executions for a project across every trigger source
 * (Finalize runs and report-only push-CI runs share the finalize_runs
 * tables), plus a per-run detail with job and step rows. Mounted behind
 * authMiddleware + the project visibility gate like every other
 * `/api/projects/:projectId/*` router. Step LOG content stays on the
 * existing `GET .../finalize/:runId/steps/:stepIndex/output` route.
 */

import { Router, type Request, type Response } from 'express';
import type { FinalizeRunRow, Project, RouteDeps } from '../types.js';
import { getDb } from '../db.js';
import { rerunCiRun } from '../git-host/push-ci.js';
import { z, registerPath } from '../openapi/registry.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const TRIGGERS = new Set(['all', 'ui_button', 'agent_block', 'git_push', 'pr_push']);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const ErrorResponse = z.object({ error: z.string() });

const CiRunJobSchema = z.object({
  job_id: z.string(),
  matrix_key: z.string(),
  state: z.string(),
  exit_code: z.number().nullable(),
  started_at: z.number().nullable(),
  ended_at: z.number().nullable(),
});

const CiRunSchema = z.object({
  id: z.string(),
  branch: z.string(),
  head_sha: z.string(),
  status: z.string(),
  mode: z.string(),
  trigger_source: z.string(),
  failure_reason: z.string().nullable(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  session_id: z.string().nullable(),
  /** Human-readable title of the run's session, when one is linked. */
  session_title: z.string().nullable(),
  jobs: z.array(CiRunJobSchema),
});

const CiRunStepSchema = z.object({
  step_index: z.number(),
  name: z.string(),
  state: z.string(),
  exit_code: z.number().nullable(),
  started_at: z.number().nullable(),
  ended_at: z.number().nullable(),
  job_id: z.string().nullable(),
  matrix_key: z.string().nullable(),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/ci-runs',
  tags: ['Projects'],
  summary: 'List past CI runs for a project (Runners page history)',
  description:
    'Finalize runs and push-CI runs (trigger_source git_push) newest first, each with per-job results. Filter by trigger via ?trigger=.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({
      trigger: z.enum(['all', 'ui_button', 'agent_block', 'git_push', 'pr_push']).optional(),
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Run history.',
      content: jsonContent(z.object({ runs: z.array(CiRunSchema) })),
    },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/ci-runs/{runId}',
  tags: ['Projects'],
  summary: 'Single CI run with job and step rows',
  request: { params: z.object({ projectId: z.string(), runId: z.string() }) },
  responses: {
    200: {
      description: 'Run detail.',
      content: jsonContent(z.object({ run: CiRunSchema, steps: z.array(CiRunStepSchema) })),
    },
    404: { description: 'Unknown project or run.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/ci-runs/{runId}/rerun',
  tags: ['Projects'],
  summary: 'Re-run a finished CI run (all jobs, or one job)',
  description:
    'GitHub-style re-run for push / pr-ci runs against the SAME commit. Pass jobId to re-run a single job. Finalize runs are excluded (400) — re-run those via the Finalize button.',
  request: {
    params: z.object({ projectId: z.string(), runId: z.string() }),
    body: {
      content: jsonContent(z.object({ jobId: z.string().optional() })),
      required: false,
    },
  },
  responses: {
    202: { description: 'Re-run queued.', content: jsonContent(z.object({ ok: z.boolean() })) },
    400: { description: 'Not a re-runnable CI run.', content: jsonContent(ErrorResponse) },
    404: { description: 'Unknown project or run.', content: jsonContent(ErrorResponse) },
    409: { description: 'Run still in progress.', content: jsonContent(ErrorResponse) },
  },
});

/**
 * Batch-load `session_id -> session.name` for every distinct, non-null
 * session id across a set of runs in ONE query. The list endpoint returns
 * up to MAX_LIMIT runs; resolving titles per-row would be an N+1 lookup, so
 * we collect the ids and fetch them all at once. Empty input short-circuits
 * (an empty `IN ()` is not valid SQLite).
 */
function loadSessionTitles(rows: FinalizeRunRow[]): Map<string, string> {
  const ids = [...new Set(rows.map((r) => r.session_id).filter((id): id is string => !!id))];
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  const placeholders = ids.map(() => '?').join(',');
  const sessions = getDb()
    .prepare(`SELECT id, name FROM sessions WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string; name: string | null }>;
  for (const s of sessions) {
    if (s.name != null) titles.set(s.id, s.name);
  }
  return titles;
}

function serializeRun(
  deps: RouteDeps,
  row: FinalizeRunRow,
  sessionTitles: Map<string, string>,
): Record<string, unknown> {
  const jobs = deps.stmts.listFinalizeRunJobsForRun.all(row.id) as Array<Record<string, unknown>>;
  // Surface the linked session's title so the Runners history reads as
  // human-readable work ("Fix login redirect") instead of an opaque
  // `agent-hub/<agent>/session-<id>` branch. Push / pr-ci runs have no
  // session (session_id null) and fall back to the branch in the UI.
  const sessionTitle = row.session_id ? (sessionTitles.get(row.session_id) ?? null) : null;
  return {
    id: row.id,
    branch: row.branch,
    head_sha: row.head_sha,
    status: row.status,
    mode: row.mode,
    trigger_source: row.trigger_source,
    failure_reason: row.failure_reason,
    started_at: row.started_at,
    ended_at: row.ended_at,
    session_id: row.session_id,
    session_title: sessionTitle,
    jobs,
  };
}

export default function createCiRunsRoutes(deps: RouteDeps): Router {
  const router = Router();

  const findProjectOr404 = (req: Request, res: Response): Project | null => {
    const project = deps.findProject(req.params.projectId as string);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return project;
  };

  router.get('/api/projects/:projectId/ci-runs', (req: Request, res: Response) => {
    const project = findProjectOr404(req, res);
    if (!project) return;
    const triggerRaw = typeof req.query.trigger === 'string' ? req.query.trigger : 'all';
    const trigger = TRIGGERS.has(triggerRaw) ? triggerRaw : 'all';
    let limit = Number.parseInt((req.query.limit as string) || '', 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const rows = deps.stmts.listFinalizeRunsForProject.all(
      project.id,
      trigger,
      trigger,
      limit,
    ) as FinalizeRunRow[];
    const sessionTitles = loadSessionTitles(rows);
    res.json({ runs: rows.map((r) => serializeRun(deps, r, sessionTitles)) });
  });

  router.get('/api/projects/:projectId/ci-runs/:runId', (req: Request, res: Response) => {
    const project = findProjectOr404(req, res);
    if (!project) return;
    const run = deps.stmts.getFinalizeRun.get(req.params.runId as string) as
      | FinalizeRunRow
      | undefined;
    if (!run || run.project_id !== project.id) {
      return res.status(404).json({ error: 'Run not found' });
    }
    const steps = deps.stmts.listFinalizeRunStepsForRun.all(run.id) as Array<
      Record<string, unknown>
    >;
    res.json({ run: serializeRun(deps, run, loadSessionTitles([run])), steps });
  });

  router.post('/api/projects/:projectId/ci-runs/:runId/rerun', (req: Request, res: Response) => {
    const project = findProjectOr404(req, res);
    if (!project) return;
    const run = deps.stmts.getFinalizeRun.get(req.params.runId as string) as
      | FinalizeRunRow
      | undefined;
    if (!run || run.project_id !== project.id) {
      return res.status(404).json({ error: 'Run not found' });
    }
    // Only the report-only CI engine re-runs here; Finalize runs re-run
    // through the Finalize button (review + fix-loop semantics).
    if (run.trigger_source !== 'git_push' && run.trigger_source !== 'pr_push') {
      return res
        .status(400)
        .json({ error: 'Only CI runs (push / pr ci) can be re-run from here.' });
    }
    if (run.status === 'queued' || run.status === 'running') {
      return res.status(409).json({ error: 'Run is still in progress.' });
    }
    const jobId =
      typeof (req.body as Record<string, unknown> | undefined)?.jobId === 'string'
        ? String((req.body as Record<string, unknown>).jobId)
        : undefined;
    // Fire-and-forget: progress arrives via finalize_run_* broadcasts and
    // the run list. The per-project queue serializes with other CI work.
    void rerunCiRun(project, run, { stmts: deps.stmts, broadcast: deps.broadcast }, { jobId });
    res.status(202).json({ ok: true });
  });

  return router;
}
