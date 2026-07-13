# `server/db-async` — async read facade contributor rules

This directory holds the Phase-2 async-DB machinery: a `worker_threads` reader
pool (`reader-pool.ts`) and the statement-based facade (`read-facade.ts`) that
measured-slow READ paths call instead of a synchronous `SELECT`. Scope was
locked by the `facade-scope` spike decision — read it before adding a call site.

## The one rule you must not break: a transaction must never span an `await`

Synchronous `better-sqlite3` gives an **implicit no-interleaving guarantee**:
because a statement (or a `db.transaction(...)`) runs to completion in a single
tick, no other JavaScript can observe a half-applied write, and no two
read-modify-write sequences can interleave. Every existing read-modify-write in
the codebase is race-free _for free_ because of this.

The moment you put an `await` between a read and the write that depends on it,
that guarantee is gone. Two operations can both read the same value, both
compute a new value from it, and both write — the second clobbering the first
(a lost update). This bug class **cannot exist today** and single-request unit
tests will never surface it, which is exactly why it is dangerous.

So:

- **Reads** may go through the async facade (`readAll` / `readGet`). A read that
  only reads is safe: it observes one consistent WAL snapshot and returns.
- **Writes and transactions stay synchronous on the main thread.** A
  read-modify-write ships as a **whole** `db.transaction(...)` with no `await`
  inside it. Do not "async-ify" the read half of a write path.
- If you find yourself writing `const x = await readGet(...)` and then, later in
  the same logical operation, a write derived from `x` — **stop**. That is the
  anti-pattern. Do the read-modify-write as one synchronous transaction instead.

## What the facade converts (and what it does not)

- ✅ Convert: a measured-slow, unbounded, read-only SELECT (identified by Phase-1
  instrumentation) whose result the handler only reads. Example:
  `GET /api/sessions/:sessionId/messages` full-transcript load.
- ❌ Do not convert: fast point queries (a `postMessage` round-trip costs more
  than a microsecond point query), `LIMIT`-bounded reads that already measure
  fast, or anything on a write / transaction path.

## The regression harness

`concurrency-harness.test.ts` is the CI net for the interleaving hazard. Unlike
the rest of the server suite (which runs against the sync-backed facade from
`server/test/setup.ts`), it installs a **real** worker pool and asserts:

1. **Interleaving safety** — sync transfers on the main thread interleaved with
   async reads through the pool never let a reader observe a torn snapshot
   (balance-sum invariant holds on every read).
2. **No cross-talk** — concurrent parametrized reads each resolve to exactly
   their own rows (guards the pool's job-id result routing).
3. **Event-loop offload** — submitting a heavy scan/sort read through the pool
   returns to the main thread far faster than running the identical read
   synchronously. Asserted as a self-calibrating **ratio** (async submission
   blocks ≥ 3× less than sync), not an absolute wall-clock ceiling, so it does
   not flake on a slow / CPU-capped gate runner. The sync half is what gives the
   assertion teeth: revert a converted path to a synchronous SELECT and the
   async "submission" call runs the query before returning, collapsing the
   ratio.
4. **Rule rationale** — a deterministic demonstration that a read-modify-write
   spanning an `await` loses updates, and that the safe synchronous-transaction
   pattern does not.

Run it directly with `cd server && npx vitest db-async/concurrency-harness`. It
runs in Finalize CI automatically as part of the server shards (no `ci.yaml`
change needed — the server suite globs `**/*.test.ts`).
