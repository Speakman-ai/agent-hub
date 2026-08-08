/**
 * Host side of the vm-agent channel.
 *
 * Firecracker exposes guest vsock to the host as a Unix socket: the host
 * connects to `<uds_path>`, sends `CONNECT <guestPort>\n`, and the VMM replies
 * `OK <n>\n` before relaying bytes to the guest listener. Everything after
 * that line is our framed protocol.
 *
 * One connection carries one logical stream (an exec, a PTY, a one-shot
 * request), so a wedged PTY cannot stall an unrelated command's output. The
 * socket factory is injectable, which is what lets the adapter's tests drive
 * full exec/PTY lifecycles over an in-memory duplex with no VM present.
 */

import { connect as netConnect } from 'net';
import {
  VmAgentFrameDecoder,
  encodeJsonFrame,
  parseVsockHandshake,
  vsockConnectCommand,
  type VmAgentFrame,
  type VmAgentFrameType,
  type VmAgentRequest,
} from './vm-agent-protocol.js';

/** The subset of `net.Socket` this module needs, so tests can fake it. */
export interface VsockDuplex {
  write(data: Buffer): void;
  end(): void;
  destroy(): void;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export type VsockConnectFn = (udsPath: string) => Promise<VsockDuplex>;

export const defaultVsockConnect: VsockConnectFn = (udsPath) =>
  new Promise((resolve, reject) => {
    const socket = netConnect(udsPath);
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket as unknown as VsockDuplex);
    });
  });

export interface VmAgentStream {
  /** Send an already-encoded frame. */
  send(frame: Buffer): void;
  onFrame(cb: (frame: VmAgentFrame) => void): () => void;
  /** Fires once, on remote close or transport error. */
  onClose(cb: (err?: Error) => void): () => void;
  close(): void;
  readonly closed: boolean;
}

