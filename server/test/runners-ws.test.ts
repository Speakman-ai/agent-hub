/**
 * Runner WebSocket handshake tests. Boots a tiny throwaway http server
 * + ws.WebSocketServer with handleRunnerConnection wired in, then
 * connects a real ws client and asserts the registered/auth_error
 * frames the protocol promises.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import {
  handleRunnerConnection,
  isRunnerWsPath,
  activeRunners,
  MAX_MISSED_PONGS,
  getRunnerSender,
  subscribeToRunner,
} from '../runners-ws.js';
import { getDb } from '../db.js';
import { createRunner } from '../runners-store.js';
import { RUNNER_PROTOCOL_VERSION } from '../../shared/runner-protocol.js';

let server: Server;
let wss: WebSocketServer;
let baseUrl = '';

beforeAll(async () => {
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    if (isRunnerWsPath(req.url)) {
      handleRunnerConnection(ws, req);
    } else {
      ws.close(4400, 'unknown path');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  getDb().exec('DELETE FROM runners');
});

interface CapturedFrames {
  registered: { runnerId: string; serverVersion: string; connectedAt: string } | null;
  authError: { code: string; message: string } | null;
  pings: Array<{ id: string }>;
  closed: { code: number; reason: string } | null;
}

function connect(): { ws: WebSocket; frames: CapturedFrames; settled: Promise<void> } {
  const ws = new WebSocket(baseUrl + '/ws/runner');
  const frames: CapturedFrames = {
    registered: null,
    authError: null,
    pings: [],
    closed: null,
  };
  let resolveSettled!: () => void;
  const settled = new Promise<void>((r) => (resolveSettled = r));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf8')) as { type?: string };
      if (msg.type === 'registered') frames.registered = msg as never;
      else if (msg.type === 'auth_error') frames.authError = msg as never;
      else if (msg.type === 'ping') frames.pings.push(msg as never);
    } catch {
      /* ignore malformed */
    }
  });
  ws.on('close', (code, reason) => {
    frames.closed = { code, reason: reason.toString('utf8') };
    resolveSettled();
  });
  ws.on('error', () => {
    /* close handler will fire too */
  });
  return { ws, frames, settled };
}

function send(ws: WebSocket, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), (err) => (err ? reject(err) : resolve()));
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('isRunnerWsPath', () => {
  it('matches /ws/runner with and without query / trailing slash', () => {
    expect(isRunnerWsPath('/ws/runner')).toBe(true);
    expect(isRunnerWsPath('/ws/runner/')).toBe(true);
    expect(isRunnerWsPath('/ws/runner?x=1')).toBe(true);
  });

  it('rejects unrelated paths', () => {
    expect(isRunnerWsPath('/')).toBe(false);
    expect(isRunnerWsPath('/api/runners')).toBe(false);
    expect(isRunnerWsPath(undefined)).toBe(false);
  });
});

describe('runner WS handshake', () => {
  it('registers a valid auth frame and sends a `registered` reply', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'r' });
    const { ws, frames } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await send(ws, {
      type: 'auth',
      runnerId: runner.id,
      token,
      version: RUNNER_PROTOCOL_VERSION,
      capabilities: { os: 'linux', engines: ['claude'] },
    });
    await waitFor(() => frames.registered !== null);
    expect(frames.registered?.runnerId).toBe(runner.id);
    expect(frames.registered?.serverVersion).toBe(RUNNER_PROTOCOL_VERSION);
    ws.close();
  });

  it('flips status to online and persists capabilities on successful auth', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'r' });
    const { ws, frames, settled } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await send(ws, {
      type: 'auth',
      runnerId: runner.id,
      token,
      version: RUNNER_PROTOCOL_VERSION,
      capabilities: { os: 'darwin', engines: ['claude'] },
    });
    await waitFor(() => frames.registered !== null);

    const row = getDb()
      .prepare('SELECT status, capabilities FROM runners WHERE id = ?')
      .get(runner.id) as { status: string; capabilities: string };
    expect(row.status).toBe('online');
    expect(JSON.parse(row.capabilities)).toEqual({ os: 'darwin', engines: ['claude'] });

    ws.close();
    await settled;
    const after = getDb().prepare('SELECT status FROM runners WHERE id = ?').get(runner.id) as
      | { status: string }
      | undefined;
    expect(after?.status).toBe('offline');
  });

  it('rejects unknown runner id with auth_error code=unknown_runner', async () => {
    const { ws, frames, settled } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await send(ws, {
      type: 'auth',
      runnerId: 'no-such-id',
      token: 'whatever',
      version: RUNNER_PROTOCOL_VERSION,
    });
    await settled;
    expect(frames.authError?.code).toBe('unknown_runner');
    expect(frames.closed?.code).toBe(4401);
  });

  it('rejects bad token with auth_error code=bad_token', async () => {
    const { runner } = createRunner({ orgId: 'default', name: 'r' });
    const { ws, frames, settled } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await send(ws, {
      type: 'auth',
      runnerId: runner.id,
      token: 'wrong-token',
      version: RUNNER_PROTOCOL_VERSION,
    });
    await settled;
    expect(frames.authError?.code).toBe('bad_token');
    expect(frames.closed?.code).toBe(4401);
  });

  it('rejects incompatible major version with auth_error code=incompatible_version', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'r' });
    const { ws, frames, settled } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await send(ws, {
      type: 'auth',
      runnerId: runner.id,
      token,
      version: '99.0.0',
    });
    await settled;
    expect(frames.authError?.code).toBe('incompatible_version');
  });

  it('rejects malformed first frame', async () => {
    const { ws, frames, settled } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send('{not json');
    await settled;
    expect(frames.authError?.code).toBe('malformed');
  });

  it('rejects re-auth with code=already_authed (not malformed)', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'r-reauth' });
    const { ws, frames, settled } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    const authFrame = {
      type: 'auth',
      runnerId: runner.id,
      token,
      version: RUNNER_PROTOCOL_VERSION,
    };
    await send(ws, authFrame);
    await waitFor(() => frames.registered !== null);
    // Send a second auth — should trigger already_authed.
    await send(ws, authFrame);
    await settled;
    expect(frames.authError?.code).toBe('already_authed');
    expect(frames.closed?.code).toBe(4401);
  });
});

