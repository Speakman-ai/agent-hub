import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import createWebSocket from '../websocket.js';
import type { WebSocketDeps } from '../types.js';
import type { PtySessionExit } from './pty-session.js';
import {
  attachTerminalWebSocket,
  decodeTerminalData,
  encodeTerminalData,
  parseTerminalWebSocketSessionId,
  type TerminalPtyHost,
  type TerminalServerFrame,
  type TerminalWebSocketHandle,
} from './terminal-websocket.js';

class FakeTerminalSession {
  readonly resizes: Array<[string, number, number]> = [];
  readonly writes: string[] = [];
  acceptWrites = true;
  exitResult: PtySessionExit | null = null;
  readonly #exit = new Set<(exit: PtySessionExit) => void>();

  resize(viewerId: string, cols: number, rows: number): void {
    this.resizes.push([viewerId, cols, rows]);
  }

  write(data: string): boolean {
    this.writes.push(data);
    return this.acceptWrites;
  }

  onExit(cb: (exit: PtySessionExit) => void): () => void {
    if (this.exitResult) {
      cb(this.exitResult);
      return () => {};
    }
    this.#exit.add(cb);
    return () => this.#exit.delete(cb);
  }

  exit(exit: PtySessionExit): void {
    this.exitResult = exit;
    for (const cb of [...this.#exit]) cb(exit);
  }
}

class FakePtyHost implements TerminalPtyHost {
  readonly session = new FakeTerminalSession();
  readonly attachCalls: Array<{ sessionId: string; viewerId: string; cols: number; rows: number }> =
    [];
  detachCount = 0;
  snapshot = 'prior\u0000screen\r\n';
  outputDuringAttach: string[] = [];
  viewerData: ((data: string) => void) | null = null;

  async attach(
    sessionId: string,
    viewer: {
      id: string;
      cols: number;
      rows: number;
      onData: (data: string) => void;
    },
  ) {
    this.attachCalls.push({
      sessionId,
      viewerId: viewer.id,
      cols: viewer.cols,
      rows: viewer.rows,
    });
    this.viewerData = viewer.onData;
    for (const data of this.outputDuringAttach) viewer.onData(data);
    return {
      snapshot: this.snapshot,
      detach: () => {
        this.detachCount += 1;
        this.viewerData = null;
      },
    };
  }

  get(sessionId: string) {
    return sessionId === 'owned' ? this.session : undefined;
  }

  emit(data: string): void {
    this.viewerData?.(data);
  }
}

interface Harness {
  server: Server;
  terminal: TerminalWebSocketHandle;
  host: FakePtyHost;
  url: string;
}

const harnesses: Harness[] = [];

async function makeHarness(
  overrides: Partial<Parameters<typeof attachTerminalWebSocket>[1]> = {},
): Promise<Harness> {
  const server = createServer();
  const host = new FakePtyHost();
  const terminal = attachTerminalWebSocket(server, {
    ptyHost: host,
    sessionExists: (sessionId) => sessionId === 'owned',
    authenticate: () => ({ ok: true, userId: 'user-1', role: 'User' }),
    userOwnsSession: (_req, sessionId) => sessionId === 'owned',
    attachTimeoutMs: 1_000,
    logger: { warn: () => {} },
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const harness = {
    server,
    terminal,
    host,
    url: `ws://127.0.0.1:${port}/api/sessions/owned/terminal/ws`,
  };
  harnesses.push(harness);
  return harness;
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

function collectFrames(ws: WebSocket): TerminalServerFrame[] {
  const frames: TerminalServerFrame[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as TerminalServerFrame));
  return frames;
}

async function waitForFrames(frames: TerminalServerFrame[], count: number): Promise<void> {
  await vi.waitFor(() => expect(frames).toHaveLength(count));
}

async function rejectedStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('unexpected-response', (_req, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    ws.once('open', () => reject(new Error('WebSocket unexpectedly opened')));
    ws.once('error', () => {
      // `unexpected-response` is the assertion-bearing event. The client can
      // also emit an error while the rejected HTTP response is being closed.
    });
  });
}

afterEach(async () => {
  for (const { server, terminal } of harnesses.splice(0)) {
    terminal.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('terminal WebSocket route', () => {
  it('parses only the dedicated session terminal path', () => {
    expect(parseTerminalWebSocketSessionId('/api/sessions/a%20b/terminal/ws?token=x')).toBe('a b');
    expect(parseTerminalWebSocketSessionId('/api/sessions/a/terminal/ws/')).toBe('a');
    expect(parseTerminalWebSocketSessionId('/api/sessions/a/messages')).toBeNull();
    expect(parseTerminalWebSocketSessionId('/api/sessions/%ZZ/terminal/ws')).toBeNull();
  });

  it('rejects unauthenticated upgrades before creating or attaching a PTY', async () => {
    const { url, host } = await makeHarness({ authenticate: () => ({ ok: false }) });
    await expect(rejectedStatus(url)).resolves.toBe(401);
    expect(host.attachCalls).toEqual([]);
  });

  it('masks a foreign session as 404 and never attaches it', async () => {
    const { url, host } = await makeHarness({ userOwnsSession: () => false });
    await expect(rejectedStatus(url)).resolves.toBe(404);
    expect(host.attachCalls).toEqual([]);
  });

  it('masks an unknown session before ownership can create an orphan shell', async () => {
    const owns = vi.fn(() => true);
    const { server, host } = await makeHarness({
      sessionExists: () => false,
      userOwnsSession: owns,
    });
    const port = (server.address() as AddressInfo).port;
    await expect(
      rejectedStatus(`ws://127.0.0.1:${port}/api/sessions/missing/terminal/ws`),
    ).resolves.toBe(404);
    expect(owns).not.toHaveBeenCalled();
    expect(host.attachCalls).toEqual([]);
  });

  it('attaches, replays snapshot before attach-time output, handles input/resize, and detaches', async () => {
    const { url, host } = await makeHarness();
    host.outputDuringAttach = ['live\u001b[31m\r\n'];
    const ws = await connect(url);
    const frames = collectFrames(ws);

    ws.send(JSON.stringify({ type: 'attach', cols: 120, rows: 40 }));
    await waitForFrames(frames, 2);

    expect(host.attachCalls).toHaveLength(1);
    expect(host.attachCalls[0]).toMatchObject({ sessionId: 'owned', cols: 120, rows: 40 });
    expect(frames).toEqual([
      { type: 'attached', encoding: 'base64', data: encodeTerminalData(host.snapshot) },
      {
        type: 'output',
        encoding: 'base64',
        data: encodeTerminalData('live\u001b[31m\r\n'),
      },
    ]);

    const input = 'printf "héllo"\u0000\n';
    ws.send(JSON.stringify({ type: 'input', encoding: 'base64', data: encodeTerminalData(input) }));
    ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 25 }));
    await vi.waitFor(() => expect(host.session.writes).toEqual([input]));
    expect(host.session.resizes[0]?.slice(1)).toEqual([90, 25]);

    host.emit('after\u0000attach');
    await waitForFrames(frames, 3);
    expect(frames[2]).toEqual({
      type: 'output',
      encoding: 'base64',
      data: encodeTerminalData('after\u0000attach'),
    });

    ws.send(JSON.stringify({ type: 'detach' }));
    await waitForFrames(frames, 4);
    expect(frames[3]).toEqual({ type: 'detached' });
    expect(host.detachCount).toBe(1);
    ws.close();
    await once(ws, 'close');
    // Close after explicit detach is idempotent.
    expect(host.detachCount).toBe(1);
  });

  it('detaches automatically when the socket closes', async () => {
    const { url, host } = await makeHarness();
    const ws = await connect(url);
    const frames = collectFrames(ws);
    ws.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));
    await waitForFrames(frames, 1);
    ws.close();
    await once(ws, 'close');
    await vi.waitFor(() => expect(host.detachCount).toBe(1));
  });

  it('reports shell exit and detaches the viewer', async () => {
    const { url, host } = await makeHarness();
    const ws = await connect(url);
    const frames = collectFrames(ws);
    ws.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));
    await waitForFrames(frames, 1);
    host.session.exit({ exitCode: 7, signal: 15 });
    await waitForFrames(frames, 2);
    expect(frames[1]).toEqual({ type: 'exit', exitCode: 7, signal: 15 });
    expect(host.detachCount).toBe(1);
    ws.close();
  });

