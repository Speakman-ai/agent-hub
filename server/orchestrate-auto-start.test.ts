/**
 * Server-side Orchestrate Auto start. Regression for forward cards posted by a
 * turn nobody was watching (a session poller run): they only started once the
 * user opened the chat, because the countdown ran in the client alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Project, SessionRow } from './types.js';
import { OrchestrateLaunchStore } from './orchestrate-launch-store.js';
import {
  OrchestrateAutoStarter,
  automaticStartRefusal,
  forwardCardsForMessage,
  noteBroadcastForOrchestrateAutoStart,
  setOrchestrateAutoStarter,
  type OrchestrateAutoStartDeps,
} from './orchestrate-auto-start.js';

/** Save launch settings for a chat (tests only). */
function saveLaunch(
  target: OrchestrateLaunchStore,
  sessionId: string,
  patch: Parameters<OrchestrateLaunchStore['setSettings']>[1],
) {
  return target.setSettings(sessionId, patch);
}

function forwardPayload(forwardId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'session_forward',
    forwardId,
    projectId: 'web',
    agentId: 'web-dev',
    name: `Do ${forwardId}`,
    summary: 's',
    prompt: `Prompt for ${forwardId}`,
    mode: 'manual',
    ...extra,
  });
}

const project = { id: 'web', name: 'Web', agents: [] } as unknown as Project;

