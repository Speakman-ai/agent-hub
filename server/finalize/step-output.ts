import { stripAnsi } from '../ansi-strip.js';
import type { FinalizeRunStepRow, MessageRow, Stmts } from '../types.js';

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
