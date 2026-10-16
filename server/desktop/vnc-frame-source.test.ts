import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import { inflateSync } from 'zlib';
import {
  connectVncFrameSource,
  defaultVncConnect,
  type VncSocket,
  encodeBgrxPng,
  negotiateRfbVersion,
  VncProtocolError,
  type DesktopFrameSource,
} from './vnc-frame-source.js';

/** Decode an 8-bit RGB PNG made by encodeBgrxPng back to rows of [r,g,b]. */
function decodePng(png: Buffer): {
  width: number;
  height: number;
  px: (x: number, y: number) => number[];
} {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9]]).toEqual([8, 2]);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  return {
    width,
    height,
    px: (x, y) => [...raw.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)],
  };
}

interface FakeRfbOpts {
  version?: string;
  securityTypes?: number[];
  width?: number;
  height?: number;
}

/**
 * Minimal RFB server: speaks the handshake, records client messages, and
 * lets the test push framebuffer updates.
 */
class FakeRfbServer {
  server: Server;
  socket: Socket | null = null;
  received: Buffer = Buffer.alloc(0);
  closed = false;
  #onSocket: (() => void)[] = [];

  constructor(readonly opts: FakeRfbOpts = {}) {
    this.server = createServer((socket) => {
      this.socket = socket;
      socket.on('data', (c: Buffer) => this.#onData(c));
      socket.on('close', () => (this.closed = true));
      socket.write(this.opts.version ?? 'RFB 003.008\n');
      for (const cb of this.#onSocket.splice(0)) cb();
    });
  }

  #stage = 0;
  #onData(chunk: Buffer): void {
    this.received = Buffer.concat([this.received, chunk]);
    const s = this.socket!;
    const version = this.opts.version ?? 'RFB 003.008\n';
    if (this.#stage === 0 && this.received.length >= 12) {
      this.received = this.received.subarray(12);
      this.#stage = 1;
      const types = this.opts.securityTypes ?? [1];
      if (version.startsWith('RFB 003.003')) {
        const msg = Buffer.alloc(4);
        msg.writeUInt32BE(types[0]!);
        s.write(msg);
        this.#stage = 2;
      } else {
        s.write(Buffer.from([types.length, ...types]));
      }
    }
    if (this.#stage === 1 && this.received.length >= 1) {
      this.received = this.received.subarray(1);
      if (version.startsWith('RFB 003.008')) s.write(Buffer.alloc(4)); // SecurityResult OK
      this.#stage = 2;
    }
    if (this.#stage === 2 && this.received.length >= 1) {
      this.received = this.received.subarray(1); // ClientInit
      const init = Buffer.alloc(24 + 4);
      init.writeUInt16BE(this.opts.width ?? 4, 0);
      init.writeUInt16BE(this.opts.height ?? 2, 2);
      init.writeUInt32BE(4, 20);
      init.write('test', 24, 'latin1');
      s.write(init);
      this.#stage = 3;
    }
  }

  /** Client messages after the handshake, by type byte. */
  messageTypes(): number[] {
    const types: number[] = [];
    let b = this.received;
    while (b.length > 0) {
      const t = b[0]!;
      types.push(t);
      const len = t === 0 ? 20 : t === 2 ? 4 + b.readUInt16BE(2) * 4 : t === 3 ? 10 : b.length;
      b = b.subarray(len);
    }
    return types;
  }

  /** Send one FramebufferUpdate of solid-colour raw rectangles. */
  sendUpdate(
    rects: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }[],
  ) {
    const parts: Buffer[] = [];
    const head = Buffer.alloc(4);
    head.writeUInt16BE(rects.length, 2);
    parts.push(head);
    for (const r of rects) {
      const rh = Buffer.alloc(12);
      rh.writeUInt16BE(r.x, 0);
      rh.writeUInt16BE(r.y, 2);
      rh.writeUInt16BE(r.w, 4);
      rh.writeUInt16BE(r.h, 6);
      rh.writeInt32BE(0, 8);
      parts.push(rh);
      const px = Buffer.alloc(r.w * r.h * 4);
      for (let i = 0; i < r.w * r.h; i++) {
        px[i * 4] = r.rgb[2];
        px[i * 4 + 1] = r.rgb[1];
        px[i * 4 + 2] = r.rgb[0];
      }
      parts.push(px);
    }
    // Split mid-message so the client has to reassemble across reads.
    const all = Buffer.concat(parts);
    const cut = Math.floor(all.length / 2);
    this.socket!.write(all.subarray(0, cut));
    setTimeout(() => this.socket?.write(all.subarray(cut)), 5);
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return (this.server.address() as AddressInfo).port;
  }

  connected(): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise((r) => this.#onSocket.push(r));
  }

  close(): Promise<void> {
    this.socket?.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }
}

const servers: FakeRfbServer[] = [];
const sources: DesktopFrameSource[] = [];
afterEach(async () => {
  for (const s of sources.splice(0)) s.close();
  for (const s of servers.splice(0)) await s.close();
});

async function setup(opts: FakeRfbOpts = {}, sourceOpts: { idleCloseMs?: number } = {}) {
  const server = new FakeRfbServer(opts);
  servers.push(server);
  const port = await server.listen();
  const source = await connectVncFrameSource(
    { host: '127.0.0.1', port },
    { timeoutMs: 2_000, minUpdateIntervalMs: 0, ...sourceOpts },
  );
  sources.push(source);
  await server.connected();
  return { server, source };
}