describe('OrchestrateAutoStarter', () => {
  let db: Database.Database;
  let store: OrchestrateLaunchStore;
  let session: Partial<SessionRow>;
  let forwardRows: Array<{ payload: string }>;
  let dispatchKeys: Map<string, { session_id: string | null }>;
  let timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  let dispatch: ReturnType<typeof vi.fn>;
  let broadcast: ReturnType<typeof vi.fn>;
  let starter: OrchestrateAutoStarter;
  let clock: number;

  const fireAll = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
  };

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE session_dispatch_keys (
      owner_user_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      session_id TEXT, agent_id TEXT, project_id TEXT, name TEXT, skipped_skills TEXT, mode TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_user_id, idem_key))`);
    store = new OrchestrateLaunchStore(db);
    session = { id: 'orch', owner_user_id: 'owner-1', session_mode: 'orchestrate' };
    forwardRows = [{ payload: forwardPayload('a') }, { payload: forwardPayload('b') }];
    dispatchKeys = new Map();
    timers = [];
    dispatch = vi.fn((args: { body: { idempotencyKey: string; mode: string } }) => {
      dispatchKeys.set(args.body.idempotencyKey, { session_id: 'child' });
      return {
        status: 201,
        body: { sessionId: 'child', agentId: 'web-dev', name: 'Do a', mode: args.body.mode },
      };
    });
    broadcast = vi.fn();
    clock = 1_000_000;
    const deps: OrchestrateAutoStartDeps = {
      stmts: {
        getSession: { get: (id: string) => (id === session.id ? session : undefined) },
        getMessagesPageLatest: {
          all: () => [
            { id: 7, role: 'assistant', content: 'Starting these.' },
            { id: 6, role: 'user', content: 'go' },
          ],
        },
        getMessageSessionForwardEvents: { all: () => forwardRows },
        getSessionDispatchKey: { get: (_owner: string, key: string) => dispatchKeys.get(key) },
      } as unknown as OrchestrateAutoStartDeps['stmts'],
      store,
      findProject: (id) => (id === 'web' ? project : undefined),
      // Every message here was posted after Auto start was switched on.
      messageOrder: () => 100,
      canUseProject: () => true,
      dispatch: dispatch as unknown as OrchestrateAutoStartDeps['dispatch'],
      broadcast: broadcast as unknown as OrchestrateAutoStartDeps['broadcast'],
      now: () => clock,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    };
    starter = new OrchestrateAutoStarter(deps);
  });

  it('starts every card of an unwatched turn after the countdown', () => {
    saveLaunch(store, 'orch', { autoStart: true, mode: 'merge' });
    starter.noteTurnEnded('orch');
    expect(timers.map((t) => t.ms)).toEqual([30_000, 30_000]);
    expect(dispatch).not.toHaveBeenCalled();

    fireAll();

    expect(dispatch).toHaveBeenCalledTimes(2);
    const first = dispatch.mock.calls[0][0];
    expect(first.ownerUserId).toBe('owner-1');
    expect(first.callingSession).toBe(session);
    expect(first.body).toMatchObject({
      prompt: 'Prompt for a',
      agentId: 'web-dev',
      name: 'Do a',
      mode: 'merge',
      idempotencyKey: 'session-forward:orch:7:a:0',
    });
    // The start itself is published by the shared dispatch, not here.
    expect(broadcast.mock.calls.map((c) => c[0].type)).not.toContain(
      'orchestrate_auto_start_ended',
    );
  });

  it('tells clients when a countdown ends without a start', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    starter.noteTurnEnded('orch');
    dispatch.mockReturnValueOnce({ status: 400, body: { error: 'no agent' } });
    fireAll();
    const ended = broadcast.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'orchestrate_auto_start_ended');
    expect(ended).toEqual([
      expect.objectContaining({ sessionId: 'orch', dispatchKey: 'session-forward:orch:7:a:0' }),
    ]);
  });

  it('tells clients their countdowns ended when Auto start is turned off', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    starter.noteTurnEnded('orch');
    broadcast.mockClear();
    starter.stopSession('orch');
    expect(broadcast.mock.calls.map((c) => c[0].dispatchKey).sort()).toEqual([
      'session-forward:orch:7:a:0',
      'session-forward:orch:7:b:0',
    ]);
    expect(broadcast.mock.calls.every((c) => c[0].type === 'orchestrate_auto_start_ended')).toBe(
      true,
    );
    expect(starter.pendingKeys()).toEqual([]);
  });

  it('tells clients when a restart drops a saved countdown that no longer applies', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    store.savePending(
      'session-forward:orch:7:a:0',
      'orch',
      {
        dispatchKey: 'session-forward:orch:7:a:0',
        messageId: '7',
        forward: JSON.parse(forwardPayload('a')),
      },
      clock + 10_000,
    );
    store.cancel('session-forward:orch:7:a:0');
    starter.sweep();
    expect(store.listPending().map((p) => p.dispatchKey)).not.toContain(
      'session-forward:orch:7:a:0',
    );
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orchestrate_auto_start_ended',
        dispatchKey: 'session-forward:orch:7:a:0',
      }),
    );
  });

  it('stays quiet when the card was started by a press before its countdown ended', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    starter.noteTurnEnded('orch');
    // Another device pressed Start; that dispatch already published the start.
    dispatchKeys.set('session-forward:orch:7:a:0', { session_id: 'pressed' });
    broadcast.mockClear();
    fireAll();
    expect(dispatch.mock.calls.map((c) => c[0].body.idempotencyKey)).toEqual([
      'session-forward:orch:7:b:0',
    ]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('publishes its countdown so a card opened later shows the real time left', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    starter.noteTurnEnded('orch');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orchestrate_auto_start_scheduled',
        sessionId: 'orch',
        dispatchKey: 'session-forward:orch:7:a:0',
        remainingMs: 30_000,
      }),
    );
    // The user opens the chat 20 seconds later.
    clock += 20_000;
    expect(starter.pendingCountdowns('orch')).toEqual([
      { dispatchKey: 'session-forward:orch:7:a:0', remainingMs: 10_000 },
      { dispatchKey: 'session-forward:orch:7:b:0', remainingMs: 10_000 },
    ]);
    starter.cancel('session-forward:orch:7:a:0');
    expect(starter.pendingCountdowns('orch').map((c) => c.dispatchKey)).toEqual([
      'session-forward:orch:7:b:0',
    ]);
    expect(starter.pendingCountdowns('other')).toEqual([]);
  });

  it('does not treat an unfinished dispatch claim as a started card, and retries after it', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    // A claim with no session: a start in progress, or one a crash abandoned.
    dispatchKeys.set('session-forward:orch:7:a:0', { session_id: null });
    starter.noteTurnEnded('orch');
    expect(starter.pendingKeys()).toContain('session-forward:orch:7:a:0');

    // While the claim is held, the dispatch route answers 409 dispatch_in_progress.
    const realDispatch = dispatch.getMockImplementation()!;
    dispatch.mockImplementationOnce(() => ({
      status: 409,
      body: {
        error: 'A session for this request is already starting',
        code: 'dispatch_in_progress',
      },
    }));
    const aTimer = timers[0];
    timers.splice(0, 1)[0].fn();
    expect(aTimer.ms).toBe(30_000);
    // Re-armed a minute later instead of giving up.
    expect(starter.pendingKeys()).toContain('session-forward:orch:7:a:0');
    const retry = timers.find((t) => !t.cleared && t.ms === 60_000)!;
    expect(retry).toBeTruthy();

    // The abandoned claim has been cleared by then; the retry starts the card.
    dispatchKeys.delete('session-forward:orch:7:a:0');
    dispatch.mockImplementation(realDispatch);
    retry.fn();
    expect(
      dispatch.mock.calls.filter((c) => c[0].body.idempotencyKey === 'session-forward:orch:7:a:0'),
    ).toHaveLength(2);
    expect(dispatchKeys.get('session-forward:orch:7:a:0')).toEqual({ session_id: 'child' });
  });

  it('does nothing with Auto start off or outside Orchestrate', () => {
    starter.noteTurnEnded('orch');
    expect(timers).toHaveLength(0);

    saveLaunch(store, 'orch', { autoStart: true });
    session.session_mode = 'chat';
    starter.noteTurnEnded('orch');
    expect(timers).toHaveLength(0);
  });

  it('skips cancelled cards and cards a client already started', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    store.cancel('session-forward:orch:7:a:0');
    dispatchKeys.set('session-forward:orch:7:b:0', { session_id: 'started-by-browser' });
    starter.noteTurnEnded('orch');
    expect(timers).toHaveLength(0);
  });

  it('stops a countdown cancelled from a client', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    starter.noteTurnEnded('orch');
    starter.cancel('session-forward:orch:7:a:0');
    fireAll();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].body.idempotencyKey).toBe('session-forward:orch:7:b:0');
    expect(store.isCancelled('session-forward:orch:7:a:0')).toBe(true);
  });

  it('re-checks settings when the countdown ends', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    starter.noteTurnEnded('orch');
    saveLaunch(store, 'orch', { autoStart: false });
    fireAll();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not schedule a card twice for repeated turn-end events', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    starter.noteTurnEnded('orch');
    starter.noteTurnEnded('orch');
    expect(starter.pendingKeys()).toHaveLength(2);
  });

  it('re-arms cards after a restart from the boot sweep', () => {
    saveLaunch(store, 'orch', { autoStart: true });
    starter.sweep();
    expect(starter.pendingKeys()).toEqual([
      'session-forward:orch:7:a:0',
      'session-forward:orch:7:b:0',
    ]);
  });

  it('resolves a workflow target to consult', () => {
    const workflow = { ...project, mode: 'workflow' } as unknown as Project;
    saveLaunch(store, 'orch', { autoStart: true, mode: 'merge' });
    const deps = (starter as unknown as { deps: OrchestrateAutoStartDeps }).deps;
    deps.findProject = () => workflow;
    starter.noteTurnEnded('orch');
    fireAll();
    expect(dispatch.mock.calls[0][0].body.mode).toBe('consult');
  });

  it('feeds turn ends from the broadcast tap', async () => {
    saveLaunch(store, 'orch', { autoStart: true });
    setOrchestrateAutoStarter(starter);
    try {
      noteBroadcastForOrchestrateAutoStart({ type: 'done', sessionId: 'orch' });
      noteBroadcastForOrchestrateAutoStart({ type: 'awaiting_input', sessionId: 'orch' });
      await Promise.resolve();
      expect(starter.pendingKeys()).toHaveLength(2);
    } finally {
      setOrchestrateAutoStarter(null);
    }
  });
});

describe('forwardCardsForMessage', () => {
  it('numbers repeated forward ids the way the clients do and skips clamped payloads', () => {
    const rows = [
      { payload: forwardPayload('a') },
      { payload: '{"forwardId":"a","prompt":"trunc' },
      { payload: forwardPayload('a') },
    ];
    const cards = forwardCardsForMessage(
      { getMessageSessionForwardEvents: { all: () => rows } } as never,
      's1',
      { id: '9', content: '' },
    );
    expect(cards.map((c) => c.dispatchKey)).toEqual([
      'session-forward:s1:9:a:0',
      'session-forward:s1:9:a:2',
    ]);
  });
});

describe('OrchestrateLaunchStore', () => {
  it('records the newest message when Auto start is switched on and keeps it across saves', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE messages (id TEXT, session_id TEXT)');
    const post = (id: string) => db.prepare("INSERT INTO messages VALUES (?, 's1')").run(id);
    const store = new OrchestrateLaunchStore(db);
    post('m1');
    post('m2');
    expect(store.activationBoundary('s1')).toBeNull();
    store.setSettings('s1', { mode: 'push' });
    expect(store.activationBoundary('s1')).toBeNull();
    store.setSettings('s1', { autoStart: true });
    expect(store.activationBoundary('s1')).toBe(store.messageOrder('m2'));
    post('m3');
    // A Default build change, or saving "on" again, does not move it.
    store.setSettings('s1', { mode: 'merge' });
    store.setSettings('s1', { autoStart: true });
    expect(store.activationBoundary('s1')).toBe(store.messageOrder('m2'));
    store.setSettings('s1', { autoStart: false });
    expect(store.activationBoundary('s1')).toBeNull();
    store.setSettings('s1', { autoStart: true });
    expect(store.activationBoundary('s1')).toBe(store.messageOrder('m3'));
    expect(store.messageOrder('missing')).toBeNull();
  });

  it('saves settings and lists launched cards for the chat owner', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE session_dispatch_keys (
      owner_user_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      session_id TEXT, agent_id TEXT, project_id TEXT, name TEXT, skipped_skills TEXT, mode TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_user_id, idem_key))`);
    const store = new OrchestrateLaunchStore(db);
    expect(store.getSettings('s1')).toEqual({
      mode: 'manual',
      autoStart: false,
      configured: false,
      revision: 0,
    });
    expect(store.setSettings('s1', { autoStart: true })).toEqual({
      mode: 'manual',
      autoStart: true,
      configured: true,
      revision: 1,
    });
    const next = store.setSettings('s1', { mode: 'push' });
    expect(next.autoStart).toBe(true);
    // Every save bumps the revision clients order server values by.
    expect(next.revision).toBe(2);
    expect(store.getSettings('s1').revision).toBe(2);
    expect(store.listAutoStartSessionIds()).toEqual(['s1']);

    db.prepare(
      `INSERT INTO session_dispatch_keys (owner_user_id, idem_key, request_hash, session_id, agent_id, name, mode)
       VALUES ('u1', 'session-forward:s1:3:a:0', 'h', 'child', 'dev', 'Do a', 'merge'),
              ('u1', 'session-forward:s10:3:a:0', 'h', 'other', 'dev', 'Other', 'merge'),
              ('u1', 'session-forward:s1:4:b:0', 'h', NULL, NULL, NULL, NULL)`,
    ).run();
    expect(store.listLaunched('s1', 'u1')).toEqual([
      {
        dispatchKey: 'session-forward:s1:3:a:0',
        sessionId: 'child',
        agentId: 'dev',
        name: 'Do a',
        mode: 'merge',
      },
    ]);
    expect(store.listLaunched('s1', null)).toEqual([]);
  });
});

