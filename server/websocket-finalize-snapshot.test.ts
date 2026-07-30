/**
 * Integration test: a WebSocket client that connects while a finalize run is
 * in flight receives a `finalize_run_phase_changed` snapshot event so its
 * checks block / button can converge without waiting for the next live
 * orchestrator broadcast.
 *
 * Why this test exists: `useFinalizeRun` mirrors run state purely from streamed
 * `finalize_run_*` events. Before this connect-replay, every event that fired
 * while the socket was down (tab sleep, Wi-Fi switch, NAT rebind, or the
 * mount→first-connect gap) was lost with no server-side recovery — the
 * recurring "tests are running but the UI doesn't say they are" report. The
 * connect-time replay closes that gap unconditionally, independent of the
 * client's reconnect-detection heuristics.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import createWebSocket from './websocket.js';
import { stmts } from './db.js';
import type { WebSocketDeps } from './types.js';

function makeDeps(): WebSocketDeps {
  return {
    getProjects: () => [],
    handleChat: vi.fn().mockResolvedValue(undefined),
    handleCancel: vi.fn(),
    handleDequeue: vi.fn(),
    handleEditQueueItem: vi.fn(),
    handleDesignChat: vi.fn().mockResolvedValue(undefined),
    handleDesignCancel: vi.fn(),
  };
}

/** Same buffer-from-construction helper as the preview snapshot test. */
function bufferMessages(ws: WebSocket) {
  const buffer: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
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
    waitFor(predicate: (m: Record<string, unknown>) => boolean, timeoutMs = 3000) {
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

const RUN_ID = 'fin-snap-run';
const TERMINAL_RUN_ID = 'fin-snap-terminal';
const SESSION_ID = 'fin-snap-sess';

function insertRun(id: string, sessionId: string | null, status: string, phase: string | null) {
  stmts!.insertFinalizeRun.run(
    id,
    `card-${id}`,
    sessionId,
    'proj-x',
    'agent-hub/x/session-x',
    'deadbeef',
    `idem-${id}`,
    status,
    phase,
    'manual',
    null,
    'user-x',
    'Tester',
    'tester@example.com',
    null,
    Date.now(),
    'full',
  );
}

describe('WebSocket — finalize snapshot on connect', () => {
  beforeAll(() => {
    insertRun(RUN_ID, SESSION_ID, 'running', 'tasks');
    // A terminal run for the same kind of session must NOT be replayed.
    insertRun(TERMINAL_RUN_ID, 'fin-snap-done-sess', 'pushed', 'push');
  });

  // No cleanup needed: each test file gets a fresh, isolated SQLite db
  // (vitest pool: 'forks', isolate: true, per-pid data dir).

  it('replays a finalize_run_phase_changed event for the in-flight run only', async () => {
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

      const event = await buf.waitFor(
        (m) => m.type === 'finalize_run_phase_changed' && m.run_id === RUN_ID,
      );
      expect(event).toMatchObject({
        type: 'finalize_run_phase_changed',
        run_id: RUN_ID,
        session_id: SESSION_ID,
        phase: 'tasks',
        status: 'running',
        snapshot: true,
      });

      // The terminal (pushed) run must never appear in the snapshot.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const terminal = buf
        .all()
        .filter((m) => m.type === 'finalize_run_phase_changed' && m.run_id === TERMINAL_RUN_ID);
      expect(terminal).toHaveLength(0);
    } finally {
      ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
