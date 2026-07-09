import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { READER_WORKER_SOURCE } from './reader-worker-source.js';

const require = createRequire(import.meta.url);

/**
 * Async, read-only SQLite facade backed by a pool of `worker_threads`, each
 * holding its own `better-sqlite3` connection opened `{ readonly: true }`.
 *
 * This is Phase-2 INFRASTRUCTURE for the async-DB epic. It is intentionally NOT
 * wired into any call site yet: per the locked `facade-scope` decision, only
 * measured-slow READ paths are migrated onto it in a later card, and writes /
 * transactions stay synchronous on the main thread. Attempting a write here
 * throws by construction (see `reader-worker-source.ts`).
 */

/** Serialized error shape sent from a worker. */
interface WorkerErrorPayload {
  message: string;
  code?: string;
  name: string;
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'init-error'; error: WorkerErrorPayload }
  | { type: 'result'; id: number; ok: true; rows: unknown }
  | { type: 'result'; id: number; ok: false; error: WorkerErrorPayload };

/**
 * Error thrown when a query fails inside a reader worker. Preserves the
 * underlying `SqliteError` `name`/`code`/`message` so callers can branch on
 * `err.code === 'SQLITE_ERROR'` exactly as they would with a synchronous
 * better-sqlite3 call. Also used for the readonly-enforcement rejection
 * (`code === 'ASYNC_DB_READONLY'`).
 */
export class AsyncDbError extends Error {
  readonly code: string | undefined;
  constructor(payload: WorkerErrorPayload) {
    super(payload.message);
    // Preserve the origin error's name (e.g. 'SqliteError') for parity with the
    // sync path, while keeping the class identity checkable via `instanceof`.
    this.name = payload.name || 'AsyncDbError';
    this.code = payload.code;
  }
}

/** Thrown when a query exceeds `queryTimeoutMs`. The worker is recycled. */
export class AsyncDbTimeoutError extends Error {
  readonly code = 'ASYNC_DB_TIMEOUT';
  constructor(timeoutMs: number, sql: string) {
    super(`async reader query timed out after ${timeoutMs}ms: ${sql.slice(0, 200)}`);
    this.name = 'AsyncDbTimeoutError';
  }
}

/** Thrown when the wait queue is full (backpressure). */
export class AsyncDbQueueFullError extends Error {
  readonly code = 'ASYNC_DB_QUEUE_FULL';
  constructor(maxQueueDepth: number) {
    super(`async reader pool queue is full (maxQueueDepth=${maxQueueDepth})`);
    this.name = 'AsyncDbQueueFullError';
  }
}

/** Thrown when a query is submitted after `shutdown()` was called. */
export class AsyncDbClosedError extends Error {
  readonly code = 'ASYNC_DB_CLOSED';
  constructor() {
    super('async reader pool is shutting down or closed');
    this.name = 'AsyncDbClosedError';
  }
}

export interface AsyncDbReaderPoolOptions {
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Number of reader workers. Clamped to at least 1. */
  size: number;
  /** Per-query timeout in ms (covers queue wait + execution). */
  queryTimeoutMs: number;
  /** Max number of queries allowed to wait for a free worker before rejecting. */
  maxQueueDepth: number;
  /** SQLite `busy_timeout` (ms) set on each worker connection. 0 disables. */
  busyTimeoutMs?: number;
}

export interface AsyncDbReaderPoolStats {
  size: number;
  /** Workers with no in-flight query. */
  idle: number;
  /** Queries currently executing on a worker. */
  inFlight: number;
  /** Queries waiting for a free worker. */
  queued: number;
  closed: boolean;
}

