/**
 * Dedicated AWS infrastructure-monitoring store (`infra.db`).
 *
 * Decision INFRA-STORE: infra telemetry is high-volume and must not contend
 * with Agent Hub operational state, so it lives in its own SQLite database
 * (WAL) under the data directory, never in `agent-hub.db` or `orgs.db`. This
 * module owns that handle: init/recovery, the idempotent schema, and the
 * derived resource key that metric points and alert rows join on. The
 * collector, inventory sync, write queue, retention reaper and REST surface are
 * separate tickets that build on this store.
 *
 * All public helpers are thin, synchronous wrappers over `better-sqlite3`
 * against a single process-wide handle, so they can be unit-tested against a
 * scratch data dir without booting the server.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import { assertSafeTestDataDir } from '../db-safety.js';
import { reconcileSchema } from '../schema-reconcile.js';
import {
  INFRA_TABLES_SCHEMA,
  INFRA_INDEXES_SCHEMA,
  INFRA_DB_FILENAME,
  INFRA_RESOURCE_KEY_SEPARATOR,
} from './infra-schema.js';

let infraDb: Database.Database | null = null;

/** Test-only override of the `infra.db` location. `null` resets to default. */
let infraDbPathOverride: string | null = null;
export function setInfraDbPathForTests(p: string | null): void {
  infraDbPathOverride = p;
  if (infraDb) {
    try {
      infraDb.close();
    } catch {}
    infraDb = null;
  }
}

/**
 * Accessor for the shared `infra.db` handle. Throws if `initInfraDb()` has not
 * run — every caller is downstream of server startup.
 */
export function getInfraDb(): Database.Database {
  if (!infraDb) {
    throw new Error('infra.db not initialized — call initInfraDb() first');
  }
  return infraDb;
}

/** Whether the store has been opened in this process. */
export function isInfraDbInitialized(): boolean {
  return infraDb !== null;
}

/**
 * Open (or create) `infra.db` under `dataDir`, apply WAL + recovery pragmas,
 * and run the idempotent schema. Safe to call more than once for the same dir —
 * the second call is a no-op that keeps the cached handle.
 */
export function initInfraDb(dataDir: string): Database.Database {
  // Same fail-closed rail as initDb() / initLogsDb(): never let a test-runner
  // process open a database outside os.tmpdir(). See server/db-safety.ts.
  assertSafeTestDataDir(dataDir);

  if (infraDb && !infraDbPathOverride) return infraDb;

  const dbPath = infraDbPathOverride || path.join(dataDir, INFRA_DB_FILENAME);
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // WAL for concurrent readers (chart reads) alongside the single batched
  // collector writer. `normal` sync trades a small durability window (the last
  // few committed transactions on a hard crash) for throughput, which is the
  // right trade for sampled telemetry that is re-collectable from CloudWatch.
  // `wal_autocheckpoint` bounds the WAL against a collector burst;
  // `busy_timeout` lets a reader wait out the writer instead of throwing
  // SQLITE_BUSY.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('wal_autocheckpoint = 1000');

  // Safe startup/recovery: a prior hard crash can leave the WAL mid-commit.
  // `wal_checkpoint(TRUNCATE)` replays and resets it; `quick_check` surfaces
  // gross corruption in the log. We never throw on a dirty WAL — infra metrics
  // are best-effort and must not block boot.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    const integrity = db.pragma('quick_check', { simple: true });
    if (integrity !== 'ok') {
      console.warn(`[infra] infra.db quick_check returned: ${String(integrity)}`);
    }
  } catch (e) {
    console.warn('[infra] infra.db startup recovery pragma failed:', (e as Error).message);
  }

  db.exec(INFRA_TABLES_SCHEMA);

  // `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so
  // a column added to INFRA_TABLES_SCHEMA by a later ticket would never reach
  // an install whose infra.db predates the edit. Reconciling here makes "add
  // the column to the CREATE body" the complete action for this database too.
  // See server/schema-reconcile.ts for the additive-only contract and for why
  // un-addable drift warns instead of throwing.
  //
  // This runs BEFORE the indexes: an index over a freshly added column would
  // throw here on an older install, which is the one gap the reconciler's own
  // docs call out as still needing a hand-written migration.
  const { alters, blocked } = reconcileSchema(db, [INFRA_TABLES_SCHEMA]);
  for (const alter of alters) {
    console.log(`[infra] schema drift repaired: added ${alter.table}.${alter.column}`);
  }
  for (const drift of blocked) {
    console.warn(
      `[infra] schema drift NOT repaired: ${drift.table}.${drift.column} (${drift.reason}). ` +
        `This column is in the CREATE TABLE body but missing from the live table; ` +
        `it needs a hand-written migration.`,
    );
  }

  db.exec(INFRA_INDEXES_SCHEMA);

  infraDb = db;
  return db;
}

/** Close the handle (tests / shutdown). */
export function closeInfraDb(): void {
  if (infraDb) {
    try {
      infraDb.close();
    } catch {}
    infraDb = null;
  }
}

/** The tuple that uniquely identifies one monitored resource. */
export interface InfraResourceIdentity {
  projectId: string;
  accountId: string;
  region: string;
  service: string;
  resourceId: string;
}

/**
 * Derive the stable primary key for a resource.
 *
 * Metric points, alert rows and chart reads all join on this key rather than on
 * the five-column tuple, so it has to be injective: two different resources may
 * never collide, or their series merge into one chart. Each component is
 * percent-encoded before joining, which removes the separator (and every other
 * reserved byte) from the component alphabet — an ARN resource id full of `:`
 * and `/` is as safe as a bare instance id.
 */
export function infraResourceKey(identity: InfraResourceIdentity): string {
  return [
    identity.projectId,
    identity.accountId,
    identity.region,
    identity.service,
    identity.resourceId,
  ]
    .map((part) => encodeURIComponent(part))
    .join(INFRA_RESOURCE_KEY_SEPARATOR);
}
