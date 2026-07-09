import path from 'path';
import config from '../config.js';
import { AsyncDbReaderPool } from './reader-pool.js';

export {
  AsyncDbReaderPool,
  AsyncDbError,
  AsyncDbTimeoutError,
  AsyncDbQueueFullError,
  AsyncDbClosedError,
} from './reader-pool.js';
export type { AsyncDbReaderPoolOptions, AsyncDbReaderPoolStats } from './reader-pool.js';

/**
 * Lazily-built, process-wide reader pool over the primary
 * `<dataDir>/agent-hub.db`, sized from `config.dbReaderPool`.
 *
 * NOTE: nothing in the app calls this yet. It exists so the later call-site
 * migration card can route measured-slow read paths through it without
 * re-deriving config / db-path plumbing. Keeping it lazy means the workers are
 * only spawned once a caller actually opts in.
 */
let sharedPool: AsyncDbReaderPool | null = null;

export function getSharedReaderPool(): AsyncDbReaderPool {
  if (!sharedPool) {
    const { size, queryTimeoutMs, maxQueueDepth, busyTimeoutMs } = config.dbReaderPool;
    sharedPool = new AsyncDbReaderPool({
      dbPath: path.join(config.dataDir, 'agent-hub.db'),
      size,
      queryTimeoutMs,
      maxQueueDepth,
      busyTimeoutMs,
    });
  }
  return sharedPool;
}

/** Drain and dispose the shared pool (e.g. on org/dataDir switch or shutdown). */
export async function shutdownSharedReaderPool(): Promise<void> {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = null;
  await pool.shutdown();
}