describe('pong-staleness detection', () => {
  it('closes the socket after MAX_MISSED_PONGS consecutive missed pongs', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'stale-runner' });
    const { ws, frames, settled } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await send(ws, {
      type: 'auth',
      runnerId: runner.id,
      token,
      version: RUNNER_PROTOCOL_VERSION,
    });
    await waitFor(() => frames.registered !== null);

    // Simulate missed pongs by bumping the counter directly on the
    // active entry — the next ping tick will see it exceed MAX_MISSED_PONGS
    // and close the socket. This avoids waiting for real 30 s intervals.
    const entry = activeRunners.get(runner.id);
    expect(entry).toBeTruthy();
    entry!.missedPongs = MAX_MISSED_PONGS; // next tick increments to MAX+1

    // Wait for the socket to close — the ping interval is 30 s in
    // production, but we've pre-loaded the counter so the very next
    // tick will trip the guard. Give it up to 35 s (one full interval).
    await Promise.race([
      settled,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 35_000)),
    ]);
    expect(frames.closed?.code).toBe(4408);
  }, 40_000);

  it('resets missedPongs on pong receipt', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'pong-runner' });
    const { ws, frames } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await send(ws, {
      type: 'auth',
      runnerId: runner.id,
      token,
      version: RUNNER_PROTOCOL_VERSION,
    });
    await waitFor(() => frames.registered !== null);

    const entry = activeRunners.get(runner.id);
    expect(entry).toBeTruthy();
    // Simulate some missed pongs (must stay below MAX_MISSED_PONGS - 1
    // so the next ping tick doesn't trip the >= threshold before we pong).
    entry!.missedPongs = 1;

    // Wait for a ping, then send a pong response.
    await waitFor(() => frames.pings.length > 0, 35_000);
    const pingId = frames.pings[0].id;
    await send(ws, { type: 'pong', id: pingId, ts: new Date().toISOString() });

    // Give the pong handler a tick to process.
    await new Promise((r) => setTimeout(r, 50));
    expect(entry!.missedPongs).toBe(0);
    ws.close();
  }, 40_000);
});

describe('reconnect race', () => {
  it('old socket teardown does not clobber a replacement connection', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'race-runner' });
    const authFrame = {
      type: 'auth',
      runnerId: runner.id,
      token,
      version: RUNNER_PROTOCOL_VERSION,
      capabilities: { os: 'linux' },
    };

    // Open S1, authenticate.
    const s1 = connect();
    await new Promise<void>((resolve) => s1.ws.once('open', resolve));
    await send(s1.ws, authFrame);
    await waitFor(() => s1.frames.registered !== null);
    expect(activeRunners.has(runner.id)).toBe(true);
    // Capture the server-side ws reference for S1.
    const s1ServerWs = activeRunners.get(runner.id)!.ws;

    // Open S2 (simulates quick reconnect) and authenticate before S1 closes.
    const s2 = connect();
    await new Promise<void>((resolve) => s2.ws.once('open', resolve));
    await send(s2.ws, authFrame);
    await waitFor(() => s2.frames.registered !== null);
    // S2 now owns the activeRunners slot — different server-side ws.
    const s2ServerWs = activeRunners.get(runner.id)!.ws;
    expect(s2ServerWs).not.toBe(s1ServerWs);

    // Close S1 — its teardown must NOT clobber S2's entry.
    s1.ws.close();
    await s1.settled;

    // S2 should still be in the map and the DB status should remain online.
    expect(activeRunners.get(runner.id)?.ws).toBe(s2ServerWs);
    const row = getDb().prepare('SELECT status FROM runners WHERE id = ?').get(runner.id) as {
      status: string;
    };
    expect(row.status).toBe('online');

    s2.ws.close();
    await s2.settled;
    // After S2 closes, runner goes offline.
    expect(activeRunners.has(runner.id)).toBe(false);
    const after = getDb().prepare('SELECT status FROM runners WHERE id = ?').get(runner.id) as {
      status: string;
    };
    expect(after.status).toBe('offline');
  });
});

