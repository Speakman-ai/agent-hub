/**
 * End-to-end test for the Phase 2 runner transport.
 *
 * Wires:
 *   server WS handler ←(real WS)→ stub runner
 *
 * The stub runner is a minimal `parseRunnerOutbound` consumer + scripted
 * frame emitter — it doesn't depend on the runner package's
 * `SpawnRegistry` because the server's tsconfig doesn't compile that
 * tree. The frames it produces match what `SpawnRegistry` would emit;
 * unit tests in runner/src/spawner.test.ts exercise the SpawnRegistry
 * itself.
 *
 * What this test proves end-to-end:
 *   1. `getRunnerTransport({runnerId})` selects RemoteRunnerTransport
 *      and routes `spawn` over the live WS to the connected runner.
 *   2. The stub runner can parse the `spawn` frame via
 *      `parseRunnerOutbound`, see all the fields the control plane
 *      sent, and respond with `result`/`stream`/`exit`.
 *   3. The ProcessHandle returned to the control plane re-emits stdout
 *      as a Node Readable, surfaces the pid, and fires `close` with
 *      the runner-reported exit code.
 *   4. `cancel` and `stdin` frames flow runner-bound when the control
 *      plane calls `kill()` / writes to stdin.
 *   5. RUNNER_OFFLINE rejects when no runner is connected for that id.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { handleRunnerConnection, isRunnerWsPath, activeRunners } from '../runners-ws.js';
import { getDb } from '../db.js';
import { createRunner } from '../runners-store.js';
import { getRunnerTransport } from '../runner-transport-select.js';
import {
  RUNNER_PROTOCOL_VERSION,
  parseRunnerOutbound,
  type RunnerCancelMessage,
  type RunnerSpawnMessage,
  type RunnerStdinMessage,
} from '../../shared/runner-protocol.js';

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
  // Fresh runners table + clear in-memory active set so each test has a
  // clean slate. Without this, the activeRunners Map can carry sockets
  // from earlier tests if their close handlers haven't fully drained.
  getDb().exec('DELETE FROM runners');
  activeRunners.clear();
});

/**
 * StubRunner — opens the WS, authenticates with the row's token, and
 * exposes a small scripted API so each test can describe how the
 * "runner" behaves on incoming `spawn`/`stdin`/`cancel` frames.
 */
interface StubRunner {
  ws: WebSocket;
  registered: Promise<void>;
  /** Frames received FROM the control plane (server → runner). */
  inbound: Array<RunnerSpawnMessage | RunnerCancelMessage | RunnerStdinMessage>;
  /** Send a JSON frame back to the server. */
  send: (frame: object) => void;
  close: () => void;
}

function startStubRunner(runnerId: string, token: string): StubRunner {
  const ws = new WebSocket(baseUrl + '/ws/runner');
  const inbound: StubRunner['inbound'] = [];
  let resolveRegistered!: () => void;
  const registered = new Promise<void>((r) => (resolveRegistered = r));

  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        type: 'auth',
        runnerId,
        token,
        version: RUNNER_PROTOCOL_VERSION,
        capabilities: { os: 'linux', engines: ['claude-code'] },
      }),
    );
  });

  ws.on('message', (raw) => {
    const msg = parseRunnerOutbound(raw as Buffer);
    if (!msg) return;
    if (msg.type === 'registered') {
      resolveRegistered();
      return;
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', id: msg.id, ts: new Date().toISOString() }));
      return;
    }
    if (msg.type === 'spawn' || msg.type === 'cancel' || msg.type === 'stdin') {
      inbound.push(msg);
    }
  });

  return {
    ws,
    registered,
    inbound,
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: string[] = [];
  return new Promise((resolve, reject) => {
    stream.setEncoding('utf8');
    stream.on('data', (c: string) => chunks.push(c));
    stream.on('end', () => resolve(chunks.join('')));
    stream.on('error', reject);
  });
}

