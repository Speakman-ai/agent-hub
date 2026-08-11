import { describe, expect, it, vi } from 'vitest';
import { SESSION_ENV_LAUNCH_STEP } from '../../shared/utils/sessionEnvLaunch.js';
import { emitSessionEnvLaunchProgress } from './session-env-progress.js';

function mockStmts(completeChanges = 1) {
  return {
    addSessionEvent: { run: vi.fn() },
    addSessionProgress: { run: vi.fn() },
    completeSessionProgress: { run: vi.fn().mockReturnValue({ changes: completeChanges }) },
  };
}

describe('emitSessionEnvLaunchProgress', () => {
  it('persists and broadcasts a started Launching session VM step', () => {
    const stmts = mockStmts();
    const broadcast = vi.fn();
    let seq = 0;
    emitSessionEnvLaunchProgress({
      stmts,
      broadcast,
      sessionId: 'sess-1',
      messageId: 'msg-1',
      nextSeq: () => ++seq,
      status: 'started',
      startedAt: 1000,
    });

    expect(stmts.addSessionEvent.run).toHaveBeenCalledWith(
      'message',
      'msg-1',
      1,
      'progress_step',
      expect.stringContaining(SESSION_ENV_LAUNCH_STEP),
    );
    expect(stmts.addSessionProgress.run).toHaveBeenCalledWith(
      'sess-1',
      'msg-1',
      SESSION_ENV_LAUNCH_STEP,
      'started',
      1000,
      null,
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session-event',
        sessionId: 'sess-1',
        messageId: 'msg-1',
        seq: 1,
        event: expect.objectContaining({
          type: 'progress_step',
          step: SESSION_ENV_LAUNCH_STEP,
          status: 'started',
          startedAt: 1000,
        }),
      }),
    );
    expect(broadcast).toHaveBeenCalledWith({
      type: 'session-progress',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      step: SESSION_ENV_LAUNCH_STEP,
      status: 'started',
      startedAt: 1000,
      finishedAt: null,
    });
  });

  it('closes the open progress row on completed', () => {
    const stmts = mockStmts(1);
    const broadcast = vi.fn();
    let seq = 0;
    emitSessionEnvLaunchProgress({
      stmts,
      broadcast,
      sessionId: 'sess-1',
      messageId: 'msg-1',
      nextSeq: () => ++seq,
      status: 'completed',
      startedAt: 1000,
      finishedAt: 2500,
    });
    expect(stmts.completeSessionProgress.run).toHaveBeenCalledWith(
      'completed',
      2500,
      'sess-1',
      SESSION_ENV_LAUNCH_STEP,
    );
    expect(stmts.addSessionProgress.run).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session-progress',
        status: 'completed',
        finishedAt: 2500,
      }),
    );
  });
});
