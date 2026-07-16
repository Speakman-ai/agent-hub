import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLogTail, type SocketLike } from './useLogTail';
import { SEVERITY_NUMBER } from '../utils/logStream';

vi.mock('../utils/connection', () => ({
  getWsUrl: () => 'ws://test/ws',
}));

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  sent: string[] = [];

  constructor() {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  // Test drivers:
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  lastSubscribeCursor(): number | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const parsed = JSON.parse(this.sent[i]);
      if (parsed.type === 'logs_subscribe') return parsed.cursor;
    }
    return null;
  }
}

function record(id: number) {
  return {
    id,
    projectId: 'p1',
    sourceId: 'src',
    timeUnixNano: id * 1_000_000,
    observedTimeUnixNano: null,
    severityNumber: SEVERITY_NUMBER.INFO,
    severityText: null,
    body: `line ${id}`,
    serviceName: 'svc',
    environment: 'prod',
    traceId: null,
    spanId: null,
    fingerprint: null,
    resourceJson: null,
    attributesJson: null,
    scopeJson: null,
    byteSize: 1,
    ingestedAt: 0,
  };
}

const opts = { createSocket: () => new FakeSocket(), reconnectBaseMs: 10, maxReconnectMs: 50 };

beforeEach(() => {
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useLogTail', () => {
  it('subscribes from cursor 0 and applies backfill then live records', () => {
    const { result } = renderHook(() => useLogTail('p1', opts));
    const sock = FakeSocket.instances[0];
    act(() => sock.open());
    expect(JSON.parse(sock.sent[0])).toMatchObject({
      type: 'logs_subscribe',
      projectId: 'p1',
      cursor: 0,
    });
    act(() =>
      sock.emit({
        type: 'logs_tail_backfill',
        projectId: 'p1',
        records: [record(1), record(2)],
        cursor: 2,
        nextCursor: null,
      }),
    );
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(3)],
        cursor: 3,
        dropped: 0,
      }),
    );
    expect(result.current.records.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(result.current.status).toBe('open');
  });

  it('reconnects from the last cursor and dedupes replayed backfill', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLogTail('p1', opts));
    const first = FakeSocket.instances[0];
    act(() => first.open());
    act(() =>
      first.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1), record(2), record(3)],
        cursor: 3,
        dropped: 0,
      }),
    );
    // Server drops the socket mid-stream.
    act(() => first.serverClose());
    expect(result.current.status).toBe('reconnecting');

    act(() => {
      vi.advanceTimersByTime(20);
    });
    const second = FakeSocket.instances[1];
    expect(second).toBeTruthy();
    act(() => second.open());
    // Reconnect must resubscribe from the last durable cursor (3).
    expect(second.lastSubscribeCursor()).toBe(3);
    // Backfill replays 2,3 and adds 4 — no duplicates.
    act(() =>
      second.emit({
        type: 'logs_tail_backfill',
        projectId: 'p1',
        records: [record(2), record(3), record(4)],
        cursor: 4,
        nextCursor: null,
      }),
    );
    expect(result.current.records.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('accumulates the dropped count from a recovery-required frame', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLogTail('p1', opts));
    const sock = FakeSocket.instances[0];
    act(() => sock.open());
    act(() => sock.emit({ type: 'logs_tail_recovery_required', projectId: 'p1', dropped: 7 }));
    act(() => sock.serverClose());
    expect(result.current.dropped).toBe(7);
  });

  it('freezes the visible list while paused and merges pending on resume', () => {
    const { result } = renderHook(() => useLogTail('p1', opts));
    const sock = FakeSocket.instances[0];
    act(() => sock.open());
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1)],
        cursor: 1,
        dropped: 0,
      }),
    );
    act(() => result.current.setPaused(true));
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(2), record(3)],
        cursor: 3,
        dropped: 0,
      }),
    );
    // Visible list unchanged while paused; pending buffered.
    expect(result.current.records.map((r) => r.id)).toEqual([1]);
    expect(result.current.pendingCount).toBe(2);

    act(() => result.current.resume());
    expect(result.current.paused).toBe(false);
    expect(result.current.pendingCount).toBe(0);
    expect(result.current.records.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('resubscribes to the new project and abandons the old socket on projectId change', () => {
    const { result, rerender } = renderHook(({ pid }) => useLogTail(pid, opts), {
      initialProps: { pid: 'p1' },
    });
    const first = FakeSocket.instances[0];
    act(() => first.open());
    act(() =>
      first.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1)],
        cursor: 1,
        dropped: 0,
      }),
    );
    expect(result.current.records.map((r) => r.id)).toEqual([1]);

    // Switch project. The effect must tear down the p1 socket and connect p2.
    act(() => rerender({ pid: 'p2' }));
    expect(first.readyState).toBe(3); // old socket closed
    const second = FakeSocket.instances[1];
    expect(second).toBeTruthy();
    act(() => second.open());
    expect(second.lastSubscribeCursor()).toBe(0); // fresh cursor for the new project
    expect(JSON.parse(second.sent[second.sent.length - 1]).projectId).toBe('p2');

    // A late frame from the abandoned p1 socket must not leak into p2 state
    // (its handlers were detached on teardown).
    act(() =>
      first.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(99)],
        cursor: 99,
        dropped: 0,
      }),
    );
    act(() =>
      second.emit({
        type: 'logs_tail',
        projectId: 'p2',
        records: [record(5)],
        cursor: 5,
        dropped: 0,
      }),
    );
    expect(result.current.records.map((r) => r.id)).toEqual([5]);
  });

  it('reset() drops the old socket, empties the tail, and ignores stale in-flight frames', () => {
    const { result } = renderHook(() => useLogTail('p1', opts));
    const first = FakeSocket.instances[0];
    act(() => first.open());
    act(() =>
      first.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1), record(2)],
        cursor: 2,
        dropped: 5,
      }),
    );
    expect(result.current.records).toHaveLength(2);
    expect(result.current.dropped).toBe(5);

    // Emulate a server-side purge. reset() must detach + close the old socket
    // and reconnect a fresh one, not just clear local buffers.
    act(() => result.current.reset());
    expect(result.current.records).toHaveLength(0);
    expect(result.current.dropped).toBe(0);
    expect(first.readyState).toBe(3); // old socket closed

    // A frame that was queued on the OLD socket before the purge must NOT
    // reintroduce the now-deleted records (its handlers were detached).
    act(() =>
      first.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(1), record(2)],
        cursor: 2,
        dropped: 0,
      }),
    );
    expect(result.current.records).toHaveLength(0);

    // A fresh socket resubscribed from cursor 0 and now drives the live view.
    const second = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(second).not.toBe(first);
    act(() => second.open());
    expect(second.lastSubscribeCursor()).toBe(0);
    act(() =>
      second.emit({
        type: 'logs_tail',
        projectId: 'p1',
        records: [record(10)],
        cursor: 10,
        dropped: 0,
      }),
    );
    expect(result.current.records.map((r) => r.id)).toEqual([10]);
  });

  it('ignores frames for a different project', () => {
    const { result } = renderHook(() => useLogTail('p1', opts));
    const sock = FakeSocket.instances[0];
    act(() => sock.open());
    act(() =>
      sock.emit({
        type: 'logs_tail',
        projectId: 'other',
        records: [record(9)],
        cursor: 9,
        dropped: 0,
      }),
    );
    expect(result.current.records).toHaveLength(0);
  });
});
