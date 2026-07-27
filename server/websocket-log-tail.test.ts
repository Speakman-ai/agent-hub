import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';
import createWebSocket from './websocket.js';
import { MAX_LOG_TAIL_SOCKET_BUFFERED_BYTES } from './websocket.js';
import type { WebSocketDeps, Project } from './types.js';
import { closeLogsDb, initLogsDb, insertLogRecords, type LogRecordRow } from './logs/logs-db.js';
import { getLogMetrics, resetLogMetrics } from './logs/log-metrics.js';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

function project(id: string): Project {
  return { id, name: id, cwd: '/tmp', ahw: '/tmp', agents: [] };
}

function bufferMessages(ws: WebSocket) {
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    } catch {}
  });
  return {
    waitFor(predicate: (message: Record<string, unknown>) => boolean) {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for WebSocket message')),
          3000,
        );
        const tick = () => {
          const message = messages.find(predicate);
          if (message) {
            clearTimeout(timer);
            resolve(message);
          } else setTimeout(tick, 5);
        };
        tick();
      });
    },
    all: () => [...messages],
  };
}

describe('WebSocket log live tail', () => {
  let dir: string;
  let server: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let publish: ((records: readonly LogRecordRow[]) => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ws-log-tail-'));
    initLogsDb(dir);
    server = createServer();
    const deps: WebSocketDeps = {
      getProjects: () => [project('project-a'), project('project-b')],
      handleChat: vi.fn().mockResolvedValue(undefined),
      handleCancel: vi.fn(),
      handleDelegationCancel: vi.fn(),
      handleDequeue: vi.fn(),
      handleEditQueueItem: vi.fn(),
      handleDesignChat: vi.fn().mockResolvedValue(undefined),
      handleDesignCancel: vi.fn(),
      subscribeLogTail: (listener) => {
        publish = listener;
        return () => {
          unsubscribe = undefined;
        };
      },
    };
    ({ wss } = createWebSocket(server, deps));
  });

  afterEach(async () => {
    unsubscribe?.();
    closeLogsDb();
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('scopes cursor backfill and live records to the subscribed project', async () => {
    const a = insertLogRecords(
      [{ projectId: 'project-a', sourceId: 'a', timeUnixNano: 1, body: 'project-a old' }],
      1,
    ).records[0]!;
    const b = insertLogRecords(
      [{ projectId: 'project-b', sourceId: 'b', timeUnixNano: 2, body: 'project-b secret' }],
      2,
    ).records[0]!;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      // A cursor from project B is untrusted input: it changes only the
      // project-A id boundary and cannot make B's row appear in the replay.
      ws.send(
        JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0, seed: true }),
      );
      const backfill = await messages.waitFor((message) => message.type === 'logs_tail_backfill');
      expect(backfill.records).toEqual([
        expect.objectContaining({ id: a.id, projectId: 'project-a', body: 'project-a old' }),
      ]);
      expect(JSON.stringify(backfill)).not.toContain('project-b secret');

      publish?.([b]);
      publish?.([
        insertLogRecords(
          [{ projectId: 'project-a', sourceId: 'a', timeUnixNano: 3, body: 'project-a live' }],
          3,
        ).records[0]!,
      ]);
      const live = await messages.waitFor((message) => message.type === 'logs_tail');
      expect(live.records).toEqual([
        expect.objectContaining({ projectId: 'project-a', body: 'project-a live' }),
      ]);
    } finally {
      ws.close();
    }
  });

  it('bounds the initial seed to the sinceUnixNano window', async () => {
    insertLogRecords(
      [{ projectId: 'project-a', sourceId: 'a', timeUnixNano: 1, body: 'ancient row' }],
      1,
    );
    const recent = insertLogRecords(
      [{ projectId: 'project-a', sourceId: 'a', timeUnixNano: 1000, body: 'recent row' }],
      1,
    ).records[0]!;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({
          type: 'logs_subscribe',
          projectId: 'project-a',
          cursor: 0,
          seed: true,
          sinceUnixNano: 500,
        }),
      );
      const backfill = await messages.waitFor((message) => message.type === 'logs_tail_backfill');
      expect(backfill.records).toEqual([
        expect.objectContaining({ id: recent.id, body: 'recent row' }),
      ]);
      expect(JSON.stringify(backfill)).not.toContain('ancient row');
    } finally {
      ws.close();
    }
  });

  it('finishes every backfill page before a queued live cursor can advance', async () => {
    const historical = Array.from({ length: 1000 }, (_, index) => ({
      projectId: 'project-a',
      sourceId: 'a',
      timeUnixNano: index + 1,
      body: `historical-${index + 1}`,
    }));
    insertLogRecords(historical, 1);
    insertLogRecords(
      [{ projectId: 'project-a', sourceId: 'a', timeUnixNano: 1001, body: 'historical-1001' }],
      1,
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      // Reconnect cursor (not 0): the client is missing a contiguous range, so
      // the server drains it forward page by page. A fresh subscribe takes the
      // single-frame seed path instead (covered below).
      ws.send(JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 1 }));
      await messages.waitFor(
        (message) => message.type === 'logs_tail_backfill' && message.nextCursor === 501,
      );
      const live = insertLogRecords(
        [{ projectId: 'project-a', sourceId: 'a', timeUnixNano: 1002, body: 'live-1002' }],
        1,
      ).records[0]!;
      publish?.([live]);
      await messages.waitFor(
        (message) => message.type === 'logs_tail_backfill' && message.nextCursor === null,
      );
      const liveFrame = await messages.waitFor(
        (message) => message.type === 'logs_tail' && message.cursor === live.id,
      );
      const all = messages.all();
      const finalBackfillIndex = all.findIndex(
        (message) => message.type === 'logs_tail_backfill' && message.nextCursor === null,
      );
      expect(all.indexOf(liveFrame)).toBeGreaterThan(finalBackfillIndex);
    } finally {
      ws.close();
    }
  });

  it('seeds a fresh subscribe with the newest window rows in one frame', async () => {
    // Regression: a fresh subscribe (cursor 0) drained the window oldest-first,
    // so the Live view opened on the oldest records of the range and only
    // reached the tail after every intermediate page had streamed. The seed must
    // be the newest rows, and it must complete in a single frame.
    insertLogRecords(
      Array.from({ length: 600 }, (_, index) => ({
        projectId: 'project-a',
        sourceId: 'a',
        timeUnixNano: index + 1,
        body: `row-${index + 1}`,
      })),
      1,
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0, seed: true }),
      );
      const seed = await messages.waitFor((message) => message.type === 'logs_tail_backfill');
      const bodies = (seed.records as Array<{ body: string }>).map((r) => r.body);
      // Newest 500 of 600, still oldest-first so the client appends in order.
      expect(bodies).toHaveLength(500);
      expect(bodies[0]).toBe('row-101');
      expect(bodies[bodies.length - 1]).toBe('row-600');
      // Single frame: no further paging, so the tail is live immediately.
      expect(seed.nextCursor).toBeNull();
      expect(messages.all().filter((m) => m.type === 'logs_tail_backfill')).toHaveLength(1);
    } finally {
      ws.close();
    }
  });

  it('seeds the chronological tail and reports the max ingest id as the cursor', async () => {
    // Regression (review): with a delayed batch the seed's last row (newest by
    // event time) is NOT the highest id. The live cursor means "newest ingest id
    // I hold", so it must be the max: reporting lower would make the reconnect
    // drain resurrect the old-event-time rows the seed deliberately excluded and
    // splice them into the live tail; reporting higher would skip ingested rows.
    const current = insertLogRecords(
      [
        { projectId: 'project-a', sourceId: 'a', timeUnixNano: 9_000, body: 'current-1' },
        { projectId: 'project-a', sourceId: 'a', timeUnixNano: 9_001, body: 'current-2' },
      ],
      1,
    ).records;
    const delayed = insertLogRecords(
      [
        { projectId: 'project-a', sourceId: 'a', timeUnixNano: 10, body: 'delayed-1' },
        { projectId: 'project-a', sourceId: 'a', timeUnixNano: 11, body: 'delayed-2' },
      ],
      1,
    ).records;
    const maxId = Math.max(...[...current, ...delayed].map((r) => r.id));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({
          type: 'logs_subscribe',
          projectId: 'project-a',
          cursor: 0,
          seed: true,
        }),
      );
      const seed = await messages.waitFor((message) => message.type === 'logs_tail_backfill');
      const records = seed.records as Array<{ body: string; id: number }>;
      // Chronological tail, oldest-first within the frame.
      expect(records.map((r) => r.body)).toEqual([
        'delayed-1',
        'delayed-2',
        'current-1',
        'current-2',
      ]);
      // Cursor is the max COMMITTED ingest id, not the last (chronologically
      // newest) row's id: the delayed batch owns the higher ids here.
      expect(seed.cursor).toBe(maxId);
      expect(seed.cursor).not.toBe(records[records.length - 1]!.id);
    } finally {
      ws.close();
    }
  });

  it('clears already-ingested rows the seed excluded, so a reconnect cannot resurrect them', async () => {
    // Regression (review): the seed cursor was the max id among the rows it
    // RETURNED. When the newest-by-event-time rows are the low-id current batch
    // and an already-ingested delayed batch (higher ids, older event times) is
    // excluded by the cutoff, that cursor sits BELOW the delayed rows. The
    // client then reconnects, the server drains `id > cursor`, and those old
    // records get spliced into the live tail as if they were new, which is the
    // exact jump this change exists to remove.
    const current = insertLogRecords(
      [
        { projectId: 'project-a', sourceId: 'a', timeUnixNano: 9_000, body: 'current-1' },
        { projectId: 'project-a', sourceId: 'a', timeUnixNano: 9_001, body: 'current-2' },
      ],
      1,
    ).records;
    // Ingested later (higher ids) but older by event time, so the seed's
    // event-time cutoff excludes them.
    const delayed = insertLogRecords(
      [
        { projectId: 'project-a', sourceId: 'a', timeUnixNano: 10, body: 'delayed-1' },
        { projectId: 'project-a', sourceId: 'a', timeUnixNano: 11, body: 'delayed-2' },
      ],
      1,
    ).records;
    expect(Math.min(...delayed.map((r) => r.id))).toBeGreaterThan(
      Math.max(...current.map((r) => r.id)),
    );

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    // Seed a fresh subscribe with a limit that excludes the delayed batch.
    const first = new WebSocket(`ws://127.0.0.1:${port}`);
    const firstMessages = bufferMessages(first);
    let seedCursor: number;
    try {
      await new Promise<void>((resolve, reject) => {
        first.once('open', resolve);
        first.once('error', reject);
      });
      first.send(
        JSON.stringify({
          type: 'logs_subscribe',
          projectId: 'project-a',
          cursor: 0,
          seed: true,
          // Window excludes the delayed batch's ancient event times.
          sinceUnixNano: 1_000,
        }),
      );
      const seed = await firstMessages.waitFor((m) => m.type === 'logs_tail_backfill');
      expect((seed.records as Array<{ body: string }>).map((r) => r.body)).toEqual([
        'current-1',
        'current-2',
      ]);
      seedCursor = seed.cursor as number;
      // The cursor clears the excluded delayed batch entirely.
      expect(seedCursor).toBe(Math.max(...delayed.map((r) => r.id)));
    } finally {
      first.close();
    }

    // Now reconnect from that cursor, exactly as the client would.
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    const secondMessages = bufferMessages(second);
    try {
      await new Promise<void>((resolve, reject) => {
        second.once('open', resolve);
        second.once('error', reject);
      });
      second.send(
        JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: seedCursor }),
      );
      const drain = await secondMessages.waitFor(
        (m) => m.type === 'logs_tail_backfill' && m.nextCursor === null,
      );
      // Nothing is redelivered: the delayed rows stay out of the live tail and
      // remain reachable only through the event-time "Load older" path.
      expect(drain.records).toEqual([]);
      expect(JSON.stringify(drain)).not.toContain('delayed-');
    } finally {
      second.close();
    }
  });

  it('keeps a windowed reconnect drain inside the window', async () => {
    // Regression (review): the client sent `sinceUnixNano` only on the seed, so
    // a reconnect drained every `id > cursor` unbounded. A delayed row committed
    // after the cursor with an out-of-window event time was therefore replayed
    // into a bounded Live view.
    const inWindow = insertLogRecords(
      [{ projectId: 'project-a', sourceId: 'a', timeUnixNano: 9_000, body: 'in-window' }],
      1,
    ).records[0]!;
    insertLogRecords(
      [{ projectId: 'project-a', sourceId: 'a', timeUnixNano: 10, body: 'delayed-out-of-window' }],
      1,
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      // Reconnect (seed omitted) from BELOW both rows, carrying the window.
      ws.send(
        JSON.stringify({
          type: 'logs_subscribe',
          projectId: 'project-a',
          cursor: inWindow.id - 1,
          sinceUnixNano: 1_000,
        }),
      );
      const drain = await messages.waitFor(
        (message) => message.type === 'logs_tail_backfill' && message.nextCursor === null,
      );
      expect((drain.records as Array<{ body: string }>).map((r) => r.body)).toEqual(['in-window']);
      expect(JSON.stringify(drain)).not.toContain('delayed-out-of-window');
    } finally {
      ws.close();
    }
  });

  it('keeps the live push inside the window too', async () => {
    // The drain is not the only delivery path: a source flushing a backlog
    // commits rows with hours-old event times, and the live fan-out would push
    // them straight into a bounded view. Same symptom, different path.
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({
          type: 'logs_subscribe',
          projectId: 'project-a',
          cursor: 0,
          seed: true,
          sinceUnixNano: 1_000,
        }),
      );
      await messages.waitFor((message) => message.type === 'logs_tail_backfill');

      const backlog = insertLogRecords(
        [
          { projectId: 'project-a', sourceId: 'a', timeUnixNano: 10, body: 'backlog-flush' },
          { projectId: 'project-a', sourceId: 'a', timeUnixNano: 9_500, body: 'fresh-row' },
        ],
        1,
      ).records;
      publish?.(backlog);

      const live = await messages.waitFor((message) => message.type === 'logs_tail');
      expect((live.records as Array<{ body: string }>).map((r) => r.body)).toEqual(['fresh-row']);
      expect(JSON.stringify(live)).not.toContain('backlog-flush');
    } finally {
      ws.close();
    }
  });

  it('drains forward from cursor 0 when no seed was requested', async () => {
    // Regression (review): the lossy newest-page seed must be opt-in. A client
    // that resubscribes from cursor 0 without asking for a seed has NOT told us
    // it is empty, so inferring one would drop every retained row older than the
    // newest page and report `nextCursor: null`, leaving no way to page back.
    insertLogRecords(
      Array.from({ length: 600 }, (_, index) => ({
        projectId: 'project-a',
        sourceId: 'a',
        timeUnixNano: index + 1,
        body: `row-${index + 1}`,
      })),
      1,
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0 }));
      const first = await messages.waitFor((message) => message.type === 'logs_tail_backfill');
      const bodies = (first.records as Array<{ body: string }>).map((r) => r.body);
      // Oldest-first page with a continue-token, not the newest-500 seed.
      expect(bodies[0]).toBe('row-1');
      expect(first.nextCursor).toBe(500);
      // ...and the remaining rows still arrive.
      const last = await messages.waitFor(
        (message) => message.type === 'logs_tail_backfill' && message.nextCursor === null,
      );
      const tailBodies = (last.records as Array<{ body: string }>).map((r) => r.body);
      expect(tailBodies[tailBodies.length - 1]).toBe('row-600');
    } finally {
      ws.close();
    }
  });

  it('ignores a seed request that contradicts a non-zero cursor', async () => {
    // `seed: true` with a cursor means the caller claims to be fresh while
    // naming rows it has already seen. Resolve toward the lossless drain.
    insertLogRecords(
      Array.from({ length: 600 }, (_, index) => ({
        projectId: 'project-a',
        sourceId: 'a',
        timeUnixNano: index + 1,
        body: `row-${index + 1}`,
      })),
      1,
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 1, seed: true }),
      );
      const first = await messages.waitFor((message) => message.type === 'logs_tail_backfill');
      expect((first.records as Array<{ body: string }>)[0]!.body).toBe('row-2');
      expect(first.nextCursor).toBe(501);
    } finally {
      ws.close();
    }
  });

  it('closes on tail-queue overflow so a reconnect can recover by cursor', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0, seed: true }),
      );
      await messages.waitFor((message) => message.type === 'logs_tail_backfill');
      resetLogMetrics();
      const recovery = messages.waitFor(
        (message) => message.type === 'logs_tail_recovery_required',
      );
      const closed = new Promise<number>((resolve) => ws.once('close', resolve));
      publish?.(
        Array.from({ length: 1001 }, (_, id) => ({
          id: id + 1,
          project_id: 'project-a',
          source_id: 'a',
          time_unix_nano: id,
          observed_time_unix_nano: null,
          severity_number: 9,
          severity_text: null,
          body: `live-${id}`,
          service_name: null,
          environment: null,
          trace_id: null,
          span_id: null,
          fingerprint: null,
          resource_json: null,
          attributes_json: null,
          scope_json: null,
          byte_size: 1,
          ingested_at: 1,
        })),
      );
      expect(await recovery).toMatchObject({ projectId: 'project-a', dropped: 1 });
      expect(await closed).toBe(1013);
      // The forced recovery is counted as one WebSocket drop for operators.
      expect(getLogMetrics().wsDrops).toBe(1);
    } finally {
      ws.close();
    }
  });

  it('closes a socket under transport backpressure so it reconnects by cursor', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(
        JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0, seed: true }),
      );
      await messages.waitFor((message) => message.type === 'logs_tail_backfill');
      const serverClient = [...wss.clients][0]!;
      Object.defineProperty(serverClient, 'bufferedAmount', {
        configurable: true,
        value: MAX_LOG_TAIL_SOCKET_BUFFERED_BYTES + 1,
      });
      const closed = new Promise<number>((resolve) => ws.once('close', resolve));
      publish?.([
        {
          id: 1,
          project_id: 'project-a',
          source_id: 'a',
          time_unix_nano: 1,
          observed_time_unix_nano: null,
          severity_number: 9,
          severity_text: null,
          body: 'must recover by cursor',
          service_name: null,
          environment: null,
          trace_id: null,
          span_id: null,
          fingerprint: null,
          resource_json: null,
          attributes_json: null,
          scope_json: null,
          byte_size: 1,
          ingested_at: 1,
        },
      ]);
      expect(await closed).toBe(1013);
    } finally {
      ws.close();
    }
  });
});
