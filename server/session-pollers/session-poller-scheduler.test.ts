import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SessionPollerStore } from './session-poller-store.js';
import {
  SessionPollerScheduler,
  SESSION_POLLER_NOTIFY_EVENT,
  SESSION_POLLER_UPDATED_EVENT,
  buildPollerRunPrompt,
  pollerReplyPreview,
  type PollerSessionLike,
} from './session-poller-scheduler.js';

const T0 = new Date('2026-11-10T14:00:00.000Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

let store: SessionPollerStore;
let now: Date;
let busy: boolean;
let awaiting: boolean;
let session: PollerSessionLike | undefined;
let dispatch: ReturnType<typeof vi.fn<(msg: { content: string }) => Promise<void>>>;
let broadcast: ReturnType<typeof vi.fn<(data: Record<string, unknown>) => void>>;
let systemMessages: string[];
let pendingTurn: { resolve: () => void } | null;

function makeScheduler() {
  return new SessionPollerScheduler({
    store,
    getSession: () => session,
    resolveProjectId: () => 'proj-1',
    isSessionBusy: () => busy,
    isSessionAwaitingUserInput: () => awaiting,
    dispatchChat: dispatch,
    getLatestAssistantText: () => '## Found **3** new tickets\n\nAll from QA.',
    broadcast,
    persistSystemMessage: (_id, content) => systemMessages.push(content),
    now: () => now,
    logger: { log: () => {}, warn: () => {} },
  });
}

function startPoller(over: Partial<Parameters<SessionPollerStore['create']>[0]> = {}) {
  return store.create({
    sessionId: 'sess-1',
    pollerId: 'dev-tickets',
    task: 'Check dev for new tickets',
    intervalMinutes: 30,
    durationMinutes: 60,
    notifyEachRun: false,
    notifyOnComplete: true,
    now: T0,
    ...over,
  }).poller;
}

/** Let the dispatch promise settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store = new SessionPollerStore(new Database(':memory:'));
  now = T0;
  busy = false;
  awaiting = false;
  session = { id: 'sess-1', agent_id: 'agent-1', owner_user_id: 'user-1' };
  systemMessages = [];
  pendingTurn = null;
  dispatch = vi.fn<(msg: { content: string }) => Promise<void>>().mockResolvedValue(undefined);
  broadcast = vi.fn<(data: Record<string, unknown>) => void>();
});

const notifications = () =>
  broadcast.mock.calls.map((c) => c[0]).filter((e) => e.type === SESSION_POLLER_NOTIFY_EVENT);

describe('SessionPollerStore', () => {
  it('is idempotent on (session, pollerId) and runs the first check immediately', () => {
    const first = store.create({
      sessionId: 's',
      pollerId: 'p',
      task: 't',
      intervalMinutes: 5,
      durationMinutes: 20,
      notifyEachRun: false,
      notifyOnComplete: true,
      now: T0,
    });
    const again = store.create({
      sessionId: 's',
      pollerId: 'p',
      task: 'different',
      intervalMinutes: 1,
      durationMinutes: 1,
      notifyEachRun: true,
      notifyOnComplete: false,
      now: min(3),
    });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.poller.id).toBe(first.poller.id);
    expect(first.poller.nextRunAt).toBe(T0.toISOString());
    expect(first.poller.endsAt).toBe(min(20).toISOString());
  });

  it('skips missed slots instead of replaying them', () => {
    const p = startPoller({ intervalMinutes: 10, durationMinutes: 120 });
    const after = store.recordRun(p.id, min(35));
    expect(after?.runCount).toBe(1);
    expect(after?.nextRunAt).toBe(min(40).toISOString());
  });
});

describe('SessionPollerScheduler', () => {
  it('runs on the interval and completes when the window ends', async () => {
    const p = startPoller();
    const s = makeScheduler();

    s.tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      type: 'chat',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      _sessionPollerRun: true,
    });
    expect(dispatch.mock.calls[0][0].content).toContain('Task: Check dev for new tickets');

    now = min(10);
    s.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);

    now = min(30);
    s.tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(2);

    now = min(60);
    s.tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(2);
    const done = store.get(p.id);
    expect(done?.status).toBe('completed');
    expect(done?.runCount).toBe(2);
    expect(systemMessages).toEqual(['Poller finished after 2 runs: Check dev for new tickets']);
    expect(notifications()).toEqual([
      expect.objectContaining({
        kind: 'complete',
        sessionId: 'sess-1',
        ownerUserId: 'user-1',
        projectId: 'proj-1',
        pollerId: p.id,
      }),
    ]);
    expect(broadcast.mock.calls.some((c) => c[0].type === SESSION_POLLER_UPDATED_EVENT)).toBe(true);
  });

  it('defers a due run while the session is busy or waiting on the user', async () => {
    startPoller();
    const s = makeScheduler();
    busy = true;
    s.tick();
    expect(dispatch).not.toHaveBeenCalled();
    busy = false;
    awaiting = true;
    s.tick();
    expect(dispatch).not.toHaveBeenCalled();
    awaiting = false;
    now = min(1);
    s.tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('notifies after each run with a plain preview when asked', async () => {
    startPoller({ notifyEachRun: true, notifyOnComplete: false });
    const s = makeScheduler();
    s.tick();
    await flush();
    expect(notifications()).toEqual([
      expect.objectContaining({
        kind: 'run',
        runCount: 1,
        body: 'Found 3 new tickets All from QA.',
      }),
    ]);
  });

  it('does not notify on completion when notifyOnComplete is off', async () => {
    const p = startPoller({ notifyOnComplete: false });
    const s = makeScheduler();
    now = min(61);
    s.tick();
    expect(store.get(p.id)?.status).toBe('completed');
    expect(notifications()).toEqual([]);
  });

  it('does not overlap runs while one is still in flight', async () => {
    dispatch = vi.fn<(msg: { content: string }) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          pendingTurn = { resolve };
        }),
    );
    const p = startPoller({ intervalMinutes: 1, durationMinutes: 10 });
    const s = makeScheduler();
    s.tick();
    now = min(2);
    s.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    pendingTurn!.resolve();
    await flush();
    s.tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(store.get(p.id)?.runCount).toBe(2);
  });

  it('cancels pollers whose session is gone', () => {
    const p = startPoller();
    session = { id: 'sess-1', agent_id: 'agent-1', deleted_at: '2026-11-10' };
    makeScheduler().tick();
    expect(store.get(p.id)?.status).toBe('cancelled');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('runs only one poller per session per tick', async () => {
    startPoller({ pollerId: 'a' });
    startPoller({ pollerId: 'b' });
    const s = makeScheduler();
    s.tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('fairness across pollers in one session', () => {
  it('lets every due poller run instead of starving the newest', async () => {
    for (const id of ['a', 'b', 'c']) {
      startPoller({ pollerId: id, task: `task-${id}`, intervalMinutes: 1, durationMinutes: 60 });
    }
    const s = makeScheduler();
    // 30-second ticks for 6 minutes; each turn finishes before the next tick.
    for (let tick = 0; tick < 12; tick++) {
      now = new Date(T0.getTime() + tick * 30_000);
      s.tick();
      await flush();
    }
    const runs: Record<string, number> = {};
    for (const call of dispatch.mock.calls) {
      const task = /Task: (task-\w)/.exec(call[0].content)?.[1] ?? '?';
      runs[task] = (runs[task] ?? 0) + 1;
    }
    expect(Object.keys(runs).sort()).toEqual(['task-a', 'task-b', 'task-c']);
    const counts = Object.values(runs);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(dispatch).toHaveBeenCalledTimes(12);
  });
});

describe('prompt helpers', () => {
  it('builds a run prompt with progress and the task', () => {
    const p = startPoller({ durationMinutes: 120 });
    const text = buildPollerRunPrompt(p, T0);
    expect(text).toContain('run 1 of about 4, every 30 min, 2h left');
    expect(text).toContain('do not start another poller');
  });

  it('strips control blocks and markdown from previews', () => {
    expect(pollerReplyPreview('ok <agenthub:react>{"a":1}</agenthub:react> **done**')).toBe(
      'ok done',
    );
    expect(pollerReplyPreview('x'.repeat(300))).toHaveLength(200);
    expect(pollerReplyPreview('')).toBeNull();
  });
});
