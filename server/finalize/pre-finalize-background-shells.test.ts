import { describe, it, expect, vi } from 'vitest';
import {
  PRE_FINALIZE_BACKGROUND_SHELL_WAIT_MS,
  buildPreFinalizeWaitNotice,
  buildPreFinalizeWaitTimeoutNotice,
  runningShellsForSession,
  suppressBackgroundShellWakesForFinalize,
  waitForPreFinalizeBackgroundShells,
  type PreFinalizeShellRuntime,
} from './pre-finalize-background-shells.js';

function runtime(over: Partial<PreFinalizeShellRuntime> = {}): PreFinalizeShellRuntime {
  return {
    listRunning: () => [],
    disarmSessionWatch: vi.fn(),
    stopBySessionId: vi.fn(async () => 0),
    stopSessionSnapshot: vi.fn(async () => []),
    ...over,
  };
}

describe('runningShellsForSession', () => {
  it('filters to running rows for that session', () => {
    const shells = runningShellsForSession(
      {
        listRunning: () => [
          { id: 'a', session_id: 'sess-1', status: 'running' },
          { id: 'b', session_id: 'sess-1', status: 'exited' },
          { id: 'c', session_id: 'sess-2', status: 'running' },
        ],
        stopBySessionId: async () => 0,
      },
      'sess-1',
    );
    expect(shells.map((s) => s.id)).toEqual(['a']);
  });

  it('returns empty when the runtime has no listRunning', () => {
    expect(runningShellsForSession({ stopBySessionId: async () => 0 }, 'sess-1')).toEqual([]);
  });
});

describe('suppressBackgroundShellWakesForFinalize', () => {
  it('forgets pending wakes and disarms watch', () => {
    const forgetSession = vi.fn();
    const disarmSessionWatch = vi.fn();
    suppressBackgroundShellWakesForFinalize(
      {
        getBackgroundShellWatcher: () => ({ forgetSession }),
        getBackgroundShellRuntime: () => runtime({ disarmSessionWatch }),
      },
      'sess-1',
    );
    expect(forgetSession).toHaveBeenCalledWith('sess-1');
    expect(disarmSessionWatch).toHaveBeenCalledWith('sess-1');
  });

  it('does not throw when getters fail', () => {
    expect(() =>
      suppressBackgroundShellWakesForFinalize(
        {
          getBackgroundShellRuntime: () => {
            throw new Error('boom');
          },
        },
        'sess-1',
      ),
    ).not.toThrow();
  });
});

describe('waitForPreFinalizeBackgroundShells', () => {
  it('returns ready immediately when nothing is running', async () => {
    const result = await waitForPreFinalizeBackgroundShells(
      { getBackgroundShellRuntime: () => runtime() },
      'sess-1',
    );
    expect(result).toBe('ready');
  });

  it('waits until running shells drain, then returns ready', async () => {
    const rows = [{ id: 'a', session_id: 'sess-1', status: 'running' }];
    const sleep = vi.fn(async () => {
      rows[0]!.status = 'exited';
    });
    const result = await waitForPreFinalizeBackgroundShells(
      {
        getBackgroundShellRuntime: () =>
          runtime({
            listRunning: () => [...rows],
          }),
        sleep,
        now: () => 0,
      },
      'sess-1',
      { timeoutMs: 10_000, pollMs: 5 },
    );
    expect(result).toBe('ready');
    expect(sleep).toHaveBeenCalled();
  });

  it('stops remaining shells and returns timed_out when the ceiling elapses', async () => {
    const stopSessionSnapshot = vi.fn(async () => [{ id: 'a' }]);
    let t = 0;
    const result = await waitForPreFinalizeBackgroundShells(
      {
        getBackgroundShellRuntime: () =>
          runtime({
            listRunning: () => [{ id: 'a', session_id: 'sess-1', status: 'running' }],
            stopSessionSnapshot,
          }),
        now: () => t,
        sleep: async () => {
          t += 100;
        },
      },
      'sess-1',
      { timeoutMs: 50, pollMs: 10 },
    );
    expect(result).toBe('timed_out');
    expect(stopSessionSnapshot).toHaveBeenCalledWith('sess-1');
  });

  it('returns aborted when the Finalize cancel signal fires', async () => {
    const result = await waitForPreFinalizeBackgroundShells(
      {
        getBackgroundShellRuntime: () =>
          runtime({
            listRunning: () => [{ id: 'a', session_id: 'sess-1', status: 'running' }],
          }),
        now: () => 0,
        sleep: async () => undefined,
      },
      'sess-1',
      { signal: { aborted: true }, timeoutMs: 10_000, pollMs: 5 },
    );
    expect(result).toBe('aborted');
  });

  it('writes a waiting notice when it actually has to wait', async () => {
    const addMessage = { run: vi.fn() };
    const rows = [{ id: 'a', session_id: 'sess-1', status: 'running' }];
    await waitForPreFinalizeBackgroundShells(
      {
        stmts: {
          addMessage,
          touchSession: { run: vi.fn() },
          getMessageById: { get: vi.fn() },
        } as never,
        getBackgroundShellRuntime: () =>
          runtime({
            listRunning: () => [...rows],
          }),
        newId: () => 'msg-1',
        now: () => 0,
        sleep: async () => {
          rows[0]!.status = 'exited';
        },
      },
      'sess-1',
      { timeoutMs: 10_000, pollMs: 5 },
    );
    expect(addMessage.run).toHaveBeenCalledWith(
      'msg-1',
      'sess-1',
      'system',
      expect.stringContaining('waiting for 1 background shell'),
      null,
      null,
      null,
      expect.stringContaining('background_shell_finalize_wait'),
      null,
      null,
      null,
    );
  });
});

describe('wait notice copy', () => {
  it('names a single shell', () => {
    expect(buildPreFinalizeWaitNotice(1)).toContain('1 background shell to finish');
  });

  it('names several shells', () => {
    expect(buildPreFinalizeWaitNotice(3)).toContain('3 background shells to finish');
  });

  it('mentions the wait ceiling on timeout', () => {
    expect(buildPreFinalizeWaitTimeoutNotice(2)).toContain(
      `${PRE_FINALIZE_BACKGROUND_SHELL_WAIT_MS / 60_000} minutes`,
    );
    expect(buildPreFinalizeWaitTimeoutNotice(2)).toContain('Stopped 2 remaining background shells');
  });
});
