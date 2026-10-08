/**
 * Widen a `<column> IN (...)` CHECK constraint on an existing SQLite table.
 *
 * SQLite cannot ALTER a CHECK, and `CREATE TABLE IF NOT EXISTS` never touches an
 * existing table, so an install created before a new enum value keeps rejecting
 * it. This rebuilds the table from its own stored DDL with only the IN-list
 * changed, which keeps every column (including ones added later by ALTER, in
 * whatever order this install has them) and recreates the table's own indexes
 * and triggers from their stored SQL.
 *
 * Statements go through `prepare().run()` rather than `exec` on purpose: `initDb`
 * records `exec`'d DDL for the additive schema reconciler, and the scratch
 * table must not end up in that record.
 */

import type Database from 'better-sqlite3';

export interface WidenInListCheckOptions {
  table: string;
  column: string;
  /** Values the IN-list must contain afterwards. Existing values are kept. */
  values: readonly string[];
}

function inListPattern(column: string): RegExp {
  return new RegExp(`(\\b${column}\\s+IN\\s*\\()([^)]*)(\\))`, 'i');
}

function parseInList(list: string): string[] {
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

/**
 * Rewrite the IN-list for `column` in a CREATE TABLE statement so it contains
 * every value in `values`. Returns null when the DDL has no such CHECK or it
 * already admits every value.
 */
export function widenInListDdl(
  ddl: string,
  column: string,
  values: readonly string[],
): string | null {
  const pattern = inListPattern(column);
  const match = pattern.exec(ddl);
  if (!match) return null;
  const current = parseInList(match[2]);
  const missing = values.filter((v) => !current.includes(v));
  if (missing.length === 0) return null;
  const list = [...current, ...missing].map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
  return ddl.replace(pattern, `$1${list}$3`);
}

function tableDdl(db: Database.Database, table: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string | null } | undefined;
  return row?.sql ?? null;
}

/**
 * Replace `table` with one built from `ddl` (which must keep the same columns in
 * the same order), copying every row and recreating the table's own indexes and
 * triggers.
 */
export function rebuildTableWithDdl(db: Database.Database, table: string, ddl: string): void {
  const scratch = `${table}__rebuild`;
  const header = /^\s*CREATE\s+TABLE\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1/i;
  if (!header.test(ddl)) throw new Error(`rebuildTableWithDdl: unrecognised DDL for ${table}`);
  const scratchDdl = ddl.replace(header, `CREATE TABLE "${scratch}"`);
  const dependents = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL",
      )
      .all(table) as { sql: string }[]
  ).map((r) => r.sql);

  // Children FK into most rebuilt tables; with foreign_keys ON the DROP would
  // cascade-delete them. legacy_alter_table keeps the RENAME from re-validating
  // other tables' triggers/views while the original name is briefly gone.
  // Both pragmas are no-ops inside a transaction, so they wrap it.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  const legacyWasOn = db.pragma('legacy_alter_table', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.prepare(`DROP TABLE IF EXISTS "${scratch}"`).run();
      db.prepare(scratchDdl).run();
      db.prepare(`INSERT INTO "${scratch}" SELECT * FROM "${table}"`).run();
      db.prepare(`DROP TABLE "${table}"`).run();
      db.prepare(`ALTER TABLE "${scratch}" RENAME TO "${table}"`).run();
      for (const sql of dependents) db.prepare(sql).run();
    })();
  } finally {
    if (!legacyWasOn) db.pragma('legacy_alter_table = OFF');
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

/** Rebuild `table` if its CHECK on `column` is missing any of `values`. Returns whether it rebuilt. */
export function widenInListCheck(db: Database.Database, opts: WidenInListCheckOptions): boolean {
  const ddl = tableDdl(db, opts.table);
  if (!ddl) return false;
  const widened = widenInListDdl(ddl, opts.column, opts.values);
  if (!widened) return false;
  rebuildTableWithDdl(db, opts.table, widened);
  return true;
}
