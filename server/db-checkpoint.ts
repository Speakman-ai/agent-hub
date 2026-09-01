/**
 * db-checkpoint.ts: WAL checkpoint cadence for every SQLite file the Hub opens.
 *
 * ## The incident this prevents
 *
 * SQLite in WAL mode appends every committed page to a `-wal` sidecar and only
 * folds those frames back into the main file at a *checkpoint*. A checkpoint runs
 * synchronously on the connection that triggers it. If *any* connection holds an
 * old snapshot (a long dashboard read, or a read routed to the `server/db-async`
 * worker pool per spec `async-boundary`), no checkpoint can advance past that
 * reader's mark, so the WAL grows unbounded. The event-loop wedge happens the
 * moment a large WAL is checkpointed *on the main thread*: with synchronous
 * `better-sqlite3` that copy runs to completion in one tick, blocking every
 * request. That is the observed 147 MB WAL / stalled event loop incident.
 *
 * ## The root-cause invariant: no checkpoint ever runs on a main-thread connection
 *
 * Every earlier round of this cadence still had *some* main-thread checkpoint
 * path (the sweep's own PASSIVE-before-size-check, the driver's
 * `wal_autocheckpoint` firing on a committing request, a synchronous fallback on
 * worker failure). Each was an instance of one defect. The fix is the single
 * invariant above, enforced three ways on the primary `agent-hub.db` and every
 * isolated hot-write file (`orgs.db`, `runner-logs.db`, `rum.db`, `logs.db`,
 * `infra.db`) via {@link applyWalCheckpointPragmas} + {@link registerCheckpointDb}:
 *
 *  1. **Main-thread autocheckpoint is DISABLED** (`wal_autocheckpoint = 0`, see
 *     {@link WAL_AUTOCHECKPOINT_PAGES}). A commit never triggers a checkpoint on
 *     the request thread, no matter how large the WAL has grown — so the
 *     reader-releases-then-a-write-arrives path can no longer wedge the loop.
 *  2. **All checkpointing happens on a worker thread.** A background sweep
 *     ({@link runDbCheckpointSweep}, every 30 s) reads each WAL's size straight
 *     *from the filesystem* ({@link getWalFileBytes}) — **without running a
 *     checkpoint** — and, only for a WAL over the threshold, dispatches a
 *     `wal_checkpoint(TRUNCATE)` to a dedicated worker ({@link CheckpointOffloader})
 *     holding its own connection. The synchronous frame-copy runs on the worker's
 *     event loop; the main thread's per-tick cost is one `fs.stat` + a
 *     `postMessage`.
 *  3. **Worker failure defers, never falls back to the main thread.** If the
 *     worker can't run the drain, the WAL is left in place (result `deferred`) for
 *     the next sweep, which re-attempts a spawn — never a giant checkpoint on the
 *     request thread.
 *  4. **A size-based growth guard + backpressure bound** ({@link trackWalGrowth})
 *     runs every sweep from the WAL's CURRENT size (re-measured after the drain).
 *     When a WAL is over the hard limit ({@link WAL_HARD_LIMIT_BYTES}, default
 *     256 MB) — a long-lived reader pins the snapshot, the worker is unavailable,
 *     or writes outrun the interval — it bounds growth on EVERY registered write
 *     surface, with no main-thread checkpoint and writes still synchronous (spec
 *     `async-boundary`):
 *       - **Cooperative shed** for the isolated hot-write flood writers
 *         (`runner_job_logs` append, the `logs`/`infra` write queues, `rum` segment
 *         ingest), which check {@link isWalUnderPressure} /
 *         {@link isWalUnderPressureLabel} and drop / 429 / 503 cleanly.
 *       - **A universal `query_only = ON` gate** on the registered handle, so a
 *         surface without a cooperative writer — the primary `agent-hub.db` and
 *         `orgs.db` — is still hard-bounded (all writes rejected until the WAL
 *         drains). Flood writers shed before they would hit this, so they degrade
 *         cleanly. `query_only` is instant and per-connection (not a checkpoint);
 *         the off-thread worker keeps draining on its own connection.
 *     Both layers RELEASE the same sweep the WAL falls back under the limit (the
 *     post-drain re-measure), so a successful drain never leaves writes shed for an
 *     extra interval. It also escalates loudly via
 *     {@link setSustainedWalGrowthHandler} once growth is sustained.
 *
 * `journal_size_limit` (64 MB) is the one remaining pragma on the main
 * connection: it only affects how far a *completed* checkpoint truncates the WAL
 * file, never triggers checkpoint work itself.
 *
 * Startup recovery obeys the same invariant: {@link recoverWalAtStartupBounded}
 * (used by the `logs.db` / `infra.db` init paths) resets a *small* dirty WAL with
 * a fast synchronous TRUNCATE at boot, but defers a *large* one (a crash-left
 * backlog) to the off-thread sweep rather than copying hundreds of MB
 * synchronously on the boot thread.
 *
 * This tunes only *when* and *where* the driver folds the WAL back; application
 * writes and transactions stay synchronous on the main thread (spec
 * `async-boundary`). The worker offloads SQLite's own housekeeping, not an app
 * read-modify-write, so the no-interleaving guarantee that spec protects is
 * untouched.
 *
 * ## Operator env (invalid values fall back to the default)
 *
 * | Variable | Default | Role |
 * | --- | --- | --- |
 * | `DB_WAL_AUTOCHECKPOINT_PAGES` | 0 (disabled) | Main-thread autocheckpoint; keep 0 |
 * | `DB_WAL_JOURNAL_SIZE_LIMIT_BYTES` | 67108864 (64 MB) | Post-checkpoint file truncate cap |
 * | `DB_CHECKPOINT_INTERVAL_MS` | 30000 | Background sweep cadence |
 * | `DB_CHECKPOINT_TRUNCATE_THRESHOLD_PAGES` | 2000 (~8 MB) | Sweep off-thread drain threshold |
 * | `DB_WAL_HARD_LIMIT_BYTES` | 268435456 (256 MB) | Growth-guard alarm ceiling |
 * | `DB_WAL_HARD_LIMIT_SUSTAINED_SWEEPS` | 2 | Over-ceiling sweeps before escalation |
 */
