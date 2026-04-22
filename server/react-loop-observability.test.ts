import { describe, it, expect, vi } from 'vitest';
import {
  emitReactLoopStep,
  mergeHostActionExitForEmit,
  type ReactLoopStepPayload,
} from './react-loop-observability.js';

describe('emitReactLoopStep', () => {
  it('broadcasts react_loop_step with the same fields as the payload', () => {
    const broadcast = vi.fn();
    const payload: ReactLoopStepPayload = {
      sessionId: 'sess-1',
      messageId: 'msg-1',
      stepId: 'msg-1:host:0:wiki',
      phase: 'host_action',
      tool: 'wiki',
      exitCode: 0,
      durationMs: 42,
      continuationDepth: 1,
      chainElapsedMs: 1200,
      detail: 'kanban',
    };
    emitReactLoopStep(broadcast, payload, false);
    expect(broadcast).toHaveBeenCalledWith({
      type: 'react_loop_step',
      ...payload,
    });
  });

  it('defaults to logging when logToConsole is omitted', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const broadcast = vi.fn();
    emitReactLoopStep(broadcast, {
      sessionId: 's',
      messageId: 'm',
      stepId: 'm:cli',
      phase: 'cli_turn',
      tool: 'claude-code',
      exitCode: 0,
      durationMs: 5000,
      continuationDepth: 0,
    });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('mergeHostActionExitForEmit', () => {
  it('preserves branch exit when the action did not throw', () => {
    expect(
      mergeHostActionExitForEmit({
        thrown: false,
        err: undefined,
        branchExit: 2,
        branchDetail: 'skipped',
      }),
    ).toEqual({ exitCode: 2, detail: 'skipped' });
  });

  it('forces exit 1 and merges the error when the action threw', () => {
    expect(
      mergeHostActionExitForEmit({
        thrown: true,
        err: new Error('network down'),
        branchExit: 0,
        branchDetail: 'web:q1',
      }),
    ).toEqual({ exitCode: 1, detail: 'web:q1: network down' });
  });

  it('uses the exception message alone when branch detail is absent', () => {
    expect(
      mergeHostActionExitForEmit({
        thrown: true,
        err: new Error('boom'),
        branchExit: 0,
        branchDetail: undefined,
      }),
    ).toEqual({ exitCode: 1, detail: 'boom' });
  });
});
