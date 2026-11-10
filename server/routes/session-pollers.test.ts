import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { SessionPollerStore } from '../session-pollers/session-poller-store.js';

let ownsSession = true;
vi.mock('../session-ownership.js', () => ({
  userOwnsSession: () => ownsSession,
  getSessionOwner: () => null,
}));

const { default: createSessionPollerRoutes } = await import('./session-pollers.js');

let store: SessionPollerStore;
let broadcast: ReturnType<typeof vi.fn>;
let kick: ReturnType<typeof vi.fn>;
let session: Record<string, unknown> | undefined;

function app() {
  const deps = {
    stmts: { getSession: { get: () => session } },
    broadcast,
    getSessionPollerStore: () => store,
    kickSessionPollers: kick,
  } as unknown as Parameters<typeof createSessionPollerRoutes>[0];
  const a = express();
  a.use(express.json());
  a.use(createSessionPollerRoutes(deps));
  return supertest(a);
}

const body = {
  pollerId: 'dev-tickets',
  task: 'Check dev for new tickets',
  intervalMinutes: 30,
  durationMinutes: 1120,
  notifyEachRun: false,
  notifyOnComplete: true,
};

beforeEach(() => {
  ownsSession = true;
  store = new SessionPollerStore(new Database(':memory:'));
  broadcast = vi.fn();
  kick = vi.fn();
  session = { id: 'sess-1', agent_id: 'agent-1', deleted_at: null };
});

describe('session poller routes', () => {
  it('starts a poller, kicks the scheduler, and is idempotent per pollerId', async () => {
    const res = await app().post('/api/sessions/sess-1/pollers').send(body);
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.poller).toMatchObject({
      sessionId: 'sess-1',
      pollerId: 'dev-tickets',
      intervalMinutes: 30,
      durationMinutes: 1120,
      status: 'active',
      runCount: 0,
    });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_poller_updated', sessionId: 'sess-1' }),
    );

    const again = await app().post('/api/sessions/sess-1/pollers').send(body);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(kick).toHaveBeenCalledTimes(1);

    const list = await app().get('/api/sessions/sess-1/pollers');
    expect(list.body.pollers).toHaveLength(1);
  });

  it('rejects non-positive or fractional minutes', async () => {
    for (const bad of [
      { intervalMinutes: 0 },
      { durationMinutes: -1 },
      { intervalMinutes: 1.5 },
      { task: '   ' },
    ]) {
      const res = await app()
        .post('/api/sessions/sess-1/pollers')
        .send({ ...body, ...bad });
      expect(res.status).toBe(400);
    }
  });

  it('stops a poller', async () => {
    const created = await app().post('/api/sessions/sess-1/pollers').send(body);
    const res = await app().post(`/api/sessions/sess-1/pollers/${created.body.poller.id}/stop`);
    expect(res.status).toBe(200);
    expect(res.body.poller.status).toBe('cancelled');
    expect(store.get(created.body.poller.id)?.nextRunAt).toBeNull();
  });

  it('404s for sessions the caller does not own and for pollers in other sessions', async () => {
    const created = await app().post('/api/sessions/sess-1/pollers').send(body);
    ownsSession = false;
    expect((await app().get('/api/sessions/sess-1/pollers')).status).toBe(404);
    ownsSession = true;
    session = { id: 'sess-2', agent_id: 'agent-1', deleted_at: null };
    const res = await app().post(`/api/sessions/sess-2/pollers/${created.body.poller.id}/stop`);
    expect(res.status).toBe(404);
  });
});