import { statSync } from 'fs';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { CHECKPOINT_WORKER_SOURCE } from './db-checkpoint-worker-source.js';

const require = createRequire(import.meta.url);

/** Bytes SQLite reserves per DB page; used to convert page thresholds to bytes. */
const DEFAULT_PAGE_SIZE = 4096;

function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return fallback;
  return n;
}

/**
 * Main-thread autocheckpoint threshold, in pages. **Default 0 = disabled.**
 *
 * This is the root-cause fix. SQLite's `wal_autocheckpoint` runs a *synchronous*
 * `PASSIVE` checkpoint on the **committing (main) thread** whenever a commit
 * grows the WAL past this many pages. When a reader has starved earlier
 * checkpoints, the WAL holds a large backlog; the first commit after the reader
 * releases would then copy that entire backlog back on the main thread — the
 * request-wedging checkpoint the ticket exists to eliminate. So we turn the
 * driver's main-thread autocheckpoint OFF entirely: ALL checkpointing happens on
 * the off-thread sweep worker ({@link CheckpointOffloader}). A commit never pays
 * a checkpoint cost, regardless of how large the WAL has grown.
 *
 * Left as an operator escape hatch (set >0 to re-enable the driver's behaviour),
 * but the default and recommended value is 0.
 */
export const WAL_AUTOCHECKPOINT_PAGES = envInt('DB_WAL_AUTOCHECKPOINT_PAGES', 0, 0);

/**
 * Post-checkpoint WAL file truncate cap, in bytes (64 MB). SQLite truncates the
 * `-wal` file below this after a checkpoint that resets it, so a burst can't
 * leave a permanently-huge sparse file.
 */
export const WAL_JOURNAL_SIZE_LIMIT_BYTES = envInt(
  'DB_WAL_JOURNAL_SIZE_LIMIT_BYTES',
  64 * 1024 * 1024,
);

/** Background sweep cadence, in ms (30 s). */
export const CHECKPOINT_INTERVAL_MS = envInt('DB_CHECKPOINT_INTERVAL_MS', 30_000);

/**
 * When a WAL file is larger than this many pages, the sweep drains it (off the
 * main thread when the worker is available). ~8 MB at 4 KB pages — above the
 * autocheckpoint threshold so a healthy write path (drained inline to ~4 MB)
 * never triggers a sweep action; it only fires when a reader starved the drain.
 */
export const CHECKPOINT_TRUNCATE_THRESHOLD_PAGES = envInt(
  'DB_CHECKPOINT_TRUNCATE_THRESHOLD_PAGES',
  2000,
);

/** The page threshold expressed in bytes, for comparing against the WAL file size. */
export const CHECKPOINT_TRUNCATE_THRESHOLD_BYTES =
  CHECKPOINT_TRUNCATE_THRESHOLD_PAGES * DEFAULT_PAGE_SIZE;

/**
 * Runtime WAL size ceiling (bytes, default 256 MB). This is the growth-guard
 * alarm level, NOT the normal drain threshold: the sweep already off-thread-drains
 * anything past {@link CHECKPOINT_TRUNCATE_THRESHOLD_BYTES}. A WAL only reaches
 * this ceiling when NO off-thread checkpoint can reset it — a long-lived reader
 * pinning the snapshot, a silent/dead worker, or a write rate that outruns the
 * sweep interval. When a WAL stays above it for {@link WAL_HARD_LIMIT_SUSTAINED_SWEEPS}
 * consecutive sweeps, the guard escalates loudly (see {@link setSustainedWalGrowthHandler}).
 *
 * It is intentionally a detection ceiling, not a physical cap: while a reader
 * holds an old snapshot, no checkpoint on ANY thread can reclaim the WAL, and the
 * only true caps — blocking/rejecting writes, or killing the reader — are out of
 * scope (writes stay synchronous and untouched, spec `async-boundary`). The guard
 * makes sustained growth loud and actionable instead of silent.
 */
