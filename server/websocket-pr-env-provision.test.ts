/**
 * Integration tests for the PR-env provisioning WebSocket subscription
 * handler (`handlePrEnvProvisionSubscription`).
 *
 * The handler is a thin wrapper around the orchestrator's `subscribeToJob`,
 * so we exercise it with a minimal fake WS client that records every
 * frame and tracks close calls. This lets us assert:
 *
 *   1. Buffered events replay in order with monotonic seq.
 *   2. Live events stream in order during the run.
 *   3. The terminal `done` event triggers a clean WS close (1000).
 *   4. Reconnect with `?since=N` produces no gaps and no duplicates.
 *   5. Unknown jobIds get a synthetic 404 done frame + 4404 close.
 *
 * No real socket is opened — the orchestrator is the source of truth for
 * the event contract, and the handler's only job is to forward those
 * events out a `WebSocket.send()`. A unit-style fake mirrors that contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { handlePrEnvProvisionSubscription } from './websocket.js';
import {
  _resetJobsForTests,
  startProvisionJob,
  stubExecutor,
  isJobFinished,
  snapshotEvents,
  type PrEnvExecutor,
  type PrEnvProvisionEvent,
  type PrEnvPhaseId,
} from './pr-env-provisioning/orchestrator.js';

interface FakeWs {
  readyState: number;
  sent: Record<string, unknown>[];
  closed: { code?: number; reason?: string } | null;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  send(msg: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

function makeFakeWs(): FakeWs {
  const ws: FakeWs = {
    readyState: WsClient.OPEN,
    sent: [],
    closed: null,
    listeners: new Map(),
    send(msg: string) {
      ws.sent.push(JSON.parse(msg) as Record<string, unknown>);
    },
    close(code, reason) {
      if (ws.closed) return;
      ws.closed = { code, reason };
      ws.readyState = WsClient.CLOSED;
      const cbs = ws.listeners.get('close') ?? [];
      for (const cb of cbs) cb(code, reason);
    },
    on(event, cb) {
      const list = ws.listeners.get(event) ?? [];
      list.push(cb);
      ws.listeners.set(event, list);
    },
    emit(event, ...args) {
      const cbs = ws.listeners.get(event) ?? [];
      for (const cb of cbs) cb(...args);
    },
  };
  return ws;
}

async function waitForDone(jobId: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isJobFinished(jobId)) {
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  _resetJobsForTests();
});

const PAYLOAD = {
  previewHost: 'preview.example.com',
  hostedZoneId: 'Z0123',
  repoFullName: 'acme/widgets',
};

describe('handlePrEnvProvisionSubscription — happy path', () => {
  it('replays + streams events in order with monotonic seq, then closes on done', async () => {
    // Hold the executor at each phase so we can subscribe mid-run.
    const releases: Array<() => void> = [];
    const slowExecutor: PrEnvExecutor = {
      async runPhase(phase) {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { status: 'ok', message: `slow ${phase}` };
      },
    };

    startProvisionJob({ jobId: 'job-1', payload: PAYLOAD, executor: slowExecutor });

    // Let the orchestrator buffer the first phase's `started` event before
    // the WS subscribes. This is the "buffered events replay first" path.
    await new Promise((r) => setTimeout(r, 5));

    const ws = makeFakeWs();
    handlePrEnvProvisionSubscription(ws as unknown as WsClient, 'job-1');

    // Drain phases — releaser is FIFO so phases progress in order.
    while (releases.length > 0 || !isJobFinished('job-1')) {
      const r = releases.shift();
      if (r) r();
      await new Promise((res) => setTimeout(res, 2));
    }

    await waitForDone('job-1');

    // Every event from the orchestrator should be on the wire, in the
    // same order, with strictly monotonic seq starting at 0.
    const expected = snapshotEvents('job-1') as Array<PrEnvProvisionEvent & { seq: number }>;
    expect(ws.sent).toHaveLength(expected.length);

    for (let i = 0; i < expected.length; i++) {
      const sent = ws.sent[i] as unknown as PrEnvProvisionEvent & { seq: number };
      expect(sent.type).toBe(expected[i]!.type);
      expect(sent.seq).toBe(expected[i]!.seq);
      expect(sent.seq).toBe(i);
    }

    // First phase should be detect-host (the frozen V1 ordering).
    const firstPhase = ws.sent.find((e) => e.type === 'phase') as
      | { phase: PrEnvPhaseId }
      | undefined;
    expect(firstPhase?.phase).toBe('detect-host');

    // Terminal `done` triggers a 1000 close.
    expect(ws.sent.at(-1)?.type).toBe('done');
    expect(ws.closed).toEqual({ code: 1000, reason: 'Job complete' });
  });

  it('streams a fully buffered run when subscribing after done', async () => {
    startProvisionJob({ jobId: 'job-finished', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('job-finished');

    const ws = makeFakeWs();
    handlePrEnvProvisionSubscription(ws as unknown as WsClient, 'job-finished');

    // The handler closes the socket synchronously after replaying buffered
    // events when the job already finished. Tail of the replay must be
    // `done`, and the closed code is the same 1000 used on live finish.
    expect(ws.sent.at(-1)?.type).toBe('done');
    expect(ws.closed?.code).toBe(1000);
    // Every event we received has a finite, non-decreasing seq.
    for (let i = 1; i < ws.sent.length; i++) {
      const prev = ws.sent[i - 1] as { seq: number };
      const curr = ws.sent[i] as { seq: number };
      expect(curr.seq).toBeGreaterThan(prev.seq);
    }
  });
});

describe('handlePrEnvProvisionSubscription — resume via ?since=N', () => {
  it('replays only events with seq > since, no gaps and no duplicates', async () => {
    startProvisionJob({ jobId: 'job-resume', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('job-resume');

    const all = snapshotEvents('job-resume') as Array<PrEnvProvisionEvent & { seq: number }>;
    expect(all.length).toBeGreaterThan(2);
    // Pick a midpoint — anything before this seq must NOT be replayed,
    // and the very next seq must be the first frame on the new socket.
    const since = all[Math.floor(all.length / 2)]!.seq;

    const ws = makeFakeWs();
    handlePrEnvProvisionSubscription(ws as unknown as WsClient, 'job-resume', since);

    // First replayed seq is exactly `since + 1` (no gap, no duplicate).
    const firstSeq = (ws.sent[0] as { seq: number }).seq;
    expect(firstSeq).toBe(since + 1);

    // No frame on the wire has seq <= since.
    for (const frame of ws.sent) {
      const seq = (frame as { seq: number }).seq;
      expect(seq).toBeGreaterThan(since);
    }

    // Length matches the suffix of the buffer.
    const suffix = all.filter((ev) => ev.seq > since);
    expect(ws.sent.map((f) => (f as { seq: number }).seq)).toEqual(suffix.map((e) => e.seq));

    // Job already finished → handler closed cleanly.
    expect(ws.sent.at(-1)?.type).toBe('done');
    expect(ws.closed?.code).toBe(1000);
  });

  it('returns the full stream when since lags before the first seq', async () => {
    startProvisionJob({ jobId: 'job-since-lag', payload: PAYLOAD, executor: stubExecutor });
    await waitForDone('job-since-lag');

    const all = snapshotEvents('job-since-lag') as Array<PrEnvProvisionEvent & { seq: number }>;
    const ws = makeFakeWs();
    handlePrEnvProvisionSubscription(ws as unknown as WsClient, 'job-since-lag', -1);

    expect(ws.sent).toHaveLength(all.length);
    expect((ws.sent[0] as { seq: number }).seq).toBe(0);
  });

  it('reconnect mid-run: events split across two sockets are gap-free + duplicate-free', async () => {
    const releases: Array<() => void> = [];
    const slowExecutor: PrEnvExecutor = {
      async runPhase(phase) {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { status: 'ok', message: `slow ${phase}` };
      },
    };

    startProvisionJob({ jobId: 'job-reconnect', payload: PAYLOAD, executor: slowExecutor });

    const wsA = makeFakeWs();
    handlePrEnvProvisionSubscription(wsA as unknown as WsClient, 'job-reconnect');

    // Advance through two phases on socket A.
    for (let i = 0; i < 2; i++) {
      const r = releases.shift();
      if (r) r();
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(wsA.sent.length).toBeGreaterThan(0);

    // Disconnect socket A.
    const lastSeqA = (wsA.sent.at(-1) as { seq: number }).seq;
    wsA.emit('close');

    // Reconnect with since = lastSeqA — must skip all events A already saw.
    const wsB = makeFakeWs();
    handlePrEnvProvisionSubscription(wsB as unknown as WsClient, 'job-reconnect', lastSeqA);

    // Drain remaining phases on socket B.
    while (releases.length > 0 || !isJobFinished('job-reconnect')) {
      const r = releases.shift();
      if (r) r();
      await new Promise((res) => setTimeout(res, 5));
    }
    await waitForDone('job-reconnect');

    // Stitched stream: every seq from A's first frame up to the terminal
    // done is present exactly once and in order.
    const stitched: number[] = [
      ...wsA.sent.map((f) => (f as { seq: number }).seq),
      ...wsB.sent.map((f) => (f as { seq: number }).seq),
    ];
    for (let i = 1; i < stitched.length; i++) {
      expect(stitched[i]).toBe(stitched[i - 1]! + 1);
    }
    expect(new Set(stitched).size).toBe(stitched.length);

    // Final frame on socket B is the done event; B was closed 1000.
    expect(wsB.sent.at(-1)?.type).toBe('done');
    expect(wsB.closed?.code).toBe(1000);
  });
});

describe('handlePrEnvProvisionSubscription — unknown job', () => {
  it('emits a synthetic 404 done frame and closes 4404', () => {
    const ws = makeFakeWs();
    handlePrEnvProvisionSubscription(ws as unknown as WsClient, 'no-such-job');

    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toEqual({
      type: 'done',
      error: { code: 404, message: 'Unknown job no-such-job' },
    });
    expect(ws.closed?.code).toBe(4404);
  });
});