interface PendingJob {
  id: number;
  sql: string;
  params: unknown[];
  mode: 'all' | 'get';
  resolve: (rows: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  settled: boolean;
  worker: PoolWorker | null;
}

interface PoolWorker {
  id: number;
  worker: Worker;
  ready: boolean;
  busy: PendingJob | null;
}

export class AsyncDbReaderPool {
  private readonly opts: Required<AsyncDbReaderPoolOptions>;
  private readonly betterSqlitePath: string;
  private workers: PoolWorker[] = [];
  private idle: PoolWorker[] = [];
  private waiting: PendingJob[] = [];
  private readonly running = new Map<number, PendingJob>();
  private nextJobId = 1;
  private nextWorkerId = 1;
  private closing = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private resolveShutdown: (() => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readyCount = 0;
  private readySettled = false;

  constructor(options: AsyncDbReaderPoolOptions) {
    this.opts = {
      dbPath: options.dbPath,
      size: Math.max(1, Math.trunc(options.size)),
      queryTimeoutMs: Math.max(1, Math.trunc(options.queryTimeoutMs)),
      maxQueueDepth: Math.max(1, Math.trunc(options.maxQueueDepth)),
      busyTimeoutMs: Math.max(0, Math.trunc(options.busyTimeoutMs ?? 0)),
    };
    this.betterSqlitePath = require.resolve('better-sqlite3');

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Avoid an unhandled-rejection warning if the caller never awaits ready().
    this.readyPromise.catch(() => {});

    for (let i = 0; i < this.opts.size; i++) this.spawnWorker();
  }

  /** Resolves when every worker has opened its connection; rejects on init failure. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  stats(): AsyncDbReaderPoolStats {
    return {
      size: this.workers.length,
      idle: this.idle.length,
      inFlight: this.running.size,
      queued: this.waiting.length,
      closed: this.closed,
    };
  }

  /** Run a read-only statement and return all rows. */
  all<Row = unknown>(sql: string, params: unknown[] = []): Promise<Row[]> {
    return this.submit(sql, params, 'all') as Promise<Row[]>;
  }

  /** Run a read-only statement and return the first row (or undefined). */
  get<Row = unknown>(sql: string, params: unknown[] = []): Promise<Row | undefined> {
    return this.submit(sql, params, 'get').then((rows) =>
      rows == null ? undefined : (rows as Row),
    );
  }

  private submit(sql: string, params: unknown[], mode: 'all' | 'get'): Promise<unknown> {
    if (this.closing || this.closed) return Promise.reject(new AsyncDbClosedError());
    if (this.waiting.length >= this.opts.maxQueueDepth) {
      return Promise.reject(new AsyncDbQueueFullError(this.opts.maxQueueDepth));
    }

    return new Promise<unknown>((resolve, reject) => {
      const job: PendingJob = {
        id: this.nextJobId++,
        sql,
        params,
        mode,
        resolve,
        reject,
        timer: null,
        settled: false,
        worker: null,
      };
      job.timer = setTimeout(() => this.onTimeout(job), this.opts.queryTimeoutMs);
      // Do not keep the event loop alive purely for a pending query timer.
      job.timer.unref?.();

      const worker = this.idle.pop();
      if (worker) this.dispatch(worker, job);
      else this.waiting.push(job);
    });
  }

  private dispatch(worker: PoolWorker, job: PendingJob): void {
    worker.busy = job;
    job.worker = worker;
    this.running.set(job.id, job);
    worker.worker.postMessage({
      type: 'query',
      id: job.id,
      sql: job.sql,
      params: job.params,
      mode: job.mode,
    });
  }

  private settleJob(job: PendingJob, err: Error | null, rows?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    this.running.delete(job.id);
    if (err) job.reject(err);
    else job.resolve(rows);
  }

  private onMessage(worker: PoolWorker, msg: WorkerMessage): void {
    if (msg.type === 'ready') {
      worker.ready = true;
      this.readyCount++;
      if (!this.readySettled && this.readyCount >= this.opts.size) {
        this.readySettled = true;
        this.resolveReady();
      }
      this.releaseWorker(worker);
      return;
    }
    if (msg.type === 'init-error') {
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady(new AsyncDbError(msg.error));
      }
      // A worker that could not open its DB is useless; drop it and, if the
      // pool has no usable workers left, fail any queued jobs so callers are
      // not stranded waiting on a worker that will never become idle.
      this.removeWorker(worker);
      if (this.workers.length === 0) this.failAllWaiting(new AsyncDbError(msg.error));
      return;
    }
    // type === 'result'
    const job = this.running.get(msg.id);
    worker.busy = null;
    if (job) {
      if (msg.ok) this.settleJob(job, null, msg.rows);
      else this.settleJob(job, new AsyncDbError(msg.error));
    }
    this.releaseWorker(worker);
  }

