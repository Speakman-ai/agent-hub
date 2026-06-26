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

import path from 'path';
import { Router, type Request, type Response } from 'express';
import type { FinalizeRunRow, Project, RouteDeps } from '../types.js';
import { getDb } from '../db.js';
import { rerunCiRun } from '../git-host/push-ci.js';
import { z, registerPath } from '../openapi/registry.js';
import { loadCiConfigFromFile, type AnyCiConfig } from '../finalize/ci-config.js';
import { matrixKeyFromRow } from '../finalize/ci-config-v2.js';
import { DEFAULT_CI_CONFIG_RELATIVE_PATH } from '../finalize/finalize-keys.js';
import { isInfraFailureReason } from '../finalize/infra-retry.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const TRIGGERS = new Set(['all', 'ui_button', 'agent_block', 'git_push', 'pr_push']);
const STATS_RANGES = new Set(['all', '24h']);

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

const CiRunStatsBucketSchema = z.object({
  average_seconds: z.number().nullable(),
  total_runs: z.number().int(),
  failed_runs: z.number().int(),
  failure_rate: z.number().nullable(),
  total_errors: z.number().int(),
  infra_errors: z.number().int(),
  infra_error_rate: z.number().nullable(),
});

const CiRunTestStatsSchema = CiRunStatsBucketSchema.extend({
  job_id: z.string(),
  matrix_key: z.string(),
  name: z.string(),
  configured: z.boolean(),
});

