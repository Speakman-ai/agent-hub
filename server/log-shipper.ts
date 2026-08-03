/**
 * Log shipper — forwards the Hub's own captured console output to Agent Hub's
 * JSON-batch log-ingest endpoint (`POST /api/logs/ingest`).
 *
 * Wiring: `server-log.ts` captures every `console.log/warn/error` into a
 * `LogEntry`; `setLogForwarder` hands each entry here. We buffer entries and
 * flush them as an Agent Hub JSON batch:
 *
 *   { resource: {...}, records: [{ timeUnixMillis, severityText, body, attributes }] }
 *
 * authenticated with `Authorization: Bearer <ahlog_ token>`. Identity
 * (project + source) is derived from the token server-side, never the body.
 *
 * Safety contract (matches server-log.ts's expectations):
 *  - Never throws into the logging path — every failure is swallowed.
 *  - Never emits via `console.*` (that would re-enter capture and could loop);
 *    unrecoverable diagnostics go straight to the original `process.stderr`.
 *  - No-ops unless `AHLOG_TOKEN` is set, so tests / local dev stay offline.
 *
 * Ingest limits mirrored here (see routes/log-ingest.ts): ≤ 1 MiB request,
 * ≤ 1,000 records per batch, ≤ 256 KiB per normalized record. We stay well
 * under these by flushing on record-count / byte thresholds and truncating
 * oversized messages before they are rejected.
 */

import type { LogEntry } from './server-log.js';
import { setLogForwarder } from './server-log.js';

// The Hub ships its own logs to its own ingest route. Default to loopback on
// the server's own port so no deployment-specific hostname is baked into the
// (public) source tree; override with AHLOG_ENDPOINT to route through a public
// URL / proxy. Path must match routes/log-ingest.ts.
const INGEST_PATH = '/api/logs/ingest';
const DEFAULT_INGEST_PORT = '3051';

function defaultBatchEndpoint(env: NodeJS.ProcessEnv): string {
  const port = (env.AGENT_HUB_PORT ?? '').trim() || DEFAULT_INGEST_PORT;
  return `http://127.0.0.1:${port}${INGEST_PATH}`;
}

// Ingest hard limits (keep in sync with routes/log-ingest.ts).
const MAX_RECORDS_PER_BATCH = 1_000;
const MAX_RECORD_BYTES = 256 * 1024; // 256 KiB
const MAX_REQUEST_BYTES = 1024 * 1024; // 1 MiB
// Budget batches a little under the 1 MiB request cap. The budget is computed
// against the *serialized* JSON size (see takeBatch), so this margin only
// absorbs tiny discrepancies (e.g. gzip is not used, transfer-encoding).
const REQUEST_BYTE_SAFETY_MARGIN = 16 * 1024; // 16 KiB
const REQUEST_BYTE_BUDGET = MAX_REQUEST_BYTES - REQUEST_BYTE_SAFETY_MARGIN;

// Flush well below the hard caps to leave envelope headroom.
const FLUSH_RECORD_COUNT = 200;
const FLUSH_BYTE_THRESHOLD = 512 * 1024; // 512 KiB
const FLUSH_INTERVAL_MS = 5_000;
// Bounded in-memory backlog if the endpoint is unreachable; oldest dropped.
const MAX_QUEUE_RECORDS = 5_000;
// Leave margin under MAX_RECORD_BYTES for attribute/envelope overhead.
const MESSAGE_TRUNCATE_BYTES = MAX_RECORD_BYTES - 4 * 1024;

