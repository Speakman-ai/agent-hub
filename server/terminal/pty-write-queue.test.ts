import { describe, expect, it, vi } from 'vitest';
import { PtyWriteQueue } from './pty-write-queue.js';

describe('PtyWriteQueue', () => {
  it('delivers messages FIFO and never overlaps two writes (single-writer invariant)', async () => {
    const order: string[] = [];
    const inFlight = { count: 0, max: 0 };
    const writer = async (data: string) => {
      inFlight.count += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.count);
      order.push(data);
      await new Promise<void>((res) => setTimeout(res, 5));
      inFlight.count -= 1;
    };
    const q = new PtyWriteQueue({ write: writer });

    // Three concurrent enqueues from "different clients".
    q.enqueue('one');
    q.enqueue('two');
    q.enqueue('three');
    await q.onIdle();

    expect(order).toEqual(['one', 'two', 'three']);
    // A second drain must never start while one is in flight.
    expect(inFlight.max).toBe(1);
  });

  it('writes each enqueued message whole (message granularity)', async () => {
    const seen: string[] = [];
    const q = new PtyWriteQueue({ write: (d) => void seen.push(d) });
    q.enqueue('git status\n');
    q.enqueue('npm test\n');
    await q.onIdle();
    // Never split or merged — one enqueue == one write.
    expect(seen).toEqual(['git status\n', 'npm test\n']);
  });

  it('empty enqueue is a no-op that still reports success', async () => {
    const seen: string[] = [];
    const q = new PtyWriteQueue({ write: (d) => void seen.push(d) });
    expect(q.enqueue('')).toBe(true);
    await q.onIdle();
    expect(seen).toEqual([]);
  });

  it('pause holds delivery until resume', async () => {
    const seen: string[] = [];
    const q = new PtyWriteQueue({ write: (d) => void seen.push(d) });
    q.pause();
    q.enqueue('a');
    q.enqueue('b');
    await Promise.resolve();
    expect(seen).toEqual([]);
    expect(q.length).toBe(2);

    q.resume();
    await q.onIdle();
    expect(seen).toEqual(['a', 'b']);
  });

  it('drops the oldest message under backpressure and counts it', async () => {
    const seen: string[] = [];
    const q = new PtyWriteQueue({
      write: (d) => void seen.push(d),
      maxQueued: 3,
      logger: { warn: () => {} },
    });
    q.pause();
    for (const m of ['a', 'b', 'c', 'd', 'e']) q.enqueue(m);
    expect(q.length).toBe(3);
    expect(q.droppedCount).toBe(2);

    q.resume();
    await q.onIdle();
    // Oldest ('a','b') dropped; freshest input survives.
    expect(seen).toEqual(['c', 'd', 'e']);
  });

  it('a throwing write is logged and does not wedge the drain loop', async () => {
    const seen: string[] = [];
    const warn = vi.fn();
    const q = new PtyWriteQueue({
      write: (d) => {
        if (d === 'boom') throw new Error('nope');
        seen.push(d);
      },
      logger: { warn },
    });
    q.enqueue('ok1');
    q.enqueue('boom');
    q.enqueue('ok2');
    await q.onIdle();
    expect(seen).toEqual(['ok1', 'ok2']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('close drops pending messages and refuses further writes', async () => {
    const seen: string[] = [];
    const q = new PtyWriteQueue({ write: (d) => void seen.push(d) });
    q.pause();
    q.enqueue('a');
    q.close();
    expect(q.length).toBe(0);
    expect(q.isClosed).toBe(true);
    expect(q.enqueue('b')).toBe(false);
    await q.onIdle();
    expect(seen).toEqual([]);
  });

  it('onIdle resolves immediately when nothing is queued', async () => {
    const q = new PtyWriteQueue({ write: () => {} });
    await expect(q.onIdle()).resolves.toBeUndefined();
  });
});
