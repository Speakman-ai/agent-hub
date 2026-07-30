/**
 * Integration test: a WebSocket client that connects while a dev server
 * preview is active receives an `agenthub_preview` snapshot event so
 * its pane can rebuild state without waiting for the next chat-handler
 * broadcast.
 *
 * Why this test exists: before the WS-snapshot path was added, the only
 * source of `preview_starting` / `preview` / `preview_failed` events
 * was the chat-handler poll loop in `preview-block.ts`. A reconnecting
 * client whose disconnect spanned the readiness transition (or whose
 * disconnect outlasted the chat turn) would never learn the current
 * preview state — the pane sat frozen on whatever event landed before
 * the drop. The connect-time replay closes that gap.
 *
 * We stand up a real WebSocket server with a stubbed runtime that
 * mimics one active "starting" group, then assert the client receives
 * a `preview_starting` event on connect with the row's port / url / log
 * tail.
 */

import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import createWebSocket from './websocket.js';
import type { WebSocketDeps } from './types.js';
import type { PreviewSnapshotRow } from './preview/preview-snapshot.js';

function activeRow(overrides: Partial<PreviewSnapshotRow> = {}): PreviewSnapshotRow {
  return {
    id: 'grp-replay',
    session_id: 'sess-replay',
    port: 4242,
    url: 'http://localhost:4242',
    status: 'starting',
    ...overrides,
  };
}

/**
 * Buffer every incoming WS message from connection time. Returns a
 * `waitFor(predicate)` that resolves with the first matching message,
 * whether it landed before or after the call.
 *
 * We can't lazily `ws.on('message', …)` after `open` — the connect-time
 * snapshots are flushed by the server synchronously inside the
 * connection handler, so they arrive while the harness is still
 * resolving the open promise. By the time the test code subscribes,
 * the snapshot has been dispatched and dropped on the floor. Buffering
 * from the moment the WebSocket is constructed avoids the race.
 */
function bufferMessages(ws: WebSocket): {
  waitFor: (
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  all: () => Record<string, unknown>[];
} {
  const buffer: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (msg: Record<string, unknown>) => boolean;
    resolve: (msg: Record<string, unknown>) => void;
  }> = [];
  ws.on('message', (raw) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    buffer.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(parsed)) {
        waiters[i].resolve(parsed);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    waitFor(predicate, timeoutMs = 3000) {
      const existing = buffer.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const entry = { predicate, resolve };
        waiters.push(entry);
        setTimeout(() => {
          const idx = waiters.indexOf(entry);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            reject(new Error('timed out waiting for matching WS message'));
          }
        }, timeoutMs);
      });
    },
    all: () => [...buffer],
  };
}

function makeDeps(
  getPreviewSnapshotRuntime?: WebSocketDeps['getPreviewSnapshotRuntime'],
): WebSocketDeps {
  return {
    getProjects: () => [],
    handleChat: vi.fn().mockResolvedValue(undefined),
    handleCancel: vi.fn(),
    handleDequeue: vi.fn(),
    handleEditQueueItem: vi.fn(),
    handleDesignChat: vi.fn().mockResolvedValue(undefined),
    handleDesignCancel: vi.fn(),
    ...(getPreviewSnapshotRuntime ? { getPreviewSnapshotRuntime } : {}),
  };
}

describe('WebSocket — preview snapshot on connect', () => {
  it('replays a `preview_starting` event when an active dev-server group exists', async () => {
    const row = activeRow({ status: 'starting' });
    const getLogTail = vi.fn().mockReturnValue(['boot-1', 'boot-2']);
    const listActive = vi.fn().mockReturnValue([row]);

    const server = createServer();
    createWebSocket(
      server,
      makeDeps(() => ({ listActive, getLogTail })),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const buf = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      const event = await buf.waitFor(
        (m) => m.type === 'agenthub_preview' && m.kind === 'preview_starting',
      );

      expect(event).toMatchObject({
        type: 'agenthub_preview',
        kind: 'preview_starting',
        sessionId: 'sess-replay',
        previewId: 'grp-replay',
        target: 'client',
        route: '/',
        agentReason: '',
        previewUrl: 'http://localhost:4242',
        port: 4242,
        logTail: ['boot-1', 'boot-2'],
      });
      expect(listActive).toHaveBeenCalledTimes(1);
      expect(getLogTail).toHaveBeenCalledWith('grp-replay');
    } finally {
      ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('replays a `preview` (ready) event with fullUrl when the row is ready', async () => {
    const row = activeRow({ status: 'ready' });
    const server = createServer();
    createWebSocket(
      server,
      makeDeps(() => ({ listActive: () => [row], getLogTail: () => ['ready-line'] })),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const buf = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      const event = await buf.waitFor((m) => m.type === 'agenthub_preview' && m.kind === 'preview');
      expect(event).toMatchObject({
        kind: 'preview',
        sessionId: 'sess-replay',
        previewId: 'grp-replay',
        fullUrl: 'http://localhost:4242',
        previewUrl: 'http://localhost:4242',
        port: 4242,
        logTail: ['ready-line'],
      });
    } finally {
      ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('skips the snapshot block when no runtime accessor is wired', async () => {
    // A missing accessor still works —
    // a missing accessor should yield zero `agenthub_preview` messages.
    const server = createServer();
    createWebSocket(server, makeDeps());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const buf = bufferMessages(ws);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      // Give the server a moment to push every connect-time snapshot.
      // If it were going to send a preview snapshot, it would do so in
      // the same synchronous block as the other snapshots — 75ms is
      // generous.
      await new Promise<void>((resolve) => setTimeout(resolve, 75));

      const previewMessages = buf.all().filter((m) => m.type === 'agenthub_preview');
      expect(previewMessages).toHaveLength(0);
    } finally {
      ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('tolerates a throwing runtime accessor without breaking the connect handshake', async () => {
    const server = createServer();
    createWebSocket(
      server,
      makeDeps(() => {
        throw new Error('runtime explosion');
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const buf = bufferMessages(ws);
    try {
      // The connect must still succeed; the snapshot is best-effort.
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      // And we should still be able to send a frame without the WS closing.
      ws.send(JSON.stringify({ type: 'ping' }));
      const pong = await buf.waitFor((m) => m.type === 'pong');
      expect(pong.type).toBe('pong');
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