const SEVERITY_TEXT: Record<LogEntry['level'], string> = {
  log: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

interface OutRecord {
  timeUnixMillis: number;
  severityText: string;
  body: string;
  attributes: Record<string, unknown>;
}

/**
 * Outcome of a single ingest POST:
 *  - `ok`        accepted (2xx)
 *  - `drop`      permanent client error (non-413 4xx) — discard the batch
 *  - `too_large` 413 — caller splits and retries instead of dropping
 *  - `retry`     5xx / network error — requeue for a later flush
 */
type PostResult = 'ok' | 'drop' | 'too_large' | 'retry';

export interface LogShipperOptions {
  token: string;
  endpoint: string;
  service: string;
  environment: string;
  fetchImpl?: typeof fetch;
  flushIntervalMs?: number;
}

/** UTF-8 byte length without allocating a Buffer per call. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function truncateToBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  // Trim by characters until under budget, then mark truncation.
  const suffix = '…[truncated]';
  const budget = maxBytes - byteLen(suffix);
  let out = s;
  while (byteLen(out) > budget && out.length > 0) {
    // Drop a chunk proportional to the overage for fewer iterations.
    const over = byteLen(out) - budget;
    const drop = Math.max(1, Math.ceil(over / 2));
    out = out.slice(0, Math.max(0, out.length - drop));
  }
  return out + suffix;
}

export class LogShipper {
  private readonly token: string;
  private readonly endpoint: string;
  private readonly resource: Record<string, unknown>;
  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private queue: OutRecord[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> | null = null;
  // Set when flush() is called while a drain is already in flight, so records
  // enqueued mid-drain trigger one more pass instead of being stranded.
  private flushAgain = false;
  private stopped = false;
  private droppedRecords = 0;
  // Serialized byte length of the request envelope with an empty records array,
  // `{"resource":<res>,"records":[]}`. takeBatch() budgets the exact payload as
  // envelopeBaseBytes + Σ serialized-record bytes + inter-record commas.
  private readonly envelopeBaseBytes: number;
  // Max records per request. Starts at the ingest cap; halves (to a floor of 1)
  // only if the endpoint 413s a batch — guaranteeing the batch strictly shrinks
  // to a single record regardless of *why* it was rejected (bytes or count), so
  // the split-retry loop always terminates.
  private maxBatchRecords = MAX_RECORDS_PER_BATCH;

  constructor(opts: LogShipperOptions) {
    this.token = opts.token;
    this.endpoint = opts.endpoint;
    this.resource = {
      'service.name': opts.service,
      'deployment.environment': opts.environment,
    };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.envelopeBaseBytes = byteLen(JSON.stringify({ resource: this.resource, records: [] }));
  }

  /** Register with the capture seam and start the periodic flush timer. */
  start(): void {
    setLogForwarder((entry) => this.enqueue(entry));
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // Don't keep the event loop alive solely for log shipping.
    this.timer.unref?.();
  }

  /** Detach from the capture seam and flush any remaining records. */
  async stop(): Promise<void> {
    this.stopped = true;
    setLogForwarder(null);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Non-throwing entry point invoked for every captured log line. */
  enqueue(entry: LogEntry): void {
    if (this.stopped) return;
    const body = truncateToBytes(entry.message ?? '', MESSAGE_TRUNCATE_BYTES);
    const rec: OutRecord = {
      timeUnixMillis: Date.parse(entry.ts) || Date.now(),
      severityText: SEVERITY_TEXT[entry.level] ?? 'INFO',
      body,
      attributes: { 'log.source': 'server-console' },
    };
    this.queue.push(rec);
    this.queuedBytes += byteLen(body);
    // Bound the backlog; drop oldest so a wedged endpoint can't grow memory.
    while (this.queue.length > MAX_QUEUE_RECORDS) {
      const dropped = this.queue.shift();
      if (dropped) this.queuedBytes -= byteLen(dropped.body);
      this.droppedRecords += 1;
    }
    if (this.queue.length >= FLUSH_RECORD_COUNT || this.queuedBytes >= FLUSH_BYTE_THRESHOLD) {
      void this.flush();
    }
  }

  /**
   * Flush queued records in ingest-limit-sized batches. Never throws.
   * Concurrent callers coalesce onto the single in-flight run and await its
   * completion (so a caller can reliably `await flush()` for a full drain).
   *
   * If a caller invokes flush() while a drain is already running (e.g. enqueue()
   * crosses a threshold mid-drain), we set `flushAgain` so the in-flight run does
   * one more pass after it finishes — otherwise records added just after the
   * drain observed an empty queue would be stranded until the next interval (or
   * lost on shutdown). Clearing `flushPromise` and re-checking the flag happen in
   * the same synchronous continuation (no await between), so no enqueue can slip
   * into that window undetected.
   */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      this.flushAgain = true;
      return this.flushPromise;
    }
    if (this.queue.length === 0) return;
    this.flushPromise = this.runDrainLoop();
    return this.flushPromise;
  }

  private async runDrainLoop(): Promise<void> {
    try {
      do {
        this.flushAgain = false;
        await this.drain();
        // drain() only exits with a non-empty queue when a post failed and
        // requeued its batch — don't spin against a failing endpoint.
        if (this.queue.length > 0) break;
      } while (this.flushAgain);
    } finally {
      this.flushPromise = null;
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.takeBatch();
      if (batch.length === 0) break;
      let result: PostResult;
      try {
        result = await this.post(batch);
      } catch (err) {
        // Unexpected error after the batch was already dequeued — requeue it so
        // the records aren't silently lost, then stop this pass.
        this.requeueFront(batch);
        this.stderr(`log-shipper drain error: ${String(err)}`);
        break;
      }

      if (result === 'ok') continue;

      if (result === 'drop') {
        // Permanent client error (bad token / malformed) — post() logged it.
        // Records are intentionally discarded (already dequeued); keep going.
        this.droppedRecords += batch.length;
        continue;
      }

      if (result === 'too_large') {
        // The request was rejected as too large despite serialized-size
        // budgeting. Split rather than drop: requeue and halve the per-request
        // record cap so the next takeBatch() produces a strictly smaller batch,
        // then keep going.
        if (batch.length > 1) {
          this.requeueFront(batch);
          this.maxBatchRecords = Math.max(1, Math.floor(batch.length / 2));
          continue;
        }
        // A single record still rejected as too large — cannot split further;
        // drop just this one to avoid an unshippable poison-pill loop.
        this.droppedRecords += 1;
        this.stderr('dropping 1 record the ingest endpoint rejected as too large (413)');
        continue;
      }

      // 'retry' (5xx / network) — requeue at the front and stop this pass so we
      // don't hot-loop against a failing endpoint.
      this.requeueFront(batch);
      break;
    }
  }

  /** Return an already-dequeued batch to the front of the queue, restoring bytes. */
  private requeueFront(batch: OutRecord[]): void {
    this.queue.unshift(...batch);
    for (const r of batch) this.queuedBytes += byteLen(r.body);
  }

  /**
   * Pull the largest prefix of the queue whose *serialized* JSON payload fits
   * the request byte budget (and the current record-count cap) off the front of
   * the queue.
   *
   * Sizing is exact: the request body is
   * `{"resource":<res>,"records":[<r0>,<r1>,…]}`, so its byte length is
   * envelopeBaseBytes + Σ byteLen(JSON.stringify(rec)) + (n−1) inter-record
   * commas. Budgeting against this (not a `body.length + 256` estimate) means a
   * message full of escapable characters can't silently push the request past
   * the 1 MiB ingest cap. A single record always fits: message truncation keeps
   * each record well under the byte budget.
   */
  private takeBatch(): OutRecord[] {
    const batch: OutRecord[] = [];
    let payloadBytes = this.envelopeBaseBytes;
    while (this.queue.length > 0 && batch.length < this.maxBatchRecords) {
      const rec = this.queue[0];
      const recBytes = byteLen(JSON.stringify(rec));
      const commaBytes = batch.length > 0 ? 1 : 0;
      if (batch.length > 0 && payloadBytes + commaBytes + recBytes > REQUEST_BYTE_BUDGET) {
        break;
      }
      this.queue.shift();
      this.queuedBytes -= byteLen(rec.body);
      batch.push(rec);
      payloadBytes += commaBytes + recBytes;
    }
    return batch;
  }

  private async post(records: OutRecord[]): Promise<PostResult> {
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ resource: this.resource, records }),
      });
      // 2xx = accepted (incl. 207-style partial success handled server-side).
      if (res.ok) return 'ok';
      // 413 = request too large → caller splits and retries (never dropped).
      if (res.status === 413) return 'too_large';
      // Other 4xx (bad token / malformed) won't succeed on retry — drop to
      // avoid a poison-pill loop. 5xx → signal caller to re-queue.
      if (res.status >= 400 && res.status < 500) {
        this.stderr(
          `log-shipper: ingest rejected ${res.status}; dropping ${records.length} record(s)`,
        );
        return 'drop';
      }
      return 'retry';
    } catch {
      // Network failure — keep the records for a later flush.
      return 'retry';
    }
  }

  /** Write directly to the original stderr, bypassing captured console.*. */
  private stderr(msg: string): void {
    try {
      process.stderr.write(`[log-shipper] ${msg}\n`);
    } catch {
      /* nothing else we can safely do */
    }
  }
}

