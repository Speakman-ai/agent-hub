import { describe, it, expect, vi } from 'vitest';
import {
  awaitStarted,
  deferStream,
  openVmAgentStream,
  type VmAgentStream,
  type VsockDuplex,
} from './vm-agent-client.js';
import {
  VmAgentFrameDecoder,
  encodeFrame,
  encodeJsonFrame,
  decodeJsonPayload,
  type VmAgentFrame,
  type VmAgentRequest,
} from './vm-agent-protocol.js';

class FakeVsock implements VsockDuplex {
  readonly written: Buffer[] = [];
  destroyed = false;
  ended = false;
  #handlers: {
    data: ((chunk: Buffer) => void)[];
    close: (() => void)[];
    error: ((err: Error) => void)[];
  } = { data: [], close: [], error: [] };

  write(data: Buffer): void {
    this.written.push(data);
  }
  end(): void {
    this.ended = true;
    this.emitClose();
  }
  destroy(): void {
    this.destroyed = true;
  }
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'data' | 'close' | 'error', cb: never): void {
    (this.#handlers[event] as unknown[]).push(cb);
  }

  emitData(chunk: Buffer): void {
    for (const cb of this.#handlers.data) cb(chunk);
  }
  emitClose(): void {
    for (const cb of this.#handlers.close) cb();
  }
  emitError(err: Error): void {
    for (const cb of this.#handlers.error) cb(err);
  }

  /** Frames the host sent, excluding the CONNECT handshake line. */
  sentFrames(): VmAgentFrame[] {
    const decoder = new VmAgentFrameDecoder();
    return this.written.slice(1).flatMap((chunk) => decoder.push(chunk));
  }
}

const REQUEST: VmAgentRequest = {
  kind: 'exec',
  command: 'echo hi',
  cwd: '/workspace',
  env: {},
};

/**
 * Let the opener's `await connect(...)` resume. Until it does, no listener is
 * attached, so a test that emits immediately would drop the handshake and
 * then wait out the real timeout.
 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function openWith(socket: FakeVsock, overrides: Record<string, unknown> = {}) {
  // Wrapped in an object because `await` on an async function that returns a
  // promise unwraps it — which would park here until the stream settles,
  // exactly the thing this helper exists to avoid.
  const opening = openVmAgentStream({
    udsPath: '/run/vsock.sock',
    port: 1024,
    request: REQUEST,
    connect: async () => socket,
    ...overrides,
  });
  // Swallow nothing — callers still await/assert on `opening`; this only
  // parks until the socket is wired up.
  opening.catch(() => undefined);
  await flush();
  return { opening };
}

describe('openVmAgentStream', () => {
  it('sends CONNECT then the opening request once the VMM accepts', async () => {
    const socket = new FakeVsock();
    const { opening } = await openWith(socket);
    // The handshake line must precede any protocol bytes; the VMM discards
    // anything sent before it replies.
    expect(socket.written[0].toString()).toBe('CONNECT 1024\n');
    socket.emitData(Buffer.from('OK 1024\n'));
    await opening;

    const frames = socket.sentFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('request');
    expect(decodeJsonPayload<VmAgentRequest>(frames[0].payload)).toEqual(REQUEST);
  });

  it('completes a handshake that arrives split across reads', async () => {
    const socket = new FakeVsock();
    const { opening } = await openWith(socket);
    socket.emitData(Buffer.from('OK 1'));
    socket.emitData(Buffer.from('024\n'));
    await expect(opening).resolves.toBeDefined();
  });

  it('delivers frames that share the handshake chunk', async () => {
    // The VMM relays guest bytes as soon as the guest writes them, so the
    // first application frame routinely lands in the same read as `OK`.
    const socket = new FakeVsock();
    const { opening } = await openWith(socket);
    socket.emitData(
      Buffer.concat([Buffer.from('OK 1024\n'), encodeFrame('stdout', Buffer.from('hi'))]),
    );
    const stream = await opening;
    const seen: VmAgentFrame[] = [];
    stream.onFrame((f) => seen.push(f));
    socket.emitData(encodeFrame('stdout', Buffer.from('there')));
    expect(seen.map((f) => f.payload.toString())).toEqual(['there']);
  });

  it('rejects when the VMM refuses the guest port', async () => {
    const socket = new FakeVsock();
    const { opening } = await openWith(socket);
    socket.emitData(Buffer.from('FAILED\n'));
    await expect(opening).rejects.toThrow(/refused by the VMM: FAILED/);
    expect(socket.destroyed).toBe(true);
  });

  it('rejects when the socket closes before the handshake', async () => {
    const socket = new FakeVsock();
    const { opening } = await openWith(socket);
    socket.emitClose();
    await expect(opening).rejects.toThrow(/closed before the handshake/);
  });

  it('rejects when the guest agent never answers', async () => {
    // A VM that boots but whose agent failed to start is the likeliest
    // failure mode; it has to surface here rather than as a silent stream.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const socket = new FakeVsock();
      const { opening } = await openWith(socket, { handshakeTimeoutMs: 500 });
      const assertion = expect(opening).rejects.toThrow(/timed out after 500ms/);
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
      expect(socket.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a desynchronized stream as a close with the decode error', async () => {
    const socket = new FakeVsock();
    const { opening } = await openWith(socket);
    socket.emitData(Buffer.from('OK 1024\n'));
    const stream = await opening;
    let closeErr: Error | undefined;
    stream.onClose((err) => (closeErr = err));

    const bogus = Buffer.alloc(5);
    bogus.writeUInt8(0x7f, 0);
    bogus.writeUInt32BE(0, 1);
    socket.emitData(bogus);

    expect(closeErr?.message).toMatch(/unknown type byte/);
    expect(stream.closed).toBe(true);
  });

  it('reports close to a late subscriber instead of dropping it', async () => {
    const socket = new FakeVsock();
    const { opening } = await openWith(socket);
    socket.emitData(Buffer.from('OK 1024\n'));
    const stream = await opening;
    socket.emitClose();

    const cb = vi.fn();
    stream.onClose(cb);
    expect(cb).toHaveBeenCalled();
  });

  it('drops sends after close rather than throwing on a dead socket', async () => {
    const socket = new FakeVsock();
    const { opening } = await openWith(socket);
    socket.emitData(Buffer.from('OK 1024\n'));
    const stream = await opening;
    const before = socket.written.length;
    socket.emitClose();
    stream.send(encodeJsonFrame('control', { kind: 'signal', signal: 'SIGTERM' }));
    expect(socket.written.length).toBe(before);
  });
});

/** Minimal in-memory stream for the defer/await helpers. */
function fakeStream() {
  const sent: Buffer[] = [];
  const frameSubs = new Set<(f: VmAgentFrame) => void>();
  const closeSubs = new Set<(err?: Error) => void>();
  let closed = false;
  const stream: VmAgentStream = {
    send: (f) => sent.push(f),
    onFrame: (cb) => {
      frameSubs.add(cb);
      return () => frameSubs.delete(cb);
    },
    onClose: (cb) => {
      closeSubs.add(cb);
      return () => closeSubs.delete(cb);
    },
    close: () => {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
  return {
    stream,
    sent,
    emit: (f: VmAgentFrame) => frameSubs.forEach((cb) => cb(f)),
    emitClose: (err?: Error) => closeSubs.forEach((cb) => cb(err)),
    wasClosed: () => closed,
  };
}

const jsonFrame = (type: VmAgentFrame['type'], value: unknown): VmAgentFrame => ({
  type,
  payload: Buffer.from(JSON.stringify(value)),
});

describe('deferStream', () => {
  it('buffers sends made before the connection exists and replays them in order', async () => {
    // `SessionEnv.spawn` is synchronous, so callers can write to the handle
    // before the vsock connection completes. Dropping those bytes would lose
    // the first input of every command.
    const inner = fakeStream();
    let release!: (s: VmAgentStream) => void;
    const deferred = deferStream(new Promise<VmAgentStream>((r) => (release = r)));

    deferred.send(Buffer.from('one'));
    deferred.send(Buffer.from('two'));
    expect(inner.sent).toHaveLength(0);

    release(inner.stream);
    await flush();
    expect(inner.sent.map((b) => b.toString())).toEqual(['one', 'two']);

    deferred.send(Buffer.from('three'));
    expect(inner.sent.map((b) => b.toString())).toEqual(['one', 'two', 'three']);
  });

  it('forwards frames and close from the resolved stream', async () => {
    const inner = fakeStream();
    const deferred = deferStream(Promise.resolve(inner.stream));
    await flush();

    const frames: VmAgentFrame[] = [];
    deferred.onFrame((f) => frames.push(f));
    const onClose = vi.fn();
    deferred.onClose(onClose);

    inner.emit(jsonFrame('started', { pid: 5 }));
    inner.emitClose();

    expect(frames).toHaveLength(1);
    expect(onClose).toHaveBeenCalled();
    expect(deferred.closed).toBe(true);
  });

  it('turns a failed open into an error frame instead of an unhandled rejection', async () => {
    // Without this the process handle would never settle: nothing would ever
    // arrive on a connection that does not exist.
    const deferred = deferStream(Promise.reject(new Error('no such vsock')));
    const frames: VmAgentFrame[] = [];
    deferred.onFrame((f) => frames.push(f));
    const onClose = vi.fn();
    deferred.onClose(onClose);
    await flush();

    expect(frames[0].type).toBe('error');
    expect(JSON.parse(frames[0].payload.toString()).message).toBe('no such vsock');
    expect(onClose).toHaveBeenCalled();
  });

  it('applies a close requested before the connection resolved', async () => {
    const inner = fakeStream();
    let release!: (s: VmAgentStream) => void;
    const deferred = deferStream(new Promise<VmAgentStream>((r) => (release = r)));
    deferred.close();
    release(inner.stream);
    await flush();
    expect(inner.wasClosed()).toBe(true);
  });
});

describe('awaitStarted', () => {
  it('resolves the guest pid', async () => {
    const inner = fakeStream();
    const pending = awaitStarted(inner.stream);
    inner.emit(jsonFrame('started', { pid: 77 }));
    await expect(pending).resolves.toBe(77);
  });

  it('rejects on an agent error frame', async () => {
    const inner = fakeStream();
    const pending = awaitStarted(inner.stream);
    inner.emit(jsonFrame('error', { message: 'bash: not found' }));
    await expect(pending).rejects.toThrow('bash: not found');
  });

  it('rejects when the stream closes first', async () => {
    const inner = fakeStream();
    const pending = awaitStarted(inner.stream);
    inner.emitClose();
    await expect(pending).rejects.toThrow(/closed before the process started/);
  });
});
