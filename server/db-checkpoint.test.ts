import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {
  __setCheckpointDispatcherForTests,
  __setWalHardLimitForTests,
  __setWalPressureForTests,
  applyWalCheckpointPragmas,
  CheckpointOffloader,
  isWalUnderPressureLabel,
  setSustainedWalGrowthHandler,
  type SustainedWalGrowthInfo,
  checkpointDbOnceSync,
  checkpointRegisteredDb,
  clearCheckpointRegistry,
  CHECKPOINT_TRUNCATE_THRESHOLD_BYTES,
  getWalFileBytes,
  recoverWalAtStartupBounded,
  registerCheckpointDb,
  registeredCheckpointDbCount,
  runDbCheckpointSweep,
  startDbCheckpointScheduler,
  stopDbCheckpointScheduler,
  unregisterCheckpointDb,
  WAL_AUTOCHECKPOINT_PAGES,
  WAL_JOURNAL_SIZE_LIMIT_BYTES,
} from './db-checkpoint.js';

function walBytes(dbPath: string): number {
  const wal = `${dbPath}-wal`;
  try {
    return existsSync(wal) ? statSync(wal).size : 0;
  } catch {
    return 0;
  }
}

/** Open a fresh WAL DB in `dir` with a simple table and (optionally) the cadence pragmas. */
function openDb(dir: string, name: string, applyCadence = true): Database.Database {
  const dbPath = path.join(dir, name);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 0');
  // applyCadence=true (default) applies the production pragmas, which now also
  // KEEP autocheckpoint disabled (wal_autocheckpoint = 0) — main-thread
  // autocheckpoint is the incident path. So the WAL accumulates until an explicit
  // (test) or off-thread (sweep) checkpoint drains it.
  if (applyCadence) applyWalCheckpointPragmas(db);
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)');
  return db;
}

/** Commit `n` rows of ~1 KB each, one transaction per row so each lands as WAL frames. */
function seedWriteBurst(db: Database.Database, n: number): void {
  const ins = db.prepare('INSERT INTO t (blob) VALUES (?)');
  const payload = 'x'.repeat(1024);
  for (let i = 0; i < n; i++) ins.run(payload);
}

describe('db-checkpoint constants', () => {
  it('disables main-thread autocheckpoint and keeps the WAL far below the incident size', () => {
    // 0 = main-thread autocheckpoint OFF (the root-cause fix): no commit ever
    // runs a synchronous checkpoint on the request thread.
    expect(WAL_AUTOCHECKPOINT_PAGES).toBe(0);
    // 64 MB backstop — a fraction of the 147 MB incident WAL.
    expect(WAL_JOURNAL_SIZE_LIMIT_BYTES).toBe(64 * 1024 * 1024);
    // ~8 MB off-thread drain threshold (2000 pages * 4 KB).
    expect(CHECKPOINT_TRUNCATE_THRESHOLD_BYTES).toBe(2000 * 4096);
  });
});

describe('applyWalCheckpointPragmas', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-pragma-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('disables autocheckpoint and sets journal_size_limit on the handle', () => {
    const db = openDb(dir, 'a.db', false);
    db.pragma('wal_autocheckpoint = 1000'); // turn it on, then prove apply disables it
    applyWalCheckpointPragmas(db);
    expect(Number(db.pragma('wal_autocheckpoint', { simple: true }))).toBe(
      WAL_AUTOCHECKPOINT_PAGES,
    );
    expect(WAL_AUTOCHECKPOINT_PAGES).toBe(0);
    expect(Number(db.pragma('journal_size_limit', { simple: true }))).toBe(
      WAL_JOURNAL_SIZE_LIMIT_BYTES,
    );
    db.close();
  });
});

