import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveChatProcess } from './active-chat-process.js';
import type { SessionRow, Stmts } from './types.js';
import {
  createFinalizeRunSignal,
  registerFinalizeRunAbort,
  unregisterFinalizeRunAbort,
  isFinalizeRunLive,
  __clearFinalizeRunAbortRegistry,
} from './finalize/run-abort-registry.js';
import {
  tryAcquireSessionWorktreeLock,
  releaseSessionWorktreeLock,
  getSessionWorktreeLockOwner,
} from './session-worktree-lock.js';
import { isSessionRecovering } from './session-recovery.js';

const mocks = vi.hoisted(() => ({
  forceKillSessionChatRun: vi.fn(),
  handleMultiAgentCancel: vi.fn(),
  recomputeSessionState: vi.fn(),
  kickoffSeededTurn: vi.fn(async (_args: { content?: string }) => undefined),
}));

vi.mock('./session-chat-cancel.js', () => ({
  forceKillSessionChatRun: mocks.forceKillSessionChatRun,
}));

vi.mock('./session-multi-agent.js', () => ({
  handleMultiAgentCancel: mocks.handleMultiAgentCancel,
  activeMultiAgentRounds: new Map(),
}));

vi.mock('./session-state.js', () => ({
  recomputeSessionState: mocks.recomputeSessionState,
}));

vi.mock('./seeded-session-kickoff.js', () => ({
  kickoffSeededTurn: mocks.kickoffSeededTurn,
}));

const { unstickAutopilotSession, waitWhileHandleRegistered } =
  await import('./session-autopilot-unstick.js');

function runningConfig() {
  return {
    durationHours: 4,
    brief: 'Harden the 3D print UI',
    goal: 'Baseline journeys pass on preview',
    escalation: 'medium',
    branch: 'autopilot/print-ui',
    startedAt: '2026-09-17T12:00:00.000Z',
    deadlineAt: '2026-09-17T16:00:00.000Z',
    status: 'running',
    cycle: 0,
    lastPushSha: null,
  };
}

function runningSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    agent_id: 'agent-1',
    name: 'Autopilot',
    engine: 'codex-cli',
    model: 'gpt-5.5',
    engine_session_id: null,
    use_worktree: 1,
    worktree_path: '/tmp/wt',
    worktree_branch: 'autopilot/print-ui',
    git_worktree_detected: 0,
    changes_ready: null,
    stale_pr_notified_at: null,
    ask_mode: 0,
    cron_id: null,
    created_at: '2026-09-17 12:00:00',
    updated_at: '2026-09-17 12:00:00',
    deleted_at: null,
    finalize_automation: 'push',
    session_mode: 'autopilot',
    autopilot_session_config: JSON.stringify(runningConfig()),
    state: 'working',
    ...overrides,
  };
}

function makeStmts(session: SessionRow, finalizeRun: { id: string } | undefined = undefined) {
  const added: unknown[] = [];
  return {
    getSession: { get: vi.fn(() => session) },
    getActiveFinalizeRunForSession: { get: vi.fn(() => finalizeRun) },
    failFinalizeRun: { run: vi.fn() },
    deleteActiveTask: { run: vi.fn() },
    clearSessionQueue: { run: vi.fn() },
    addMessage: {
      run: vi.fn((...args: unknown[]) => {
        added.push(args);
      }),
    },
    touchSession: { run: vi.fn() },
    getMessageById: { get: vi.fn(() => ({ id: 'sys-1', role: 'system' })) },
    updateSessionState: { run: vi.fn() },
    _added: added,
  } as unknown as Stmts & { _added: unknown[] };
}

describe('waitWhileHandleRegistered', () => {
  it('returns true once the handle leaves the map', async () => {
    const handle = { kind: 'host', kill: vi.fn() } as unknown as ActiveChatProcess;
    const activeProcesses = new Map<string, ActiveChatProcess>([['sess-1', handle]]);
    let ticks = 0;
    const gone = await waitWhileHandleRegistered({
      sessionId: 'sess-1',
      handle,
      activeProcesses,
      timeoutMs: 200,
      now: () => {
        ticks += 1;
        return ticks * 10;
      },
      sleep: async () => {
        activeProcesses.delete('sess-1');
      },
    });
    expect(gone).toBe(true);
  });

  it('returns false when the handle never leaves', async () => {
    const handle = { kind: 'host', kill: vi.fn() } as unknown as ActiveChatProcess;
    const activeProcesses = new Map<string, ActiveChatProcess>([['sess-1', handle]]);
    const gone = await waitWhileHandleRegistered({
      sessionId: 'sess-1',
      handle,
      activeProcesses,
      timeoutMs: 20,
      now: (() => {
        let t = 0;
        return () => {
          t += 50;
          return t;
        };
      })(),
      sleep: async () => undefined,
    });
    expect(gone).toBe(false);
  });
});