export const WAL_HARD_LIMIT_BYTES = envInt('DB_WAL_HARD_LIMIT_BYTES', 256 * 1024 * 1024);

/** Consecutive over-ceiling sweeps before the growth guard escalates (default 2). */
export const WAL_HARD_LIMIT_SUSTAINED_SWEEPS = envInt('DB_WAL_HARD_LIMIT_SUSTAINED_SWEEPS', 2);

/** SQLite `busy_timeout` for the worker connection, so TRUNCATE waits out a writer. */
const WORKER_BUSY_TIMEOUT_MS = 5000;

/**
 * Hard ceiling on a single off-thread checkpoint. A bounded WAL checkpoints in
 * well under this; if a worker goes silent (no result, no error, no exit) the job
 * must still settle so `checkpointRegisteredDb` returns `deferred`, the sweep
 * resolves, and `sweepInFlight` clears. Generous so it never fires on a healthy
 * slow drain; on timeout the worker is treated as unhealthy and replaced.
 */
const CHECKPOINT_JOB_TIMEOUT_MS = 60_000;

export type CheckpointMode = 'PASSIVE' | 'TRUNCATE' | 'RESTART';

/** One row of `PRAGMA wal_checkpoint(<mode>)` output. */
export interface WalCheckpointRow {
  /** 1 if a reader/writer blocked the checkpoint from completing in this mode. */
  busy: number;
  /** Total frames currently in the `-wal` file. */
  log: number;
  /** Frames moved back into the main DB by this checkpoint. */
  checkpointed: number;
}

export interface CheckpointResult {
  label: string;
  /**
   * How the checkpoint ran, or why it did nothing:
   * - `skipped` — WAL under the threshold; no checkpoint run (filesystem read only).
   * - `offloaded` — drained on the worker thread.
   * - `deferred` — WAL over the threshold but the worker was unavailable; left in
   *   place for the next sweep to retry off-thread (NEVER checkpointed on the
   *   main thread — that would recreate the incident).
   * - `passive` / `truncate` — only from {@link checkpointDbOnceSync}, the
   *   synchronous diagnostic/test path, never the sweep.
   */
  mode: 'passive' | 'truncate' | 'offloaded' | 'skipped' | 'deferred';
  /** True if the checkpoint was blocked (a reader held a snapshot). */
  busy: boolean;
  /** WAL file size in bytes measured (from the filesystem) before acting. */
  walBytesBefore: number;
  /** Frames checkpointed, when known (0 for skipped / offload dispatch). */
  checkpointedPages: number;
}

/**
 * WAL file size in bytes, read straight from the filesystem. Crucially this does
 * NOT run a checkpoint — it is how the sweep decides whether to act *before*
 * doing any (potentially large, synchronous) checkpoint work. Returns 0 when the
 * `-wal` file is absent (DB not in WAL mode yet, or already fully checkpointed).
 */
export function getWalFileBytes(db: Database.Database): number {
  try {
    return statSync(`${db.name}-wal`).size;
  } catch {
    return 0;
  }
}

/**
 * Apply the per-file WAL cadence pragmas. Callers own `journal_mode`,
 * `synchronous`, `foreign_keys`, and `busy_timeout`; this sets only the two
 * checkpoint-cadence levers so it composes with every DB's existing init.
 * Idempotent — safe to call on re-init of a cached handle.
 *
 * By default this DISABLES the driver's main-thread autocheckpoint
 * ({@link WAL_AUTOCHECKPOINT_PAGES} = 0): no commit ever runs a synchronous
 * checkpoint. `journal_size_limit` still lets the off-thread checkpoint truncate
 * the WAL file back down after it resets it.
 */