describe('automaticStartRefusal', () => {
  it('allows only a live Orchestrate chat with Auto start on and an uncancelled card', () => {
    const store = new OrchestrateLaunchStore(new Database(':memory:'));
    const chat = { id: 'c', session_mode: 'orchestrate', deleted_at: null };
    expect(automaticStartRefusal(store, chat, 'k')?.code).toBe('auto_start_off');
    saveLaunch(store, 'c', { autoStart: true });
    expect(automaticStartRefusal(store, chat, 'k')).toBeNull();
    store.cancel('k');
    expect(automaticStartRefusal(store, chat, 'k')?.code).toBe('auto_start_cancelled');
    expect(automaticStartRefusal(store, chat, null)).toBeNull();
    expect(automaticStartRefusal(store, { ...chat, session_mode: 'chat' }, null)?.code).toBe(
      'auto_start_off',
    );
    expect(automaticStartRefusal(store, { ...chat, deleted_at: 'x' }, null)?.code).toBe(
      'auto_start_off',
    );
    expect(automaticStartRefusal(store, undefined, null)?.code).toBe('auto_start_off');
  });
});

describe('OrchestrateAutoStarter across turns and restarts', () => {
  function setup(db: Database.Database, clock: { now: number }) {
    db.exec('CREATE TABLE IF NOT EXISTS messages (id TEXT, session_id TEXT)');
    const store = new OrchestrateLaunchStore(db);
    const session = { id: 'orch', owner_user_id: 'owner-1', session_mode: 'orchestrate' };
    const messages: Array<{ id: string; role: string; content: string }> = [];
    const cardsByMessage = new Map<string, Array<{ payload: string }>>();
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean; key: string }> = [];
    const started = new Set<string>();
    const dispatch = vi.fn((args: { body: { idempotencyKey: string } }) => {
      started.add(args.body.idempotencyKey);
      return {
        status: 201,
        body: { sessionId: 'child', agentId: 'dev', name: 'n', mode: 'manual' },
      };
    });
    const make = () =>
      new OrchestrateAutoStarter({
        stmts: {
          getSession: { get: (id: string) => (id === 'orch' ? session : undefined) },
          getMessagesPageLatest: { all: () => [...messages].reverse() },
          getMessageSessionForwardEvents: {
            all: (id: string) => cardsByMessage.get(String(id)) ?? [],
          },
          getSessionDispatchKey: {
            get: (_o: string, key: string) => (started.has(key) ? { session_id: 'x' } : undefined),
          },
        } as unknown as OrchestrateAutoStartDeps['stmts'],
        store,
        findProject: () => ({ id: 'web', name: 'Web', agents: [] }) as unknown as Project,
        canUseProject: () => true,
        dispatch: dispatch as unknown as OrchestrateAutoStartDeps['dispatch'],
        now: () => clock.now,
        setTimer: (fn, ms) => {
          const timer = { fn, ms, cleared: false, key: '' };
          timers.push(timer);
          return timer;
        },
        clearTimer: (handle) => {
          (handle as { cleared: boolean }).cleared = true;
        },
      });
    const addTurn = (id: string, forwardIds: string[]) => {
      messages.push({ id: `u${id}`, role: 'user', content: 'go' });
      messages.push({ id, role: 'assistant', content: '' });
      // Real rows, so the Auto start boundary is a real insert order.
      db.prepare("INSERT INTO messages VALUES (?, 'orch')").run(`u${id}`);
      db.prepare("INSERT INTO messages VALUES (?, 'orch')").run(id);
      cardsByMessage.set(
        id,
        forwardIds.map((f) => ({ payload: forwardPayload(f) })),
      );
    };
    return { store, make, addTurn, timers, dispatch, db };
  }

  it('resumes an earlier turn’s countdown after a restart that followed a later turn', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE session_dispatch_keys (
      owner_user_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      session_id TEXT, agent_id TEXT, project_id TEXT, name TEXT, skipped_skills TEXT, mode TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_user_id, idem_key))`);
    const clock = { now: 1_000_000 };
    const env = setup(db, clock);
    saveLaunch(env.store, 'orch', { autoStart: true });

    const before = env.make();
    env.addTurn('7', ['a']); // turn A
    before.noteTurnEnded('orch');
    clock.now += 10_000;
    env.addTurn('9', ['c']); // turn B, before A's deadline
    before.noteTurnEnded('orch');
    expect(before.pendingKeys().sort()).toEqual([
      'session-forward:orch:7:a:0',
      'session-forward:orch:9:c:0',
    ]);

    // The server restarts 10 seconds later; in-memory timers are gone.
    before.stopAll();
    env.timers.length = 0;
    clock.now += 10_000;
    const after = env.make();
    after.sweep();
    expect(after.pendingCountdowns('orch')).toEqual(
      expect.arrayContaining([
        { dispatchKey: 'session-forward:orch:7:a:0', remainingMs: 10_000 },
        { dispatchKey: 'session-forward:orch:9:c:0', remainingMs: 20_000 },
      ]),
    );
    expect(env.timers.map((t) => t.ms).sort((x, y) => x - y)).toEqual([10_000, 20_000]);

    for (const timer of env.timers.splice(0)) timer.fn();
    expect(env.dispatch.mock.calls.map((c) => c[0].body.idempotencyKey).sort()).toEqual([
      'session-forward:orch:7:a:0',
      'session-forward:orch:9:c:0',
    ]);
    // Fired countdowns are no longer saved.
    expect(env.store.listPending()).toEqual([]);
  });

  it('schedules a card posted after Auto start was switched on even when newer messages were deleted', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE session_dispatch_keys (
      owner_user_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      session_id TEXT, agent_id TEXT, project_id TEXT, name TEXT, skipped_skills TEXT, mode TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_user_id, idem_key))`);
    const env = setup(db, { now: 5_000 });
    const starter = env.make();
    env.addTurn('7', ['a']);
    // Another chat's recent messages, the newest rows at activation.
    db.prepare("INSERT INTO messages VALUES ('x1', 'other')").run();
    db.prepare("INSERT INTO messages VALUES ('x2', 'other')").run();
    saveLaunch(env.store, 'orch', { autoStart: true });
    // The newest rows are deleted, so a rowid-based boundary would be reused.
    db.prepare("DELETE FROM messages WHERE id IN ('x1', 'x2', '7', 'u7')").run();
    env.addTurn('9', ['c']);
    starter.noteTurnEnded('orch');
    expect(starter.pendingKeys()).toEqual(['session-forward:orch:9:c:0']);
  });

  it('never starts a card posted before Auto start was switched on, even in the same second', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE session_dispatch_keys (
      owner_user_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      session_id TEXT, agent_id TEXT, project_id TEXT, name TEXT, skipped_skills TEXT, mode TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_user_id, idem_key))`);
    const env = setup(db, { now: 5_000 });
    const starter = env.make();
    // Posted just before Auto start is switched on (no clock involved: the
    // boundary is the message insert order). The server cannot know whether
    // it was cancelled in a browser, so it never starts it.
    env.addTurn('7', ['a']);
    saveLaunch(env.store, 'orch', { autoStart: true });
    starter.noteTurnEnded('orch');
    expect(starter.pendingKeys()).toEqual([]);
    // A card posted right after does start.
    env.addTurn('9', ['c']);
    starter.noteTurnEnded('orch');
    expect(starter.pendingKeys()).toEqual(['session-forward:orch:9:c:0']);

    // Off and quickly on again: card c is now from before.
    starter.stopSession('orch');
    saveLaunch(env.store, 'orch', { autoStart: false });
    saveLaunch(env.store, 'orch', { autoStart: true });
    expect(env.store.listPending()).toEqual([]);
    starter.noteTurnEnded('orch');
    expect(starter.pendingKeys()).toEqual([]);
  });
});

describe('OrchestrateAutoStarter when a chat leaves Orchestrate', () => {
  function setupWithSessions() {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, owner_user_id TEXT, session_mode TEXT, deleted_at TEXT)`);
    db.exec(`CREATE TABLE session_dispatch_keys (
      owner_user_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      session_id TEXT, agent_id TEXT, project_id TEXT, name TEXT, skipped_skills TEXT, mode TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_user_id, idem_key))`);
    db.exec('CREATE TABLE messages (id TEXT, session_id TEXT)');
    db.prepare("INSERT INTO sessions VALUES ('orch', 'owner-1', 'orchestrate', NULL)").run();
    const store = new OrchestrateLaunchStore(db);
    // Auto start was switched on before the card was posted.
    store.setSettings('orch', { autoStart: true });
    db.prepare("INSERT INTO messages VALUES ('7', 'orch')").run();
    const timers: Array<{ fn: () => void; cleared: boolean }> = [];
    const dispatch = vi.fn(() => ({ status: 201, body: { sessionId: 'child' } }));
    const broadcast = vi.fn();
    const make = () =>
      new OrchestrateAutoStarter({
        stmts: {
          getSession: {
            get: (id: string) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id),
          },
          getMessagesPageLatest: {
            all: () => [{ id: '7', role: 'assistant', content: '' }],
          },
          getMessageSessionForwardEvents: { all: () => [{ payload: forwardPayload('a') }] },
          getSessionDispatchKey: { get: () => undefined },
        } as unknown as OrchestrateAutoStartDeps['stmts'],
        store,
        findProject: () => ({ id: 'web', name: 'Web', agents: [] }) as unknown as Project,
        canUseProject: () => true,
        dispatch: dispatch as unknown as OrchestrateAutoStartDeps['dispatch'],
        broadcast: broadcast as unknown as OrchestrateAutoStartDeps['broadcast'],
        setTimer: (fn) => {
          const timer = { fn, cleared: false };
          timers.push(timer);
          return timer;
        },
        clearTimer: (handle) => {
          (handle as { cleared: boolean }).cleared = true;
        },
      });
    const setMode = (mode: string) =>
      db.prepare("UPDATE sessions SET session_mode = ? WHERE id = 'orch'").run(mode);
    return { db, store, make, timers, dispatch, broadcast, setMode };
  }
  const key = 'session-forward:orch:7:a:0';

  it('does not start the old card when the chat comes back before the deadline', () => {
    const env = setupWithSessions();
    const starter = env.make();
    starter.noteTurnEnded('orch');
    expect(env.store.listPending().map((p) => p.dispatchKey)).toEqual([key]);

    env.setMode('chat');
    expect(env.store.listPending()).toEqual([]);
    env.setMode('orchestrate');
    // The original timer fires after the chat is back in Orchestrate.
    env.timers.shift()!.fn();
    expect(env.dispatch).not.toHaveBeenCalled();
    expect(env.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'orchestrate_auto_start_ended', dispatchKey: key }),
    );
    // The next turn end does not pick the old card up again either.
    starter.noteTurnEnded('orch');
    expect(starter.pendingKeys()).toEqual([]);
  });

  it('does not resume the countdown after a restart once the chat left Orchestrate', () => {
    const env = setupWithSessions();
    env.make().noteTurnEnded('orch');
    env.setMode('chat');
    env.setMode('orchestrate');
    // Restart: a fresh starter resumes saved countdowns.
    env.timers.length = 0;
    const after = env.make();
    after.sweep();
    expect(after.pendingKeys()).toEqual([]);
    expect(env.dispatch).not.toHaveBeenCalled();
  });

  it('keeps counting when the chat stays in Orchestrate', () => {
    const env = setupWithSessions();
    env.make().noteTurnEnded('orch');
    env.timers.shift()!.fn();
    expect(env.dispatch).toHaveBeenCalledTimes(1);
  });
});