describe('getWalFileBytes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-size-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports WAL size WITHOUT triggering a checkpoint', () => {
    const db = openDb(dir, 'a.db');
    const dbPath = path.join(dir, 'a.db');
    db.pragma('wal_autocheckpoint = 0'); // let the burst accumulate in the WAL
    seedWriteBurst(db, 4000); // ~27 MB WAL
    const before = walBytes(dbPath);
    expect(before).toBeGreaterThan(8 * 1024 * 1024);

    // The measurement itself must not checkpoint (that is the whole point of
    // measuring from the filesystem — the size check can't do the expensive work
    // it is meant to gate). Call it repeatedly and confirm the WAL is untouched.
    const measured = getWalFileBytes(db);
    expect(measured).toBe(before);
    getWalFileBytes(db);
    getWalFileBytes(db);
    expect(walBytes(dbPath)).toBe(before); // no shrink → no checkpoint ran
    db.close();
  });

  it('returns 0 after the WAL has been checkpointed to empty', () => {
    const db = openDb(dir, 'empty.db');
    seedWriteBurst(db, 3);
    db.pragma('wal_checkpoint(TRUNCATE)'); // resets the -wal file to 0 bytes
    expect(getWalFileBytes(db)).toBe(0);
    db.close();
  });
});

describe('checkpointDbOnceSync', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-sync-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stays PASSIVE when the WAL is under the threshold', () => {
    const db = openDb(dir, 'a.db');
    seedWriteBurst(db, 5); // a few KB
    const r = checkpointDbOnceSync(db, 'a.db');
    expect(r).not.toBeNull();
    expect(r!.mode).toBe('passive');
    db.close();
  });

  it('escalates to TRUNCATE and reclaims the WAL when it exceeds the threshold', () => {
    const db = openDb(dir, 'a.db');
    const dbPath = path.join(dir, 'a.db');
    db.pragma('wal_autocheckpoint = 0'); // let the burst accumulate in the WAL
    seedWriteBurst(db, 4000); // ~27 MB WAL with autocheckpoint off
    expect(walBytes(dbPath)).toBeGreaterThan(CHECKPOINT_TRUNCATE_THRESHOLD_BYTES);

    const r = checkpointDbOnceSync(db, 'a.db');
    expect(r!.mode).toBe('truncate');
    expect(walBytes(dbPath)).toBeLessThan(64 * 1024); // reset
    db.close();
  });

  it('returns null for a closed handle instead of throwing', () => {
    const db = openDb(dir, 'a.db');
    db.close();
    expect(checkpointDbOnceSync(db)).toBeNull();
  });
});

describe('recoverWalAtStartupBounded', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-recover-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resets a small dirty WAL synchronously at startup', () => {
    const db = openDb(dir, 'a.db');
    const dbPath = path.join(dir, 'a.db');
    seedWriteBurst(db, 5); // small WAL, under the threshold
    const res = recoverWalAtStartupBounded(db, 'a.db');
    expect(res.checkpointed).toBe(true);
    expect(walBytes(dbPath)).toBeLessThan(64 * 1024); // TRUNCATE reset it
    db.close();
  });

  it('does NOT synchronously checkpoint a large startup WAL — it defers to the sweep', () => {
    // A crash could leave a giant WAL; recovery must not copy it synchronously on
    // the main (boot) thread. It is left intact for the off-thread sweep.
    const db = openDb(dir, 'a.db');
    const dbPath = path.join(dir, 'a.db');
    db.pragma('wal_autocheckpoint = 0');
    seedWriteBurst(db, 4000); // ~27 MB WAL, over the ~8 MB threshold
    const big = walBytes(dbPath);
    expect(big).toBeGreaterThan(CHECKPOINT_TRUNCATE_THRESHOLD_BYTES);

    const res = recoverWalAtStartupBounded(db, 'a.db');
    expect(res.checkpointed).toBe(false);
    expect(walBytes(dbPath)).toBe(big); // untouched — no synchronous checkpoint
    db.close();
  });
});

