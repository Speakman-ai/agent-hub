/**
 * Additive schema reconciliation.
 *
 * ## Why this exists
 *
 * `initDb` builds the schema with `CREATE TABLE IF NOT EXISTS`. On any database
 * where the table already exists that statement is a **no-op** — SQLite does not
 * diff the body against the live table. So adding a column to a CREATE body only
 * takes effect on installs whose database is younger than the edit. Every older
 * install silently keeps the narrower table.
 *
 * That drift is invisible until two things line up: a process restart, and a
 * build whose prepared statements reference the missing column. `initDb`
 * prepares ~755 statements eagerly, and `better-sqlite3` validates column names
 * at *prepare* time, so a single drifted column throws before the HTTP listener
 * binds. The process crash-loops, the load balancer's target never goes healthy,
 * and the whole deployment serves 502s — from one missing column.
 *
 * That is exactly the 2026-07-29 prod outage:
 * `finalize_kickoff_claims.job_filter` was added to the CREATE body only, while
 * the sibling `finalize_runs.job_filter` in the same change got a real
 * `ALTER TABLE` migration. Prod's `finalize_kickoff_claims` predated the edit,
 * so the column never appeared, and the first image to reference it took the
 * site down.
 *
 * ## What this does
 *
 * After all DDL has run, it compares every `CREATE TABLE` this process executed
 * against the live table's actual columns and issues
 * `ALTER TABLE ... ADD COLUMN` for anything missing. That makes "add the column
 * to the CREATE body" the *complete* action, which is what every author already
 * assumes it is.
 *
 * ## What it deliberately does not do
 *
 * It is **additive only**. It never drops a column, changes a type, rewrites a
 * CHECK constraint, or touches data. Those need hand-written, reviewed
 * migrations; the reconciler exists to kill the boring failure mode, not to be
 * a migration framework.
 *
 * Columns SQLite refuses to add to an existing table (PRIMARY KEY, UNIQUE,
 * NOT NULL with no constant default, generated columns, and so on) are reported
 * as `blocked` rather than applied — see `reconcileSchema` for why that is a
 * warning and not a thrown error.
 *
 * ## Known limitation: it runs after all DDL, not between statements
 *
 * Reconciliation needs the complete set of `CREATE TABLE` bodies, so it can only
 * run once every DDL block has executed. That fully covers the crash vector that
 * caused the outage — eagerly prepared statements, which run afterwards — but
 * NOT a statement that references a drifted column *during* schema setup. The
 * usual shape is a `CREATE INDEX ... ON t(new_column)` sitting in the same
 * `db.exec` block as the CREATE TABLE: it throws before this ever runs. Indexes
 * over freshly added columns therefore still need the column ordered ahead of
 * them by a hand-written `ALTER TABLE` migration, exactly as
 * `idx_support_tickets_unread` / `support_tickets.read_at` does today.
 */

import type Database from 'better-sqlite3';

/** A single column parsed out of a `CREATE TABLE` body. */
export interface ParsedColumn {
  /** Bare (unquoted) column name. */
  name: string;
  /** Everything after the name, verbatim: type, constraints, default. */
  definition: string;
  /** Whether SQLite permits adding this column via `ALTER TABLE ADD COLUMN`. */
  addable: boolean;
  /** Why the column cannot be added. Set only when `addable` is false. */
  reason?: string;
}

/** A table parsed out of a `CREATE TABLE` statement. */
export interface ParsedTable {
  /** Bare (unquoted) table name. */
  table: string;
  columns: ParsedColumn[];
}

/** An `ALTER TABLE ADD COLUMN` the reconciler intends to run. */
export interface SchemaAlter {
  table: string;
  column: string;
  sql: string;
}

/** A column that is missing from the live table but cannot be auto-added. */
export interface SchemaDrift {
  table: string;
  column: string;
  reason: string;
}

export interface SchemaReconciliationPlan {
  alters: SchemaAlter[];
  blocked: SchemaDrift[];
}

/**
 * Table-level constraint keywords. A body part starting with one of these is a
 * constraint (`PRIMARY KEY (a, b)`, `FOREIGN KEY ...`), not a column.
 */
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'FOREIGN',
  'UNIQUE',
  'CHECK',
  'EXCLUDE',
]);

/** Identifier, optionally quoted with `"`, backticks, or `[]`. */
const IDENTIFIER = String.raw`"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*`;

/**
 * `CREATE TABLE [IF NOT EXISTS] <name> (`.
 *
 * `\bCREATE\s+TABLE\b` requires TABLE to immediately follow CREATE, so
 * `CREATE VIRTUAL TABLE` (FTS5) and `CREATE TEMP TABLE` do not match — neither
 * is reconcilable by `ALTER TABLE ADD COLUMN`.
 */
const CREATE_TABLE_RE = new RegExp(
  String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})\s*\(`,
  'gi',
);

const LEADING_IDENTIFIER_RE = new RegExp(String.raw`^(${IDENTIFIER})`);

/** Strip surrounding `"`, backtick, or `[]` quoting from an identifier. */
function unquoteIdentifier(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/""/g, '"');
  if (raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1).replace(/``/g, '`');
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1);
  return raw;
}

