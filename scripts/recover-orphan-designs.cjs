#!/usr/bin/env node
/**
 * Recover orphan design directories by inserting matching rows into the
 * `designs` table. Orphans are directories under `<dataDir>/designs/<uuid>/`
 * that don't have a corresponding row in the `designs` table.
 *
 * This was written after an incident where `server/designs-store.test.ts`'s
 * bulk-wipe beforeEach ran against the production DB, deleting rows while
 * leaving the on-disk artifact dirs intact.
 *
 * Usage:
 *   node scripts/recover-orphan-designs.cjs              # dry run, prints plan
 *   node scripts/recover-orphan-designs.cjs --apply       # insert rows
 *   AGENT_HUB_DATA_DIR=/path node scripts/recover-orphan-designs.cjs --apply
 *
 * Safe to re-run: INSERT uses `OR IGNORE` so dirs that already have rows are
 * skipped. Design names are derived from each dir's `index.html` <title> tag
 * when present, otherwise fall back to "Recovered <shortId>".
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.AGENT_HUB_DATA_DIR || path.join(os.homedir(), '.agent-hub', 'data');
const DB_PATH = path.join(DATA_DIR, 'agent-hub.db');
const DESIGNS_ROOT = path.join(DATA_DIR, 'designs');
const APPLY = process.argv.includes('--apply');
const ORG_ID = process.env.ORG_ID || 'default';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function extractTitle(htmlPath) {
  try {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    const m = html.match(/<title>([^<]+)<\/title>/i);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found: ${DB_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(DESIGNS_ROOT)) {
    console.error(`Designs root not found: ${DESIGNS_ROOT}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  const existing = new Set(db.prepare('SELECT id FROM designs').all().map((r) => r.id));
  const allDirs = fs
    .readdirSync(DESIGNS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && UUID_RE.test(d.name))
    .map((d) => d.name);

  const orphans = allDirs.filter((id) => !existing.has(id));

  console.log(`DB:            ${DB_PATH}`);
  console.log(`Designs root:  ${DESIGNS_ROOT}`);
  console.log(`Org:           ${ORG_ID}`);
  console.log(`Existing rows: ${existing.size}`);
  console.log(`Total dirs:    ${allDirs.length}`);
  console.log(`Orphan dirs:   ${orphans.length}\n`);

  if (orphans.length === 0) {
    console.log('Nothing to recover.');
    db.close();
    return;
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO designs (id, name, org_id, created_at, updated_at)
     VALUES (?, ?, ?, datetime(?, 'unixepoch'), datetime(?, 'unixepoch'))`,
  );

  const plan = orphans.map((id) => {
    const dir = path.join(DESIGNS_ROOT, id);
    const indexPath = path.join(dir, 'index.html');
    const title = extractTitle(indexPath);
    const name = title || `Recovered ${id.slice(0, 8)}`;
    const stat = fs.statSync(dir);
    const mtime = Math.floor(stat.mtimeMs / 1000);
    return { id, name, mtime };
  });

  for (const { id, name, mtime } of plan) {
    console.log(`  ${APPLY ? 'INSERT' : 'WOULD INSERT'}  ${id}  ${new Date(mtime * 1000).toISOString()}  "${name}"`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to insert these rows.');
    db.close();
    return;
  }

  const tx = db.transaction((rows) => {
    for (const { id, name, mtime } of rows) {
      insert.run(id, name, ORG_ID, mtime, mtime);
    }
  });
  tx(plan);

  const after = db.prepare('SELECT COUNT(*) AS n FROM designs').get().n;
  console.log(`\nDone. designs row count: ${existing.size} -> ${after}`);
  db.close();
}

main();
