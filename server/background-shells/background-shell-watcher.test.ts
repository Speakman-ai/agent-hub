/**
 * Watch-loop coordinator tests.
 *
 * These cover the bookkeeping around {@link planBackgroundShellWake}: what gets
 * consumed, when a deferred wake actually fires, and the cases where a bug
 * would either lose a wake (session silent forever — the original bug) or
 * duplicate one (agent told twice that the same build finished).
 *
 * Everything is faked through the injected deps — no database, no processes, no
 * CLI — per the repo's hard rails on tests.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  BackgroundShellWatcher,
  type WatchRuntimeLike,
  type WatcherChatMessage,
} from './background-shell-watcher.js';
import {
  MAX_WAKES_PER_SESSION,
  MIN_WAKE_INTERVAL_MS,
  WAKE_BUDGET_IDLE_RESET_MS,
} from './background-shell-watch.js';
import type { BackgroundShellRow } from './background-shell-runtime.js';

function row(over: Partial<BackgroundShellRow> = {}): BackgroundShellRow {
  return {
    id: 'shell-1',
    session_id: 'sess-1',
    project_id: 'proj-1',
    command: 'npm run build',
    label: 'build',
    cwd: '/wt',
    pid: 100,
    pid_start_time: null,
    status: 'exited',
    exit_code: 0,
    log_path: null,
    watch: 1,
    watch_resolved_at: null,
    timeout_ms: 1_800_000,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** In-memory stand-in for the runtime, with a hand-driven finalize event. */
function fakeRuntime(initial: BackgroundShellRow[] = []) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  let listener: ((row: BackgroundShellRow) => void) | null = null;
  const runtime: WatchRuntimeLike & {
    emitFinalize: (r: BackgroundShellRow) => void;
    put: (r: BackgroundShellRow) => void;
    rows: Map<string, BackgroundShellRow>;
  } = {
    subscribeFinalize(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    listWatched: (sessionId) =>
      [...rows.values()].filter(
        (r) => r.session_id === sessionId && r.watch === 1 && r.status === 'running',
      ),
    getById: (id) => rows.get(id) ?? null,
    getLogTail: () => ['out'],
    clearWatch: (id) => {
      const existing = rows.get(id);
      if (existing) existing.watch = 0;
    },
    put: (r) => rows.set(r.id, { ...r }),
    rows,
    emitFinalize: (r) => {
      rows.set(r.id, { ...r });
      listener?.(r);
    },
  };
  return runtime;
}

