/**
 * Live-view frames from a desktop's VNC server (RFB, RFC 6143).
 *
 * The Firecracker desktop runs x11vnc on <guest-ip>:5900, reachable only from
 * the Hub host. Polling the framebuffer over VNC costs the guest nothing per
 * frame, where a scrot screenshot forks two processes and writes a file every
 * tick. Agent screenshots still go through the vm-agent, so what the agent
 * sees never depends on the viewer connection.
 *
 * The client is deliberately small: protocol 3.3 to 3.8, security type None
 * only (the guest is not reachable from anywhere but the Hub), 32-bit true
 * colour, Raw encoding only. It keeps one connection open, asks for an
 * incremental update after each one arrives (throttled), and keeps a local
 * copy of the framebuffer. `capture` encodes that copy as PNG, so it never
 * waits on the server once the first full frame is in. A source left unused
 * closes itself.
 */
import { Socket } from 'net';
import { deflateSync } from 'zlib';
import type { DesktopDisplayEndpoint } from './desktop-runtime.js';

export interface DesktopFrameSource {
  /** PNG of the current framebuffer; waits for the first full frame. */
  capture(timeoutMs?: number): Promise<Buffer>;
  close(): void;
  readonly closed: boolean;
}

/** The parts of a net.Socket the client uses; injected in tests. */
export interface VncSocket {
  write(data: Buffer): unknown;
  on(event: 'data', cb: (chunk: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
  destroy(): unknown;
}

export interface VncFrameSourceOpts {
  /**
   * Open the TCP connection. Must give up (and free the socket) when
   * `signal` aborts; the caller aborts it at the connect deadline.
   */
  connect?: (endpoint: DesktopDisplayEndpoint, signal: AbortSignal) => Promise<VncSocket>;
  /** Deadline for the TCP connect, and separately for the handshake and first frame. */
  timeoutMs?: number;
  /** Minimum gap between update requests, so a busy screen can't spin the Hub. */
  minUpdateIntervalMs?: number;
  /** Close the connection after this long without a capture. */
  idleCloseMs?: number;
}

export class VncProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VncProtocolError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 200;
const DEFAULT_IDLE_CLOSE_MS = 30_000;
const MAX_DIMENSION = 8192;
const MAX_TEXT_BYTES = 1024 * 1024;
const BYTES_PER_PIXEL = 4;

const SECURITY_NONE = 1;
const ENCODING_RAW = 0;

export const defaultVncConnect = (
  endpoint: DesktopDisplayEndpoint,
  signal: AbortSignal,
): Promise<VncSocket> =>
  new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.setNoDelay(true);
    const onAbort = () => {
      socket.destroy();
      reject(signal.reason instanceof Error ? signal.reason : new Error('VNC connect aborted'));
    };
    const onError = (err: Error) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    socket.connect(endpoint.port, endpoint.host, () => {
      signal.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      resolve(socket);
    });
  });

/**
 * Connect with a deadline. A guest that silently drops SYNs would otherwise
 * hold the caller until the kernel's TCP timeout (minutes), so the live view
 * could neither fall back to screenshots nor be stopped. A socket that still
 * arrives after the deadline is destroyed.
 */
async function connectWithDeadline(
  connect: NonNullable<VncFrameSourceOpts['connect']>,
  endpoint: DesktopDisplayEndpoint,
  timeoutMs: number,
): Promise<VncSocket> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new VncProtocolError(
        `VNC connect to ${endpoint.host}:${endpoint.port} timed out after ${timeoutMs}ms`,
      );
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  const attempt = connect(endpoint, controller.signal);
  try {
    return await Promise.race([attempt, deadline]);
  } catch (err) {
    attempt.then(
      (late) => late.destroy(),
      () => undefined,
    );
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Buffers socket bytes and hands out exact-length reads. */
class ByteReader {
  #chunks: Buffer[] = [];
  #length = 0;
  #waiter: (() => void) | null = null;
  #error: Error | null = null;

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    this.#wake();
  }

  fail(err: Error): void {
    this.#error ??= err;
    this.#wake();
  }

  #wake(): void {
    const w = this.#waiter;
    this.#waiter = null;
    w?.();
  }

  async read(n: number): Promise<Buffer> {
    while (this.#length < n) {
      if (this.#error) throw this.#error;
      await new Promise<void>((resolve) => (this.#waiter = resolve));
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.#chunks[0]!;
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      if (take === head.length) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(take);
    }
    this.#length -= n;
    return out;
  }
}

/** RFB SetPixelFormat body: 32bpp, depth 24, little-endian true colour, R<<16|G<<8|B. */
function setPixelFormatMessage(): Buffer {
  const msg = Buffer.alloc(20);
  msg.writeUInt8(0, 0);
  msg.writeUInt8(32, 4); // bits per pixel
  msg.writeUInt8(24, 5); // depth
  msg.writeUInt8(0, 6); // big-endian: no
  msg.writeUInt8(1, 7); // true colour
  msg.writeUInt16BE(255, 8);
  msg.writeUInt16BE(255, 10);
  msg.writeUInt16BE(255, 12);
  msg.writeUInt8(16, 14);
  msg.writeUInt8(8, 15);
  msg.writeUInt8(0, 16);
  return msg;
}

function setEncodingsMessage(): Buffer {
  const msg = Buffer.alloc(8);
  msg.writeUInt8(2, 0);
  msg.writeUInt16BE(1, 2);
  msg.writeInt32BE(ENCODING_RAW, 4);
  return msg;
}

function updateRequest(incremental: boolean, width: number, height: number): Buffer {
  const msg = Buffer.alloc(10);
  msg.writeUInt8(3, 0);
  msg.writeUInt8(incremental ? 1 : 0, 1);
  msg.writeUInt16BE(width, 6);
  msg.writeUInt16BE(height, 8);
  return msg;
}

/** Pick the protocol minor version to speak, from the server's 12-byte banner. */
export function negotiateRfbVersion(banner: Buffer): 3 | 7 | 8 {
  const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner.toString('latin1'));
  if (!m) throw new VncProtocolError('not a VNC server (bad protocol banner)');
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < 3) throw new VncProtocolError(`unsupported RFB version ${major}.${minor}`);
  if (major > 3 || minor >= 8) return 8;
  if (minor >= 7) return 7;
  return 3;
}

