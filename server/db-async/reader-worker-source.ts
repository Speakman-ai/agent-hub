/**
 * Reader-worker body, run via `new Worker(src, { eval: true })` so there is no
 * separate file for tsx / vitest to resolve (mirrors the pattern in
 * `skill-evals.ts`). It is authored as CommonJS: `require` is available in the
 * worker-eval context, `import` is not.
 *
 * `better-sqlite3` is required by ABSOLUTE path (passed in `workerData`) rather
 * than by bare specifier: with `{ eval: true }` a bare `require('better-sqlite3')`
 * resolves relative to the process CWD, which is not stable across `npm run
 * dev` / vitest / a packaged install. The parent resolves the path once with
 * `createRequire(import.meta.url)` and hands it over.
 *
 * Read-only is enforced two ways, by construction:
 *   1. The connection is opened `{ readonly: true }` — SQLite refuses writes at
 *      the engine level.
 *   2. Every prepared statement is checked with better-sqlite3's `stmt.readonly`
 *      flag before execution; a non-readonly statement (INSERT/UPDATE/DELETE/
 *      DDL, incl. `... RETURNING`) is rejected with an `ASYNC_DB_READONLY`
 *      error before it can touch the engine.
 *
 * Protocol (parent → worker):
 *   { type: 'query', id, sql, params, mode: 'all' | 'get' }
 *   { type: 'close' }
 * Protocol (worker → parent):
 *   { type: 'ready' }
 *   { type: 'init-error', error }
 *   { type: 'result', id, ok: true, rows }
 *   { type: 'result', id, ok: false, error: { message, code?, name } }
 */
export const READER_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');

function serializeError(e) {
  if (!e) return { message: 'unknown error', name: 'Error' };
  return {
    message: e.message != null ? String(e.message) : String(e),
    code: e.code != null ? String(e.code) : undefined,
    name: e.name != null ? String(e.name) : 'Error',
  };
}

let db = null;
let initError = null;
try {
  const Database = require(workerData.betterSqlitePath);
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  const busy = Number(workerData.busyTimeoutMs) || 0;
  if (busy > 0) db.pragma('busy_timeout = ' + busy);
} catch (e) {
  initError = serializeError(e);
}

parentPort.postMessage(initError ? { type: 'init-error', error: initError } : { type: 'ready' });

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'close') {
    try { if (db) db.close(); } catch (_) { /* ignore */ }
    process.exit(0);
    return;
  }
  if (msg.type !== 'query') return;

  const id = msg.id;
  if (!db) {
    parentPort.postMessage({
      type: 'result',
      id,
      ok: false,
      error: { message: 'reader worker not initialized', code: 'ASYNC_DB_NOT_READY', name: 'Error' },
    });
    return;
  }

  try {
    const stmt = db.prepare(msg.sql);
    if (!stmt.readonly) {
      const err = new Error(
        'write statements are not allowed on the async reader pool: ' + String(msg.sql).slice(0, 200),
      );
      err.code = 'ASYNC_DB_READONLY';
      throw err;
    }
    const params = Array.isArray(msg.params) ? msg.params : [];
    const rows = msg.mode === 'get' ? stmt.get.apply(stmt, params) : stmt.all.apply(stmt, params);
    // Normalize get()'s undefined to null so structured clone always carries an
    // explicit "no row" signal; the parent maps it back to undefined.
    parentPort.postMessage({ type: 'result', id, ok: true, rows: rows === undefined ? null : rows });
  } catch (e) {
    parentPort.postMessage({ type: 'result', id, ok: false, error: serializeError(e) });
  }
});
`;