export interface OpenVmAgentStreamOpts {
  udsPath: string;
  /** Guest vsock port. Defaults to the agent's fixed port. */
  port: number;
  /** Opening request; sent immediately after a successful handshake. */
  request: VmAgentRequest;
  connect?: VsockConnectFn;
  /** Fail the open if the handshake has not completed in this window. */
  handshakeTimeoutMs?: number;
  clock?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Connect, complete the VMM handshake, send the opening request, and hand
 * back a frame-oriented stream.
 *
 * Rejects (rather than resolving a dead stream) when the guest is not
 * listening: a VM that booted but whose agent never came up is the single
 * most likely failure here, and it has to surface at open time instead of as
 * silence on a stream nobody will ever get frames from.
 */
export async function openVmAgentStream(opts: OpenVmAgentStreamOpts): Promise<VmAgentStream> {
  const connect = opts.connect ?? defaultVsockConnect;
  const timers = opts.clock ?? { setTimeout, clearTimeout };
  const socket = await connect(opts.udsPath);

  const frameSubs = new Set<(frame: VmAgentFrame) => void>();
  const closeSubs = new Set<(err?: Error) => void>();
  const decoder = new VmAgentFrameDecoder();

  let handshakeDone = false;
  let handshakeBuffer = Buffer.alloc(0);
  let closed = false;
  let closeError: Error | undefined;

  let settleHandshake!: (err?: Error) => void;
  const handshake = new Promise<void>((resolve, reject) => {
    settleHandshake = (err) => (err ? reject(err) : resolve());
  });

  const fireClose = (err?: Error) => {
    if (closed) return;
    closed = true;
    closeError = err;
    for (const cb of closeSubs) cb(err);
    closeSubs.clear();
    frameSubs.clear();
  };

  socket.on('data', (chunk) => {
    if (!handshakeDone) {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const result = parseVsockHandshake(handshakeBuffer);
      // No newline yet: the reply is still arriving, not a rejection.
      if (!result) return;
      handshakeDone = true;
      if (!result.ok) {
        const err = new Error(
          `vsock connect to guest port ${opts.port} was refused by the VMM: ${result.line}`,
        );
        settleHandshake(err);
        socket.destroy();
        fireClose(err);
        return;
      }
      settleHandshake();
      if (result.rest.length === 0) return;
      chunk = result.rest;
    }
    let frames: VmAgentFrame[];
    try {
      frames = decoder.push(chunk);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      socket.destroy();
      fireClose(error);
      return;
    }
    for (const frame of frames) {
      for (const cb of frameSubs) cb(frame);
    }
  });

  socket.on('error', (err) => {
    if (!handshakeDone) settleHandshake(err);
    fireClose(err);
  });

  socket.on('close', () => {
    if (!handshakeDone) {
      settleHandshake(
        new Error(`vsock connection to ${opts.udsPath} closed before the handshake completed`),
      );
    }
    fireClose(closeError);
  });

  const timeout = timers.setTimeout(() => {
    if (handshakeDone) return;
    const err = new Error(
      `vsock handshake with the guest agent timed out after ${
        opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
      }ms (is the in-VM agent running?)`,
    );
    settleHandshake(err);
    socket.destroy();
    fireClose(err);
  }, opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  // Never hold the event loop open on a handshake nobody is waiting for.
  (timeout as { unref?: () => void }).unref?.();

  socket.write(vsockConnectCommand(opts.port));

  try {
    await handshake;
  } finally {
    timers.clearTimeout(timeout);
  }

  socket.write(encodeJsonFrame('request', opts.request));

  return {
    send: (frame) => {
      if (closed) return;
      socket.write(frame);
    },
    onFrame: (cb) => {
      frameSubs.add(cb);
      return () => frameSubs.delete(cb);
    },
    onClose: (cb) => {
      if (closed) {
        cb(closeError);
        return () => {};
      }
      closeSubs.add(cb);
      return () => closeSubs.delete(cb);
    },
    close: () => {
      socket.end();
    },
    get closed() {
      return closed;
    },
  };
}

/** Send a JSON control/stdin frame on an open stream. */
export function sendJson(stream: VmAgentStream, type: VmAgentFrameType, value: unknown): void {
  stream.send(encodeJsonFrame(type, value));
}

/**
 * A stream usable before its connection exists.
 *
 * `SessionEnv.spawn` is synchronous — it hands back a process handle the
 * caller subscribes to immediately — but opening a vsock connection is not.
 * This buffers sends until the real stream arrives and replays subscriptions
 * onto it, so no output is lost in the window between `spawn()` returning and
 * the connection completing.
 *
 * A failed open is surfaced as an `error` frame rather than an unhandled
 * rejection, which is what lets the process handle settle with a real reason
 * instead of hanging forever on a connection that will never exist.
 */
export function deferStream(pending: Promise<VmAgentStream>): VmAgentStream {
  const outbox: Buffer[] = [];
  const frameSubs = new Set<(frame: VmAgentFrame) => void>();
  const closeSubs = new Set<(err?: Error) => void>();
  let resolved: VmAgentStream | null = null;
  let closed = false;
  let closeRequested = false;
  let closeError: Error | undefined;

  const fireClose = (err?: Error) => {
    if (closed) return;
    closed = true;
    closeError = err;
    for (const cb of closeSubs) cb(err);
    closeSubs.clear();
    frameSubs.clear();
  };

  pending.then(
    (stream) => {
      resolved = stream;
      stream.onFrame((frame) => {
        for (const cb of frameSubs) cb(frame);
      });
      stream.onClose((err) => fireClose(err));
      for (const buffered of outbox.splice(0)) stream.send(buffered);
      if (closeRequested) stream.close();
    },
    (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      const frame: VmAgentFrame = {
        type: 'error',
        payload: Buffer.from(JSON.stringify({ message: error.message }), 'utf8'),
      };
      for (const cb of frameSubs) cb(frame);
      fireClose(error);
    },
  );

  return {
    send: (frame) => {
      if (closed) return;
      if (resolved) resolved.send(frame);
      else outbox.push(frame);
    },
    onFrame: (cb) => {
      frameSubs.add(cb);
      return () => frameSubs.delete(cb);
    },
    onClose: (cb) => {
      if (closed) {
        cb(closeError);
        return () => {};
      }
      closeSubs.add(cb);
      return () => closeSubs.delete(cb);
    },
    close: () => {
      closeRequested = true;
      resolved?.close();
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * Resolve the guest pid from the agent's `started` frame. `openPty` needs it
 * before it can hand back a handle, since `SessionEnvPty.pid` is not nullable.
 */
export function awaitStarted(stream: VmAgentStream, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`guest agent did not report a started pid within ${timeoutMs}ms`));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    const offFrame = stream.onFrame((frame) => {
      if (frame.type === 'started') {
        const { pid } = JSON.parse(frame.payload.toString('utf8')) as { pid: number };
        cleanup();
        resolve(pid);
        return;
      }
      if (frame.type === 'error') {
        const { message } = JSON.parse(frame.payload.toString('utf8')) as { message: string };
        cleanup();
        reject(new Error(message));
      }
    });
    const offClose = stream.onClose((err) => {
      cleanup();
      reject(err ?? new Error('vm-agent stream closed before the process started'));
    });

    function cleanup(): void {
      clearTimeout(timer);
      offFrame();
      offClose();
    }
  });
}
