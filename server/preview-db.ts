/**
 * preview-db.ts — DB snapshot utilities for preview environments.
 *
 * Two modes:
 *   1. **snapshot** — Uses the SQLite Online Backup API (via better-sqlite3's
 *      `db.backup()`) to create a consistent, point-in-time copy of the live
 *      database while it's running under WAL mode.
 *   2. **seed** — Opens a fresh database at the target path and runs the full
 *      schema DDL + optional seed data so the preview starts with a known state.
 *
 * Both modes produce a self-contained `.db` file that can be mounted into a
 * preview container. The copy is fully independent — mutations in the preview
 * never affect the source.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, unlinkSync, readdirSync, statSync, rmSync } from 'fs';
import path from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface SnapshotResult {
  mode: 'snapshot' | 'seed';
  path: string;
  sizeBytes: number;
  createdAt: string;
  tables: string[];
}

/** Lightweight snapshot info returned by listSnapshots (no DB connection per file). */
export interface SnapshotInfo {
  mode: 'snapshot' | 'seed';
  path: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

export interface SnapshotOptions {
  /** Directory to write the snapshot file into. Created if missing. */
  destDir: string;
  /** Optional filename override (default: preview-<timestamp>.db) */
  filename?: string;
}

export interface SeedOptions extends SnapshotOptions {
  /** Optional source DB to extract schema from. Falls back to FALLBACK_SEED_SCHEMA. */
  sourceDb?: Database.Database;
}

export interface SeedRow {
  table: string;
  columns: string[];
  rows: unknown[][];
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_SNAPSHOTS = 5;

/** Safe filename pattern — alphanumeric, hyphens, underscores, dots, ending in .db */
const SAFE_FILENAME_RE = /^[a-zA-Z0-9_.-]+\.db$/;

// ─── Seed Schema ────────────────────────────────────────────────
// Dynamically extracted from the live database rather than maintained
// as a separate copy. The `extractSchema()` function reads
// sqlite_master to get all CREATE TABLE/INDEX statements, ensuring
// seed-mode previews always match the current production schema.

/**
 * Extract the full schema DDL from an existing database.
 * Returns all CREATE TABLE and CREATE INDEX statements.
 */
function extractSchema(sourceDb: Database.Database): string {
  const rows = sourceDb
    .prepare(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name",
    )
    .all() as { sql: string }[];
  return rows.map((r) => r.sql + ';').join('\n');
}

/**
 * Minimal fallback schema used when no source DB is available (e.g., tests).
 * Covers the most commonly needed tables for preview functionality.
 */
const FALLBACK_SEED_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    engine TEXT,
    model TEXT,
    engine_session_id TEXT,
    use_worktree INTEGER NOT NULL DEFAULT 0,
    ask_mode INTEGER NOT NULL DEFAULT 0,
    project_id TEXT,
    cron_id INTEGER,
    worktree_path TEXT,
    worktree_branch TEXT,
    git_worktree_detected INTEGER DEFAULT NULL,
    changes_ready TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    cost_usd REAL,
    duration_ms INTEGER,
    model TEXT,
    engine TEXT,
    session_id_ext TEXT,
    attachments TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS heartbeat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    prompt TEXT NOT NULL,
    result TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'success', 'error')),
    project_id TEXT
  );

  CREATE TABLE IF NOT EXISTS crons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    last_result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    agent_id TEXT,
    project_id TEXT,
    next_run_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_heartbeat_agent ON heartbeat_logs(agent_id);
