import { describe, it, expect, vi } from 'vitest';
import { reconcileFinalizeRunTerminalSteps } from './reconcile-terminal-steps.js';
import type { FinalizeRunStepRow } from '../types.js';

/**
 * Regression coverage for the recurring "Finalize run appears to be running but
 * has failed" report: a terminally-failed v2 matrix run leaves sibling shard
 * step rows stuck `queued`/`running` and never records WHICH step failed.
 * `reconcileFinalizeRunTerminalSteps` must (a) backfill the failed-step summary
 * and (b) sweep the stranded rows to `skipped` + broadcast each.
 */

function step(partial: Partial<FinalizeRunStepRow> & { step_index: number; state: string }) {
  return {
    run_id: 'run-1',
    name: `step ${partial.step_index}`,
    exit_code: null,
    started_at: null,
    ended_at: null,
    job_id: null,
    matrix_key: null,
    log_storage_kind: null,
    log_storage_bucket: null,
    log_storage_region: null,
    log_key: null,
    log_lines: null,
    log_truncated: null,
    log_attempt: null,
    ...partial,
  } as unknown as FinalizeRunStepRow;
}

function makeDeps(steps: FinalizeRunStepRow[]) {
  const skipCalls: Array<[string, number]> = [];
  const backfillCalls: Array<unknown[]> = [];
  const broadcasts: Record<string, unknown>[] = [];
  const deps = {
    stmts: {
      listFinalizeRunStepsForRun: { all: vi.fn(() => steps) },
      // Only flips rows still in a non-terminal state — mirror the SQL guard.
      markFinalizeRunStepSkippedIfPending: {
        run: vi.fn((runId: string, stepIndex: number) => {
          skipCalls.push([runId, stepIndex]);
          const row = steps.find((s) => s.step_index === stepIndex);
          const pending = row && (row.state === 'queued' || row.state === 'running');
          return { changes: pending ? 1 : 0 };
        }),
      },
      backfillFinalizeRunFailedStep: {
        run: vi.fn((...args: unknown[]) => {
          backfillCalls.push(args);
          return { changes: 1 };
        }),
      },
    },
    broadcast: (data: Record<string, unknown>) => {
      broadcasts.push(data);
    },
  } as never;
  return { deps, skipCalls, backfillCalls, broadcasts };
}

describe('reconcileFinalizeRunTerminalSteps', () => {
  it('backfills failed-step summary and sweeps stranded sibling shards', () => {
    // Mirrors the captured repro: shard 1 (idx 8) failed, shard 2 (idx 9)
    // passed, shard 3 (idx 10) never started, client (idx 11) still running.
    const steps = [
      step({ step_index: 8, state: 'failed', exit_code: 1, name: 'server 1/3', job_id: 'test' }),
      step({ step_index: 9, state: 'passed', exit_code: 0, name: 'server 2/3', job_id: 'test' }),
      step({ step_index: 10, state: 'queued', name: 'server 3/3', job_id: 'test' }),
      step({
        step_index: 11,
        state: 'running',
        name: 'client',
        job_id: 'test',
        matrix_key: 'suite=client',
      }),
    ];
    const { deps, backfillCalls, broadcasts } = makeDeps(steps);

    const result = reconcileFinalizeRunTerminalSteps(deps, 'run-1', 'sess-1');

    // (a) failed-step summary backfilled from the FIRST failed step (idx 8).
    expect(backfillCalls).toHaveLength(1);
    expect(backfillCalls[0]).toEqual([8, 'server 1/3', 1, 'run-1']);
    expect(result.backfilledFailedStep).toEqual({ index: 8, name: 'server 1/3', exitCode: 1 });

    // (b) only the two non-terminal rows are swept; passed/failed untouched.
    expect(result.sweptStepIndexes).toEqual([10, 11]);

    // (c) a terminal `skipped` step event is broadcast for each swept row,
    //     carrying session + job/matrix context so the checks panel converges.
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[0]).toMatchObject({
      type: 'finalize_run_step_state',
      run_id: 'run-1',
      session_id: 'sess-1',
      step_index: 10,
      state: 'skipped',
      job_id: 'test',
    });
    expect(broadcasts[1]).toMatchObject({
      step_index: 11,
      state: 'skipped',
      matrix_key: 'suite=client',
    });
  });

  it('is a no-op when every step row is already terminal', () => {
    const steps = [
      step({ step_index: 1, state: 'passed', exit_code: 0 }),
      step({ step_index: 2, state: 'failed', exit_code: 1 }),
      step({ step_index: 3, state: 'skipped' }),
    ];
    const { deps, broadcasts, skipCalls } = makeDeps(steps);

    const result = reconcileFinalizeRunTerminalSteps(deps, 'run-1', 'sess-1');

    expect(result.sweptStepIndexes).toEqual([]);
    expect(skipCalls).toEqual([]); // never attempts to sweep terminal rows
    expect(broadcasts).toEqual([]);
  });

  it('does not broadcast when the sweep statement reports zero changes (raced)', () => {
    // A concurrent terminal write flipped the row between read and sweep:
    // listed as `running` but the guarded UPDATE matches nothing now.
    const steps = [step({ step_index: 5, state: 'running' })];
    const { deps, broadcasts } = makeDeps(steps);
    // Force the guarded update to report no change.
    (
      deps as unknown as {
        stmts: { markFinalizeRunStepSkippedIfPending: { run: ReturnType<typeof vi.fn> } };
      }
    ).stmts.markFinalizeRunStepSkippedIfPending.run = vi.fn(() => ({ changes: 0 }));

    const result = reconcileFinalizeRunTerminalSteps(deps, 'run-1', 'sess-1');

    expect(result.sweptStepIndexes).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('omits session_id from broadcasts for ad-hoc (session-less) runs', () => {
    const steps = [step({ step_index: 2, state: 'running' })];
    const { deps, broadcasts } = makeDeps(steps);

    reconcileFinalizeRunTerminalSteps(deps, 'run-1', null);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).not.toHaveProperty('session_id');
  });

  it('does not backfill when there is no failed step (e.g. cancel mid-flight)', () => {
    const steps = [
      step({ step_index: 1, state: 'passed', exit_code: 0 }),
      step({ step_index: 2, state: 'running' }),
    ];
    const { deps, backfillCalls } = makeDeps(steps);
    const out = reconcileFinalizeRunTerminalSteps(deps, 'run-1', 'sess-1');

    expect(backfillCalls).toEqual([]);
    expect(out.backfilledFailedStep).toBeNull();
    expect(out.sweptStepIndexes).toEqual([2]);
  });
});