  it('does not send a stale attached snapshot when the shell exited during attach', async () => {
    const { url, host } = await makeHarness();
    host.session.exitResult = { exitCode: 9 };
    const ws = await connect(url);
    const frames = collectFrames(ws);
    ws.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));
    await waitForFrames(frames, 1);
    expect(frames).toEqual([{ type: 'exit', exitCode: 9 }]);
    expect(host.detachCount).toBe(1);
    ws.close();
  });

  it('closes and detaches a slow client before outbound buffering grows unbounded', async () => {
    const { url, host } = await makeHarness({ maxBufferedBytes: 16 });
    const ws = await connect(url);
    ws.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));
    const [code] = (await once(ws, 'close')) as [number, Buffer];
    expect(code).toBe(1013);
    expect(host.detachCount).toBe(1);
  });

  it('keeps the chat WebSocket from claiming the dedicated terminal upgrade', async () => {
    const server = createServer();
    const chat = createWebSocket(server, {
      getProjects: () => [],
      handleChat: vi.fn(),
      handleCancel: vi.fn(),
      handleDequeue: vi.fn(),
      handleEditQueueItem: vi.fn(),
      handleDesignChat: vi.fn(),
      handleDesignCancel: vi.fn(),
    } as unknown as WebSocketDeps);
    const host = new FakePtyHost();
    const terminal = attachTerminalWebSocket(server, {
      ptyHost: host,
      sessionExists: () => true,
      authenticate: () => ({ ok: true, userId: 'user-1' }),
      userOwnsSession: () => true,
      logger: { warn: () => {} },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const record = { server, terminal, host, url: '' };
    harnesses.push(record);

    const ws = await connect(`ws://127.0.0.1:${port}/api/sessions/owned/terminal/ws`);
    const frames = collectFrames(ws);
    ws.send(JSON.stringify({ type: 'attach', cols: 80, rows: 24 }));
    await waitForFrames(frames, 1);
    expect(frames[0]?.type).toBe('attached');
    expect(chat.wss.clients.size).toBe(0);
    chat.wss.close();
    ws.close();
  });
});

describe('terminal data encoding', () => {
  it('round-trips control bytes and multibyte Unicode through base64', () => {
    const input = '\u0000\u001b[31m héllo 👋\r\n';
    expect(decodeTerminalData(encodeTerminalData(input), 1024)).toBe(input);
  });

  it('rejects malformed base64, invalid UTF-8, and oversized input', () => {
    expect(() => decodeTerminalData('not base64', 1024)).toThrow(/canonical base64/);
    expect(() => decodeTerminalData('/w==', 1024)).toThrow(/valid UTF-8/);
    expect(() => decodeTerminalData(encodeTerminalData('abcd'), 3)).toThrow(/exceeds 3/);
  });
});
