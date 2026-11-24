import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { OrchestrateLaunchStore } from '../orchestrate-launch-store.js';

let ownsSession = true;
vi.mock('../session-ownership.js', () => ({
  userOwnsSession: () => ownsSession,
  getSessionOwner: () => null,
}));

const { default: createOrchestrateLaunchRoutes } = await import('./orchestrate-launch.js');

let store: OrchestrateLaunchStore;
let starter: {
  noteTurnEnded: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  pendingCountdowns: ReturnType<typeof vi.fn>;
};
let session: Record<string, unknown> | undefined;
let broadcast: ReturnType<typeof vi.fn>;

function app() {
  const deps = {
    stmts: { getSession: { get: () => session } },
    broadcast,
    getOrchestrateLaunchStore: () => store,
    getOrchestrateAutoStarter: () => starter,
  } as unknown as Parameters<typeof createOrchestrateLaunchRoutes>[0];
  const a = express();
  a.use(express.json());
  a.use(createOrchestrateLaunchRoutes(deps));
  return supertest(a);
}

beforeEach(() => {
  ownsSession = true;
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE session_dispatch_keys (
    owner_user_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    session_id TEXT, agent_id TEXT, project_id TEXT, name TEXT, skipped_skills TEXT, mode TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (owner_user_id, idem_key))`);
  store = new OrchestrateLaunchStore(db);
  broadcast = vi.fn();
  starter = {
    noteTurnEnded: vi.fn(),
    stopSession: vi.fn(),
    cancel: vi.fn(),
    pendingCountdowns: vi.fn(() => [
      { dispatchKey: 'session-forward:orch:7:b:0', remainingMs: 12_000 },
    ]),
  };
  session = { id: 'orch', owner_user_id: 'u1', session_mode: 'orchestrate', deleted_at: null };
});

describe('orchestrate launch routes', () => {
  it('saves Auto start and arms the server countdown for the latest turn', async () => {
    const initial = await app().get('/api/sessions/orch/orchestrate-launch');
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({
      settings: { mode: 'manual', autoStart: false, configured: false, revision: 0 },
      launched: [],
      cancelled: [],
      // The server's own countdowns, as time left, for clients to count down to.
      pending: [{ dispatchKey: 'session-forward:orch:7:b:0', remainingMs: 12_000 }],
    });

    const on = await app()
      .put('/api/sessions/orch/orchestrate-launch')
      .send({ autoStart: true, mode: 'merge' });
    expect(on.status).toBe(200);
    expect(on.body.settings).toEqual({
      mode: 'merge',
      autoStart: true,
      configured: true,
      revision: 1,
    });
    expect(starter.noteTurnEnded).toHaveBeenCalledWith('orch');

    const off = await app().put('/api/sessions/orch/orchestrate-launch').send({ autoStart: false });
    expect(off.body.settings.mode).toBe('merge');
    expect(starter.stopSession).toHaveBeenCalledWith('orch');
    // Other open clients adopt the change.
    expect(broadcast).toHaveBeenLastCalledWith({
      type: 'orchestrate_launch_updated',
      sessionId: 'orch',
      ownerUserId: 'u1',
      settings: { mode: 'merge', autoStart: false, configured: true, revision: 2 },
    });
  });

  it('rejects unknown modes and fields', async () => {
    expect(
      (await app().put('/api/sessions/orch/orchestrate-launch').send({ mode: 'consult' })).status,
    ).toBe(400);
    expect(
      (await app().put('/api/sessions/orch/orchestrate-launch').send({ extra: true })).status,
    ).toBe(400);
  });

  it('cancels one card by its dispatch key', async () => {
    const res = await app()
      .post('/api/sessions/orch/orchestrate-launch/cancel')
      .send({ messageId: 7, forwardId: 'a', occurrence: 0 });
    expect(res.status).toBe(200);
    expect(res.body.dispatchKey).toBe('session-forward:orch:7:a:0');
    expect(starter.cancel).toHaveBeenCalledWith('session-forward:orch:7:a:0');
    // Other open clients hear about it and stop their countdowns.
    expect(broadcast).toHaveBeenCalledWith({
      type: 'orchestrate_auto_start_cancelled',
      sessionId: 'orch',
      ownerUserId: 'u1',
      dispatchKey: 'session-forward:orch:7:a:0',
    });
  });

  it('lists cancelled cards so a client opening the chat later skips them', async () => {
    const withStore = { ...starter, cancel: (key: string) => store.cancel(key) };
    starter = withStore as typeof starter;
    await app()
      .post('/api/sessions/orch/orchestrate-launch/cancel')
      .send({ messageId: 7, forwardId: 'a', occurrence: 0 });
    store.cancel('session-forward:orch-other:1:a:0');
    const res = await app().get('/api/sessions/orch/orchestrate-launch');
    expect(res.body.cancelled).toEqual(['session-forward:orch:7:a:0']);
  });

  it('hides sessions the caller does not own', async () => {
    ownsSession = false;
    expect((await app().get('/api/sessions/orch/orchestrate-launch')).status).toBe(404);
    expect(
      (await app().put('/api/sessions/orch/orchestrate-launch').send({ autoStart: true })).status,
    ).toBe(404);
  });
});
