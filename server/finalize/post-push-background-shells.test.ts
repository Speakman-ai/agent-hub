import { describe, expect, it, vi } from 'vitest';
import {
  buildPostFinalizePushShellTeardownNotice,
  stopBackgroundShellsAfterFinalizePush,
  type PostPushBackgroundShellDeps,
} from './post-push-background-shells.js';

function makeDeps(
  overrides: {
    stopSessionSnapshot?: (sessionId: string) => Promise<Array<{ id: string }>>;
    stopBySessionId?: (sessionId: string) => Promise<number>;
    forgetSession?: (sessionId: string) => void;
    runtimeMissing?: boolean;
  } = {},
) {
  const addMessage = { run: vi.fn() };
  const touchSession = { run: vi.fn() };
  const getMessageById = { get: vi.fn(() => ({ id: 'msg-1', role: 'system' })) };
  const broadcast = vi.fn();
  const stopSessionSnapshot = vi.fn(overrides.stopSessionSnapshot ?? (async () => []));
  const stopBySessionId = vi.fn(overrides.stopBySessionId ?? (async () => 0));
  const forgetSession = vi.fn(overrides.forgetSession ?? (() => {}));
  const log = vi.fn();

  const deps: PostPushBackgroundShellDeps = {
    stmts: { addMessage, touchSession, getMessageById } as never,
    broadcast,
    getBackgroundShellRuntime: () =>
      overrides.runtimeMissing ? null : { stopSessionSnapshot, stopBySessionId },
    getBackgroundShellWatcher: () => ({ forgetSession }),
    newId: () => 'msg-1',
    log,
  };
  return {
    deps,
    addMessage,
    touchSession,
    broadcast,
    stopSessionSnapshot,
    stopBySessionId,
    forgetSession,
    log,
  };
}

/** Parsed metadata of the last persisted system message. */
function lastMetadata(addMessage: { run: { mock: { calls: unknown[][] } } }) {
  const calls = addMessage.run.mock.calls;
  if (calls.length === 0) return null;
  return JSON.parse(calls[calls.length - 1][7] as string) as Record<string, unknown>;
}