// ─── Phase 2 inbound dispatcher (subscribe / sender / fanout) ────────

describe('Phase 2 dispatcher — getRunnerSender / subscribeToRunner', () => {
  async function authOnce(): Promise<{
    runnerId: string;
    ws: WebSocket;
    frames: CapturedFrames;
    settled: Promise<void>;
  }> {
    const { runner, token } = createRunner({ orgId: 'default', name: 'phase2' });
    const c = connect();
    await new Promise<void>((resolve) => c.ws.once('open', resolve));
    await send(c.ws, {
      type: 'auth',
      runnerId: runner.id,
      token,
      version: RUNNER_PROTOCOL_VERSION,
    });
    await waitFor(() => c.frames.registered !== null);
    return { runnerId: runner.id, ...c };
  }

  it('returns null sender for unknown / disconnected runners', () => {
    expect(getRunnerSender('no-such-runner')).toBeNull();
  });

  it('routes result/stream/exit frames to subscribed listeners', async () => {
    const { runnerId, ws, settled } = await authOnce();
    const received: unknown[] = [];
    const unsubscribe = subscribeToRunner(runnerId, (msg) => received.push(msg));

    await send(ws, { type: 'result', id: 'spawn-1', ok: true, pid: 99 });
    await send(ws, { type: 'stream', id: 'spawn-1', channel: 'stdout', data: 'hi', seq: 0 });
    await send(ws, { type: 'exit', id: 'spawn-1', code: 0, signal: null });
    await waitFor(() => received.length === 3);

    expect(received).toEqual([
      { type: 'result', id: 'spawn-1', ok: true, pid: 99 },
      { type: 'stream', id: 'spawn-1', channel: 'stdout', data: 'hi', seq: 0 },
      { type: 'exit', id: 'spawn-1', code: 0, signal: null },
    ]);

    unsubscribe();
    ws.close();
    await settled;
  });

  it('fans out a single frame to multiple subscribers', async () => {
    const { runnerId, ws, settled } = await authOnce();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unA = subscribeToRunner(runnerId, (msg) => a.push(msg));
    const unB = subscribeToRunner(runnerId, (msg) => b.push(msg));

    await send(ws, { type: 'stream', id: 'x', channel: 'stdout', data: 'fan', seq: 0 });
    await waitFor(() => a.length === 1 && b.length === 1);
    expect(a).toEqual(b);

    unA();
    unB();
    ws.close();
    await settled;
  });

  it('unsubscribe stops further deliveries', async () => {
    const { runnerId, ws, settled } = await authOnce();
    const received: unknown[] = [];
    const unsubscribe = subscribeToRunner(runnerId, (msg) => received.push(msg));

    await send(ws, { type: 'stream', id: 'x', channel: 'stdout', data: '1', seq: 0 });
    await waitFor(() => received.length === 1);
    unsubscribe();
    await send(ws, { type: 'stream', id: 'x', channel: 'stdout', data: '2', seq: 1 });
    // Give the message a tick to arrive.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);

    ws.close();
    await settled;
  });

  it('subscriber that throws does not break the dispatch loop', async () => {
    const { runnerId, ws, settled } = await authOnce();
    const good: unknown[] = [];
    const unBad = subscribeToRunner(runnerId, () => {
      throw new Error('boom');
    });
    const unGood = subscribeToRunner(runnerId, (msg) => good.push(msg));

    await send(ws, { type: 'stream', id: 'x', channel: 'stdout', data: 'ok', seq: 0 });
    await waitFor(() => good.length === 1);
    expect(good).toHaveLength(1);

    unBad();
    unGood();
    ws.close();
    await settled;
  });

  it('closes the socket on unauthenticated result/stream/exit frames', async () => {
    const { ws, frames, settled } = connect();
    await new Promise<void>((resolve) => ws.once('open', resolve));
    await send(ws, { type: 'result', id: 'x', ok: true });
    await settled;
    // protocol-violation close code lives in 4xxx range; the exact code
    // is private to runners-ws.ts (CLOSE_PROTOCOL = 4400).
    expect(frames.closed?.code).toBe(4400);
  });

  it('getRunnerSender returns a working sender for a connected runner', async () => {
    const { runnerId, ws, settled } = await authOnce();

    // Capture frames the runner receives back from the server.
    const fromServer: unknown[] = [];
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as { type?: string };
        if (msg.type === 'spawn') fromServer.push(msg);
      } catch {
        /* ignore */
      }
    });

    const sender = getRunnerSender(runnerId);
    expect(sender).not.toBeNull();
    sender!({
      type: 'spawn',
      id: 'sp-1',
      engine: 'claude-code',
      args: [],
      sessionId: 'sess',
    });
    await waitFor(() => fromServer.length === 1);
    expect(fromServer[0]).toMatchObject({ type: 'spawn', id: 'sp-1' });

    ws.close();
    await settled;
  });
});
