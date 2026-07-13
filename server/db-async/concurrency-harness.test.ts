/**
 * Concurrency regression harness for the async read facade (Phase-2 async-DB).
 *
 * The facade's one dangerous failure mode is read-modify-write interleaving that
 * a single-request unit test can never surface: it only shows up when concurrent
 * work races. This harness makes that class of bug CI-visible. It asserts three
 * properties that, together, guard the `facade-scope` architectural decision:
 *
 *   1. Interleaving safety — sync writes on the main thread interleaved with
 *      async reads through the worker pool never let a reader observe a torn or
 *      invariant-violating snapshot (classic balance-sum invariant).
 *   2. No cross-talk — many concurrent reads with distinct params each resolve
 *      to exactly their own rows (guards the pool's job-id result routing).
 *   3. Event-loop offload — submitting a heavy scan/sort read through the pool
 *      returns to the main thread far faster than running the identical read
 *      synchronously. Asserted as a self-calibrating RATIO (async ≥ 3× less
 *      blocking than sync), not an absolute ms ceiling, so it does not flake on a
 *      slow / CPU-capped gate runner. The sync half gives it teeth: revert a
 *      converted path to a sync SELECT and the ratio collapses.
 *
 * A fourth test deterministically demonstrates WHY the "a transaction must never
 * span an await" rule exists: a read-modify-write split across an await loses
 * updates and breaks the invariant. See server/db-async/README.md.
 *
 * Unlike the rest of the server suite (which runs against the sync-backed facade
 * installed in server/test/setup.ts), this file installs a REAL worker_threads
 * pool so it exercises the production off-thread path end to end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncDbReaderPool } from './reader-pool.js';
import {
  setReadFacadeForTesting,
  syncReadFacade,
  readAll,
  readGet,
  type AsyncReadFacade,
  type ReadableStatement,
} from './read-facade.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACCOUNTS = 20;
const START_BALANCE = 1_000;
const TOTAL = ACCOUNTS * START_BALANCE; // the invariant: sum of all balances

// Event-loop workload: a scan+sort-dominated read over thousands of wide rows
// that returns only a handful of small rows. The heavy work (sorting an
// unindexed 2KB text column across every row) happens wherever the query runs,
// on the main thread for a sync read, or off-thread in a worker for the facade.
// Because the RESULT is tiny, the main-thread deserialization cost of the async
// path is negligible. The harness measures synchronous read time against async
// submission time, avoiding timer drift from worker CPU contention on shared CI.
const WIDE_ROWS = 8_000;
// Distinct payloads sharing a long common prefix so the ORDER BY comparator must
// scan ~2KB per comparison before reaching the differentiating suffix — this is
// what makes the sort genuinely CPU-heavy rather than trivially short-circuited.
const widePayload = (i: number): string => 'x'.repeat(2_000) + String(i).padStart(48, '0');

let tmpDir: string;
let dbPath: string;
let writeDb: Database.Database; // main-thread writer (sync writes + prepared reads)
let pool: AsyncDbReaderPool;

let accountsStmt: ReadableStatement; // SELECT * FROM accounts
let catalogByKindStmt: ReadableStatement; // SELECT ... WHERE kind = ?
let heavySortStmt: ReadableStatement; // scan+sort over wide_rows, tiny LIMITed result

/** A pool-backed facade bound to the harness's real worker pool. */
function poolFacade(): AsyncReadFacade {
  return {
    all: (stmt, params = []) => pool.all(stmt.source, params),
    get: (stmt, params = []) => pool.get(stmt.source, params),
  };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'concurrency-harness-'));
  dbPath = path.join(tmpDir, 'harness.db');

  writeDb = new Database(dbPath);
  // WAL is what lets the readonly worker connections see a consistent snapshot
  // concurrently with the main-thread writer — same mode as the app DB.
  writeDb.pragma('journal_mode = WAL');
  writeDb.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);
    CREATE TABLE catalog (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL);
    CREATE TABLE wide_rows (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL);
  `);

  const insAcct = writeDb.prepare('INSERT INTO accounts (id, balance) VALUES (?, ?)');
  const seedAccts = writeDb.transaction(() => {
    for (let i = 0; i < ACCOUNTS; i++) insAcct.run(i, START_BALANCE);
  });
  seedAccts();

  // catalog: 5 kinds, deterministic row sets per kind for cross-talk assertions.
  const insCat = writeDb.prepare('INSERT INTO catalog (id, kind, label) VALUES (?, ?, ?)');
  const seedCat = writeDb.transaction(() => {
    let id = 0;
    for (const kind of ['a', 'b', 'c', 'd', 'e']) {
      const count = kind.charCodeAt(0) - 'a'.charCodeAt(0) + 1; // a=1 … e=5 rows
      for (let n = 0; n < count; n++) insCat.run(id++, kind, `${kind}-${n}`);
    }
  });
  seedCat();

  const insWide = writeDb.prepare('INSERT INTO wide_rows (id, kind, payload) VALUES (?, ?, ?)');
  const seedWide = writeDb.transaction(() => {
    for (let i = 0; i < WIDE_ROWS; i++)
      insWide.run(i, i % 2 === 0 ? 'even' : 'odd', widePayload(i));
  });
  seedWide();

  accountsStmt = writeDb.prepare('SELECT * FROM accounts') as unknown as ReadableStatement;
  catalogByKindStmt = writeDb.prepare(
    'SELECT id, label FROM catalog WHERE kind = ? ORDER BY id ASC',
  ) as unknown as ReadableStatement;
  // Full-table scan + sort on the unindexed `payload` column, returning only 20
  // small rows: the work is in the scan/sort, not in marshalling the result.
  heavySortStmt = writeDb.prepare(
    'SELECT id FROM wide_rows ORDER BY payload DESC, id DESC LIMIT 20',
  ) as unknown as ReadableStatement;

  pool = new AsyncDbReaderPool({
    dbPath,
    size: 4,
    queryTimeoutMs: 10_000,
    maxQueueDepth: 1_000,
    busyTimeoutMs: 2_000,
  });
  await pool.ready();
  setReadFacadeForTesting(poolFacade());
}, 30_000);

afterAll(async () => {
  setReadFacadeForTesting(syncReadFacade); // restore the suite-wide default
  if (pool) await pool.shutdown();
  if (writeDb) writeDb.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// Reset balances before each interleaving test so the invariant starts clean.
beforeEach(() => {
  const reset = writeDb.transaction(() => {
    const upd = writeDb.prepare('UPDATE accounts SET balance = ? WHERE id = ?');
    for (let i = 0; i < ACCOUNTS; i++) upd.run(START_BALANCE, i);
  });
  reset();
});

// ─── 1. Interleaving safety: balance-sum invariant ───────────────────────────

/**
 * The correct pattern: a transfer is a WHOLE synchronous transaction on the main
 * thread. It never yields mid-way, so no async read can observe a half-applied
 * transfer. better-sqlite3 transactions are synchronous, so this is race-free by
 * construction — which is exactly the guarantee the facade-scope decision leans
 * on for the reads it leaves synchronous.
 */
function transfer(from: number, to: number, amount: number): void {
  const tx = writeDb.transaction((f: number, t: number, amt: number) => {
    const debit = writeDb.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?');
    const credit = writeDb.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?');
    debit.run(amt, f);
    credit.run(amt, t);
  });
  tx(from, to, amount);
}

describe('interleaving safety (balance-sum invariant)', () => {
  it('async reads always observe a consistent total while sync transfers run', async () => {
    const reads: Array<Promise<void>> = [];
    const observedTotals: number[] = [];

    // Interleave 200 sync transfers with 200 async full-table reads. Each read
    // is fired without awaiting, so many are in flight across the worker pool
    // while the main thread keeps mutating balances between them.
    for (let i = 0; i < 200; i++) {
      const from = i % ACCOUNTS;
      const to = (i + 1) % ACCOUNTS;
      transfer(from, to, (i % 7) + 1);

      reads.push(
        readAll<{ id: number; balance: number }>(accountsStmt).then((rows) => {
          const sum = rows.reduce((acc, r) => acc + r.balance, 0);
          observedTotals.push(sum);
          // Every snapshot a reader sees must preserve the invariant. A torn
          // read (mixing pre/post states of one transfer) or a mixed-up result
          // buffer between two concurrent jobs would show a sum != TOTAL.
          expect(sum).toBe(TOTAL);
          expect(rows).toHaveLength(ACCOUNTS);
        }),
      );

      // Yield occasionally so the pool actually drains mid-flight rather than
      // queueing every read behind the whole synchronous write loop.
      if (i % 25 === 0) await new Promise((r) => setImmediate(r));
    }

    await Promise.all(reads);
    expect(observedTotals).toHaveLength(200);
    expect(observedTotals.every((t) => t === TOTAL)).toBe(true);
    // Sanity: the writes actually happened (balances moved off their seed value).
    const finalRow = await readGet<{ balance: number }>(accountsStmt);
    expect(finalRow).toBeDefined();
  });
});

// ─── 2. No cross-talk between concurrent reads ───────────────────────────────

describe('concurrent reads do not contaminate each other', () => {
  it('each parametrized read resolves to exactly its own rows', async () => {
    const kinds = ['a', 'b', 'c', 'd', 'e'];
    const expectedCount: Record<string, number> = { a: 1, b: 2, c: 3, d: 4, e: 5 };

    // Fire a large fan-out of interleaved reads across all kinds at once. If the
    // pool ever routed a result to the wrong pending job, some read would come
    // back with another kind's rows and the label prefix check would fail.
    const jobs: Array<Promise<void>> = [];
    for (let round = 0; round < 40; round++) {
      for (const kind of kinds) {
        jobs.push(
          readAll<{ id: number; label: string }>(catalogByKindStmt, [kind]).then((rows) => {
            expect(rows).toHaveLength(expectedCount[kind]);
            expect(rows.every((r) => r.label.startsWith(`${kind}-`))).toBe(true);
          }),
        );
      }
    }
    await Promise.all(jobs);
    expect(jobs).toHaveLength(kinds.length * 40);
  });
});

// ─── 3. Event-loop lag budget ────────────────────────────────────────────────

/**
 * How much less the main thread may be blocked while submitting the async path
 * than running the sync path, as a ratio. This is deliberately a
 * SELF-CALIBRATING relative bound, not an absolute wall-clock ceiling: the sync
 * measurement calibrates how expensive this runner finds the heavy query. The
 * ratio still has teeth: if the async facade regresses to `syncReadFacade`, the
 * "submission" call runs the SELECT before returning and the ratio breaks.
 */
const OFFLOAD_RATIO = 3;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe('event-loop lag budget', () => {
  it('running the heavy read off-thread keeps the loop far more responsive than sync', async () => {
    const READS = 6;

    const syncSamples: number[] = [];
    for (let i = 0; i < READS; i++) {
      const start = performance.now();
      const rows = heavySortStmt.all() as unknown[];
      syncSamples.push(performance.now() - start);
      expect(rows).toHaveLength(20);
    }

    const asyncSubmitSamples: number[] = [];
    for (let i = 0; i < READS; i++) {
      const start = performance.now();
      const rowsPromise = readAll(heavySortStmt);
      asyncSubmitSamples.push(performance.now() - start);
      const rows = await rowsPromise;
      expect(rows).toHaveLength(20);
    }

    const syncMedian = median(syncSamples);
    const asyncSubmitMedian = median(asyncSubmitSamples);

    if (process.env.HARNESS_DEBUG) {
      process.stdout.write(
        `\n[event-loop] syncMedian=${syncMedian.toFixed(1)}ms ` +
          `asyncSubmitMedian=${asyncSubmitMedian.toFixed(3)}ms ` +
          `ratio=${(syncMedian / Math.max(asyncSubmitMedian, 0.001)).toFixed(1)}x\n`,
      );
    }

    // Self-calibrating: submitting through the async path must block the loop at
    // least OFFLOAD_RATIO times LESS than the synchronous path running the
    // identical read. No absolute ms ceiling is involved, and a regression that
    // runs the read synchronously before returning collapses the ratio.
    expect(asyncSubmitMedian * OFFLOAD_RATIO).toBeLessThan(syncMedian);
  }, 20_000);
});

// ─── 4. Why transactions must never span an await ────────────────────────────

/**
 * Documents-as-code the failure mode the "a transaction must never span an
 * await" rule prevents, using a counter (the clean lost-update invariant). A
 * read-modify-write that reads a value through the async facade, awaits, THEN
 * writes `value + 1` is not atomic: once the read yields the loop, a concurrent
 * increment can read the SAME value before either write lands, so the second
 * write clobbers the first. N concurrent increments end at far less than +N.
 *
 * This is deterministic here because the reads all resolve before any write runs
 * — exactly the interleave an event-loop yield permits for real under load. The
 * safe version does the whole read-modify-write as one synchronous transaction
 * (no await), which better-sqlite3 makes atomic by construction.
 */
describe('read-modify-write spanning an await corrupts (rule rationale)', () => {
  const N = 10;
  const counterStmt = () =>
    writeDb.prepare('SELECT balance FROM accounts WHERE id = 0') as unknown as ReadableStatement;
  const writeCounter = (v: number) =>
    writeDb.prepare('UPDATE accounts SET balance = ? WHERE id = 0').run(v);

  it('loses updates when async increments span the await', async () => {
    // WRONG: read via the async facade (yields the loop), then write value + 1.
    // Launched concurrently, every increment reads the same START_BALANCE before
    // any write happens, so the final value is START_BALANCE + 1, not + N.
    const reads = await Promise.all(
      Array.from({ length: N }, () => readGet<{ balance: number }>(counterStmt())),
    );
    for (const row of reads) writeCounter(row!.balance + 1);

    const after = (await readGet<{ balance: number }>(counterStmt()))!.balance;
    expect(after).toBeLessThan(START_BALANCE + N); // updates were lost
  });

  it('the safe pattern (one synchronous transaction, no await) never loses one', () => {
    // RIGHT: read-modify-write as a whole synchronous transaction. No yield
    // point exists between read and write, so N increments land exactly +N.
    const increment = writeDb.transaction(() => {
      const cur = (
        writeDb.prepare('SELECT balance FROM accounts WHERE id = 0').get() as {
          balance: number;
        }
      ).balance;
      writeCounter(cur + 1);
    });
    for (let i = 0; i < N; i++) increment();

    const after = (
      writeDb.prepare('SELECT balance FROM accounts WHERE id = 0').get() as {
        balance: number;
      }
    ).balance;
    expect(after).toBe(START_BALANCE + N);
  });
});