const waitUntil = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('connectVncFrameSource', () => {
  it('handshakes, asks for 32-bit raw frames, and returns the screen as PNG', async () => {
    const { server, source } = await setup();
    const shot = source.capture();
    // SetPixelFormat, SetEncodings, then a full (non-incremental) update request.
    await waitUntil(() => server.messageTypes().length >= 3);
    expect(server.messageTypes().slice(0, 3)).toEqual([0, 2, 3]);
    server.sendUpdate([{ x: 0, y: 0, w: 4, h: 2, rgb: [10, 20, 30] }]);
    const png = decodePng(await shot);
    expect([png.width, png.height]).toEqual([4, 2]);
    expect(png.px(3, 1)).toEqual([10, 20, 30]);
  });

  it('applies incremental rectangles on top of the last frame', async () => {
    const { server, source } = await setup();
    const first = source.capture();
    await waitUntil(() => server.messageTypes().length >= 3);
    server.sendUpdate([{ x: 0, y: 0, w: 4, h: 2, rgb: [0, 0, 0] }]);
    await first;
    // After an update the client asks for the next one, incrementally.
    await waitUntil(() => server.messageTypes().length >= 4);
    server.sendUpdate([{ x: 2, y: 1, w: 1, h: 1, rgb: [255, 0, 0] }]);
    let png = decodePng(await source.capture());
    for (let i = 0; i < 100 && png.px(2, 1)[0] !== 255; i++) {
      await new Promise((r) => setTimeout(r, 5));
      png = decodePng(await source.capture());
    }
    expect(png.px(2, 1)).toEqual([255, 0, 0]);
    expect(png.px(0, 0)).toEqual([0, 0, 0]);
  });

  it('returns the same PNG while the screen is unchanged', async () => {
    const { server, source } = await setup();
    const shot = source.capture();
    await waitUntil(() => server.messageTypes().length >= 3);
    server.sendUpdate([{ x: 0, y: 0, w: 4, h: 2, rgb: [1, 2, 3] }]);
    const a = await shot;
    expect(await source.capture()).toBe(a);
  });

  it('speaks RFB 3.3 servers', async () => {
    const { server, source } = await setup({ version: 'RFB 003.003\n' });
    const shot = source.capture();
    await waitUntil(() => server.messageTypes().length >= 3);
    server.sendUpdate([{ x: 0, y: 0, w: 4, h: 2, rgb: [9, 9, 9] }]);
    expect(decodePng(await shot).px(0, 0)).toEqual([9, 9, 9]);
  });

  it('refuses a server that requires a password', async () => {
    const { source } = await setup({ securityTypes: [2] });
    await expect(source.capture()).rejects.toThrow(/requires authentication/);
    expect(source.closed).toBe(true);
  });

  it('rejects a rectangle outside the screen instead of writing past the buffer', async () => {
    const { server, source } = await setup();
    const shot = source.capture();
    await waitUntil(() => server.messageTypes().length >= 3);
    server.sendUpdate([{ x: 3, y: 0, w: 2, h: 1, rgb: [1, 1, 1] }]);
    await expect(shot).rejects.toThrow(/outside the screen/);
  });

  it('fails capture when the server goes away', async () => {
    const { server, source } = await setup();
    server.socket!.destroy();
    await expect(source.capture()).rejects.toThrow(VncProtocolError);
    await waitUntil(() => source.closed);
  });

  it('closes itself after sitting unused', async () => {
    const { server, source } = await setup({}, { idleCloseMs: 30 });
    await waitUntil(() => source.closed);
    await waitUntil(() => server.closed);
  });
});

describe('VNC connect deadline', () => {
  const endpoint = { host: '172.30.0.9', port: 5900 };

  it('gives up on a connect that never completes and aborts it', async () => {
    let signal: AbortSignal | null = null;
    const stalled = (_e: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise<never>(() => undefined);
    };
    await expect(
      connectVncFrameSource(endpoint, { connect: stalled, timeoutMs: 20 }),
    ).rejects.toThrow(/VNC connect to 172\.30\.0\.9:5900 timed out after 20ms/);
    expect(signal!.aborted).toBe(true);
  });

  it('destroys a socket that only connects after the deadline', async () => {
    let destroyed = false;
    let finish!: (s: VncSocket) => void;
    const late = () => new Promise<VncSocket>((resolve) => (finish = resolve));
    await expect(connectVncFrameSource(endpoint, { connect: late, timeoutMs: 10 })).rejects.toThrow(
      /timed out/,
    );
    finish({
      write: () => true,
      on: () => undefined,
      destroy: () => {
        destroyed = true;
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(destroyed).toBe(true);
  });

  it('the default connect destroys its socket when aborted', async () => {
    const server = new FakeRfbServer();
    servers.push(server);
    const port = await server.listen();
    const controller = new AbortController();
    controller.abort(new Error('deadline'));
    await expect(defaultVncConnect({ host: '127.0.0.1', port }, controller.signal)).rejects.toThrow(
      'deadline',
    );
  });
});

describe('negotiateRfbVersion', () => {
  it.each([
    ['RFB 003.003\n', 3],
    ['RFB 003.007\n', 7],
    ['RFB 003.008\n', 8],
    ['RFB 003.889\n', 8],
    ['RFB 004.001\n', 8],
  ])('%j -> 3.%i', (banner, minor) => {
    expect(negotiateRfbVersion(Buffer.from(banner))).toBe(minor);
  });

  it('rejects a non-VNC banner', () => {
    expect(() => negotiateRfbVersion(Buffer.from('HTTP/1.1 400'))).toThrow(VncProtocolError);
  });
});

describe('encodeBgrxPng', () => {
  it('maps BGRX pixels to RGB', () => {
    const fb = Buffer.from([30, 20, 10, 0, 3, 2, 1, 0]);
    const png = decodePng(encodeBgrxPng(fb, 2, 1));
    expect(png.px(0, 0)).toEqual([10, 20, 30]);
    expect(png.px(1, 0)).toEqual([1, 2, 3]);
  });
});
