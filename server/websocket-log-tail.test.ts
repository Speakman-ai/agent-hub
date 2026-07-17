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
      ws.send(JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0 }));
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

  it('bounds the initial backfill to the sinceUnixNano window', async () => {
    // Regression: an initial subscribe (cursor 0) replayed the entire retained
    // history oldest-first, so the Live view filled with ancient records before
    // the newest arrived. A time window must seed only recent rows.
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
      ws.send(JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0 }));
      await messages.waitFor(
        (message) => message.type === 'logs_tail_backfill' && message.nextCursor === 500,
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
      ws.send(JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0 }));
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
      ws.send(JSON.stringify({ type: 'logs_subscribe', projectId: 'project-a', cursor: 0 }));
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
