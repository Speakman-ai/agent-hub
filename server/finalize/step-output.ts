import { stripAnsi } from '../ansi-strip.js';
import type { FinalizeRunStepRow, MessageRow, Stmts } from '../types.js';
import { getOrgsDb } from '../orgs.js';
import { getRunnerJobLogsDb } from './runner-logs-db.js';

export interface FinalizeStepOutputLine {
  stream: 'stdout' | 'stderr';
  text: string;
  created_at: string;
}

export function mapFinalizeRunStepRow(row: FinalizeRunStepRow) {
  return {
    index: row.step_index,
    name: row.name,
    state: row.state,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    jobId: row.job_id,
    matrixKey: row.matrix_key,
  };
}

export function listFinalizeRunJobs(
  stmts: Pick<Stmts, 'listFinalizeRunJobsForRun'>,
  runId: string,
) {
  return (
    stmts.listFinalizeRunJobsForRun.all(runId) as import('../types.js').FinalizeRunJobRow[]
  ).map((row) => ({
    jobId: row.job_id,
    matrixKey: row.matrix_key,
    state: row.state,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }));
}

export function listFinalizeRunSteps(
  stmts: Pick<Stmts, 'listFinalizeRunStepsForRun'>,
  runId: string,
): ReturnType<typeof mapFinalizeRunStepRow>[] {
  const rows = stmts.listFinalizeRunStepsForRun.all(runId) as FinalizeRunStepRow[];
  return rows.map(mapFinalizeRunStepRow);
}

/**
 * Load streamed CI output lines for one finalize step from session messages.
 */
export function loadFinalizeStepOutput(
  stmts: Pick<Stmts, 'getMessages'>,
  args: { sessionId: string; runId: string; stepIndex: number },
): FinalizeStepOutputLine[] {
  const rows = stmts.getMessages.all(args.sessionId) as MessageRow[];
  const out: FinalizeStepOutputLine[] = [];
  for (const row of rows) {
    if (!row.metadata) continue;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (meta.kind !== 'finalize_step_output') continue;
    const runId = meta.runId ?? meta.run_id;
    if (runId !== args.runId) continue;
    const stepIndex = meta.stepIndex ?? meta.step_index;
    if (stepIndex !== args.stepIndex) continue;
    const stream = meta.stream === 'stderr' ? 'stderr' : 'stdout';
    const body = row.content ?? '';
    const raw = body.replace(/^\[(stdout|stderr)\]\s*/, '');
    out.push({ stream, text: stripAnsi(raw), created_at: row.created_at });
  }
  return out;
}

interface RunnerJobLogRow {
  stream: 'stdout' | 'stderr';
  data: string;
  at: number;
}

interface RunnerQueueJobRow {
  id: string;
}

interface RunnerJobLogCountRow {
  n: number;
}

export interface FinalizeStepOutputResult {
  lines: FinalizeStepOutputLine[];
  truncated: boolean;
  totalLines: number;
}

const RUNNER_QUEUE_STEP_OUTPUT_MAX_LINES = 5_000;
const RUNNER_QUEUE_STEP_OUTPUT_TAIL_LINES = 40;

/**
 * Load remote-runner log frames for a finalize step from the runner queue spool.
 *
 * Remote fleet agents persist stdout/stderr into the dedicated `runner-logs.db`
 * spool, while the Runners page reads this finalize-step endpoint. The finalize
 * step row stores the logical job id + matrix key, so we bridge that to the
 * newest queue job (in orgs.db) for the same project/run/job/matrix and then
 * read the frames for the step from the spool DB. The queue-job lookup and the
 * frame reads are two separate queries against two files, never a JOIN.
 */
export function loadRunnerQueueStepOutput(args: {
  projectId: string;
  runId: string;
  step: Pick<FinalizeRunStepRow, 'step_index' | 'job_id' | 'matrix_key'>;
  maxLines?: number;
}): FinalizeStepOutputResult {
  if (!args.step.job_id) return { lines: [], truncated: false, totalLines: 0 };
  const matrixKey = args.step.matrix_key ?? '';
  const job = getOrgsDb()
    .prepare(
      `SELECT id
         FROM runner_jobs
        WHERE project_id = @projectId
          AND run_id = @runId
          AND job_id = @jobId
          AND matrix_key = @matrixKey
        ORDER BY enqueued_at DESC
        LIMIT 1`,
    )
    .get({
      projectId: args.projectId,
      runId: args.runId,
      jobId: args.step.job_id,
      matrixKey,
    }) as RunnerQueueJobRow | undefined;
  if (!job) return { lines: [], truncated: false, totalLines: 0 };

  const maxLines =
    typeof args.maxLines === 'number' && Number.isFinite(args.maxLines) && args.maxLines > 0
      ? Math.floor(args.maxLines)
      : RUNNER_QUEUE_STEP_OUTPUT_MAX_LINES;
  const logsDb = getRunnerJobLogsDb();
  const totalLines = (
    logsDb
      .prepare(
        `SELECT COUNT(*) AS n
           FROM runner_job_logs
          WHERE job_id = @jobId AND step_index = @stepIndex`,
      )
      .get({ jobId: job.id, stepIndex: args.step.step_index }) as RunnerJobLogCountRow
  ).n;
  if (totalLines <= 0) return { lines: [], truncated: false, totalLines: 0 };

  const loadRows = (sql: string, limit: number): RunnerJobLogRow[] => {
    if (limit <= 0) return [];
    return logsDb
      .prepare(sql)
      .all({ jobId: job.id, stepIndex: args.step.step_index, limit }) as RunnerJobLogRow[];
  };
  const mapRows = (rows: RunnerJobLogRow[]): FinalizeStepOutputLine[] =>
    rows.map((row) => ({
      stream: row.stream === 'stderr' ? 'stderr' : 'stdout',
      text: stripAnsi(row.data),
      created_at: new Date(row.at).toISOString(),
    }));

  if (totalLines <= maxLines) {
    const rows = loadRows(
      `SELECT stream, data, at
         FROM runner_job_logs
        WHERE job_id = @jobId AND step_index = @stepIndex
        ORDER BY seq ASC
        LIMIT @limit`,
      maxLines,
    );
    return { lines: mapRows(rows), truncated: false, totalLines };
  }

  const tailLimit = Math.min(
    RUNNER_QUEUE_STEP_OUTPUT_TAIL_LINES,
    Math.max(0, Math.floor((maxLines - 1) / 2)),
  );
  const headLimit = Math.max(0, maxLines - tailLimit - 1);
  const headRows = loadRows(
    `SELECT stream, data, at
       FROM runner_job_logs
      WHERE job_id = @jobId AND step_index = @stepIndex
      ORDER BY seq ASC
      LIMIT @limit`,
    headLimit,
  );
  const tailRows = loadRows(
    `SELECT stream, data, at
       FROM runner_job_logs
      WHERE job_id = @jobId AND step_index = @stepIndex
      ORDER BY seq DESC
      LIMIT @limit`,
    tailLimit,
  ).reverse();
  const dropped = Math.max(0, totalLines - headRows.length - tailRows.length);
  const lines = mapRows(headRows);
  lines.push({
    stream: 'stderr',
    text:
      `[output truncated] ${dropped} of ${totalLines} lines omitted ` +
      `(runner spool response limited to ${maxLines} lines)` +
      (tailRows.length ? `; last ${tailRows.length} lines follow` : ''),
    created_at: '',
  });
  lines.push(...mapRows(tailRows));
  return { lines, truncated: true, totalLines };
}
