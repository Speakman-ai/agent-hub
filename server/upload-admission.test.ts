import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { AdmissionGate, AdmissionRejectedError, admitted } from './upload-admission.js';

function gate(maxActive = 1, maxQueued = 1, maxWaitMs = 10_000) {
  return new AdmissionGate({ name: 'Test', maxActive, maxQueued, maxWaitMs });
}

describe('AdmissionGate', () => {
  afterEach(() => vi.useRealTimers());

  it('admits up to maxActive, queues up to maxQueued, and rejects the rest immediately', async () => {
    const g = gate(2, 1);
    const r1 = await g.acquire();
    const r2 = await g.acquire();
    const queued = g.acquire();
    await expect(g.acquire()).rejects.toMatchObject({ reason: 'queue_full' });
    expect(g.stats).toEqual({ active: 2, queued: 1 });

    r1();
    const r3 = await queued;
    expect(g.stats).toEqual({ active: 2, queued: 0 });
    r1(); // double release is a no-op
    expect(g.stats.active).toBe(2);
    r2();
    r3();
    expect(g.stats).toEqual({ active: 0, queued: 0 });
  });

  it('times out a waiter with a retryable error', async () => {
    vi.useFakeTimers();
    const g = gate(1, 1, 5_000);
    const release = await g.acquire();
    const waiting = g.acquire();
    vi.advanceTimersByTime(5_001);
    await expect(waiting).rejects.toMatchObject({ reason: 'wait_timeout', retryAfterSec: 5 });
    expect(g.stats).toEqual({ active: 1, queued: 0 });
    release();
  });

  it('drops a cancelled waiter from the queue', async () => {
    const g = gate(1, 1);
    const release = await g.acquire();
    const controller = new AbortController();
    const waiting = g.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ reason: 'aborted' });
    expect(g.stats.queued).toBe(0);
    release();
    expect(g.stats.active).toBe(0);
  });
});

describe('admitted() under saturation', () => {
  it('never starts reading more bodies than maxActive, however many clients pile on', async () => {
    const g = gate(1, 1);
    let bodyReadsStarted = 0;
    let finishHeld!: () => void;
    const held = new Promise<void>((r) => (finishHeld = r));

    const app = express();
    app.post(
      '/upload',
      admitted(
        g,
        [
          (_req, _res, next) => {
            bodyReadsStarted++;
            next();
          },
          express.raw({ type: () => true, limit: '1mb' }),
        ],
        async (req, res) => {
          await held;
          res.json({ bytes: (req.body as Buffer).length });
        },
      ),
    );
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    type Result = { status: number; retryAfter?: string; body: string };
    const clients: http.ClientRequest[] = [];
    const send = (fullBody: boolean): Promise<Result> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            port,
            host: '127.0.0.1',
            method: 'POST',
            path: '/upload',
            headers: { 'Content-Length': 1000, 'Content-Type': 'application/octet-stream' },
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                retryAfter: res.headers['retry-after'] as string | undefined,
                body,
              }),
            );
          },
        );
        req.on('error', reject);
        clients.push(req);
        // Every client starts sending; only admitted ones are ever read.
        req.write(Buffer.alloc(fullBody ? 1000 : 10));
        if (fullBody) req.end();
      });

    try {
      const first = send(true);
      await vi.waitFor(() => expect(g.stats.active).toBe(1));
      const second = send(false).catch(() => null);
      await vi.waitFor(() => expect(g.stats.queued).toBe(1));

      const rejected = await Promise.all(Array.from({ length: 8 }, () => send(false)));
      for (const r of rejected) {
        expect(r.status).toBe(503);
        expect(r.retryAfter).toBe('10');
        expect(JSON.parse(r.body).code).toBe('busy');
      }
      expect(bodyReadsStarted).toBe(1);
      expect(g.stats).toEqual({ active: 1, queued: 1 });

      // The queued client gives up: its slot in the queue is released.
      clients[1]!.destroy();
      await second;
      await vi.waitFor(() => expect(g.stats.queued).toBe(0));

      finishHeld();
      expect((await first).status).toBe(200);
      await vi.waitFor(() => expect(g.stats).toEqual({ active: 0, queued: 0 }));
      expect(bodyReadsStarted).toBe(1);
    } finally {
      finishHeld();
      clients.forEach((c) => c.destroy());
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('frees an admitted slot when the client disconnects mid-body (parser fails, work ends)', async () => {
    const g = gate(1, 0);
    const app = express();
    app.post(
      '/upload',
      admitted(g, [express.raw({ type: () => true })], async (_q, s) => {
        s.json({});
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const req = http.request({
        port,
        host: '127.0.0.1',
        method: 'POST',
        path: '/upload',
        headers: { 'Content-Length': 1000 },
      });
      req.on('error', () => {});
      req.write(Buffer.alloc(10));
      await vi.waitFor(() => expect(g.stats.active).toBe(1));
      req.destroy();
      await vi.waitFor(() => expect(g.stats.active).toBe(0));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('keeps the slot until admitted work finishes, even after the client disconnects', async () => {
    const g = gate(1, 0);
    let finishWork!: () => void;
    const work = new Promise<void>((r) => (finishWork = r));
    let sawAbort = false;
    let handlerDone = false;
    const app = express();
    app.post(
      '/upload',
      admitted(g, [express.raw({ type: () => true })], async (_req, res, signal) => {
        signal.addEventListener('abort', () => (sawAbort = true));
        await work; // e.g. a slow store.put that ignores cancellation
        handlerDone = true;
        if (!signal.aborted) res.json({});
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const req = http.request({
        port,
        host: '127.0.0.1',
        method: 'POST',
        path: '/upload',
        headers: { 'Content-Length': 10 },
      });
      req.on('error', () => {});
      req.end(Buffer.alloc(10)); // full body: parsing completes, handler starts
      await vi.waitFor(() => expect(g.stats.active).toBe(1));
      req.destroy();
      await vi.waitFor(() => expect(sawAbort).toBe(true));

      // Disconnected, but the work (and its memory) is still live: slot held.
      await new Promise((r) => setTimeout(r, 50));
      expect(g.stats.active).toBe(1);
      await expect(g.acquire()).rejects.toMatchObject({ reason: 'queue_full' });

      finishWork();
      await vi.waitFor(() => expect(handlerDone).toBe(true));
      await vi.waitFor(() => expect(g.stats.active).toBe(0));
    } finally {
      finishWork();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('is an AdmissionRejectedError that callers can map to 503', () => {
    expect(new AdmissionRejectedError('x', 'queue_full', 3)).toBeInstanceOf(Error);
  });
});