/** Double-quote an identifier for safe interpolation into generated SQL. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Copy a quoted run starting at `i` (which must point at the opening quote).
 * Returns the literal text including both quotes and the index just past it.
 * Handles SQL's doubled-quote escape (`'it''s'`).
 */
function readQuoted(sql: string, i: number): [string, number] {
  const quote = sql[i];
  if (quote === '[') {
    let out = '[';
    let j = i + 1;
    while (j < sql.length && sql[j] !== ']') out += sql[j++];
    if (j < sql.length) out += sql[j++];
    return [out, j];
  }
  let out = quote;
  let j = i + 1;
  while (j < sql.length) {
    const c = sql[j];
    if (c === quote) {
      if (sql[j + 1] === quote) {
        out += c + c;
        j += 2;
        continue;
      }
      out += c;
      j += 1;
      break;
    }
    out += c;
    j += 1;
  }
  return [out, j];
}

function isQuoteChar(c: string): boolean {
  return c === "'" || c === '"' || c === '`' || c === '[';
}

/**
 * Remove `--` line comments and block comments, leaving string literals and
 * quoted identifiers untouched. The schema in `server/db.ts` is heavily
 * commented inside CREATE bodies, so this has to run before column parsing.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (isQuoteChar(ch)) {
      const [text, next] = readQuoted(sql, i);
      out += text;
      i = next;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Index of the `)` matching the `(` at `openIdx`, or -1 if unbalanced.
 * Parens inside string literals do not count.
 */
function findMatchingParen(sql: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < sql.length) {
    const ch = sql[i];
    if (isQuoteChar(ch)) {
      [, i] = readQuoted(sql, i);
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Split a CREATE TABLE body on top-level commas. Commas nested in parens
 * (`CHECK(x IN ('a','b'))`, `NUMERIC(10,2)`) or inside literals do not split.
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (isQuoteChar(ch)) {
      const [text, next] = readQuoted(body, i);
      current += text;
      i = next;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

interface ColumnDefault {
  /** `expression` defaults cannot be used by ALTER TABLE ADD COLUMN. */
  kind: 'constant' | 'expression';
  isNull: boolean;
}

/**
 * Parse the DEFAULT clause of a column definition, if any.
 *
 * SQLite treats parenthesised expressions and the CURRENT_* keywords as
 * non-constant, and rejects both in ALTER TABLE ADD COLUMN.
 */
function extractDefault(definition: string): ColumnDefault | null {
  const marker = /\bDEFAULT\b/i.exec(definition);
  if (!marker) return null;
  const rest = definition.slice(marker.index + marker[0].length).trimStart();
  if (rest.startsWith('(')) return { kind: 'expression', isNull: false };
  const token = /^('(?:[^']|'')*'|"[^"]*"|[^\s,)]+)/.exec(rest);
  const value = token ? token[1] : '';
  const upper = value.toUpperCase();
  if (upper === 'CURRENT_TIME' || upper === 'CURRENT_DATE' || upper === 'CURRENT_TIMESTAMP') {
    return { kind: 'expression', isNull: false };
  }
  return { kind: 'constant', isNull: upper === 'NULL' };
}

/**
 * Whether SQLite will accept this column definition in an
 * `ALTER TABLE ... ADD COLUMN`.
 *
 * Restrictions per https://sqlite.org/lang_altertable.html#altertabaddcol.
 * We assume `foreign_keys = ON` (which `initDb` sets), hence the REFERENCES
 * rule.
 */
function assessAddable(definition: string): { addable: boolean; reason?: string } {
  const upper = definition.toUpperCase();
  if (/\bPRIMARY\s+KEY\b/.test(upper)) {
    return { addable: false, reason: 'PRIMARY KEY columns cannot be added to an existing table' };
  }
  if (/\bUNIQUE\b/.test(upper)) {
    return { addable: false, reason: 'UNIQUE columns cannot be added to an existing table' };
  }
  if (/\bGENERATED\s+ALWAYS\b/.test(upper) || /\bAS\s*\(/.test(upper)) {
    return { addable: false, reason: 'generated columns cannot be added to an existing table' };
  }
  const columnDefault = extractDefault(definition);
  const notNull = /\bNOT\s+NULL\b/.test(upper);
  if (columnDefault?.kind === 'expression') {
    return { addable: false, reason: 'DEFAULT must be a constant, not an expression' };
  }
  if (notNull && !columnDefault) {
    return { addable: false, reason: 'NOT NULL without a DEFAULT' };
  }
  if (notNull && columnDefault?.isNull) {
    return { addable: false, reason: 'NOT NULL with a NULL DEFAULT' };
  }
  if (/\bREFERENCES\b/.test(upper) && (notNull || (columnDefault && !columnDefault.isNull))) {
    return {
      addable: false,
      reason: 'REFERENCES columns must default to NULL while foreign_keys is ON',
    };
  }
  return { addable: true };
}

/** Parse one comma-separated CREATE TABLE body part, or null if it is a constraint. */
function parseColumnDef(part: string): ParsedColumn | null {
  const match = LEADING_IDENTIFIER_RE.exec(part);
  if (!match) return null;
  const name = unquoteIdentifier(match[1]);
  if (TABLE_CONSTRAINT_KEYWORDS.has(name.toUpperCase())) return null;
  const definition = part.slice(match[0].length).trim();
  const { addable, reason } = assessAddable(definition);
  return { name, definition, addable, ...(reason ? { reason } : {}) };
}

/**
 * Extract every `CREATE TABLE` (not `CREATE VIRTUAL TABLE`) in a DDL string,
 * with its column list. Comments are stripped first.
 */
export function parseCreateTableStatements(sql: string): ParsedTable[] {
  const clean = stripSqlComments(sql);
  const tables: ParsedTable[] = [];
  CREATE_TABLE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CREATE_TABLE_RE.exec(clean)) !== null) {
    const openIdx = match.index + match[0].length - 1;
    const closeIdx = findMatchingParen(clean, openIdx);
    if (closeIdx === -1) continue;
    const body = clean.slice(openIdx + 1, closeIdx);
    const columns = splitTopLevel(body)
      .map(parseColumnDef)
      .filter((c): c is ParsedColumn => c !== null);
    if (columns.length > 0) {
      tables.push({ table: unquoteIdentifier(match[1]), columns });
    }
    CREATE_TABLE_RE.lastIndex = closeIdx;
  }
  return tables;
}

/**
 * Merge repeated CREATE TABLE statements for the same table (keyed
 * case-insensitively, as SQLite compares identifiers). Later definitions win.
 */
function mergeExpected(tables: ParsedTable[]): Map<string, ParsedTable> {
  const merged = new Map<string, ParsedTable>();
  for (const table of tables) {
    const key = table.table.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { table: table.table, columns: [...table.columns] });
      continue;
    }
    for (const column of table.columns) {
      const at = existing.columns.findIndex(
        (c) => c.name.toLowerCase() === column.name.toLowerCase(),
      );
      if (at === -1) existing.columns.push(column);
      else existing.columns[at] = column;
    }
  }
  return merged;
}