const CiRunStatsRangeSchema = z.enum(['all', '24h']);

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
  path: '/api/projects/{projectId}/ci-runs/stats',
  tags: ['Projects'],
  summary: 'Runner card completion and failure-rate stats',
  description:
    'Aggregates completed Runner runs for the Runners page. Per-test stats are limited to jobs currently configured in ci.yaml; configured jobs are returned even before they have historical samples.',
  request: {
    params: z.object({ projectId: z.string() }),
    query: z.object({ range: CiRunStatsRangeSchema.optional() }),
  },
  responses: {
    200: {
      description: 'Runner stats.',
      content: jsonContent(
        z.object({
          range: CiRunStatsRangeSchema,
          overall: CiRunStatsBucketSchema,
          tests: z.array(CiRunTestStatsSchema),
          ci_config: z.object({
            found: z.boolean(),
            version: z.number().nullable(),
            error: z.string().nullable(),
          }),
        }),
      ),
    },
    404: { description: 'Unknown project.', content: jsonContent(ErrorResponse) },
    500: { description: 'Stats could not be read.', content: jsonContent(ErrorResponse) },
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

interface StatsBucket {
  average_seconds: number | null;
  total_runs: number;
  failed_runs: number;
  failure_rate: number | null;
  total_errors: number;
  infra_errors: number;
  infra_error_rate: number | null;
}

interface MutableStatsBucket {
  durationSecondsTotal: number;
  durationSamples: number;
  totalRuns: number;
  failedRuns: number;
  totalErrors: number;
  infraErrors: number;
}

interface ConfiguredTest {
  job_id: string;
  matrix_key: string;
  name: string;
}

type CiRunStatsRange = z.infer<typeof CiRunStatsRangeSchema>;

const SUCCESS_RUN_STATUSES = new Set(['succeeded', 'ready_to_push', 'pushed']);
const IN_FLIGHT_JOB_STATES = new Set(['queued', 'running']);

function emptyMutableStats(): MutableStatsBucket {
  return {
    durationSecondsTotal: 0,
    durationSamples: 0,
    totalRuns: 0,
    failedRuns: 0,
    totalErrors: 0,
    infraErrors: 0,
  };
}

function serializeStats(bucket: MutableStatsBucket): StatsBucket {
  return {
    average_seconds:
      bucket.durationSamples > 0 ? bucket.durationSecondsTotal / bucket.durationSamples : null,
    total_runs: bucket.totalRuns,
    failed_runs: bucket.failedRuns,
    failure_rate: bucket.totalRuns > 0 ? bucket.failedRuns / bucket.totalRuns : null,
    total_errors: bucket.totalErrors,
    infra_errors: bucket.infraErrors,
    infra_error_rate: bucket.totalErrors > 0 ? bucket.infraErrors / bucket.totalErrors : null,
  };
}

function addDuration(bucket: MutableStatsBucket, startedAt: number | null, endedAt: number | null) {
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number' || endedAt < startedAt) return;
  bucket.durationSecondsTotal += (endedAt - startedAt) / 1000;
  bucket.durationSamples++;
}

function runFailed(status: string): boolean {
  return !SUCCESS_RUN_STATUSES.has(status);
}

function runInfraFailed(status: string, failureReason: string | null): boolean {
  return status === 'infra_error' || isInfraFailureReason(failureReason);
}

function jobFailed(state: string, exitCode: number | null): boolean {
  if (state === 'passed' || state === 'success' || state === 'skipped') return false;
  if (IN_FLIGHT_JOB_STATES.has(state)) return false;
  return state === 'failed' || state === 'failure' || state === 'timeout' || exitCode !== 0;
}

function statsKey(jobId: string, matrixKey: string): string {
  return `${jobId}\u0000${matrixKey}`;
}

function configuredTestsFromCi(config: AnyCiConfig): ConfiguredTest[] {
  if (config.version === 1) {
    return config.steps.map((step, i) => ({
      job_id: step.name || `step ${i + 1}`,
      matrix_key: '',
      name: step.name || `step ${i + 1}`,
    }));
  }
  const tests: ConfiguredTest[] = [];
  for (const [jobId, job] of Object.entries(config.jobs)) {
    const matrixRows = job.matrixInclude.length > 0 ? job.matrixInclude : [{}];
    for (const matrixRow of matrixRows) {
      const matrixKey = matrixKeyFromRow(matrixRow);
      const label = matrixRow.label || matrixRow.name || matrixRow.group || matrixKey;
      tests.push({
        job_id: jobId,
        matrix_key: matrixKey,
        name: label ? `${jobId} / ${label}` : jobId,
      });
    }
  }
  return tests;
}

async function loadConfiguredTests(project: Project): Promise<{
  tests: ConfiguredTest[];
  ciConfig: { found: boolean; version: number | null; error: string | null };
}> {
  const ciPath = path.join(project.cwd, DEFAULT_CI_CONFIG_RELATIVE_PATH);
  let parsed: Awaited<ReturnType<typeof loadCiConfigFromFile>>;
  try {
    parsed = await loadCiConfigFromFile(ciPath);
  } catch (err) {
    return {
      tests: [],
      ciConfig: {
        found: true,
        version: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
  if (!parsed.ok) {
    return {
      tests: [],
      ciConfig: {
        found: parsed.error.message.includes('file not found') ? false : true,
        version: null,
        error: parsed.error.message,
      },
    };
  }
  return {
    tests: configuredTestsFromCi(parsed.config),
    ciConfig: { found: true, version: parsed.config.version, error: null },
  };
}

async function buildCiRunStats(project: Project, range: CiRunStatsRange) {
  const configured = await loadConfiguredTests(project);
  const overall = emptyMutableStats();
  const byTest = new Map<string, MutableStatsBucket>();
  const names = new Map<string, ConfiguredTest>();
  const configuredKeys = new Set(
    configured.tests.map((test) => statsKey(test.job_id, test.matrix_key)),
  );
  for (const test of configured.tests) {
    const key = statsKey(test.job_id, test.matrix_key);
    byTest.set(key, emptyMutableStats());
    names.set(key, test);
  }

  const completedAfter = range === '24h' ? Date.now() - 24 * 60 * 60 * 1000 : null;
  const rows = getDb()
    .prepare(
      `SELECT
          r.id AS run_id,
          r.status AS run_status,
          r.failure_reason AS failure_reason,
          r.started_at AS run_started_at,
          r.ended_at AS run_ended_at,
          j.job_id AS job_id,
          j.matrix_key AS matrix_key,
          j.state AS job_state,
          j.exit_code AS job_exit_code,
          j.started_at AS job_started_at,
          j.ended_at AS job_ended_at
        FROM finalize_runs r
        LEFT JOIN finalize_run_jobs j ON j.run_id = r.id
        WHERE r.project_id = ?
          AND r.ended_at IS NOT NULL
          AND (? IS NULL OR r.ended_at >= ?)
        ORDER BY r.started_at ASC, j.job_id ASC, j.matrix_key ASC`,
    )
    .all(project.id, completedAfter, completedAfter) as Array<{
    run_id: string;
    run_status: string;
    failure_reason: string | null;
    run_started_at: number;
    run_ended_at: number | null;
    job_id: string | null;
    matrix_key: string | null;
    job_state: string | null;
    job_exit_code: number | null;
    job_started_at: number | null;
    job_ended_at: number | null;
  }>;

  const seenRuns = new Set<string>();
  for (const row of rows) {
    if (!seenRuns.has(row.run_id)) {
      seenRuns.add(row.run_id);
      overall.totalRuns++;
      addDuration(overall, row.run_started_at, row.run_ended_at);
      if (runFailed(row.run_status)) {
        overall.failedRuns++;
        overall.totalErrors++;
        if (runInfraFailed(row.run_status, row.failure_reason)) overall.infraErrors++;
      }
    }

    if (!row.job_id || !row.job_state || IN_FLIGHT_JOB_STATES.has(row.job_state)) continue;
    const matrixKey = row.matrix_key ?? '';
    const key = statsKey(row.job_id, matrixKey);
    const bucket = byTest.get(key);
    if (!bucket) continue;
    bucket.totalRuns++;
    addDuration(bucket, row.job_started_at, row.job_ended_at);
    if (jobFailed(row.job_state, row.job_exit_code)) {
      bucket.failedRuns++;
      bucket.totalErrors++;
      if (runInfraFailed(row.run_status, row.failure_reason)) bucket.infraErrors++;
    }
  }

  const tests = [...byTest.entries()]
    .map(([key, bucket]) => {
      const info = names.get(key)!;
      return {
        ...info,
        configured: configuredKeys.has(key),
        ...serializeStats(bucket),
      };
    })
    .sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return {
    range,
    overall: serializeStats(overall),
    tests,
    ci_config: configured.ciConfig,
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

  router.get('/api/projects/:projectId/ci-runs/stats', async (req: Request, res: Response) => {
    const project = findProjectOr404(req, res);
    if (!project) return;
    const rangeRaw = typeof req.query.range === 'string' ? req.query.range : 'all';
    const range = STATS_RANGES.has(rangeRaw) ? (rangeRaw as CiRunStatsRange) : 'all';
    try {
      res.json(await buildCiRunStats(project, range));
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to read CI run stats',
      });
    }
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