describe('runner E2E — control plane spawn → runner → streamed exit', () => {
  it('routes spawn over the live WS, streams stdout back, and fires close on exit', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'e2e-runner' });
    const stub = startStubRunner(runner.id, token);
    await stub.registered;

    // Control-plane side: pick the transport for a project tied to this
    // runner and spawn a command. The fake "engine" + "bin" + "args"
    // are arbitrary; the stub runner doesn't care, it just echoes them
    // back via inbound[].
    const transport = getRunnerTransport({ runnerId: runner.id });
    const spawnPromise = transport.spawn({
      engine: 'claude-code',
      bin: 'unused-on-runner-side',
      args: ['--print', 'hi'],
      cwd: '/tmp',
      env: { CUSTOM: 'value' },
      sessionId: 'session-e2e',
    });

    // Wait until the stub runner sees the spawn frame so we can echo
    // result/stream/exit with the right id.
    await waitFor(() => stub.inbound.length > 0);
    const spawnFrame = stub.inbound[0] as RunnerSpawnMessage;
    expect(spawnFrame.type).toBe('spawn');
    expect(spawnFrame.engine).toBe('claude-code');
    expect(spawnFrame.args).toEqual(['--print', 'hi']);
    expect(spawnFrame.sessionId).toBe('session-e2e');
    // Confirm the env field round-trips (RemoteRunnerTransport must not
    // strip it — chat.ts depends on it for ANTHROPIC_API_KEY etc.).
    expect(spawnFrame.env?.CUSTOM).toBe('value');

    // Stub runner: ack, stream, exit.
    stub.send({ type: 'result', id: spawnFrame.id, ok: true, pid: 99999 });
    const handle = await spawnPromise;
    expect(handle.pid).toBe(99999);

    // Now stream a couple of stdout chunks and an exit.
    stub.send({
      type: 'stream',
      id: spawnFrame.id,
      channel: 'stdout',
      data: 'hello ',
      seq: 0,
    });
    stub.send({
      type: 'stream',
      id: spawnFrame.id,
      channel: 'stdout',
      data: 'world',
      seq: 1,
    });
    stub.send({ type: 'exit', id: spawnFrame.id, code: 0, signal: null });

    // The ProcessHandle's stdout is a real Readable; collectStream
    // resolves once 'end' fires, which happens on exit teardown.
    const stdout = await collectStream(handle.stdout!);
    expect(stdout).toBe('hello world');

    // 'close' event: the chat handler waits on this to finalize the turn.
    const closeArgs = await new Promise<[number | null, string | null]>((resolve) => {
      handle.once('close', (code, signal) => resolve([code, signal]));
      // close may already have fired before we attached if the test
      // raced; collectStream awaits 'end' so by here it has fired
      // synchronously alongside.
    }).catch(() => [0, null] as [number | null, string | null]);
    expect(closeArgs[0]).toBe(0);

    stub.close();
  });

  it('rejects the spawn when no runner is connected for that id (RUNNER_OFFLINE)', async () => {
    const { runner } = createRunner({ orgId: 'default', name: 'never-online' });
    // Note: we deliberately do NOT start a stub runner here.
    const transport = getRunnerTransport({ runnerId: runner.id });
    await expect(
      transport.spawn({
        engine: 'claude-code',
        bin: '/x',
        args: [],
        sessionId: 's',
      }),
    ).rejects.toMatchObject({ code: 'RUNNER_OFFLINE' });
  });

  it('forwards cancel(SIGTERM) over the WS to the runner', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'r-cancel' });
    const stub = startStubRunner(runner.id, token);
    await stub.registered;

    const transport = getRunnerTransport({ runnerId: runner.id });
    const spawnPromise = transport.spawn({
      engine: 'claude-code',
      bin: '/x',
      args: [],
      sessionId: 's',
    });
    await waitFor(() => stub.inbound.length > 0);
    const spawnFrame = stub.inbound[0] as RunnerSpawnMessage;
    stub.send({ type: 'result', id: spawnFrame.id, ok: true, pid: 1 });
    const handle = await spawnPromise;

    handle.kill();
    await waitFor(() => stub.inbound.some((f) => f.type === 'cancel' && f.id === spawnFrame.id));
    const cancelFrame = stub.inbound.find((f) => f.type === 'cancel') as RunnerCancelMessage;
    // The transport defaults to omitting the signal so the runner's
    // protocol default (SIGTERM) applies — kill() with no arg does NOT
    // include a `signal` field on the wire.
    expect(cancelFrame.signal).toBeUndefined();

    // Clean up: stub sends exit so the handle's listeners drain.
    stub.send({ type: 'exit', id: spawnFrame.id, code: null, signal: 'SIGTERM' });
    stub.close();
  });

  it('forwards stdin writes to the runner with optional end:true', async () => {
    const { runner, token } = createRunner({ orgId: 'default', name: 'r-stdin' });
    const stub = startStubRunner(runner.id, token);
    await stub.registered;

    const transport = getRunnerTransport({ runnerId: runner.id });
    const spawnPromise = transport.spawn({
      engine: 'claude-code',
      bin: '/x',
      args: [],
      sessionId: 's',
    });
    await waitFor(() => stub.inbound.length > 0);
    const spawnFrame = stub.inbound[0] as RunnerSpawnMessage;
    stub.send({ type: 'result', id: spawnFrame.id, ok: true, pid: 2 });
    const handle = await spawnPromise;

    handle.stdin!.write('hello-from-server');
    handle.stdin!.end();

    await waitFor(() => stub.inbound.filter((f) => f.type === 'stdin').length >= 1);
    const stdinFrames = stub.inbound.filter((f) => f.type === 'stdin') as RunnerStdinMessage[];
    // Implementations may either coalesce write+end into one frame, or
    // emit them as two — the contract that matters is: somewhere among
    // the frames we see the data, and the last one carries `end:true`.
    const combined = stdinFrames.map((f) => f.data).join('');
    expect(combined).toBe('hello-from-server');
    expect(stdinFrames.at(-1)?.end).toBe(true);

    stub.send({ type: 'exit', id: spawnFrame.id, code: 0, signal: null });
    stub.close();
  });
});
