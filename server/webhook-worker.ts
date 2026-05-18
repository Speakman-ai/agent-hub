/**
 * webhook-worker.ts — Background processor for the `webhook_events` queue.
 *
 * The GitHub webhook HTTP handler (routes/webhooks.ts) fast-acks every
 * delivery by inserting a row into `webhook_events` and returning 202. This
 * worker polls that queue, claims rows atomically, and invokes
 * `processWebhookEvent` with a strict concurrency cap so a delivery
 * stampede can't saturate the event loop.
 *
 * Why a cap of 2:
 *   - Each processed event may spawn a Claude CLI subprocess. Historical
 *     incident (2026-04-16) showed uncapped processing wedging the host
 *     under bursts of 100+ events/min.
 *   - Two in flight gives us some throughput while leaving the event loop
 *     responsive to new deliveries, WebSocket chat, and health checks.
 *
 * Stale-claim recovery:
 *   - On `init`, any rows left in 'processing' from a prior run are reset
 *     to 'pending'. Safe because the worker hasn't started yet.
 *
 * Testability:
 *   - `processOnce()` processes a single row synchronously (no polling,
 *     no concurrency scheduling) so unit tests can drive the pipeline
 *     deterministically.
 *   - `init()` is a no-op when AGENT_HUB_TEST_MODE is set; tests opt-in
 *     to polling via `startPollingForTest()`.
 */

import type { RouteDeps, Stmts, WebhookEventRow } from './types.js';
import { processWebhookEvent } from './routes/webhooks.js';

/** Maximum concurrent webhook events being processed. */
export const WEBHOOK_WORKER_CONCURRENCY = 2;

/** How often the worker polls the queue for new pending rows. */
export const WEBHOOK_WORKER_POLL_MS = 500;

/**
 * Per-job wall timeout. If a single webhook processing invocation (kanban
 * lifecycle + optional Claude run) exceeds this, we abandon it and mark
 * the row as 'error'. The inner Claude call has its own timeout
 * (config.defaultTimeoutMs) but this is the backstop.
 */
export const WEBHOOK_WORKER_JOB_TIMEOUT_MS = 15 * 60 * 1000;

interface WebhookWorkerDeps {
  stmts: Stmts;
  routeDeps: RouteDeps;
  /** Overridable for tests. Defaults to the real processWebhookEvent. */
  processEvent?: (deps: RouteDeps, row: WebhookEventRow) => Promise<unknown>;
}

let _deps: WebhookWorkerDeps | null = null;
let _inFlight = 0;
let _pollInterval: ReturnType<typeof setInterval> | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}: wall timeout after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Marker substring used to discriminate wall-timeout errors from
 * user-space exceptions in `runOneClaim`. `withTimeout` is the only
 * site that constructs this exact string, so a substring match is a
 * reliable, allocation-free classifier. Exported for the test that
 * pins the log-line `kind=timeout` differentiator.
 */
export const WALL_TIMEOUT_MARKER = 'wall timeout after';

/**
 * Extract the repo full name (`owner/name`) for the log descriptor.
 *
 * Preference order:
 *   1. `pr_key` (indexed column, format `<repo_full_name>:<pr_number>`) —
 *      populated by the enqueue path for any PR-scoped event. Fast and
 *      cannot throw.
 *   2. JSON-parse `row.payload` and read `repository.full_name`. Needed
 *      for non-PR events (`push`, `ping`, `create`, …) where `pr_key`
 *      is NULL. Wrapped in try/catch so a malformed payload can never
 *      bubble up and suppress the caller's DB write.
 *   3. `?` fallback when both paths come up empty.
 */
function extractRepo(row: WebhookEventRow): string {
  if (row.pr_key) {
    const colon = row.pr_key.indexOf(':');
    if (colon > 0) return row.pr_key.slice(0, colon);
  }
  try {
    const payload = JSON.parse(row.payload) as { repository?: { full_name?: string } };
    return payload.repository?.full_name || '?';
  } catch {
    return '?';
  }
}

/**
 * Build a one-line, grep-friendly descriptor for a queued webhook row. Used
 * for both the wall-timeout error label (so the thrown message carries
 * routing context) and the catch-block log line (so PM2 logs are
 * self-diagnosing without cross-referencing the SQLite queue). Best-effort
 * on `repo` — malformed payloads should not abort the run.
 */
export function describeWebhookRow(row: WebhookEventRow): string {
  const eventKey = row.action ? `${row.event_type}.${row.action}` : row.event_type;
  const repo = extractRepo(row);
  return (
    `event=${row.id} key=${eventKey} repo=${repo} cfg=${row.webhook_config_id}` +
    ` delivery=${row.delivery_id ?? 'none'}`
  );
}