`;

// ─── Default seed data ──────────────────────────────────────────

const DEFAULT_SEED_DATA: SeedRow[] = [
  {
    table: 'sessions',
    columns: ['id', 'agent_id', 'name', 'engine'],
    rows: [['preview-session-1', 'preview-agent', 'Preview Session', 'claude-code']],
  },
  {
    table: 'messages',
    columns: ['id', 'session_id', 'role', 'content'],
    rows: [
      ['msg-1', 'preview-session-1', 'user', 'Hello, this is a preview environment.'],
      ['msg-2', 'preview-session-1', 'assistant', 'Welcome to the Agent Hub preview!'],
    ],
  },
];

// ─── Core functions ─────────────────────────────────────────────

/**
 * Create a snapshot of the live database using the SQLite Online Backup API.
 * Safe to call while the DB is open and serving requests under WAL mode.
 */
export async function createSnapshot(
  sourceDb: Database.Database,
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  mkdirSync(options.destDir, { recursive: true });

  const filename = options.filename || `preview-${Date.now()}.db`;
  validateFilename(filename);
  const destPath = path.join(options.destDir, filename);

  // Resolve and validate the destination stays inside destDir (defense-in-depth)
  const resolvedDest = path.resolve(destPath);
  if (
    !resolvedDest.startsWith(path.resolve(options.destDir) + path.sep) &&
    resolvedDest !== path.resolve(options.destDir)
  ) {
    throw new Error('Snapshot destination escapes the target directory');
  }

  // Remove existing file atomically (no TOCTOU race)
  rmSync(destPath, { force: true });

  // Use better-sqlite3's backup() — wraps sqlite3_backup_init/step/finish
  await sourceDb.backup(destPath);

  // Prune old snapshots (keep only the most recent MAX_SNAPSHOTS)
  pruneSnapshots(options.destDir);

  const stat = statSync(destPath);
  const tables = listTables(destPath);

  return {
    mode: 'snapshot',
    path: destPath,
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
    tables,
  };
}

/**
 * Create a fresh seeded database with the core schema and optional seed data.
 * The result is a clean, minimal DB suitable for testing or demo previews.
 *
 * If `options.sourceDb` is provided, the schema is extracted from the live
 * database (ensuring the preview always matches production). Otherwise falls
 * back to a minimal built-in schema.
 */
export function createSeedDb(options: SeedOptions, seedData?: SeedRow[]): SnapshotResult {
  mkdirSync(options.destDir, { recursive: true });

  const filename = options.filename || `preview-seed-${Date.now()}.db`;
  validateFilename(filename);
  const destPath = path.join(options.destDir, filename);

  // Resolve and validate the destination stays inside destDir (defense-in-depth)
  const resolvedDest = path.resolve(destPath);
  if (
    !resolvedDest.startsWith(path.resolve(options.destDir) + path.sep) &&
    resolvedDest !== path.resolve(options.destDir)
  ) {
    throw new Error('Seed destination escapes the target directory');
  }

  // Remove existing file atomically (no TOCTOU race)
  rmSync(destPath, { force: true });

  const seedDb = new Database(destPath);
  seedDb.pragma('journal_mode = WAL');
  seedDb.pragma('foreign_keys = ON');

  // Create schema — prefer extracting from live DB to avoid drift
  if (options.sourceDb) {
    const schemaDdl = extractSchema(options.sourceDb);
    seedDb.exec(schemaDdl);
  } else {
    seedDb.exec(FALLBACK_SEED_SCHEMA);
  }

  // Insert seed data with validation against actual table/column names
  const data = seedData || DEFAULT_SEED_DATA;
  const knownTables = new Set(
    (
      seedDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name),
  );

  for (const { table, columns, rows } of data) {
    // Validate table name against actual schema to prevent SQL injection
    if (!knownTables.has(table)) {
      throw new Error(`Seed data references unknown table: ${table}`);
    }
    // Validate column names — only allow identifier-safe characters
    for (const col of columns) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
        throw new Error(`Invalid column name in seed data: ${col}`);
      }
    }

    const placeholders = columns.map(() => '?').join(', ');
    const quotedCols = columns.map((c) => `"${c}"`).join(', ');
    const stmt = seedDb.prepare(
      `INSERT OR IGNORE INTO "${table}" (${quotedCols}) VALUES (${placeholders})`,
    );
    for (const row of rows) {
      stmt.run(...row);
    }
  }

  // Query tables from the already-open handle (avoids opening a second connection)
  const tables = (
    seedDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

  seedDb.close();

  const stat = statSync(destPath);

  return {
    mode: 'seed',
    path: destPath,
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
    tables,
  };
}

/**
 * List all snapshot files in the given directory, sorted newest first.
 * Returns lightweight info without opening each DB (avoids N connections).
 * Use `getSnapshotDetail()` to fetch table lists for a specific snapshot.
 */
export function listSnapshots(dir: string): SnapshotInfo[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.startsWith('preview-') && f.endsWith('.db'))
    .map((f) => {
      const fullPath = path.join(dir, f);
      const stat = statSync(fullPath);
      return {
        mode: (f.includes('-seed-') ? 'seed' : 'snapshot') as 'snapshot' | 'seed',
        path: fullPath,
        filename: f,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Get detailed info for a specific snapshot, including table list.
 * Opens a read-only connection to the DB file to query sqlite_master.
 */
export function getSnapshotDetail(filePath: string): SnapshotResult | null {
  if (!existsSync(filePath)) return null;
  const base = path.basename(filePath);
  if (!base.startsWith('preview-') || !base.endsWith('.db')) return null;

  const stat = statSync(filePath);
  const tables = listTables(filePath);

  return {
    mode: (base.includes('-seed-') ? 'seed' : 'snapshot') as 'snapshot' | 'seed',
    path: filePath,
    sizeBytes: stat.size,
    createdAt: stat.mtime.toISOString(),
    tables,
  };
}

/**
 * Delete a specific snapshot file.
 */
export function deleteSnapshot(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  // Safety: only delete files that look like our snapshots
  const base = path.basename(filePath);
  if (!base.startsWith('preview-') || !base.endsWith('.db')) return false;
  unlinkSync(filePath);
  // Clean up WAL/SHM if present
  for (const suffix of ['-wal', '-shm']) {
    const walPath = filePath + suffix;
    if (existsSync(walPath)) unlinkSync(walPath);
  }
  return true;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Validate that a filename is safe — no path traversal, no special characters.
 */
function validateFilename(filename: string): void {
  if (!SAFE_FILENAME_RE.test(filename)) {
    throw new Error(
      `Invalid snapshot filename: "${filename}". ` +
        'Must match /^[a-zA-Z0-9_.-]+\\.db$/ (no path separators or special characters).',
    );
  }
}

function listTables(dbPath: string): string[] {
  const tmpDb = new Database(dbPath, { readonly: true });
  try {
    const rows = tmpDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    tmpDb.close();
  }
}

function pruneSnapshots(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('preview-') && f.endsWith('.db'))
    .map((f) => ({
      name: f,
      path: path.join(dir, f),
      mtime: statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  // Keep only the newest MAX_SNAPSHOTS
  for (const old of files.slice(MAX_SNAPSHOTS)) {
    try {
      unlinkSync(old.path);
      for (const suffix of ['-wal', '-shm']) {
        const walPath = old.path + suffix;
        if (existsSync(walPath)) unlinkSync(walPath);
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Return the default snapshot directory for a given data dir.
 */
export function getSnapshotDir(dataDir: string): string {
  return path.join(dataDir, 'snapshots');
}