describe('checkpoint registry + sweep', () => {
  let dir: string;
  beforeEach(() => {
    clearCheckpointRegistry();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-sweep-'));
  });
  afterEach(async () => {
    await stopDbCheckpointScheduler();
    clearCheckpointRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers by file path and de-dupes re-registration of the same file', () => {
    const db = openDb(dir, 'a.db');
    registerCheckpointDb(db, 'a.db');
    registerCheckpointDb(db, 'a.db'); // same path — must not double-count
    expect(registeredCheckpointDbCount()).toBe(1);
    unregisterCheckpointDb(db);
    expect(registeredCheckpointDbCount()).toBe(0);
    db.close();
  });

  it('does NOT checkpoint a small WAL — it is skipped after a filesystem-only size read', async () => {
    // This is the [8/10] fix: under-threshold WALs must not be checkpointed at
    // all (no PASSIVE runs before the size is known). Prove the WAL is untouched.
    const db = openDb(dir, 'a.db');
    const dbPath = path.join(dir, 'a.db');
    registerCheckpointDb(db, 'a.db');
    db.pragma('wal_autocheckpoint = 0'); // keep the small burst in the WAL
    seedWriteBurst(db, 20); // ~KB, well under the ~8 MB threshold
    const before = walBytes(dbPath);
    expect(before).toBeGreaterThan(0);

    const [result] = await runDbCheckpointSweep();
    expect(result.mode).toBe('skipped');
    expect(walBytes(dbPath)).toBe(before); // no checkpoint ran
    db.close();
  });

  it('sweeps every registered handle and drops closed ones', async () => {
    const a = openDb(dir, 'a.db');
    const b = openDb(dir, 'b.db');
    registerCheckpointDb(a, 'a.db');
    registerCheckpointDb(b, 'b.db');
    seedWriteBurst(a, 10);
    seedWriteBurst(b, 10);

    const results = await runDbCheckpointSweep();
    expect(results.map((r) => r.label).sort()).toEqual(['a.db', 'b.db']);

    b.close();
    const after = await runDbCheckpointSweep();
    expect(after.map((r) => r.label)).toEqual(['a.db']);
    expect(registeredCheckpointDbCount()).toBe(1);
    a.close();
  });

  it('keeps the WAL bounded across sustained bursts interleaved with the sweep', async () => {
    const db = openDb(dir, 'hot.db');
    const dbPath = path.join(dir, 'hot.db');
    db.pragma('wal_autocheckpoint = 0'); // isolate the sweep as the only checkpointer
    registerCheckpointDb(db, 'hot.db');
    db.pragma('wal_autocheckpoint = 0'); // register re-applied the pragma; disable again

    let maxWal = 0;
    for (let round = 0; round < 20; round++) {
      seedWriteBurst(db, 500); // ~2 MB of frames per round
      maxWal = Math.max(maxWal, walBytes(dbPath));
      await runDbCheckpointSweep(); // drains whenever the WAL crosses ~8 MB
    }

    // Without any cadence 10k rows hold ~69 MB (see the control test). The sweep
    // keeps the peak to a small multiple of the ~8 MB threshold, never near 147 MB.
    expect(maxWal).toBeLessThan(16 * 1024 * 1024);
    db.close();
  });

  it('leaves the WAL unbounded WITHOUT a cadence — proving the guard is load-bearing', () => {
    const db = openDb(dir, 'nocadence.db', false); // autocheckpoint stays 0, no sweep
    const dbPath = path.join(dir, 'nocadence.db');
    for (let round = 0; round < 20; round++) seedWriteBurst(db, 500); // 10k rows
    // Empirically ~69 MB — it blew well past the 8 MB the cadence holds it under.
    expect(walBytes(dbPath)).toBeGreaterThan(16 * 1024 * 1024);
    db.close();
  });
});