describe('stopBackgroundShellsAfterFinalizePush', () => {
  it('drops pending wakes, stops the boundary snapshot, and reports the total', async () => {
    // Regression: a pushed session is locked in ask mode and will never ship
    // again, but its background shells kept running and its watch loop kept
    // firing wake turns into it.
    const h = makeDeps({
      stopSessionSnapshot: async () => [{ id: 'sh-armed-1' }, { id: 'sh-unwatched-1' }],
    });

    const stopped = await stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1');

    expect(stopped).toBe(2);
    expect(h.forgetSession).toHaveBeenCalledWith('sess-1');
    expect(h.stopSessionSnapshot).toHaveBeenCalledWith('sess-1');
    // The session-wide sweep must NOT also run: it would re-query the table
    // after the snapshot teardown's awaits and kill post-boundary shells.
    expect(h.stopBySessionId).not.toHaveBeenCalled();
  });

  it('drops the watcher state before killing anything', async () => {
    // A completion already queued in the watcher must not race the kill into
    // a wake turn, so forgetSession has to land first.
    const order: string[] = [];
    const h = makeDeps({
      forgetSession: () => void order.push('forget'),
      stopSessionSnapshot: async () => {
        order.push('stopSessionSnapshot');
        return [{ id: 'sh-1' }];
      },
      stopBySessionId: async () => {
        order.push('stop');
        return 0;
      },
    });

    await stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1');

    expect(order).toEqual(['forget', 'stopSessionSnapshot']);
  });

  it('persists a system notice naming the teardown when shells were stopped', async () => {
    const h = makeDeps({ stopSessionSnapshot: async () => [{ id: 'sh-1' }] });

    await stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1');

    expect(h.addMessage.run).toHaveBeenCalledTimes(1);
    const args = h.addMessage.run.mock.calls[0];
    expect(args[1]).toBe('sess-1');
    expect(args[2]).toBe('system');
    expect(args[3]).toContain('Finalize pushed this session');
    expect(lastMetadata(h.addMessage)).toEqual({
      kind: 'background_shell_finalize_push_teardown',
      stoppedCount: 1,
    });
    expect(h.touchSession.run).toHaveBeenCalledWith('sess-1');
    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message_added', sessionId: 'sess-1' }),
    );
  });

  it('stays silent when the session had no shells', async () => {
    const h = makeDeps();

    const stopped = await stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1');

    expect(stopped).toBe(0);
    expect(h.addMessage.run).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('is a no-op when the runtime is not wired', async () => {
    const h = makeDeps({ runtimeMissing: true });

    await expect(stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1')).resolves.toBe(0);
    expect(h.forgetSession).not.toHaveBeenCalled();
  });

  it('is a no-op without a session id', async () => {
    const h = makeDeps();

    await expect(stopBackgroundShellsAfterFinalizePush(h.deps, null)).resolves.toBe(0);
    expect(h.stopBySessionId).not.toHaveBeenCalled();
  });

  it('still reports the stopped shells when newId throws', async () => {
    // Regression: the id mint, the copy builder, and the metadata serialize all
    // run before persistTeardownNotice's inner try blocks, so a throwing
    // injected newId escaped the whole teardown — after the shells were already
    // stopped and the push already persisted. `newId` is the only one of the
    // three a caller can make throw, so it stands in for the shared path; the
    // guard is at the call site and covers all of them.
    const h = makeDeps({ stopSessionSnapshot: async () => [{ id: 'sh-1' }] });
    h.deps.newId = () => {
      throw new Error('uuid backend unavailable');
    };

    await expect(stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1')).resolves.toBe(1);
    // Nothing was written: the throw happened before the insert, which is
    // exactly why the inner try blocks could not catch it.
    expect(h.addMessage.run).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('teardown notice failed'));
  });

  it('survives a log sink that throws on every call', async () => {
    // Regression: `log` is injected and is called from inside every error
    // handler, so an unguarded sink turned a handled cosmetic failure into an
    // exception escaping into runFinalizePush.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = makeDeps({ stopSessionSnapshot: async () => [{ id: 'sh-1' }] });
      h.deps.log = () => {
        throw new Error('log transport down');
      };

      await expect(stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1')).resolves.toBe(1);
      // Fell back to the console rather than going silent.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('survives a log sink that throws from inside an error handler', async () => {
    // The nastiest ordering: the step fails, and logging that failure fails
    // too. Both the sink and the console are broken, so the teardown has to
    // complete on silence alone.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('console gone');
    });
    try {
      const h = makeDeps({
        stopSessionSnapshot: async () => {
          throw new Error('boom');
        },
      });
      h.deps.log = () => {
        throw new Error('log transport down');
      };

      await expect(stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1')).resolves.toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('backstops an unguarded throw from a runtime property getter', async () => {
    // `if (runtime.stopSessionSnapshot)` is a property read, which is a call
    // into injected code when the runtime exposes it as a getter. No per-step
    // guard covers it; the outer wrapper does.
    const h = makeDeps();
    const runtime = {
      stopBySessionId: async () => 5,
      get stopSessionSnapshot(): undefined {
        throw new Error('getter exploded');
      },
    };
    h.deps.getBackgroundShellRuntime = () => runtime as never;

    await expect(stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1')).resolves.toBe(0);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('teardown failed unexpectedly'));
  });

  it('swallows a throwing runtime getter', async () => {
    // Regression: the runtime lookup was the one call outside a try. It runs
    // after the push already succeeded, so letting it throw would escape into
    // runFinalizePush and report a completed push as failed.
    const log = vi.fn();
    const deps: PostPushBackgroundShellDeps = {
      stmts: {
        addMessage: { run: vi.fn() },
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn(() => undefined) },
      } as never,
      broadcast: vi.fn(),
      getBackgroundShellRuntime: () => {
        throw new Error('deps not wired');
      },
      log,
    };

    await expect(stopBackgroundShellsAfterFinalizePush(deps, 'sess-1')).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('runtime lookup failed'));
  });

  it('swallows a throwing stopSessionSnapshot without falling back to the sweep', async () => {
    // Non-throwing contract: the push already succeeded, so a shell that
    // refuses to die is a log line, not a failed push. And a failed snapshot
    // must not silently escalate to the session-wide sweep — that would kill
    // post-boundary shells, trading one bug for the one just fixed.
    const h = makeDeps({
      stopSessionSnapshot: async () => {
        throw new Error('boom');
      },
      stopBySessionId: async () => 2,
    });

    await expect(stopBackgroundShellsAfterFinalizePush(h.deps, 'sess-1')).resolves.toBe(0);
    expect(h.stopBySessionId).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('stopSessionSnapshot failed'));
  });

  it('swallows a throwing stopBySessionId on the fallback path', async () => {
    const log = vi.fn();
    const deps: PostPushBackgroundShellDeps = {
      stmts: {
        addMessage: { run: vi.fn() },
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn(() => undefined) },
      } as never,
      broadcast: vi.fn(),
      getBackgroundShellRuntime: () => ({
        stopBySessionId: async () => {
          throw new Error('boom');
        },
      }),
      log,
    };

    await expect(stopBackgroundShellsAfterFinalizePush(deps, 'sess-1')).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stopBySessionId failed'));
  });

  it('falls back to the session-wide sweep on a runtime without stopSessionSnapshot', async () => {
    const stopBySessionId = vi.fn(async () => 1);
    const addMessage = { run: vi.fn() };
    const deps: PostPushBackgroundShellDeps = {
      stmts: {
        addMessage,
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn(() => undefined) },
      } as never,
      broadcast: vi.fn(),
      getBackgroundShellRuntime: () => ({ stopBySessionId }),
      log: vi.fn(),
    };

    await expect(stopBackgroundShellsAfterFinalizePush(deps, 'sess-1')).resolves.toBe(1);
    expect(addMessage.run).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('no stopSessionSnapshot'));
  });
});

describe('buildPostFinalizePushShellTeardownNotice', () => {
  it('reads naturally for one shell', () => {
    const notice = buildPostFinalizePushShellTeardownNotice(1);
    expect(notice).toContain('1 running background shell was stopped');
  });

  it('pluralizes for several', () => {
    const notice = buildPostFinalizePushShellTeardownNotice(3);
    expect(notice).toContain('3 running background shells were stopped');
  });

  it('tells the operator how to continue long-running work', () => {
    expect(buildPostFinalizePushShellTeardownNotice(2)).toContain('follow-up session');
  });
});