describe('unstickAutopilotSession', () => {
  afterEach(() => {
    __clearFinalizeRunAbortRegistry();
    releaseSessionWorktreeLock('sess-1', 'finalize');
  });

  it('waits for a pending rebase to settle without releasing its lock', async () => {
    const stmts = makeStmts(runningSession(), { id: 'run-rebase' });
    const { signal, abort } = createFinalizeRunSignal();
    registerFinalizeRunAbort('run-rebase', abort);
    expect(tryAcquireSessionWorktreeLock('sess-1', 'finalize')).toBe(true);
    let settleRebase!: () => void;
    const pendingRebase = new Promise<void>((resolve) => {
      settleRebase = resolve;
    });
    // Finalize's finally owns deregistration and lock release, not Unstick.
    const finalize = pendingRebase.finally(() => {
      unregisterFinalizeRunAbort('run-rebase');
      releaseSessionWorktreeLock('sess-1', 'finalize');
    });
    let sleepEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      sleepEntered = resolve;
    });
    const recovering = unstickAutopilotSession({
      sessionId: 'sess-1',
      stmts,
      broadcast: vi.fn(),
      activeProcesses: new Map(),
      handleChat: vi.fn(),
      sleep: async () => {
        sleepEntered();
        await finalize;
      },
    });
    await entered;
    expect(signal.aborted).toBe(true);
    expect(isFinalizeRunLive('run-rebase')).toBe(true);
    expect(getSessionWorktreeLockOwner('sess-1')).toBe('finalize');
    expect(stmts.deleteActiveTask.run).not.toHaveBeenCalled();
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
    settleRebase();
    expect(await recovering).toEqual({
      ok: true,
      killedProcess: false,
      cancelledFinalizeRunId: 'run-rebase',
    });
    expect(mocks.kickoffSeededTurn).toHaveBeenCalledTimes(1);
  });

  it('preserves Finalize ownership when a pending rebase outlasts the wait', async () => {
    const stmts = makeStmts(runningSession(), { id: 'run-rebase' });
    registerFinalizeRunAbort('run-rebase', vi.fn());
    expect(tryAcquireSessionWorktreeLock('sess-1', 'finalize')).toBe(true);
    const result = await unstickAutopilotSession({
      sessionId: 'sess-1',
      stmts,
      broadcast: vi.fn(),
      activeProcesses: new Map(),
      handleChat: vi.fn(),
      waitMs: 0,
    });
    expect(result).toMatchObject({ ok: false, error: 'autopilot_unstick_still_stopping' });
    expect(getSessionWorktreeLockOwner('sess-1')).toBe('finalize');
    expect(isFinalizeRunLive('run-rebase')).toBe(true);
    expect(stmts.failFinalizeRun.run).not.toHaveBeenCalled();
    expect(stmts.deleteActiveTask.run).not.toHaveBeenCalled();
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
  });

  it('clears and suspends draining before prompt close, and coalesces concurrent requests', async () => {
    const stmts = makeStmts(runningSession());
    const handle = { kind: 'host', kill: vi.fn() } as unknown as ActiveChatProcess;
    const activeProcesses = new Map<string, ActiveChatProcess>([['sess-1', handle]]);
    const dispatchQueued = vi.fn();
    mocks.forceKillSessionChatRun.mockImplementationOnce(() => {
      expect(stmts.clearSessionQueue.run).toHaveBeenCalledWith('sess-1');
      expect(isSessionRecovering('sess-1')).toBe(true);
      activeProcesses.delete('sess-1');
      if (!isSessionRecovering('sess-1')) dispatchQueued();
      return handle;
    });
    const deps = {
      sessionId: 'sess-1',
      stmts,
      broadcast: vi.fn(),
      activeProcesses,
      handleChat: vi.fn(),
    };
    const first = unstickAutopilotSession(deps);
    const second = unstickAutopilotSession(deps);
    expect(first).toBe(second);
    expect(await first).toMatchObject({ ok: true, killedProcess: true });
    expect(await second).toMatchObject({ ok: true, killedProcess: true });
    expect(dispatchQueued).not.toHaveBeenCalled();
    expect(mocks.forceKillSessionChatRun).toHaveBeenCalledTimes(1);
    expect(mocks.kickoffSeededTurn).toHaveBeenCalledTimes(1);
    expect(isSessionRecovering('sess-1')).toBe(false);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.kickoffSeededTurn.mockResolvedValue(undefined);
    mocks.forceKillSessionChatRun.mockReturnValue(undefined);
  });

  it('fails without cancelling or resuming if queued work cannot be cleared', async () => {
    const stmts = makeStmts(runningSession());
    vi.mocked(stmts.clearSessionQueue.run).mockImplementationOnce(() => {
      throw new Error('queue write failed');
    });
    const result = await unstickAutopilotSession({
      sessionId: 'sess-1',
      stmts,
      broadcast: vi.fn(),
      activeProcesses: new Map(),
      handleChat: vi.fn(),
    });
    expect(result).toEqual({
      ok: false,
      status: 500,
      error: 'autopilot_unstick_failed',
      message: 'queue write failed',
    });
    expect(mocks.forceKillSessionChatRun).not.toHaveBeenCalled();
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
    expect(isSessionRecovering('sess-1')).toBe(false);
  });

  it('rejects non-autopilot sessions', async () => {
    const session = runningSession({ session_mode: 'chat', autopilot_session_config: null });
    const stmts = makeStmts(session);
    const result = await unstickAutopilotSession({
      sessionId: 'sess-1',
      stmts,
      broadcast: vi.fn(),
      activeProcesses: new Map(),
      handleChat: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: 'not_autopilot' });
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
  });

  it('rejects Autopilot that has not started', async () => {
    const session = runningSession({
      autopilot_session_config: JSON.stringify({
        durationHours: 4,
        brief: 'x',
        goal: 'y',
        escalation: 'none',
        branch: 'autopilot/x',
        startedAt: null,
        deadlineAt: null,
        status: 'configuring',
        cycle: 0,
        lastPushSha: null,
      }),
    });
    const stmts = makeStmts(session);
    const result = await unstickAutopilotSession({
      sessionId: 'sess-1',
      stmts,
      broadcast: vi.fn(),
      activeProcesses: new Map(),
      handleChat: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, status: 409, error: 'autopilot_not_running' });
  });

  it('kills the process, cancels Finalize, clears the queue, and continues', async () => {
    const session = runningSession();
    const stmts = makeStmts(session, { id: 'run-9' });
    const handle = { kind: 'host', kill: vi.fn() } as unknown as ActiveChatProcess;
    const activeProcesses = new Map<string, ActiveChatProcess>([['sess-1', handle]]);
    mocks.forceKillSessionChatRun.mockReturnValue(handle);
    const broadcast = vi.fn();

    const result = await unstickAutopilotSession({
      sessionId: 'sess-1',
      stmts,
      broadcast,
      activeProcesses,
      handleChat: vi.fn(),
      sleep: async () => {
        activeProcesses.delete('sess-1');
      },
      waitMs: 200,
    });

    expect(result).toEqual({
      ok: true,
      killedProcess: true,
      cancelledFinalizeRunId: 'run-9',
    });
    expect(isFinalizeRunLive('run-9')).toBe(false);
    expect(stmts.failFinalizeRun.run).toHaveBeenCalledWith('cancelled', 'cancelled', 'run-9');
    expect(mocks.handleMultiAgentCancel).toHaveBeenCalledWith('sess-1');
    expect(mocks.forceKillSessionChatRun).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      activeProcesses,
    });
    expect(stmts.deleteActiveTask.run).toHaveBeenCalledWith('sess-1');
    expect(stmts.clearSessionQueue.run).toHaveBeenCalledWith('sess-1');
    expect(getSessionWorktreeLockOwner('sess-1')).toBeNull();
    expect(broadcast).toHaveBeenCalledWith({ type: 'interrupted', sessionId: 'sess-1' });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'queue_updated',
      sessionId: 'sess-1',
      queue: [],
    });
    expect(mocks.kickoffSeededTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        agentId: 'agent-1',
      }),
    );
    const kickoff = mocks.kickoffSeededTurn.mock.calls[0]?.[0] as { content?: string };
    expect(kickoff?.content).toContain('unstuck');
    expect(kickoff?.content).toContain('autopilot/print-ui');
  });

  it('keeps recovery blocked when process termination cannot be confirmed', async () => {
    const session = runningSession();
    const stmts = makeStmts(session);
    const handle = { kind: 'host', kill: vi.fn() } as unknown as ActiveChatProcess;
    const activeProcesses = new Map<string, ActiveChatProcess>([['sess-1', handle]]);
    mocks.forceKillSessionChatRun.mockReturnValue(handle);

    const result = await unstickAutopilotSession({
      sessionId: 'sess-1',
      stmts,
      broadcast: vi.fn(),
      activeProcesses,
      handleChat: vi.fn(),
      now: (() => {
        let t = 0;
        return () => {
          t += 100;
          return t;
        };
      })(),
      sleep: async () => undefined,
      waitMs: 50,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'autopilot_unstick_still_stopping',
    });
    expect(activeProcesses.get('sess-1')).toBe(handle);
    expect(stmts.deleteActiveTask.run).not.toHaveBeenCalled();
    expect(mocks.kickoffSeededTurn).not.toHaveBeenCalled();
  });
});