describe('off-main-thread checkpoint offload', () => {
  let dir: string;
  beforeEach(() => {
    clearCheckpointRegistry();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-offload-'));
  });
  afterEach(async () => {
    __setCheckpointDispatcherForTests(null); // never leak a test double
    await stopDbCheckpointScheduler(); // terminates the worker
    clearCheckpointRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drains a large WAL off the main thread — main-thread synchronous cost stays far below a sync checkpoint', async () => {
    // Two identical large WALs. One is drained via the worker (offload), the
    // other by a synchronous main-thread checkpoint, and we compare how long
    // each blocks the calling (main) thread. This is the measured guarantee
    // that the ticket asks for: no individual synchronous main-thread
    // checkpoint processes a giant WAL.
    const rows = 10000; // ~69 MB WAL with autocheckpoint off

    const off = openDb(dir, 'offload.db');
    const offPath = path.join(dir, 'offload.db');
    off.pragma('wal_autocheckpoint = 0');
    registerCheckpointDb(off, 'offload.db');
    off.pragma('wal_autocheckpoint = 0');

    // Warm the worker so spawn cost isn't charged to the measured window.
    seedWriteBurst(off, 3000);
    await runDbCheckpointSweep();
    expect(walBytes(offPath)).toBeLessThan(64 * 1024);

    // Now build the giant WAL and measure the MAIN-thread blocking time of the
    // offloaded drain (the synchronous portion before the await hands off).
    seedWriteBurst(off, rows);
    expect(walBytes(offPath)).toBeGreaterThan(32 * 1024 * 1024);
    const entry = { db: off, label: 'offload.db' };
    const t0 = performance.now();
    const promise = checkpointRegisteredDb(entry);
    const offloadMainThreadMs = performance.now() - t0;
    const res = await promise;
    expect(res.mode).toBe('offloaded');
    expect(walBytes(offPath)).toBeLessThan(64 * 1024); // worker drained it

    // Same-size WAL, drained synchronously on the main thread.
    const sync = openDb(dir, 'sync.db');
    const syncPath = path.join(dir, 'sync.db');
    sync.pragma('wal_autocheckpoint = 0');
    seedWriteBurst(sync, rows);
    expect(walBytes(syncPath)).toBeGreaterThan(32 * 1024 * 1024);
    const t1 = performance.now();
    const syncRes = checkpointDbOnceSync(sync, 'sync.db');
    const syncMainThreadMs = performance.now() - t1;
    expect(syncRes!.mode).toBe('truncate');
    expect(walBytes(syncPath)).toBeLessThan(64 * 1024);

    // The offload's synchronous main-thread cost is a filesystem stat + a
    // postMessage; the sync checkpoint copies ~69 MB inline. The former must be
    // dramatically cheaper. A self-calibrating ratio (like the async-facade
    // harness) keeps this honest without a wall-clock assumption.
    expect(syncMainThreadMs).toBeGreaterThan(offloadMainThreadMs * 3);

    off.close();
    sync.close();
  }, 30000);

  it('a starved reader cannot force a giant synchronous main-thread checkpoint; WAL drains once it releases', async () => {
    const db = openDb(dir, 'starved.db');
    const dbPath = path.join(dir, 'starved.db');
    db.pragma('wal_autocheckpoint = 0');
    registerCheckpointDb(db, 'starved.db');
    db.pragma('wal_autocheckpoint = 0');
    seedWriteBurst(db, 200); // seed a row so the reader has a snapshot

    // A second connection holds an open read transaction — the exact condition
    // that starves autocheckpoints and grew the 147 MB WAL. While it is held,
    // no checkpoint can reset the WAL.
    const reader = new Database(dbPath);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM t').get();

    seedWriteBurst(db, 10000); // ~69 MB WAL that the reader pins
    expect(walBytes(dbPath)).toBeGreaterThan(32 * 1024 * 1024);

    // The sweep measures the WAL from the filesystem and offloads the drain, so
    // the main thread is not blocked by the giant WAL even though it exists.
    const t0 = performance.now();
    const promise = runDbCheckpointSweep();
    const mainThreadMs = performance.now() - t0;
    const [res] = await promise;
    expect(res.mode).toBe('offloaded');
    // The offload dispatch does not copy frames on the main thread.
    expect(mainThreadMs).toBeLessThan(200);
    // Reader still holds → TRUNCATE could not reset the file, so it is retained
    // (bounded work, no wedge) rather than dropped.
    expect(walBytes(dbPath)).toBeGreaterThan(32 * 1024 * 1024);

    // Release the reader; the next sweep drains the backlog off-thread.
    reader.exec('COMMIT');
    reader.close();
    await runDbCheckpointSweep();
    expect(walBytes(dbPath)).toBeLessThan(64 * 1024);

    db.close();
  }, 30000);

  it('a commit AFTER a reader releases does not trigger a synchronous main-thread checkpoint', async () => {
    // The [8/10] release-then-write regression. With main-thread autocheckpoint
    // disabled, the first write after a reader frees a giant WAL must NOT pay the
    // backlog checkpoint on the request thread. A PASSIVE checkpoint reuses the
    // WAL file without shrinking it, so the discriminator is write LATENCY, not
    // file size: the write must be fast even though the WAL is huge.
    const dbPath = path.join(dir, 'rw.db');
    const db = openDb(dir, 'rw.db'); // production pragmas → autocheckpoint 0
    registerCheckpointDb(db, 'rw.db');
    seedWriteBurst(db, 5);

    const reader = new Database(dbPath);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM t').get();
    seedWriteBurst(db, 10000); // ~69 MB WAL pinned by the reader
    const big = walBytes(dbPath);
    expect(big).toBeGreaterThan(32 * 1024 * 1024);

    reader.exec('COMMIT');
    reader.close();
    const t0 = performance.now();
    db.prepare('INSERT INTO t (blob) VALUES (?)').run('x'.repeat(1024));
    const disabledWriteMs = performance.now() - t0;
    // Autocheckpoint disabled → the commit only appended a frame; it did not copy
    // the ~69 MB backlog, so the WAL grew rather than collapsing.
    expect(walBytes(dbPath)).toBeGreaterThan(big);

    // Control: an identical file with the DRIVER-DEFAULT autocheckpoint pays the
    // whole backlog checkpoint synchronously on that same post-release write —
    // proving the disable is load-bearing, not incidental.
    const ctlPath = path.join(dir, 'ctl.db');
    const ctl = new Database(ctlPath);
    ctl.pragma('journal_mode = WAL');
    ctl.pragma('busy_timeout = 5000');
    ctl.pragma('wal_autocheckpoint = 1000'); // the pre-fix / default behaviour
    ctl.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT NOT NULL)');
    ctl.prepare('INSERT INTO t (blob) VALUES (?)').run('x');
    const ctlReader = new Database(ctlPath);
    ctlReader.exec('BEGIN');
    ctlReader.prepare('SELECT COUNT(*) AS c FROM t').get();
    seedWriteBurst(ctl, 10000);
    expect(walBytes(ctlPath)).toBeGreaterThan(32 * 1024 * 1024);
    ctlReader.exec('COMMIT');
    ctlReader.close();
    const t1 = performance.now();
    ctl.prepare('INSERT INTO t (blob) VALUES (?)').run('x'.repeat(1024));
    const defaultWriteMs = performance.now() - t1;
    ctl.close();

    // The disabled-autocheckpoint write is dramatically cheaper than the one that
    // pays the backlog checkpoint. Self-calibrating ratio, no wall-clock constant.
    expect(defaultWriteMs).toBeGreaterThan(disabledWriteMs * 3);

    db.close();
  }, 30000);

  it('worker unavailable → deferred (never a synchronous main-thread checkpoint), retried next sweep', async () => {
    // The [7/10] fix: a down worker must not move the giant checkpoint back onto
    // the request thread. The WAL is left for the next off-thread retry.
    const db = openDb(dir, 'deferred.db');
    const dbPath = path.join(dir, 'deferred.db');
    registerCheckpointDb(db, 'deferred.db');
    seedWriteBurst(db, 4000); // ~27 MB, over the ~8 MB threshold
    const big = walBytes(dbPath);
    expect(big).toBeGreaterThan(CHECKPOINT_TRUNCATE_THRESHOLD_BYTES);

    let calls = 0;
    __setCheckpointDispatcherForTests({
      checkpoint: async () => {
        calls++;
        throw new Error('simulated worker down');
      },
      closeDb: () => {},
      close: async () => {},
    });

    const t0 = performance.now();
    const promise = runDbCheckpointSweep();
    const mainThreadMs = performance.now() - t0;
    const [res] = await promise;
    expect(calls).toBe(1);
    expect(res.mode).toBe('deferred');
    // No checkpoint ran on the main thread: WAL untouched, dispatch was cheap.
    expect(walBytes(dbPath)).toBe(big);
    expect(mainThreadMs).toBeLessThan(200);

    // Restore the real worker; the deferred backlog drains on the next sweep.
    __setCheckpointDispatcherForTests(null);
    await runDbCheckpointSweep();
    expect(walBytes(dbPath)).toBeLessThan(64 * 1024);

    db.close();
  }, 30000);
});