export function applyWalCheckpointPragmas(db: Database.Database): void {
  db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
  db.pragma(`journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
}

/**
 * Bounded startup WAL recovery, upholding the same no-giant-synchronous-checkpoint
 * invariant as the sweep. A hot crash can leave a large `-wal` on disk; the
 * classic recovery of `wal_checkpoint(TRUNCATE)` at init would then copy the
 * entire backlog synchronously on the main thread during boot — the same wedge
 * the module exists to prevent, just moved to startup.
 *
 * So: measure the WAL from the filesystem first. If it is under the threshold
 * (the normal case — a clean or lightly-dirty WAL), reset it with a fast
 * synchronous TRUNCATE. If it is large, DO NOT checkpoint it inline — the WAL is
 * still fully valid and readable (SQLite recovers a dirty WAL automatically on
 * open), so leave it for the off-thread sweep, which drains it shortly after
 * {@link startDbCheckpointScheduler} runs. The caller must already have
 * {@link registerCheckpointDb}'d the handle so that deferred drain is scheduled.
 *
 * Returns whether the synchronous reset ran and the measured size. Never throws
 * for the "reader holds the WAL" case (there are no readers at init anyway).
 */
export function recoverWalAtStartupBounded(
  db: Database.Database,
  label = db.name,
): { checkpointed: boolean; walBytes: number } {
  const walBytes = getWalFileBytes(db);
  if (walBytes > CHECKPOINT_TRUNCATE_THRESHOLD_BYTES) {
    console.warn(
      `[db-checkpoint] ${label} startup WAL is ~${Math.round(
        walBytes / (1024 * 1024),
      )} MB; skipping the synchronous recovery checkpoint and deferring it to the off-thread sweep`,
    );
    return { checkpointed: false, walBytes };
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { checkpointed: true, walBytes };
}

/**
 * Synchronous, main-thread checkpoint. **Not used by the sweep** — the sweep only
 * ever checkpoints off-thread. This is a diagnostic/test tool and the synchronous
 * baseline the off-thread tests measure against; it must NEVER be called on a hot
 * request path, because on a large WAL it blocks the event loop for the whole
 * copy (the incident). Measures the WAL size first, then runs one checkpoint:
 * PASSIVE when small, TRUNCATE when over the threshold. A closed handle is a
 * no-op; it never throws for the expected "a reader holds the WAL" case.
 */
export function checkpointDbOnceSync(
  db: Database.Database,
  label = db.name,
  thresholdBytes = CHECKPOINT_TRUNCATE_THRESHOLD_BYTES,
): CheckpointResult | null {
  if (!db.open) return null;
  const walBytesBefore = getWalFileBytes(db);
  const mode: CheckpointMode = walBytesBefore > thresholdBytes ? 'TRUNCATE' : 'PASSIVE';
  const rows = db.pragma(`wal_checkpoint(${mode})`) as WalCheckpointRow[];
  const row = rows?.[0];
  return {
    label,
    mode: mode === 'TRUNCATE' ? 'truncate' : 'passive',
    busy: Number(row?.busy ?? 0) === 1,
    walBytesBefore,
    checkpointedPages: Number(row?.checkpointed ?? 0),
  };
}

// ── Off-main-thread checkpoint worker ──────────────────────────────────────

type WorkerInboundMsg =
  | { type: 'ready' }
  | { type: 'init-error'; error?: { message: string; code?: string; name: string } }
  | {
      type: 'result';
      id: number;
      ok: boolean;
      row?: WalCheckpointRow;
      error?: { message: string; code?: string; name: string };
    };

export type CheckpointWorkerFactory = () => Worker;

/** Default factory: resolve the native module path once and spawn the eval worker. */
function defaultCheckpointWorkerFactory(): Worker {
  const betterSqlitePath = require.resolve('better-sqlite3');
  return new Worker(CHECKPOINT_WORKER_SOURCE, {
    eval: true,
    workerData: { betterSqlitePath, busyTimeoutMs: WORKER_BUSY_TIMEOUT_MS },
  });
}

/**
 * One spawn attempt of the checkpoint worker. The worker handle is captured at
 * spawn time (not at `ready`), so `close()` can terminate a still-initializing
 * worker. `readyPromise` resolves with the live worker on `ready` and rejects on
 * any terminal signal; `settle*` are idempotent so the promise settles exactly
 * once. `down` guards the terminal cleanup so error+exit don't double-fire.
 */
interface WorkerEpoch {
  readonly id: number;
  readonly worker: Worker;
  ready: boolean;
  down: boolean;
  readyPromise: Promise<Worker>;
  settleResolve: (w: Worker) => void;
  settleReject: (err: Error) => void;
}

/**
 * A single worker thread that runs `wal_checkpoint(...)` on its own connection so
 * the synchronous frame-copy never blocks the main event loop.
 *
 * Lifecycle is a single **epoch** state machine, which is the root-cause fix for
 * the recurring lifecycle bugs (pre-ready error not settling, close-during-init
 * leaking/resurrecting a worker, late `ready` restoring closed state). At most one
 * epoch is live at a time (`this.current`); it is created on spawn and cleared the
 * instant it dies. Every event carries its epoch and is ignored when
 * {@link isStale} (superseded or after close), so a message from a dead/closed
 * worker can never mutate state. Every terminal transition — spawn failure, a
 * pre-ready `error`/`exit`, `init-error`, a post-ready crash, a per-job timeout,
 * or `close()` — routes through {@link failEpoch}, which settles the init promise,
 * fails in-flight jobs, terminates the worker, and (unless closed) frees
 * `this.current` so the next sweep re-spawns. A spawn/crash is never latched.
 *
 * The offloader never falls back to a synchronous main-thread checkpoint: on any
 * failure the caller ({@link checkpointRegisteredDb}) leaves the WAL for the next
 * off-thread retry.
 */
export class CheckpointOffloader implements CheckpointDispatcher {
  private nextId = 1;
  private epochSeq = 0;
  private current: WorkerEpoch | null = null;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (row: WalCheckpointRow) => void; reject: (err: Error) => void }
  >();

  /** `makeWorker` is injectable so tests can drive error/exit-before-ready paths. */
  constructor(
    private readonly makeWorker: CheckpointWorkerFactory = defaultCheckpointWorkerFactory,
  ) {}

  /** True when `epoch` is no longer the authority (superseded or offloader closed). */
  private isStale(epoch: WorkerEpoch): boolean {
    return this.closed || this.current !== epoch;
  }

  /** Reject and clear every in-flight checkpoint job. */
  private failPending(err: Error): void {
    for (const [, job] of this.pending) job.reject(err);
    this.pending.clear();
  }

  /**
   * The single terminal path for an epoch. Idempotent per epoch (`down` guard):
   * settles the init promise (no-op once resolved), terminates the worker (covers
   * an initializing one), and — only if this epoch is still current — fails its
   * jobs and frees `this.current` so a respawn can happen.
   */
  private failEpoch(epoch: WorkerEpoch, err: Error): void {
    if (epoch.down) return;
    epoch.down = true;
    epoch.settleReject(err);
    try {
      void epoch.worker.terminate();
    } catch {
      /* already gone */
    }
    if (this.current === epoch) {
      this.current = null;
      this.failPending(err);
    }
  }

  private spawn(): Promise<Worker> {
    const partial: Partial<WorkerEpoch> = { id: ++this.epochSeq, ready: false, down: false };
    partial.readyPromise = new Promise<Worker>((resolve, reject) => {
      let settled = false;
      partial.settleResolve = (w: Worker) => {
        if (!settled) {
          settled = true;
          resolve(w);
        }
      };
      partial.settleReject = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
    });

    let worker: Worker;
    try {
      worker = this.makeWorker();
    } catch (err) {
      // require.resolve / Worker spawn failure: settle the init promise rejected
      // and leave `this.current` null so the next sweep retries.
      partial.settleReject!(err as Error);
      return partial.readyPromise!;
    }
    const epoch = { ...partial, worker } as WorkerEpoch;
    this.current = epoch;

    worker.on('message', (msg: WorkerInboundMsg) => {
      if (this.isStale(epoch)) return; // a superseded/closed worker cannot mutate state
      if (msg.type === 'ready') {
        epoch.ready = true;
        epoch.settleResolve(worker);
        return;
      }
      if (msg.type === 'init-error') {
        this.failEpoch(epoch, new Error('checkpoint worker init failed'));
        return;
      }
      if (msg.type === 'result' && typeof msg.id === 'number') {
        const job = this.pending.get(msg.id);
        if (!job) return;
        this.pending.delete(msg.id);
        if (msg.ok && msg.row) job.resolve(msg.row);
        else job.reject(new Error(msg.error?.message ?? 'checkpoint failed'));
      }
    });
    worker.on('error', (err: Error) => this.failEpoch(epoch, err));
    worker.on('exit', (code: number) =>
      this.failEpoch(epoch, new Error(`checkpoint worker exited (code ${code})`)),
    );
    worker.unref?.(); // don't keep the process alive for the checkpoint worker alone
    return epoch.readyPromise;
  }

  private ensureWorker(): Promise<Worker> {
    if (this.closed) return Promise.reject(new Error('checkpoint offloader closed'));
    if (this.current) return this.current.readyPromise; // resolved (ready) or in-flight
    return this.spawn();
  }

  async checkpoint(dbPath: string, mode: CheckpointMode): Promise<WalCheckpointRow> {
    const worker = await this.ensureWorker();
    // Re-validate after the await: the epoch may have died (or the offloader been
    // closed) between `ready` and now. If so, reject so the caller defers rather
    // than posting to a dead worker and hanging.
    const epoch = this.current;
    if (this.closed || !epoch || epoch.worker !== worker || !epoch.ready) {
      throw new Error('checkpoint worker unavailable');
    }
    const id = this.nextId++;
    return new Promise<WalCheckpointRow>((resolve, reject) => {
      // Timeout guarantees the job settles even if the worker goes silent, so the
      // sweep always resolves and `sweepInFlight` always clears.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          const err = new Error('checkpoint timed out');
          reject(err);
          this.failEpoch(epoch, err); // unhealthy worker → replaced next sweep
        }
      }, CHECKPOINT_JOB_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (row) => {
          clearTimeout(timer);
          resolve(row);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      worker.postMessage({ type: 'checkpoint', id, dbPath, mode });
    });
  }

  /** Tell the worker to close its cached connection for a path (on unregister). */
  closeDb(dbPath: string): void {
    const epoch = this.current;
    if (epoch && epoch.ready && !this.closed)
      epoch.worker.postMessage({ type: 'close-db', dbPath });
  }

  async close(): Promise<void> {
    this.closed = true;
    const epoch = this.current;
    this.current = null;
    this.failPending(new Error('checkpoint offloader closing'));
    if (epoch) {
      // Settle a still-pending init and terminate the worker even if it never sent
      // `ready` (the epoch captured the handle at spawn). A late `ready` afterwards
      // is dropped by isStale, so the closed offloader can't be resurrected.
      epoch.settleReject(new Error('checkpoint offloader closing'));
      try {
        epoch.worker.postMessage({ type: 'close' });
      } catch {
        /* worker may already be gone */
      }
      try {
        await epoch.worker.terminate();
      } catch {
        /* already gone */
      }
    }
  }
}

/** The off-thread checkpoint surface the sweep depends on (real or test double). */
export interface CheckpointDispatcher {
  checkpoint(dbPath: string, mode: CheckpointMode): Promise<WalCheckpointRow>;
  closeDb(dbPath: string): void;
  close(): Promise<void>;
}

let offloader: CheckpointOffloader | null = null;
let dispatcherOverride: CheckpointDispatcher | null = null;

function getOffloader(): CheckpointDispatcher {
  if (dispatcherOverride) return dispatcherOverride;
  if (!offloader) offloader = new CheckpointOffloader();
  return offloader;
}

/**
 * Test-only: inject a {@link CheckpointDispatcher} (e.g. one whose `checkpoint`
 * always rejects, to exercise the worker-unavailable → `deferred` path) or `null`
 * to restore the real worker. Never called in production.
 */
export function __setCheckpointDispatcherForTests(d: CheckpointDispatcher | null): void {
  dispatcherOverride = d;
}

// ── Unbounded-growth guard ─────────────────────────────────────────────────

export interface SustainedWalGrowthInfo {
  label: string;
  walBytes: number;
  /** How many consecutive sweeps this WAL has stayed above the hard limit. */
  consecutiveSweeps: number;
  hardLimitBytes: number;
}

export type SustainedWalGrowthHandler = (info: SustainedWalGrowthInfo) => void;

const defaultGrowthHandler: SustainedWalGrowthHandler = (i) => {
  console.error(
    `[db-checkpoint] SUSTAINED WAL GROWTH: ${i.label} WAL ~${Math.round(
      i.walBytes / (1024 * 1024),
    )} MB has stayed above the ${Math.round(
      i.hardLimitBytes / (1024 * 1024),
    )} MB hard limit for ${i.consecutiveSweeps} sweeps. The off-thread checkpoint ` +
      `cannot reset it (a long-lived reader is pinning the WAL, or the checkpoint ` +
      `worker is unavailable). Writes continue and the WAL will keep growing until ` +
      `it can be checkpointed — investigate the blocking reader/worker.`,
  );
};

let growthHandler: SustainedWalGrowthHandler = defaultGrowthHandler;

/**
 * Wire the operational escalation for sustained WAL growth (e.g. a metric or an
 * in-app alert). Pass `null` to restore the default (a loud `console.error`).
 */
export function setSustainedWalGrowthHandler(fn: SustainedWalGrowthHandler | null): void {
  growthHandler = fn ?? defaultGrowthHandler;
}

let walHardLimitBytes = WAL_HARD_LIMIT_BYTES;
/** Test-only: override the hard limit so a test needn't write hundreds of MB. */
export function __setWalHardLimitForTests(bytes: number | null): void {
  walHardLimitBytes = bytes ?? WAL_HARD_LIMIT_BYTES;
}

/** Per-label count of consecutive sweeps the WAL has been above the hard limit. */
const growthSweeps = new Map<string, number>();

/**
 * The runtime bound. Since no checkpoint on any thread can reclaim a reader-pinned
 * WAL, the only way to stop it growing is to stop appending to it. Two layers,
 * both engaged the moment a WAL crosses the hard limit and released the moment it
 * falls back under — with NO main-thread checkpoint and writes still synchronous
 * (spec `async-boundary`):
 *
 * - **Cooperative shed** ({@link pressuredLabels}): the isolated hot-write flood
 *   writers check {@link isWalUnderPressure} / {@link isWalUnderPressureLabel} and
 *   shed cleanly (429 / drop / 503) — the graceful path for the high-volume DBs.
 * - **Universal hard gate** ({@link queryOnlyLabels}): `PRAGMA query_only = ON` on
 *   the registered handle rejects EVERY write to that DB, so a surface without a
 *   cooperative writer — the primary `agent-hub.db` and `orgs.db` — is still
 *   bounded (a pinned reader can no longer grow its WAL). `query_only` is instant
 *   and per-connection; it is not a checkpoint, and the off-thread worker (its own
 *   connection) keeps draining, so the WAL shrinks as soon as the reader releases.
 *
 * Flood writers shed before they would hit `query_only`, so they degrade cleanly;
 * everything else on any registered DB is hard-rejected until the WAL drains.
 */
const pressuredLabels = new Set<string>();

/** Labels whose handle currently has `query_only = ON` (to toggle only on change). */
const queryOnlyLabels = new Set<string>();

/** True when the flood writers for this label should shed to bound WAL growth. */
export function isWalUnderPressureLabel(label: string): boolean {
  return pressuredLabels.has(label);
}

/** Handle-based variant: resolves the registered label for `db` and checks it. */
export function isWalUnderPressure(db: Database.Database): boolean {
  const entry = registry.get(db.name);
  return entry ? pressuredLabels.has(entry.label) : false;
}

/** Test-only: force a label's cooperative-shed state without a real growth scenario. */
export function __setWalPressureForTests(label: string, on: boolean): void {
  if (on) pressuredLabels.add(label);
  else pressuredLabels.delete(label);
}

/** Thrown by write paths that reject a write because the WAL is under pressure. */
export class WalPressureError extends Error {
  readonly code = 'WAL_PRESSURE';
  constructor(label: string) {
    super(`write rejected: ${label} WAL is over its hard limit and cannot be checkpointed`);
    this.name = 'WalPressureError';
  }
}

/** Engage both bound layers for a registered DB (idempotent). */
function engageWalPressure(entry: RegisteredDb): void {
  pressuredLabels.add(entry.label);
  if (!queryOnlyLabels.has(entry.label)) {
    try {
      entry.db.pragma('query_only = ON');
      queryOnlyLabels.add(entry.label);
    } catch (err) {
      console.warn(
        `[db-checkpoint] failed to set query_only on ${entry.label}:`,
        (err as Error).message,
      );
    }
  }
}

/** Release both bound layers for a registered DB (idempotent; safe if handle closed). */
function releaseWalPressure(entry: RegisteredDb): void {
  pressuredLabels.delete(entry.label);
  if (queryOnlyLabels.has(entry.label)) {
    queryOnlyLabels.delete(entry.label);
    try {
      entry.db.pragma('query_only = OFF');
    } catch {
      /* handle may be closing/closed */
    }
  }
}

/**
 * Size-based growth guard, independent of the drain mechanism. Called with the
 * WAL's CURRENT size (measured after any drain attempt, so a successful drain
 * releases pressure the same sweep). Below the hard limit it releases both bound
 * layers and clears the counter; at or above it, it engages both layers (so the
 * WAL cannot keep growing) and counts consecutive over-limit sweeps, escalating
 * the operational alert once sustained. Runs no checkpoint.
 */
function trackWalGrowth(entry: RegisteredDb, walBytes: number): void {
  if (walBytes < walHardLimitBytes) {
    growthSweeps.delete(entry.label);
    releaseWalPressure(entry);
    return;
  }
  engageWalPressure(entry);
  const n = (growthSweeps.get(entry.label) ?? 0) + 1;
  growthSweeps.set(entry.label, n);
  if (n >= WAL_HARD_LIMIT_SUSTAINED_SWEEPS) {
    try {
      growthHandler({
        label: entry.label,
        walBytes,
        consecutiveSweeps: n,
        hardLimitBytes: walHardLimitBytes,
      });
    } catch (err) {
      console.warn('[db-checkpoint] WAL growth handler threw:', (err as Error).message);
    }
  }
}

// ── Registry + sweep ───────────────────────────────────────────────────────

interface RegisteredDb {
  db: Database.Database;
  label: string;
}

/** Keyed by the DB file path so re-init of a cached handle replaces cleanly. */
const registry = new Map<string, RegisteredDb>();

/**
 * Register a handle for the background sweep. Keyed by file path, so opening the
 * same file again (per-org handles rotate through their own registries) just
 * updates the entry rather than double-sweeping it. Also applies the cadence
 * pragmas so a caller can register-and-forget.
 */
export function registerCheckpointDb(db: Database.Database, label = db.name): void {
  applyWalCheckpointPragmas(db);
  registry.set(db.name, { db, label });
}

/** Drop a handle from the sweep (call before closing it). No-op if absent. */
export function unregisterCheckpointDb(db: Database.Database): void {
  const path = db.name;
  const entry = registry.get(path);
  // Clear any query_only gate so a closing/rotating handle is never left
  // read-only, and forget the pressure/growth state for this label.
  if (entry) releaseWalPressure(entry);
  registry.delete(path);
  // Release the worker's cached connection for this file so it doesn't pin a
  // deleted/rotated DB. Safe even if the worker never opened it.
  if (offloader) offloader.closeDb(path);
}

/** Test/reset hook: forget every registered handle and growth/pressure state. */
export function clearCheckpointRegistry(): void {
  registry.clear();
  growthSweeps.clear();
  pressuredLabels.clear();
  queryOnlyLabels.clear();
}

/** Number of handles currently registered for the sweep (test/observability). */
export function registeredCheckpointDbCount(): number {
  return registry.size;
}

/**
 * Checkpoint one registered handle: measure the WAL from the filesystem FIRST,
 * skip if it is under the threshold, otherwise drain it OFF the main thread via
 * the worker. If the worker can't run the drain (spawn/init/crash), the WAL is
 * left in place and returned as `deferred` for the next sweep to retry — it is
 * NEVER checkpointed on the main thread, because on a large WAL that is exactly
 * the request-wedging copy this module exists to prevent. Exposed for tests.
 */
export async function checkpointRegisteredDb(entry: RegisteredDb): Promise<CheckpointResult> {
  const { db, label } = entry;
  const walBytesBefore = getWalFileBytes(db);
  if (walBytesBefore <= CHECKPOINT_TRUNCATE_THRESHOLD_BYTES) {
    // Steady state / under threshold: nothing worth a checkpoint — and we did NOT
    // run one to find that out (filesystem read only). Below the hard limit, so
    // this also releases any pressure/query_only gate for the label.
    trackWalGrowth(entry, walBytesBefore);
    return { label, mode: 'skipped', busy: false, walBytesBefore, checkpointedPages: 0 };
  }
  // Large WAL — drain it strictly off the request thread.
  let result: CheckpointResult;
  try {
    const row = await getOffloader().checkpoint(db.name, 'TRUNCATE');
    result = {
      label,
      mode: 'offloaded',
      busy: Number(row.busy) === 1,
      walBytesBefore,
      checkpointedPages: Number(row.checkpointed),
    };
  } catch (err) {
    // Worker unavailable: DO NOT checkpoint on the main thread. Leave the backlog
    // for the next sweep, which re-attempts a worker spawn.
    console.warn(
      `[db-checkpoint] offload unavailable for ${label}; deferring drain to next sweep (WAL ~${Math.round(
        walBytesBefore / (1024 * 1024),
      )} MB):`,
      (err as Error).message,
    );
    result = { label, mode: 'deferred', busy: false, walBytesBefore, checkpointedPages: 0 };
  }
  // Re-measure AFTER the drain and drive the growth/pressure state from the
  // CURRENT size — so a successful drain RELEASES pressure and the query_only gate
  // in this same sweep (no extra interval of shed writes / 503s), while a WAL that
  // is still over the limit (reader-pinned / worker down) engages the bound and,
  // when sustained, escalates. This is the only place growth state is updated for
  // over-threshold WALs, so it always reflects reality post-drain.
  trackWalGrowth(entry, getWalFileBytes(db));
  return result;
}

/**
 * Checkpoint every registered handle once. Each handle is isolated in a
 * try/catch so one bad file can't abort the sweep; closed handles are dropped.
 * Async because large drains are offloaded to the worker thread.
 */
export async function runDbCheckpointSweep(): Promise<CheckpointResult[]> {
  const results: CheckpointResult[] = [];
  for (const [key, entry] of Array.from(registry)) {
    if (!entry.db.open) {
      registry.delete(key);
      continue;
    }
    try {
      results.push(await checkpointRegisteredDb(entry));
    } catch (err) {
      console.warn(`[db-checkpoint] sweep failed for ${entry.label}:`, (err as Error).message);
    }
  }
  return results;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/**
 * Start the periodic sweep. Idempotent — a second call is a no-op so a re-import
 * or re-init can't stack timers. The timer is `unref`'d so it never keeps the
 * process alive on its own. Overlapping ticks are skipped (a slow offload must
 * not pile up).
 */
export function startDbCheckpointScheduler(intervalMs = CHECKPOINT_INTERVAL_MS): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    void runDbCheckpointSweep()
      .catch((err) => console.warn('[db-checkpoint] sweep tick failed:', (err as Error).message))
      .finally(() => {
        sweepInFlight = false;
      });
  }, intervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/** Stop the periodic sweep and terminate the offload worker (test cleanup / shutdown). */
export async function stopDbCheckpointScheduler(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (offloader) {
    const o = offloader;
    offloader = null;
    await o.close();
  }
}

/** Approximate WAL size in bytes for a page count, for docs/tests. */
export function walBytesForPages(pages: number, pageSize = DEFAULT_PAGE_SIZE): number {
  return pages * pageSize;
}