function build(
  runtime: ReturnType<typeof fakeRuntime>,
  over: Partial<ConstructorParameters<typeof BackgroundShellWatcher>[0]> = {},
) {
  const dispatchChat = (over.dispatchChat ??
    vi.fn().mockResolvedValue(undefined)) as unknown as Mock<(msg: WatcherChatMessage) => unknown>;
  const persistSystemMessage = (over.persistSystemMessage ?? vi.fn()) as unknown as Mock<
    (sessionId: string, content: string, meta: Record<string, unknown>) => void
  >;
  let now = 1_000_000;
  const watcher = new BackgroundShellWatcher({
    runtime,
    getSession: () => ({ id: 'sess-1', agent_id: 'agent-1' }),
    isSessionBusy: () => false,
    logger: { log: () => {}, warn: () => {} },
    ...over,
    dispatchChat,
    persistSystemMessage,
    now: () => now,
  });
  return {
    watcher,
    dispatchChat,
    persistSystemMessage,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Let the coordinator's dispatch microtask (and any promise chain) run. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('BackgroundShellWatcher', () => {
  let runtime: ReturnType<typeof fakeRuntime>;

  beforeEach(() => {
    runtime = fakeRuntime();
  });

  it('wakes the session when a watched shell finishes', async () => {
    const { dispatchChat } = build(runtime);
    runtime.emitFinalize(row());
    await settle();

    expect(dispatchChat).toHaveBeenCalledTimes(1);
    const msg = dispatchChat.mock.calls[0][0];
    expect(msg).toMatchObject({
      type: 'chat',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      _backgroundShellWake: true,
    });
    expect(msg.content).toContain('npm run build');
  });

  it('ignores an unwatched shell entirely', async () => {
    const { dispatchChat } = build(runtime);
    runtime.emitFinalize(row({ watch: 0 }));
    await settle();
    expect(dispatchChat).not.toHaveBeenCalled();
  });

  it('consumes the watch so the same completion cannot wake twice', async () => {
    const { dispatchChat } = build(runtime);
    const finished = row();
    runtime.emitFinalize(finished);
    await settle();
    runtime.emitFinalize(finished);
    await settle();
    expect(dispatchChat).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst of completions into one wake naming all of them', async () => {
    const { dispatchChat } = build(runtime);
    runtime.emitFinalize(row({ id: 'a', label: 'unit tests' }));
    runtime.emitFinalize(row({ id: 'b', label: 'e2e tests' }));
    runtime.emitFinalize(row({ id: 'c', label: 'lint' }));
    await settle();

    expect(dispatchChat).toHaveBeenCalledTimes(1);
    const content = dispatchChat.mock.calls[0][0].content;
    expect(content).toContain('unit tests');
    expect(content).toContain('e2e tests');
    expect(content).toContain('lint');
  });

  it('defers while the session is busy, then wakes on the next sweep', async () => {
    let busy = true;
    const { watcher, dispatchChat } = build(runtime, { isSessionBusy: () => busy });

    runtime.emitFinalize(row());
    await settle();
    expect(dispatchChat).not.toHaveBeenCalled();
    expect(watcher.pendingCount('sess-1')).toBe(1);

    busy = false;
    watcher.tickAll();
    await settle();
    expect(dispatchChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a deferred completion pending rather than dropping it', async () => {
    const { watcher } = build(runtime, { isSessionBusy: () => true });
    runtime.emitFinalize(row());
    watcher.tickAll();
    watcher.tickAll();
    await settle();
    expect(watcher.pendingCount('sess-1')).toBe(1);
  });

  it('drops a pending wake whose watch was cancelled out from under it', async () => {
    const { watcher, dispatchChat } = build(runtime, { isSessionBusy: () => true });
    runtime.emitFinalize(row());

    runtime.clearWatch('shell-1');
    watcher.tickAll();
    await settle();

    expect(dispatchChat).not.toHaveBeenCalled();
    expect(watcher.pendingCount('sess-1')).toBe(0);
  });

  it('does not wake a deleted session', async () => {
    const { dispatchChat } = build(runtime, { getSession: () => undefined });
    runtime.emitFinalize(row());
    await settle();
    expect(dispatchChat).not.toHaveBeenCalled();
  });

  it('does not wake an archived session', async () => {
    const { dispatchChat } = build(runtime, {
      getSession: () => ({ id: 'sess-1', agent_id: 'agent-1', deleted_at: '2026-01-02' }),
    });
    runtime.emitFinalize(row());
    await settle();
    expect(dispatchChat).not.toHaveBeenCalled();
  });

  it('drops a completion while Finalize is in flight instead of waking a new process', async () => {
    const { watcher, dispatchChat } = build(runtime, { isSessionFinalizing: () => true });
    runtime.emitFinalize(row());
    await settle();
    expect(dispatchChat).not.toHaveBeenCalled();
    expect(watcher.pendingCount('sess-1')).toBe(0);
    expect(runtime.getById('shell-1')?.watch).toBe(0);
  });

  it('names shells still running so the agent knows more is coming', async () => {
    runtime.put(row({ id: 'slow', label: 'migration', status: 'running' }));
    const { dispatchChat } = build(runtime);
    runtime.emitFinalize(row({ id: 'fast' }));
    await settle();

    expect(dispatchChat.mock.calls[0][0].content).toContain('migration');
  });

  it('will not dispatch a second wake while the first wake turn is still running', async () => {
    const { dispatchChat, advance } = build(runtime, {
      dispatchChat: vi.fn(() => new Promise(() => {})),
    });
    runtime.emitFinalize(row({ id: 'a' }));
    await settle();
    advance(MIN_WAKE_INTERVAL_MS);
    runtime.emitFinalize(row({ id: 'b' }));
    await settle();

    expect(dispatchChat).toHaveBeenCalledTimes(1);
  });

  /**
   * Drives the loop to its cap. Each wake claims the session until its dispatch
   * promise settles, so the microtask queue has to drain between iterations —
   * the same ordering a real turn finishing produces.
   */
  async function exhaustWakeBudget(
    watcher: BackgroundShellWatcher,
    advance: (ms: number) => void,
  ): Promise<void> {
    for (let i = 0; i < MAX_WAKES_PER_SESSION; i += 1) {
      runtime.emitFinalize(row({ id: `shell-${i}` }));
      await settle();
      advance(MIN_WAKE_INTERVAL_MS);
      watcher.tickAll();
      await settle();
    }
  }

  it('stops waking and warns the human once the budget is exhausted', async () => {
    const { watcher, dispatchChat, persistSystemMessage, advance } = build(runtime);

    await exhaustWakeBudget(watcher, advance);
    expect(dispatchChat).toHaveBeenCalledTimes(MAX_WAKES_PER_SESSION);

    runtime.emitFinalize(row({ id: 'one-too-many' }));
    watcher.tickAll();
    await settle();

    expect(dispatchChat).toHaveBeenCalledTimes(MAX_WAKES_PER_SESSION);
    expect(persistSystemMessage).toHaveBeenCalledTimes(1);
    expect(persistSystemMessage.mock.calls[0][1]).toContain('Stopped watching');
  });

  it('disarms the shells it gave up on, so they cannot re-trigger later', async () => {
    const { watcher, advance } = build(runtime);
    await exhaustWakeBudget(watcher, advance);

    runtime.emitFinalize(row({ id: 'dropped' }));
    watcher.tickAll();
    await settle();

    expect(runtime.rows.get('dropped')?.watch).toBe(0);
  });

  it('keeps the budget across bursts, so the cap cannot be reset by going quiet', async () => {
    const { watcher, dispatchChat, advance } = build(runtime);
    await exhaustWakeBudget(watcher, advance);

    // A short quiet gap, then more work — the shape of a runaway loop pausing.
    advance(MIN_WAKE_INTERVAL_MS * 2);
    watcher.tickAll();
    runtime.emitFinalize(row({ id: 'after-a-pause' }));
    watcher.tickAll();
    await settle();

    expect(dispatchChat).toHaveBeenCalledTimes(MAX_WAKES_PER_SESSION);
  });

  it('restores the budget once the session has been quiet long enough', async () => {
    const { watcher, dispatchChat, advance } = build(runtime);
    await exhaustWakeBudget(watcher, advance);

    advance(WAKE_BUDGET_IDLE_RESET_MS);
    watcher.tickAll();
    runtime.emitFinalize(row({ id: 'much-later' }));
    watcher.tickAll();
    await settle();

    expect(dispatchChat).toHaveBeenCalledTimes(MAX_WAKES_PER_SESSION + 1);
  });

  it('warns the human only once while capped', async () => {
    const { watcher, persistSystemMessage, advance } = build(runtime);
    await exhaustWakeBudget(watcher, advance);

    runtime.emitFinalize(row({ id: 'over-1' }));
    watcher.tickAll();
    await settle();
    runtime.emitFinalize(row({ id: 'over-2' }));
    watcher.tickAll();
    await settle();

    expect(persistSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('survives a dispatch that rejects, leaving the session free for later wakes', async () => {
    const dispatchChat = vi.fn().mockRejectedValue(new Error('boom'));
    const { watcher } = build(runtime, { dispatchChat });

    runtime.emitFinalize(row());
    await settle();

    expect(dispatchChat).toHaveBeenCalledTimes(1);
    expect(watcher.pendingCount('sess-1')).toBe(0);
  });

  it('survives a dispatch that throws synchronously', async () => {
    const dispatchChat = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const { watcher } = build(runtime, { dispatchChat });
    runtime.emitFinalize(row());
    await settle();

    expect(dispatchChat).toHaveBeenCalledTimes(1);
    expect(watcher.pendingCount('sess-1')).toBe(0);
  });

  it('replays completions left unreported by a prior Hub process on boot', async () => {
    const orphan = row({ id: 'from-last-boot' });
    runtime.put(orphan);
    const { dispatchChat, watcher } = build(runtime, {
      listUnreportedCompletions: () => [orphan],
    });

    expect(watcher.resumePendingOnBoot()).toBe(1);
    await settle();
    expect(dispatchChat).toHaveBeenCalledTimes(1);
    expect(dispatchChat.mock.calls[0][0].content).toContain('npm run build');
  });

  it('skips boot rows that are still running — nothing has finished yet', async () => {
    const stillRunning = row({ id: 'live', status: 'running' });
    runtime.put(stillRunning);
    const { dispatchChat, watcher } = build(runtime, {
      listUnreportedCompletions: () => [stillRunning],
    });

    watcher.resumePendingOnBoot();
    await settle();
    expect(dispatchChat).not.toHaveBeenCalled();
  });

  it('forgetSession clears pending state when the watch is cancelled', () => {
    const { watcher } = build(runtime, { isSessionBusy: () => true });
    runtime.emitFinalize(row());
    expect(watcher.pendingCount('sess-1')).toBe(1);

    watcher.forgetSession('sess-1');
    expect(watcher.pendingCount('sess-1')).toBe(0);
  });

  it('close() detaches from the runtime', async () => {
    const { watcher, dispatchChat } = build(runtime);
    watcher.close();
    runtime.emitFinalize(row());
    await settle();
    expect(dispatchChat).not.toHaveBeenCalled();
  });
});