  /** Give a now-free worker the next queued job, or park it as idle. */
  private releaseWorker(worker: PoolWorker): void {
    if (!worker.ready) return;
    const next = this.waiting.shift();
    if (next) {
      this.dispatch(worker, next);
    } else {
      if (!this.idle.includes(worker)) this.idle.push(worker);
      this.maybeFinishDrain();
    }
  }

  private onTimeout(job: PendingJob): void {
    if (job.settled) return;
    const runningWorker = job.worker;
    this.settleJob(job, new AsyncDbTimeoutError(this.opts.queryTimeoutMs, job.sql));
    if (runningWorker) {
      // The worker is stuck in a synchronous better-sqlite3 call that cannot be
      // interrupted from this thread; terminate it and spin up a replacement so
      // the pool does not lose capacity permanently.
      this.recycleWorker(runningWorker);
    } else {
      // Job was still waiting for a worker; just drop it from the queue.
      const idx = this.waiting.indexOf(job);
      if (idx >= 0) this.waiting.splice(idx, 1);
    }
  }

  private spawnWorker(): void {
    const poolWorker: PoolWorker = {
      id: this.nextWorkerId++,
      ready: false,
      busy: null,
      worker: new Worker(READER_WORKER_SOURCE, {
        eval: true,
        workerData: {
          betterSqlitePath: this.betterSqlitePath,
          dbPath: this.opts.dbPath,
          busyTimeoutMs: this.opts.busyTimeoutMs,
        },
      }),
    };
    poolWorker.worker.on('message', (m: WorkerMessage) => this.onMessage(poolWorker, m));
    poolWorker.worker.on('error', (err: unknown) => this.onWorkerError(poolWorker, err));
    poolWorker.worker.on('exit', () => this.onWorkerExit(poolWorker));
    this.workers.push(poolWorker);
  }

  private onWorkerError(worker: PoolWorker, err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    const job = worker.busy;
    worker.busy = null;
    if (job) {
      this.settleJob(job, new AsyncDbError({ message: e.message, name: e.name || 'Error' }));
    }
    this.recycleWorker(worker);
  }

  private onWorkerExit(worker: PoolWorker): void {
    // A clean close-driven exit leaves nothing to do. An unexpected exit while
    // busy surfaces to the in-flight job via the error handler; guard anyway.
    const job = worker.busy;
    if (job && !job.settled) {
      worker.busy = null;
      this.settleJob(
        job,
        new AsyncDbError({ message: 'reader worker exited unexpectedly', name: 'Error' }),
      );
    }
    this.maybeFinishDrain();
  }

  /** Terminate a worker and, unless we are done draining, replace it. */
  private recycleWorker(worker: PoolWorker): void {
    this.removeWorker(worker);
    if (this.closed) return;
    if (this.closing && this.running.size === 0 && this.waiting.length === 0) {
      this.maybeFinishDrain();
      return;
    }
    this.spawnWorker();
  }

  private removeWorker(worker: PoolWorker): void {
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    void worker.worker.terminate();
  }

  private failAllWaiting(err: Error): void {
    const jobs = this.waiting.splice(0);
    for (const job of jobs) this.settleJob(job, err);
  }

  /**
   * Graceful shutdown: reject new submissions, let in-flight and already-queued
   * queries drain, then close every worker connection. Idempotent.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
      this.maybeFinishDrain();
    });
    return this.shutdownPromise;
  }

  private maybeFinishDrain(): void {
    if (!this.closing || this.closed) return;
    if (this.running.size > 0 || this.waiting.length > 0) return;
    this.closed = true;
    const workers = this.workers.splice(0);
    this.idle = [];
    let remaining = workers.length;
    if (remaining === 0) {
      this.resolveShutdown?.();
      this.resolveShutdown = null;
      return;
    }
    for (const w of workers) {
      w.worker.once('exit', () => {
        remaining--;
        if (remaining === 0) {
          this.resolveShutdown?.();
          this.resolveShutdown = null;
        }
      });
      try {
        w.worker.postMessage({ type: 'close' });
      } catch {
        void w.worker.terminate();
      }
    }
  }
}
