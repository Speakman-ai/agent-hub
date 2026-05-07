#!/usr/bin/env node
/**
 * One-shot prune of orphan session_events rows + VACUUM to reclaim
 * file-system space.
 *
 * Why this exists: `session_events.parent_id` references
 * `messages.id` / `heartbeat_logs.id` / `cron_logs.id` but the table
 * has no FK / cascade. When parents are deleted (manual session
 * delete, archived-session purge, etc.) the events become orphans
 * that accumulate forever. Prior to this script, prod held 659,649
 * orphan rows (2.36 GiB) vs. only 16,654 live rows (53 MiB).
 *
 * The same sweep runs daily inside `runWorkspacePurge` going forward
 * via `pruneOrphanSessionEvents` in `server/session-events-store.ts`.
 * This script exists for one-time backfill: it does the orphan sweep
 * and then VACUUMs to actually shrink the file (without VACUUM, the
 * pages are reclaimed for reuse but the .db file size doesn't drop).
 *
 * Usage:
 *   node scripts/prune-session-events.cjs                 # dry run
 *   node scripts/prune-session-events.cjs --apply          # delete + VACUUM
 *   AGENT_HUB_DATA_DIR=/path node scripts/prune-session-events.cjs --apply
 *
 * Safe to re-run: orphan SELECTs have no side effects, VACUUM is a
 * no-op when there's nothing to reclaim. Always grab a backup of
 * `agent-hub.db` before --apply on a host you can't easily restore.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.AGENT_HUB_DATA_DIR || path.join(os.homedir(), '.agent-hub', 'data');
const DB_PATH = path.join(DATA_DIR, 'agent-hub.db');
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(DB_PATH)) {
  console.error(`[prune] DB not found: ${DB_PATH}`);
  process.exit(1);
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

const sizeBefore = fs.statSync(DB_PATH).size;
console.log(`[prune] DB: ${DB_PATH}`);
console.log(`[prune] Size before: ${fmtBytes(sizeBefore)}`);

const db = new Database(DB_PATH);

// Count orphans by parent_kind without deleting (used by both dry-run
// and apply paths so the report reflects the actual state).
const counts = {
  message: db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS bytes
       FROM session_events
       WHERE parent_kind = 'message' AND parent_id NOT IN (SELECT id FROM messages)`,
    )
    .get(),
  heartbeat: db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS bytes
       FROM session_events
       WHERE parent_kind = 'heartbeat'
         AND parent_id NOT IN (SELECT CAST(id AS TEXT) FROM heartbeat_logs)`,
    )
    .get(),
  cron: db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(LENGTH(payload)) AS bytes
       FROM session_events
       WHERE parent_kind = 'cron'
         AND parent_id NOT IN (SELECT CAST(id AS TEXT) FROM cron_logs)`,
    )
    .get(),
};

const totalRows = counts.message.n + counts.heartbeat.n + counts.cron.n;
const totalBytes =
  (counts.message.bytes || 0) + (counts.heartbeat.bytes || 0) + (counts.cron.bytes || 0);

console.log(
  `[prune] Orphans: message=${counts.message.n} (${fmtBytes(counts.message.bytes || 0)}), ` +
    `heartbeat=${counts.heartbeat.n} (${fmtBytes(counts.heartbeat.bytes || 0)}), ` +
    `cron=${counts.cron.n} (${fmtBytes(counts.cron.bytes || 0)})`,
);
console.log(`[prune] Total: ${totalRows} rows, ${fmtBytes(totalBytes)}`);

if (!APPLY) {
  console.log('[prune] Dry run — pass --apply to delete + VACUUM.');
  db.close();
  process.exit(0);
}

if (totalRows === 0) {
  console.log('[prune] Nothing to delete; skipping VACUUM.');
  db.close();
  process.exit(0);
}

// Delete in a transaction so a SQLITE_BUSY mid-sweep doesn't leave us
// half-pruned.
const sweep = db.transaction(() => {
  const m = db
    .prepare(
      `DELETE FROM session_events
       WHERE parent_kind = 'message' AND parent_id NOT IN (SELECT id FROM messages)`,
    )
    .run().changes;
  const h = db
    .prepare(
      `DELETE FROM session_events
       WHERE parent_kind = 'heartbeat'
         AND parent_id NOT IN (SELECT CAST(id AS TEXT) FROM heartbeat_logs)`,
    )
    .run().changes;
  const c = db
    .prepare(
      `DELETE FROM session_events
       WHERE parent_kind = 'cron'
         AND parent_id NOT IN (SELECT CAST(id AS TEXT) FROM cron_logs)`,
    )
    .run().changes;
  return { m, h, c };
});

const start = Date.now();
const r = sweep();
const sweepMs = Date.now() - start;
console.log(
  `[prune] Deleted message=${r.m}, heartbeat=${r.h}, cron=${r.c} in ${sweepMs}ms.`,
);

// VACUUM is a non-transactional rewrite of the entire DB file. It can
// take a while on a multi-GiB DB; print a progress hint so an operator
// doesn't think the script hung.
console.log('[prune] Running VACUUM (this may take 30s+ on a multi-GiB DB)...');
const vacStart = Date.now();
db.exec('VACUUM');
console.log(`[prune] VACUUM complete in ${Date.now() - vacStart}ms.`);

db.close();
const sizeAfter = fs.statSync(DB_PATH).size;
console.log(`[prune] Size after:  ${fmtBytes(sizeAfter)}`);
console.log(`[prune] Reclaimed:   ${fmtBytes(sizeBefore - sizeAfter)}`);
