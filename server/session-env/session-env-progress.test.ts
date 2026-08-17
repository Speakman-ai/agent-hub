import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_ENV_LAUNCH_STEP,
  SESSION_WORKSPACE_STEP,
} from '../../shared/utils/sessionEnvLaunch.js';
import {
  emitSessionEnvLaunchProgress,
  emitSessionStartupProgress,
  emitSessionWorkspaceProgress,
} from './session-env-progress.js';
import { SESSION_STARTUP_STEP } from './session-startup-hooks.js';

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
      detail: null,
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
      null,
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

  it('persists failure detail on Launching session VM', () => {
    const stmts = mockStmts(1);
    const broadcast = vi.fn();
    emitSessionEnvLaunchProgress({
      stmts,
      broadcast,
      sessionId: 'sess-1',
      status: 'failed',
      startedAt: 1000,
      finishedAt: 1400,
      detail: 'Firecracker guest bridge is not ready',
    });
    expect(stmts.completeSessionProgress.run).toHaveBeenCalledWith(
      'failed',
      1400,
      'Firecracker guest bridge is not ready',
      'sess-1',
      SESSION_ENV_LAUNCH_STEP,
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session-progress',
        status: 'failed',
        detail: 'Firecracker guest bridge is not ready',
      }),
    );
  });
});

describe('emitSessionStartupProgress', () => {
  it('persists failure detail on the Session setup step', () => {
    const stmts = mockStmts(1);
    const broadcast = vi.fn();
    emitSessionStartupProgress({
      stmts,
      broadcast,
      sessionId: 'sess-1',
      status: 'failed',
      startedAt: 1000,
      finishedAt: 2000,
      detail: '$ pip install (exit 1)\nerror: no such file',
    });
    expect(stmts.completeSessionProgress.run).toHaveBeenCalledWith(
      'failed',
      2000,
      '$ pip install (exit 1)\nerror: no such file',
      'sess-1',
      SESSION_STARTUP_STEP,
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session-progress',
        step: SESSION_STARTUP_STEP,
        status: 'failed',
        detail: '$ pip install (exit 1)\nerror: no such file',
      }),
    );
  });
});

describe('emitSessionEnvLaunchProgress without chat messageId', () => {
  it('uses the sentinel message id for manager-owned launch progress', () => {
    const stmts = mockStmts();
    const broadcast = vi.fn();
    emitSessionEnvLaunchProgress({
      stmts,
      broadcast,
      sessionId: 'sess-1',
      status: 'started',
      startedAt: 1000,
    });
    expect(stmts.addSessionProgress.run).toHaveBeenCalledWith(
      'sess-1',
      '__session_env_launch__',
      SESSION_ENV_LAUNCH_STEP,
      'started',
      1000,
      null,
      null,
    );
  });
});

describe('emitSessionWorkspaceProgress', () => {
  it('persists and broadcasts Preparing session workspace', () => {
    const stmts = mockStmts();
    const broadcast = vi.fn();
    emitSessionWorkspaceProgress({
      stmts,
      broadcast,
      sessionId: 'sess-1',
      status: 'started',
      startedAt: 1000,
    });
    expect(stmts.addSessionProgress.run).toHaveBeenCalledWith(
      'sess-1',
      '__session_workspace__',
      SESSION_WORKSPACE_STEP,
      'started',
      1000,
      null,
      null,
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session-progress',
        sessionId: 'sess-1',
        step: SESSION_WORKSPACE_STEP,
        status: 'started',
        startedAt: 1000,
      }),
    );
  });
});
