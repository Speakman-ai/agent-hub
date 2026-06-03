import { describe, expect, it, vi } from 'vitest';
import type { Stmts } from '../types.js';
import {
  loadFinalizeStepOutput,
  listFinalizeRunSteps,
  mapFinalizeRunStepRow,
} from './step-output.js';

describe('step-output', () => {
  it('maps persisted step rows to client shape', () => {
    expect(
      mapFinalizeRunStepRow({
        run_id: 'run-1',
        step_index: 2,
        name: 'backend-tests',
        state: 'failed',
        exit_code: 127,
        started_at: 1000,
        ended_at: 2000,
        job_id: 'e2e',
        matrix_key: 'Profiles_Tasks',
      }),
    ).toEqual({
      index: 2,
      name: 'backend-tests',
      state: 'failed',
      exitCode: 127,
      startedAt: 1000,
      endedAt: 2000,
      jobId: 'e2e',
      matrixKey: 'Profiles_Tasks',
    });
  });

  it('loads finalize_step_output messages for a run/step', () => {
    const stmts = {
      getMessages: {
        all: vi.fn(() => [
          {
            id: 'm1',
            session_id: 'sess-1',
            role: 'system',
            content: '[stderr] pip: command not found',
            metadata: JSON.stringify({
              kind: 'finalize_step_output',
              runId: 'run-1',
              stepIndex: 1,
              stream: 'stderr',
            }),
            created_at: '2026-05-29T12:00:00.000Z',
          },
          {
            id: 'm2',
            session_id: 'sess-1',
            role: 'system',
            content: '[stdout] ok',
            metadata: JSON.stringify({
              kind: 'finalize_step_output',
              runId: 'run-1',
              stepIndex: 1,
              stream: 'stdout',
            }),
            created_at: '2026-05-29T12:00:01.000Z',
          },
          {
            id: 'm3',
            session_id: 'sess-1',
            role: 'system',
            content: '[stdout] other step',
            metadata: JSON.stringify({
              kind: 'finalize_step_output',
              runId: 'run-1',
              stepIndex: 2,
              stream: 'stdout',
            }),
            created_at: '2026-05-29T12:00:02.000Z',
          },
        ]),
      },
    };

    const lines = loadFinalizeStepOutput(stmts as unknown as Pick<Stmts, 'getMessages'>, {
      sessionId: 'sess-1',
      runId: 'run-1',
      stepIndex: 1,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('pip: command not found');
    expect(lines[0].stream).toBe('stderr');
    expect(lines[1].text).toBe('ok');
  });

  it('strips ANSI color codes from step output lines', () => {
    const stmts = {
      getMessages: {
        all: vi.fn(() => [
          {
            id: 'm1',
            session_id: 'sess-1',
            role: 'system',
            content: '[stdout] \u001b[32mCleanup complete!\u001b[0m',
            metadata: JSON.stringify({
              kind: 'finalize_step_output',
              runId: 'run-1',
              stepIndex: 3,
              stream: 'stdout',
            }),
            created_at: '2026-05-29T12:00:00.000Z',
          },
        ]),
      },
    };

    const lines = loadFinalizeStepOutput(stmts as unknown as Pick<Stmts, 'getMessages'>, {
      sessionId: 'sess-1',
      runId: 'run-1',
      stepIndex: 3,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Cleanup complete!');
  });

  it('lists steps ordered by index', () => {
    const stmts = {
      listFinalizeRunStepsForRun: {
        all: vi.fn(() => [
          {
            run_id: 'run-1',
            step_index: 1,
            name: 'lint',
            state: 'passed',
            exit_code: 0,
            started_at: 1,
            ended_at: 2,
            job_id: null,
            matrix_key: null,
          },
        ]),
      },
    };
    expect(
      listFinalizeRunSteps(stmts as unknown as Pick<Stmts, 'listFinalizeRunStepsForRun'>, 'run-1'),
    ).toEqual([
      {
        index: 1,
        name: 'lint',
        state: 'passed',
        exitCode: 0,
        startedAt: 1,
        endedAt: 2,
        jobId: null,
        matrixKey: null,
      },
    ]);
  });
});
