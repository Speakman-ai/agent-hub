/**
 * Integration tests for the wall-timeout path inside `runOneClaim`.
 *
 * The descriptor-format tests in `webhook-worker-descriptor.test.ts` only
 * exercise the helper. This file drives the real `withTimeout` timer
 * mechanism end-to-end with fake timers so the test pins three properties
 * of the catch branch:
 *
 *   1. When the inner promise never resolves and 15 min of fake time
 *      elapse, the worker logs the new structured line with
 *      `kind=timeout` (the differentiator a reviewer specifically
 *      called out as the on-call grep filter).
 *   2. `markWebhookEventError` still runs — i.e. the parse-protection
 *      and try/catch around `describeWebhookRow` cannot suppress the DB
 *      error write.
 *   3. The descriptor used in the log line matches the descriptor
 *      embedded in the thrown wall-timeout error label.
 *
 * Tests intentionally bypass the polling interval (it stays disabled
 * under AGENT_HUB_TEST_MODE) and call `tickForTest()` directly so the
 * single claim+timeout cycle runs deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  initWebhookWorker,
  stopWebhookWorker,
  tickForTest,
  getInFlightCount,
  WEBHOOK_WORKER_JOB_TIMEOUT_MS,
} from './webhook-worker.js';
import type { RouteDeps, Stmts, WebhookEventRow } from './types.js';

interface StubStmts {
  resetStaleWebhookEvents: { run: Mock };
  claimPendingWebhookEvent: { get: Mock };
  markWebhookEventDone: { run: Mock };
  markWebhookEventError: { run: Mock };
}

function makeRow(overrides: Partial<WebhookEventRow> = {}): WebhookEventRow {
  return {
    id: 8967,
    webhook_config_id: 3,
    delivery_id: 'gh-delivery-abc-123',
    event_type: 'pull_request',
    action: 'synchronize',
    payload: JSON.stringify({
      repository: { full_name: 'Speakman-ai/agent-hub' },
    }),
    signature: null,
    status: 'processing',
    started_at: null,
    completed_at: null,
    error_message: null,
    attempts: 0,
    created_at: '2026-05-18 17:00:00',
    pr_key: 'Speakman-ai/agent-hub:1043',
    deferred_until: null,
    superseded_by: null,
    ...overrides,
  };
}

function makeStubStmts(row: WebhookEventRow | undefined): StubStmts {
  let consumed = false;
  return {
    resetStaleWebhookEvents: { run: vi.fn(() => ({ changes: 0 })) },
    claimPendingWebhookEvent: {
      // One-shot: hand the row out exactly once so the reentrant
      // setImmediate inside `runOneClaim`'s finally sees an empty queue
      // and bails instead of looping forever on the same fake row.
      get: vi.fn(() => {
        if (consumed) return undefined;
        consumed = true;
        return row;
      }),
    },
    markWebhookEventDone: { run: vi.fn() },
    markWebhookEventError: { run: vi.fn() },
  };
}

describe('runOneClaim — wall-timeout path', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopWebhookWorker();
    vi.useRealTimers();
    consoleError.mockRestore();
  });

  it('logs kind=timeout with structured descriptor when wall budget exhausted', async () => {
    const row = makeRow();
    const stmts = makeStubStmts(row);

    // Inject a processEvent that never resolves so the only way out is
    // the wall-timeout. Using a pending promise (not a setTimeout) keeps
    // the inner promise insensitive to fake-timer advancement — we want
    // ONLY the withTimeout's setTimeout to fire.
    const neverResolves = new Promise(() => undefined);

    initWebhookWorker({
      stmts: stmts as unknown as Stmts,
      routeDeps: {} as RouteDeps,
      processEvent: vi.fn(() => neverResolves),
    });

    // Kick the worker. tickForTest calls pollTick → runOneClaim, which
    // increments _inFlight and starts awaiting withTimeout(...).
    tickForTest();

    // Sanity: the claim ran, the slot was taken.
    expect(getInFlightCount()).toBe(1);

    // Advance past the wall budget. `await` here flushes the queued
    // microtasks so the catch branch actually runs before we assert.
    await vi.advanceTimersByTimeAsync(WEBHOOK_WORKER_JOB_TIMEOUT_MS + 1);

    // The DB error write fired.
    expect(stmts.markWebhookEventError.run).toHaveBeenCalledTimes(1);
    const [errMsg, errRowId] = stmts.markWebhookEventError.run.mock.calls[0] as [string, number];
    expect(errRowId).toBe(8967);
    expect(errMsg).toContain('wall timeout after');
    // The thrown label must include the structured descriptor so the
    // error_message column carries the same routing context as the log.
    expect(errMsg).toContain('event=8967');
    expect(errMsg).toContain('key=pull_request.synchronize');
    expect(errMsg).toContain('repo=Speakman-ai/agent-hub');

    // The log line carries kind=timeout + descriptor + elapsedMs.
    expect(consoleError).toHaveBeenCalled();
    const logged = (consoleError.mock.calls as unknown[][])
      .map((args: unknown[]) => args.join(' '))
      .find((line: string) => line.includes('[webhook-worker]'));
    expect(logged).toBeDefined();
    expect(logged).toContain('[webhook-worker] timeout');
    expect(logged).toContain('event=8967');
    expect(logged).toContain('key=pull_request.synchronize');
    expect(logged).toContain('repo=Speakman-ai/agent-hub');
    expect(logged).toContain('cfg=3');
    expect(logged).toContain('delivery=gh-delivery-abc-123');
    expect(logged).toMatch(/elapsedMs=\d+/);

    // markWebhookEventDone must NOT fire on the timeout path.
    expect(stmts.markWebhookEventDone.run).not.toHaveBeenCalled();

    // The slot must be released — otherwise the concurrency cap drops by 1
    // for every wall-timeout, eventually starving the queue.
    expect(getInFlightCount()).toBe(0);
  });

  it('logs kind=error (not timeout) when processEvent throws a user-space exception', async () => {
    const row = makeRow({ id: 9001, delivery_id: null });
    const stmts = makeStubStmts(row);

    initWebhookWorker({
      stmts: stmts as unknown as Stmts,
      routeDeps: {} as RouteDeps,
      processEvent: vi.fn(() => Promise.reject(new Error('handler crashed for unknown reasons'))),
    });

    tickForTest();

    // Flush microtasks so the rejected promise propagates through
    // withTimeout into the catch branch.
    await vi.advanceTimersByTimeAsync(0);

    expect(stmts.markWebhookEventError.run).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    const logged = (consoleError.mock.calls as unknown[][])
      .map((args: unknown[]) => args.join(' '))
      .find((line: string) => line.includes('[webhook-worker]'));
    expect(logged).toBeDefined();
    // CRITICAL: a user-space throw must NOT be classified as a wall timeout,
    // otherwise the on-call `grep 'kind=timeout'` filter loses precision.
    expect(logged).toContain('[webhook-worker] error');
    expect(logged).not.toContain('[webhook-worker] timeout');
    expect(logged).toContain('event=9001');
    expect(logged).toContain('delivery=none');
    expect(logged).toContain('handler crashed for unknown reasons');

    expect(getInFlightCount()).toBe(0);
  });
});