describe('unbounded-growth guard', () => {
  let dir: string;
  beforeEach(() => {
    clearCheckpointRegistry();
    dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-growth-'));
  });
  afterEach(async () => {
    setSustainedWalGrowthHandler(null);
    __setWalHardLimitForTests(null);
    __setCheckpointDispatcherForTests(null);
    await stopDbCheckpointScheduler();
    clearCheckpointRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('escalates sustained WAL growth (WAL cannot be reset) without a main-thread checkpoint', async () => {
    const db = openDb(dir, 'grow.db');
    const dbPath = path.join(dir, 'grow.db');
    db.pragma('wal_autocheckpoint = 0');
    registerCheckpointDb(db, 'grow.db');
    __setWalHardLimitForTests(6 * 1024 * 1024); // 6 MB test ceiling (avoids writing 256 MB)

    // A dispatcher that can never reset the WAL — models a reader-pinned WAL (or a
    // worker that returns busy). It does NOT touch the file, so the WAL persists.
    let dispatched = 0;
    __setCheckpointDispatcherForTests({
      checkpoint: async () => {
        dispatched++;
        return { busy: 1, log: 99999, checkpointed: 0 };
      },
      closeDb: () => {},
      close: async () => {},
    });

    const alerts: SustainedWalGrowthInfo[] = [];
    setSustainedWalGrowthHandler((i) => alerts.push(i));

    seedWriteBurst(db, 4000); // ~27 MB WAL, over the 6 MB ceiling
    const initial = walBytes(dbPath);
    expect(initial).toBeGreaterThan(6 * 1024 * 1024);

    // Sweep 1: over the ceiling but not yet sustained (needs 2 sweeps) → no alert,
    // but backpressure engages immediately so growth is bounded from here on.
    const [r1] = await runDbCheckpointSweep();
    expect(r1.mode).toBe('offloaded'); // dispatched off-thread (busy, not reset)
    expect(alerts.length).toBe(0);
    expect(isWalUnderPressureLabel('grow.db')).toBe(true);

    // The WAL still can't be reset (busy dispatcher = pinned reader), so the second
    // sweep sees it sustained and escalates. No new writes are needed — and indeed
    // the bound now blocks them (covered by the query_only test below).
    const [r2] = await runDbCheckpointSweep();
    expect(r2.mode).toBe('offloaded');
    expect(alerts.length).toBe(1);
    expect(alerts[0].label).toBe('grow.db');
    expect(alerts[0].consecutiveSweeps).toBe(2);
    expect(alerts[0].walBytes).toBeGreaterThan(6 * 1024 * 1024);

    // The guard ran no main-thread checkpoint: the WAL was never reset.
    expect(walBytes(dbPath)).toBe(initial);
    expect(dispatched).toBe(2); // every over-threshold sweep still tried off-thread

    // Recovery: once the WAL can actually be drained (real worker, no reader), the
    // next sweep resets it and the growth counter clears.
    __setCheckpointDispatcherForTests(null);
    const alertsAfterReset = alerts.length;
    await runDbCheckpointSweep(); // real worker drains it (no reader here)
    expect(walBytes(dbPath)).toBeLessThan(64 * 1024);
    // Pressure is released in the SAME sweep as the successful drain (the guard
    // re-measures after draining) — no extra interval of shed writes / 503s.
    expect(isWalUnderPressureLabel('grow.db')).toBe(false);
    expect(alerts.length).toBe(alertsAfterReset); // a drained WAL raises no new alert

    db.close();
  }, 30000);

  it('bounds an ungated surface (primary/orgs) via query_only, released the same sweep on drain', async () => {
    // agent-hub.db / orgs.db have no cooperative writer, so the universal bound is
    // a query_only gate the guard sets under pressure — proving EVERY registered
    // write surface is bounded, not just the flood writers.
    const db = openDb(dir, 'primary.db');
    const dbPath = path.join(dir, 'primary.db');
    db.pragma('wal_autocheckpoint = 0');
    registerCheckpointDb(db, 'primary.db');
    __setWalHardLimitForTests(6 * 1024 * 1024);

    // A dispatcher that never resets the WAL (models a pinned reader), so the guard
    // sees a persistently-over-limit WAL and must engage the hard gate.
    __setCheckpointDispatcherForTests({
      checkpoint: async () => ({ busy: 1, log: 99999, checkpointed: 0 }),
      closeDb: () => {},
      close: async () => {},
    });

    const write = db.prepare('INSERT INTO t (blob) VALUES (?)');
    write.run('ok'); // writable before pressure
    seedWriteBurst(db, 4000); // ~27 MB, over the 6 MB ceiling

    await runDbCheckpointSweep(); // WAL still large after the busy drain → gate ON
    expect(Number(db.pragma('query_only', { simple: true }))).toBe(1);
    // Every write to this surface is now rejected — the WAL cannot grow further.
    expect(() => write.run('blocked')).toThrow(/readonly|read-only|query_only|SQLITE_READONLY/i);

    // Recovery: real worker drains (no reader here); the gate lifts the same sweep.
    __setCheckpointDispatcherForTests(null);
    await runDbCheckpointSweep();
    expect(walBytes(dbPath)).toBeLessThan(64 * 1024);
    expect(Number(db.pragma('query_only', { simple: true }))).toBe(0);
    expect(() => write.run('ok-again')).not.toThrow(); // writes resume

    db.close();
  }, 30000);

  it('backpressure actually bounds growth: a writer that honors the gate stops appending', async () => {
    const db = openDb(dir, 'gated.db');
    const dbPath = path.join(dir, 'gated.db');
    db.pragma('wal_autocheckpoint = 0');
    registerCheckpointDb(db, 'gated.db');

    // A flood writer that consults the gate before every write (exactly what the
    // real runner-log / logs / infra / rum writers now do).
    const gatedWrite = () => {
      if (isWalUnderPressureLabel('gated.db')) return false; // shed
      seedWriteBurst(db, 50);
      return true;
    };

    // Grow it, then engage pressure (as the sweep would once over the ceiling).
    for (let i = 0; i < 10; i++) gatedWrite();
    const beforePressure = walBytes(dbPath);
    __setWalPressureForTests('gated.db', true);

    // Under pressure every further write sheds, so the WAL stops growing.
    let shed = 0;
    for (let i = 0; i < 100; i++) if (!gatedWrite()) shed++;
    expect(shed).toBe(100);
    expect(walBytes(dbPath)).toBe(beforePressure); // bounded — no new frames

    // Release: writes resume.
    __setWalPressureForTests('gated.db', false);
    expect(gatedWrite()).toBe(true);
    expect(walBytes(dbPath)).toBeGreaterThan(beforePressure);

    db.close();
  });
});

describe('CheckpointOffloader worker lifecycle', () => {
  /** Minimal Worker stand-in: an EventEmitter with the methods the offloader uses. */
  type FakeWorker = EventEmitter & {
    postMessage: (m: unknown) => void;
    terminate: () => Promise<number>;
    unref: () => void;
  };
  function fakeWorker(setup: (ee: FakeWorker) => void): Worker {
    const ee = new EventEmitter() as FakeWorker;
    ee.postMessage = () => {};
    ee.terminate = async () => 0;
    ee.unref = () => {};
    setup(ee);
    return ee as unknown as Worker;
  }

  it('rejects (does not hang) when the worker errors BEFORE ready, then respawns next call', async () => {
    // The [7/10] fix: a pre-ready `error` must reject the init promise so the
    // awaiting checkpoint() / sweep settles instead of hanging forever.
    let attempt = 0;
    const off = new CheckpointOffloader(() => {
      attempt++;
      return fakeWorker((ee) => {
        if (attempt === 1) {
          queueMicrotask(() => ee.emit('error', new Error('spawn boom')));
        } else {
          ee.postMessage = (msg: unknown) => {
            const m = msg as { type: string; id: number };
            if (m.type === 'checkpoint') {
              queueMicrotask(() =>
                ee.emit('message', {
                  type: 'result',
                  id: m.id,
                  ok: true,
                  row: { busy: 0, log: 5, checkpointed: 5 },
                }),
              );
            }
          };
          queueMicrotask(() => ee.emit('message', { type: 'ready' }));
        }
      });
    });
    try {
      await expect(off.checkpoint('/tmp/x.db', 'TRUNCATE')).rejects.toThrow(/spawn boom/);
      // The init promise was cleared, so the next call re-spawns and succeeds.
      const row = await off.checkpoint('/tmp/x.db', 'TRUNCATE');
      expect(row.checkpointed).toBe(5);
      expect(attempt).toBe(2);
    } finally {
      await off.close();
    }
  });

  it('rejects when the worker EXITS before ready (init promise never left pending)', async () => {
    const off = new CheckpointOffloader(() =>
      fakeWorker((ee) => {
        queueMicrotask(() => ee.emit('exit', 1));
      }),
    );
    try {
      await expect(off.checkpoint('/tmp/x.db', 'TRUNCATE')).rejects.toThrow(/exited/);
    } finally {
      await off.close();
    }
  });

  it('close() terminates a still-initializing worker and a late ready cannot resurrect it', async () => {
    // The [5/10] fix: close() during a pending init must terminate the worker
    // (its handle is captured at spawn, not at ready) and mark the offloader
    // closed so a late `ready` from that worker is ignored — no leak, no
    // resurrection.
    let terminated = 0;
    let fireLateReady: () => void = () => {};
    const off = new CheckpointOffloader(() =>
      fakeWorker((ee) => {
        // Never readies on its own; capture a trigger to fire `ready` AFTER close.
        fireLateReady = () => ee.emit('message', { type: 'ready' });
        ee.terminate = async () => {
          terminated++;
          return 0;
        };
      }),
    );

    const inflight = off.checkpoint('/tmp/x.db', 'TRUNCATE').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await off.close();
    expect(terminated).toBe(1); // the initializing worker was terminated

    fireLateReady(); // a late ready must not restore state
    await new Promise((r) => setTimeout(r, 10));

    // The pending checkpoint rejected (offloader closing), and further calls
    // reject too — the offloader was not resurrected.
    expect(await inflight).toMatch(/clos/i);
    await expect(off.checkpoint('/tmp/x.db', 'TRUNCATE')).rejects.toThrow(/closed/);
  });

  it('a sweep whose worker dies before ready defers, and the NEXT sweep respawns (not wedged)', async () => {
    // End-to-end: the reviewer's failure mode — a pre-ready worker death must not
    // leave the sweep pending (which would pin sweepInFlight and skip every later
    // tick). First sweep → deferred; second sweep → the worker respawns and drains.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-wedge-'));
    try {
      const db = openDb(dir, 'a.db');
      const dbPath = path.join(dir, 'a.db');
      registerCheckpointDb(db, 'a.db');
      seedWriteBurst(db, 4000); // > threshold, so the sweep tries to drain
      expect(walBytes(dbPath)).toBeGreaterThan(CHECKPOINT_TRUNCATE_THRESHOLD_BYTES);

      let attempt = 0;
      __setCheckpointDispatcherForTests(
        new CheckpointOffloader(() => {
          attempt++;
          return fakeWorker((ee) => {
            if (attempt === 1) {
              queueMicrotask(() => ee.emit('error', new Error('boom before ready')));
            } else {
              ee.postMessage = (msg: unknown) => {
                const m = msg as { type: string; id: number };
                if (m.type === 'checkpoint') {
                  queueMicrotask(() =>
                    ee.emit('message', {
                      type: 'result',
                      id: m.id,
                      ok: true,
                      row: { busy: 0, log: 0, checkpointed: 0 },
                    }),
                  );
                }
              };
              queueMicrotask(() => ee.emit('message', { type: 'ready' }));
            }
          });
        }),
      );

      const [first] = await runDbCheckpointSweep(); // resolves (does not hang)
      expect(first.mode).toBe('deferred');

      const [second] = await runDbCheckpointSweep(); // worker respawns
      expect(second.mode).toBe('offloaded');
      expect(attempt).toBe(2);

      db.close();
    } finally {
      __setCheckpointDispatcherForTests(null);
      await stopDbCheckpointScheduler();
      clearCheckpointRegistry();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scheduler lifecycle', () => {
  afterEach(async () => {
    await stopDbCheckpointScheduler();
    clearCheckpointRegistry();
  });

  it('start is idempotent and stop is safe to call when not running', async () => {
    await stopDbCheckpointScheduler(); // safe when never started
    startDbCheckpointScheduler(60_000);
    startDbCheckpointScheduler(60_000); // no-op (no stacked timers)
    await stopDbCheckpointScheduler();
  });

  it('a scheduled tick drains a starved WAL', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ahub-ckpt-timer-'));
    try {
      const db = openDb(dir, 'a.db');
      registerCheckpointDb(db, 'a.db');
      db.pragma('wal_autocheckpoint = 0');
      seedWriteBurst(db, 4000); // ~27 MB, over the ~8 MB threshold
      const dbPath = path.join(dir, 'a.db');
      expect(walBytes(dbPath)).toBeGreaterThan(CHECKPOINT_TRUNCATE_THRESHOLD_BYTES);

      startDbCheckpointScheduler(20); // fast tick
      // Wait for a tick to fire and its async offload to complete.
      const deadline = Date.now() + 10000;
      while (walBytes(dbPath) >= 64 * 1024 && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 25));
      }
      await stopDbCheckpointScheduler();

      expect(walBytes(dbPath)).toBeLessThan(64 * 1024);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