let active: LogShipper | null = null;

/**
 * Initialize log shipping from environment config. No-op (returns null) unless
 * `AHLOG_TOKEN` is present, so tests and unconfigured deployments never emit
 * network traffic. Safe to call once at server startup.
 */
export function initLogShipperFromEnv(env: NodeJS.ProcessEnv = process.env): LogShipper | null {
  if (active) return active;
  const token = (env.AHLOG_TOKEN ?? '').trim();
  if (!token) {
    // Announce the disabled state at boot. Without this line the no-op is
    // completely silent, so a missing/unpersisted AHLOG_TOKEN (e.g. dropped on a
    // restart) presents downstream only as an indefinitely-empty Logs module
    // with no trace of the cause. One boot line turns that blackout into a grep.
    console.warn(
      '[log-shipper] self log-shipping DISABLED: AHLOG_TOKEN not set — the Hub will not ship its own console logs to the Logs module',
    );
    return null;
  }
  const endpoint = (env.AHLOG_ENDPOINT ?? '').trim() || defaultBatchEndpoint(env);
  const shipper = new LogShipper({
    token,
    endpoint,
    service: (env.AHLOG_SERVICE ?? '').trim() || 'agent-hub',
    environment: (env.AHLOG_ENVIRONMENT ?? '').trim() || 'production',
  });
  shipper.start();
  active = shipper;
  // Confirm the enabled state and where records go (endpoint only — never the
  // token). This is also the first line the just-started shipper captures, so a
  // healthy pipe self-verifies as the first shipped record.
  console.log(`[log-shipper] self log-shipping ENABLED → ${endpoint}`);
  return shipper;
}

/**
 * Whether self log-shipping is currently active.
 *
 * Exists because the only other signal of the disabled state is a single
 * `console.warn` at boot, and `/api/server-logs` is a bounded ring buffer that
 * rotates that line out within the hour. After that there is no way to tell a
 * healthy pipe from a silently-disabled one, which is exactly how an unset
 * `AHLOG_TOKEN` went unnoticed for two weeks while the Logs module sat empty.
 *
 * Deliberately returns only a boolean — no token, and no endpoint. `/api/health`
 * is mounted ahead of the auth middleware (server/index.ts), so anything added
 * here is world-readable; the ingest endpoint can carry an internal hostname and
 * stays out of the payload.
 */
export function isLogShippingEnabled(): boolean {
  return active !== null;
}

/** Test/shutdown helper: detach and clear the module-level singleton. */
export async function _resetLogShipper(): Promise<void> {
  if (active) {
    await active.stop();
    active = null;
  }
}