async function readReason(reader: ByteReader): Promise<string> {
  const len = (await reader.read(4)).readUInt32BE(0);
  if (len > MAX_TEXT_BYTES) throw new VncProtocolError('VNC failure reason too long');
  return (await reader.read(len)).toString('utf8');
}

class VncFrameSource implements DesktopFrameSource {
  #closed = false;
  #width = 0;
  #height = 0;
  /** BGRX, as the server sends it under our pixel format. */
  #fb: Buffer = Buffer.alloc(0);
  #version = 0;
  #pngVersion = -1;
  #png: Buffer | null = null;
  #firstFrame: Promise<void>;
  #resolveFirst!: () => void;
  #rejectFirst!: (err: Error) => void;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #updateTimer: ReturnType<typeof setTimeout> | null = null;
  #lastRequestAt = 0;
  readonly #reader = new ByteReader();

  constructor(
    private readonly socket: VncSocket,
    private readonly opts: Required<Omit<VncFrameSourceOpts, 'connect'>>,
  ) {
    this.#firstFrame = new Promise<void>((resolve, reject) => {
      this.#resolveFirst = resolve;
      this.#rejectFirst = reject;
    });
    // Nobody may be awaiting the first frame when the connection dies.
    this.#firstFrame.catch(() => undefined);
    socket.on('data', (chunk) => this.#reader.push(chunk));
    socket.on('error', (err) => this.#fail(err));
    socket.on('close', () => this.#fail(new VncProtocolError('VNC connection closed')));
    this.#armIdle();
  }

  get closed(): boolean {
    return this.#closed;
  }

  async run(): Promise<void> {
    try {
      await this.#handshake();
      this.socket.write(setPixelFormatMessage());
      this.socket.write(setEncodingsMessage());
      this.#request(false);
      await this.#readLoop();
    } catch (err) {
      this.#fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async #handshake(): Promise<void> {
    const r = this.#reader;
    const minor = negotiateRfbVersion(await r.read(12));
    this.socket.write(Buffer.from(`RFB 003.00${minor}\n`, 'latin1'));
    if (minor === 3) {
      const type = (await r.read(4)).readUInt32BE(0);
      if (type === 0) throw new VncProtocolError(`VNC server refused: ${await readReason(r)}`);
      if (type !== SECURITY_NONE) {
        throw new VncProtocolError(`VNC server requires authentication (security type ${type})`);
      }
    } else {
      const count = (await r.read(1)).readUInt8(0);
      if (count === 0) throw new VncProtocolError(`VNC server refused: ${await readReason(r)}`);
      const types = [...(await r.read(count))];
      if (!types.includes(SECURITY_NONE)) {
        throw new VncProtocolError(
          `VNC server requires authentication (offers security types ${types.join(', ')})`,
        );
      }
      this.socket.write(Buffer.from([SECURITY_NONE]));
      if (minor === 8) {
        const result = (await r.read(4)).readUInt32BE(0);
        if (result !== 0) {
          throw new VncProtocolError(`VNC security handshake failed: ${await readReason(r)}`);
        }
      }
    }
    // ClientInit: shared, so the viewer never kicks another client off.
    this.socket.write(Buffer.from([1]));
    const init = await r.read(24);
    const width = init.readUInt16BE(0);
    const height = init.readUInt16BE(2);
    if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new VncProtocolError(`VNC server reported an unusable screen ${width}x${height}`);
    }
    const nameLen = init.readUInt32BE(20);
    if (nameLen > MAX_TEXT_BYTES) throw new VncProtocolError('VNC desktop name too long');
    await r.read(nameLen);
    this.#width = width;
    this.#height = height;
    this.#fb = Buffer.alloc(width * height * BYTES_PER_PIXEL);
  }

  async #readLoop(): Promise<void> {
    const r = this.#reader;
    for (;;) {
      const type = (await r.read(1)).readUInt8(0);
      switch (type) {
        case 0:
          await this.#readUpdate();
          break;
        case 1: {
          // SetColourMapEntries: unexpected in true colour, skip it.
          const head = await r.read(5);
          await r.read(head.readUInt16BE(3) * 6);
          break;
        }
        case 2:
          break; // Bell
        case 3: {
          const head = await r.read(7);
          const len = head.readUInt32BE(3);
          if (len > MAX_TEXT_BYTES) throw new VncProtocolError('VNC clipboard text too long');
          await r.read(len);
          break;
        }
        default:
          throw new VncProtocolError(`unknown VNC server message type ${type}`);
      }
    }
  }

  async #readUpdate(): Promise<void> {
    const r = this.#reader;
    const count = (await r.read(3)).readUInt16BE(1);
    for (let i = 0; i < count; i++) {
      const head = await r.read(12);
      const x = head.readUInt16BE(0);
      const y = head.readUInt16BE(2);
      const w = head.readUInt16BE(4);
      const h = head.readUInt16BE(6);
      const encoding = head.readInt32BE(8);
      if (encoding !== ENCODING_RAW) {
        throw new VncProtocolError(`VNC server sent unrequested encoding ${encoding}`);
      }
      if (x + w > this.#width || y + h > this.#height) {
        throw new VncProtocolError(`VNC rectangle ${w}x${h}+${x}+${y} is outside the screen`);
      }
      const rowBytes = w * BYTES_PER_PIXEL;
      const pixels = await r.read(rowBytes * h);
      for (let row = 0; row < h; row++) {
        pixels.copy(
          this.#fb,
          ((y + row) * this.#width + x) * BYTES_PER_PIXEL,
          row * rowBytes,
          (row + 1) * rowBytes,
        );
      }
    }
    this.#version++;
    this.#resolveFirst();
    this.#scheduleRequest();
  }

  #scheduleRequest(): void {
    if (this.#closed || this.#updateTimer) return;
    const wait = Math.max(0, this.#lastRequestAt + this.opts.minUpdateIntervalMs - Date.now());
    this.#updateTimer = setTimeout(() => {
      this.#updateTimer = null;
      this.#request(true);
    }, wait);
    this.#updateTimer.unref?.();
  }

  #request(incremental: boolean): void {
    if (this.#closed) return;
    this.#lastRequestAt = Date.now();
    this.socket.write(updateRequest(incremental, this.#width, this.#height));
  }

  async capture(timeoutMs = this.opts.timeoutMs): Promise<Buffer> {
    if (this.#closed) throw new VncProtocolError('VNC connection closed');
    this.#armIdle();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.#firstFrame,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new VncProtocolError(`no VNC frame within ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.#png && this.#pngVersion === this.#version) return this.#png;
    this.#png = encodeBgrxPng(this.#fb, this.#width, this.#height);
    this.#pngVersion = this.#version;
    return this.#png;
  }

  #armIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close(), this.opts.idleCloseMs);
    this.#idleTimer.unref?.();
  }

  #fail(err: Error): void {
    this.#rejectFirst(err);
    this.#reader.fail(err);
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#updateTimer) clearTimeout(this.#updateTimer);
    this.#rejectFirst(new VncProtocolError('VNC connection closed'));
    this.#reader.fail(new VncProtocolError('VNC connection closed'));
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }
}

/**
 * Open a VNC connection and start mirroring the framebuffer. Resolves once
 * the socket is connected; the handshake runs in the background and its
 * failure surfaces from `capture`.
 */
export async function connectVncFrameSource(
  endpoint: DesktopDisplayEndpoint,
  opts: VncFrameSourceOpts = {},
): Promise<DesktopFrameSource> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = await connectWithDeadline(opts.connect ?? defaultVncConnect, endpoint, timeoutMs);
  const source = new VncFrameSource(socket, {
    timeoutMs,
    minUpdateIntervalMs: opts.minUpdateIntervalMs ?? DEFAULT_MIN_UPDATE_INTERVAL_MS,
    idleCloseMs: opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS,
  });
  void source.run();
  return source;
}

// PNG encoding (RGB, 8 bits per channel, no filtering)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode a BGRX framebuffer as an RGB PNG. */
export function encodeBgrxPng(fb: Buffer, width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride + 1; // filter byte 0 (None)
    let i = y * width * BYTES_PER_PIXEL;
    for (let x = 0; x < width; x++, i += BYTES_PER_PIXEL) {
      raw[o++] = fb[i + 2]!;
      raw[o++] = fb[i + 1]!;
      raw[o++] = fb[i]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 3 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
