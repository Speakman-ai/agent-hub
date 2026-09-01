/**
 * Checkpoint-worker body, run via `new Worker(src, { eval: true })` so there is
 * no separate file for tsx / vitest to resolve (mirrors `reader-worker-source.ts`
 * and `skill-evals.ts`). Authored as CommonJS: `require` is available in the
 * worker-eval context, `import` is not.
 *
 * ## Why a worker at all
 *
 * A `PRAGMA wal_checkpoint(...)` copies WAL frames back into the main DB file,
 * and with synchronous `better-sqlite3` that copy runs to completion in the
 * calling thread's event-loop tick. On the MAIN thread a checkpoint of a large
 * (reader-starved) WAL therefore blocks every request for the whole copy — the
 * 147 MB-WAL wedge this whole module exists to prevent. Running the checkpoint
 * on its OWN connection in a worker thread moves that synchronous copy off the
 * request thread entirely. WAL is explicitly designed for multiple read-write
 * connections to the same file (even across processes); SQLite serialises the
 * actual checkpoint via its checkpoint lock, and `PASSIVE`/`TRUNCATE` never
 * corrupt a concurrently-writing main connection.
 *
 * This offloads SQLite's own housekeeping, NOT an application read-modify-write,
 * so it does not touch the `async-boundary` spec's no-interleaving guarantee
 * (that rule is about app-level read-then-write logic losing updates across an
 * `await`; a checkpoint reads/writes no application value).
 *
 * `better-sqlite3` is required by ABSOLUTE path (passed in `workerData`): with
 * `{ eval: true }` a bare `require('better-sqlite3')` resolves against the
 * process CWD, which is not stable across dev / vitest / a packaged install. The
 * parent resolves it once with `createRequire(import.meta.url)`.
 *
 * The connection is opened READ-WRITE (a checkpoint mutates the main file) and
 * with `fileMustExist: true` (the parent only ever checkpoints an already-open
 * DB). One connection is cached per file path so repeated ticks reuse it.
 *
 * Protocol (parent → worker):
 *   { type: 'checkpoint', id, dbPath, mode: 'PASSIVE' | 'TRUNCATE' | 'RESTART' }
 *   { type: 'close-db', dbPath }
 *   { type: 'close' }
 * Protocol (worker → parent):
 *   { type: 'ready' }
 *   { type: 'init-error', error }
 *   { type: 'result', id, ok: true, row: { busy, log, checkpointed } }
 *   { type: 'result', id, ok: false, error: { message, code?, name } }
 */
export const CHECKPOINT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');

function serializeError(e) {
  if (!e) return { message: 'unknown error', name: 'Error' };
  return {
    message: e.message != null ? String(e.message) : String(e),
    code: e.code != null ? String(e.code) : undefined,
    name: e.name != null ? String(e.name) : 'Error',
  };
}

let Database = null;
let initError = null;
try {
  Database = require(workerData.betterSqlitePath);
} catch (e) {
  initError = serializeError(e);
}

const busyTimeoutMs = Number(workerData.busyTimeoutMs) || 0;
const conns = new Map();

function connFor(dbPath) {
  let db = conns.get(dbPath);
  if (!db) {
    db = new Database(dbPath, { fileMustExist: true });
    if (busyTimeoutMs > 0) db.pragma('busy_timeout = ' + busyTimeoutMs);
    conns.set(dbPath, db);
  }
  return db;
}

function closeConn(dbPath) {
  const db = conns.get(dbPath);
  if (db) {
    try { db.close(); } catch (_) { /* ignore */ }
    conns.delete(dbPath);
  }
}

parentPort.postMessage(initError ? { type: 'init-error', error: initError } : { type: 'ready' });

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'close') {
    for (const p of Array.from(conns.keys())) closeConn(p);
    process.exit(0);
    return;
  }
  if (msg.type === 'close-db') {
    closeConn(msg.dbPath);
    return;
  }
  if (msg.type !== 'checkpoint') return;

  const id = msg.id;
  if (!Database) {
    parentPort.postMessage({
      type: 'result',
      id,
      ok: false,
      error: { message: 'checkpoint worker not initialized', code: 'CKPT_NOT_READY', name: 'Error' },
    });
    return;
  }

  try {
    const mode = msg.mode === 'TRUNCATE' || msg.mode === 'RESTART' ? msg.mode : 'PASSIVE';
    const db = connFor(msg.dbPath);
    const rows = db.pragma('wal_checkpoint(' + mode + ')');
    const row = rows && rows[0] ? rows[0] : { busy: 0, log: 0, checkpointed: 0 };
    parentPort.postMessage({
      type: 'result',
      id,
      ok: true,
      row: {
        busy: Number(row.busy || 0),
        log: Number(row.log || 0),
        checkpointed: Number(row.checkpointed || 0),
      },
    });
  } catch (e) {
    parentPort.postMessage({ type: 'result', id, ok: false, error: serializeError(e) });
  }
});
`;