/**
 * Diff the expected schema against the live one and produce the additive plan.
 *
 * `live` maps a lowercased table name to its current column names. Expected
 * tables absent from `live` are skipped: either the CREATE just made them (so
 * they match by construction) or a migration dropped/renamed them, and inventing
 * a table here would resurrect something a migration deliberately removed.
 */
export function planSchemaReconciliation(
  expected: ParsedTable[],
  live: Map<string, string[]>,
): SchemaReconciliationPlan {
  const alters: SchemaAlter[] = [];
  const blocked: SchemaDrift[] = [];

  for (const [key, table] of mergeExpected(expected)) {
    const liveColumns = live.get(key);
    if (!liveColumns) continue;
    const present = new Set(liveColumns.map((c) => c.toLowerCase()));
    for (const column of table.columns) {
      if (present.has(column.name.toLowerCase())) continue;
      if (!column.addable) {
        blocked.push({
          table: table.table,
          column: column.name,
          reason: column.reason ?? 'not addable',
        });
        continue;
      }
      alters.push({
        table: table.table,
        column: column.name,
        sql:
          `ALTER TABLE ${quoteIdentifier(table.table)} ` +
          `ADD COLUMN ${quoteIdentifier(column.name)} ${column.definition}`.trimEnd(),
      });
    }
  }

  return { alters, blocked };
}

/** Minimal surface of a better-sqlite3 handle that the reconciler needs. */
type SchemaDb = Pick<Database.Database, 'exec' | 'prepare' | 'pragma'>;

/** Read every real table's current column list from the live database. */
export function readLiveSchema(db: SchemaDb): Map<string, string[]> {
  const live = new Map<string, string[]>();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
    name: string;
  }[];
  for (const { name } of tables) {
    const columns = db.pragma(`table_info(${quoteIdentifier(name)})`) as { name: string }[];
    live.set(
      name.toLowerCase(),
      columns.map((c) => c.name),
    );
  }
  return live;
}

/**
 * Apply additive reconciliation to `db` using the DDL this process executed.
 *
 * Returns what was applied and what could not be. **Blocked columns are
 * reported, not thrown.** Throwing here would convert latent, harmless drift on
 * an existing install into a hard boot failure on its next deploy — the exact
 * outage class this module exists to prevent. If a blocked column actually
 * matters, statement preparation still fails immediately afterwards, exactly as
 * it does today, but now with this diagnostic already in the log.
 */
export function reconcileSchema(db: SchemaDb, ddl: string[]): SchemaReconciliationPlan {
  const expected = ddl.flatMap((sql) => parseCreateTableStatements(sql));
  const plan = planSchemaReconciliation(expected, readLiveSchema(db));

  const applied: SchemaAlter[] = [];
  for (const alter of plan.alters) {
    try {
      db.exec(alter.sql);
      applied.push(alter);
    } catch (err) {
      plan.blocked.push({
        table: alter.table,
        column: alter.column,
        reason: `ALTER TABLE failed: ${(err as Error).message}`,
      });
    }
  }

  return { alters: applied, blocked: plan.blocked };
}