async function runOneClaim(): Promise<boolean> {
  if (!_deps) return false;
  if (_inFlight >= WEBHOOK_WORKER_CONCURRENCY) return false;

  const row = _deps.stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
  if (!row) return false;

  _inFlight++;
  const processFn = _deps.processEvent ?? processWebhookEvent;
  const descriptor = describeWebhookRow(row);
  // Capture `startedAt` immediately before the `withTimeout` call so
  // `elapsedMs` measures actual processing time, not queue wait time.
  // Placing it after the slot increment / descriptor build is intentional:
  // those steps are O(µs) and including them would only add jitter to the
  // diagnostic. Used in the catch branch below for both wall-timeout and
  // user-space-error log lines.
  const startedAt = Date.now();
  try {
    await withTimeout(
      processFn(_deps.routeDeps, row),
      WEBHOOK_WORKER_JOB_TIMEOUT_MS,
      `webhook ${descriptor}`,
    );
    _deps.stmts.markWebhookEventDone.run(row.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsedMs = Date.now() - startedAt;
    // Differentiate wall-timeout failures (outer 15 min budget exhausted)
    // from user-space throws so on-call can filter PM2 with a single grep:
    //   grep '\[webhook-worker\] timeout' — only wall-timeout events
    //   grep '\[webhook-worker\] error'   — only user-space throws
    // Without this field both failure classes share the bare `failed` prefix
    // and operators have to parse the trailing `wall timeout after Nms`
    // substring to tell them apart.
    const kind = msg.includes(WALL_TIMEOUT_MARKER) ? 'timeout' : 'error';
    _deps.stmts.markWebhookEventError.run(msg.substring(0, 10000), row.id);
    console.error(`[webhook-worker] ${kind} ${descriptor} elapsedMs=${elapsedMs}: ${msg}`);
  } finally {
    _inFlight--;
    // Try to keep the pipeline full: if another slot is available and the
    // queue is non-empty, claim immediately instead of waiting for the next
    // poll tick.
    setImmediate(() => {
      runOneClaim().catch((err) => {
        console.error('[webhook-worker] reentrant claim failed:', (err as Error).message);
      });
    });
  }
  return true;
}

function pollTick(): void {
  if (!_deps) return;
  // Fire enough claims to reach the concurrency cap. Each runOneClaim will
  // bail early if the cap is already hit or if the queue is empty.
  const slots = WEBHOOK_WORKER_CONCURRENCY - _inFlight;
  for (let i = 0; i < slots; i++) {
    runOneClaim().catch((err) => {
      console.error('[webhook-worker] poll claim failed:', (err as Error).message);
    });
  }
}

/**
 * Start the background worker. Call once at server boot AFTER the DB is
 * initialized and before any webhook events can be enqueued (the HTTP
 * server can start before this, but the window is small and pending
 * events will be picked up on the first tick).
 *
 * Safe to call with AGENT_HUB_TEST_MODE=1 — it will still run
 * stale-claim recovery but will NOT start the polling interval.
 * Tests that want polling can call `startPollingForTest()` after init.
 */
export function initWebhookWorker(deps: WebhookWorkerDeps): void {
  _deps = deps;

  // Stale-claim recovery: any rows stuck in 'processing' from a previous
  // run get reset. Safe because we haven't started polling yet.
  const reset = deps.stmts.resetStaleWebhookEvents.run();
  if (reset.changes > 0) {
    console.log(`[webhook-worker] recovered ${reset.changes} stale processing row(s)`);
  }

  if (process.env.AGENT_HUB_TEST_MODE) {
    // Tests drive processing explicitly via processOnce() or an opt-in
    // `startPollingForTest()` so assertions are deterministic.
    return;
  }

  _pollInterval = setInterval(pollTick, WEBHOOK_WORKER_POLL_MS);
  console.log(
    `[webhook-worker] started (cap=${WEBHOOK_WORKER_CONCURRENCY}, poll=${WEBHOOK_WORKER_POLL_MS}ms)`,
  );
}

export function stopWebhookWorker(): void {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
  _deps = null;
  _inFlight = 0;
}

/**
 * Process at most one pending event and await its completion. Used by
 * tests to drive the worker deterministically. Returns true if a row was
 * claimed, false if the queue was empty or the cap was hit.
 */
export async function processOnce(): Promise<boolean> {
  if (!_deps) throw new Error('webhook-worker not initialized');
  if (_inFlight >= WEBHOOK_WORKER_CONCURRENCY) return false;

  const row = _deps.stmts.claimPendingWebhookEvent.get() as WebhookEventRow | undefined;
  if (!row) return false;

  _inFlight++;
  const processFn = _deps.processEvent ?? processWebhookEvent;
  try {
    await processFn(_deps.routeDeps, row);
    _deps.stmts.markWebhookEventDone.run(row.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    _deps.stmts.markWebhookEventError.run(msg.substring(0, 10000), row.id);
  } finally {
    _inFlight--;
  }
  return true;
}

/**
 * Kick off a polling tick manually. Combined with processOnce semantics,
 * this lets tests exercise the concurrency-cap behavior by forcing the
 * worker to claim up to `WEBHOOK_WORKER_CONCURRENCY` rows without waiting
 * on the real setInterval cadence.
 */
export function tickForTest(): void {
  pollTick();
}

/** Opt-in polling for tests that want to exercise the real interval path. */
export function startPollingForTest(intervalMs: number = WEBHOOK_WORKER_POLL_MS): void {
  if (_pollInterval) return;
  _pollInterval = setInterval(pollTick, intervalMs);
}

/** Introspection for tests and health checks. */
export function getInFlightCount(): number {
  return _inFlight;
}
