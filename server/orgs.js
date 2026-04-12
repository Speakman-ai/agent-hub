/**
 * Server-side organization management (LOCAL orgs only).
 *
 * Orgs are stored in the ROOT database (config.dataDir), not per-org databases.
 * This ensures the org list is always accessible regardless of which org is active.
 *
 * Remote orgs (bookmarks to other servers) are stored client-side in localStorage
 * because they need to be accessible before connecting to any server.
 *
 * Each local org maps to a data directory:
 *   - "default" → config.dataDir (the server's original location)
 *   - anything else → ~/.agent-hub/orgs/<orgId>/
 */

import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import config from './config.js';

const HOME = process.env.HOME || '/home/' + (process.env.USER || 'user');

let orgsDb;
let orgsStmts;

/** Get the data directory for an org ID. */
export function orgDataDir(orgId) {
  if (orgId === 'default') return config.dataDir;
  return path.join(HOME, '.agent-hub', 'orgs', orgId);
}

/** Initialize the orgs database in the root data directory. */
export function initOrgsDb() {
  const dbPath = path.join(config.dataDir, 'orgs.db');
  orgsDb = new Database(dbPath);
  orgsDb.pragma('journal_mode = WAL');

  orgsDb.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'local' CHECK(mode IN ('local', 'remote')),
      color TEXT NOT NULL DEFAULT '#6366f1',
      remote_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Tracks which org the server should load on startup
    CREATE TABLE IF NOT EXISTS active_org (
      key TEXT PRIMARY KEY DEFAULT 'active' CHECK(key = 'active'),
      org_id TEXT NOT NULL DEFAULT 'default'
    );
  `);

  // Migration: add position column if missing
  try {
    orgsDb.prepare('SELECT position FROM orgs LIMIT 1').get();
  } catch {
    orgsDb.exec('ALTER TABLE orgs ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  }

  orgsStmts = {
    getAll: orgsDb.prepare('SELECT * FROM orgs ORDER BY position ASC, created_at ASC'),
    getById: orgsDb.prepare('SELECT * FROM orgs WHERE id = ?'),
    insert: orgsDb.prepare(
      `INSERT INTO orgs (id, name, mode, color, remote_url, api_key, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    update: orgsDb.prepare(
      `UPDATE orgs SET name = ?, mode = ?, color = ?, remote_url = ?, api_key = ?, position = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ),
    delete: orgsDb.prepare('DELETE FROM orgs WHERE id = ?'),
    count: orgsDb.prepare('SELECT COUNT(*) as count FROM orgs'),
    getActiveOrgId: orgsDb.prepare("SELECT org_id FROM active_org WHERE key = 'active'"),
    setActiveOrgId: orgsDb.prepare(
      `INSERT INTO active_org (key, org_id) VALUES ('active', ?)
       ON CONFLICT(key) DO UPDATE SET org_id = excluded.org_id`,
    ),
  };

  // Seed default org if table is empty
  const { count } = orgsStmts.count.get();
  if (count === 0) {
    seedOrgsFromDisk();
  }
}

/** Seed orgs from existing disk directories + create a default org. */
function seedOrgsFromDisk() {
  // Always create a "default" org pointing to the server's main data dir
  orgsStmts.insert.run('default', 'Default', 'local', '#6366f1', '', '', 0);

  // Scan ~/.agent-hub/orgs/ for existing org directories and import them
  const orgsDir = path.join(HOME, '.agent-hub', 'orgs');
  if (!existsSync(orgsDir)) return;

  let entries;
  try {
    entries = readdirSync(orgsDir, { withFileTypes: true });
  } catch {
    return;
  }

  let position = 1;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const orgId = entry.name;
    const orgPath = path.join(orgsDir, orgId);

    // Try to read projects.json to derive a meaningful name
    let name = orgId;
    try {
      const projects = JSON.parse(readFileSync(path.join(orgPath, 'projects.json'), 'utf-8'));
      if (Array.isArray(projects) && projects.length > 0) {
        // Use first project name as the org name
        name = projects[0].name || orgId;
      }
    } catch {}

    try {
      orgsStmts.insert.run(orgId, name, 'local', '#6366f1', '', '', position++);
    } catch {
      // Already exists (shouldn't happen on first seed, but be safe)
    }
  }
}

/** Get the server's last-active org ID (survives restarts). */
export function getActiveOrgId() {
  const row = orgsStmts.getActiveOrgId.get();
  return row?.org_id || 'default';
}

/** Set the server's active org ID (persisted across restarts). */
export function setActiveOrgId(orgId) {
  orgsStmts.setActiveOrgId.run(orgId);
}

/** Get all orgs. */
export function getAllOrgs() {
  return orgsStmts.getAll.all();
}

/** Get a single org by ID. */
export function getOrg(orgId) {
  return orgsStmts.getById.get(orgId);
}

/** Create a new org. Returns the created org. */
export function createOrg({
  id,
  name,
  mode = 'local',
  color = '#6366f1',
  remoteUrl = '',
  apiKey = '',
}) {
  const orgId = id || uid();

  // If org with this ID already exists, return it
  const existing = orgsStmts.getById.get(orgId);
  if (existing) return existing;

  const { count } = orgsStmts.count.get();
  orgsStmts.insert.run(orgId, name, mode, color, remoteUrl, apiKey, count);

  // Create data directory for local orgs
  if (mode !== 'remote') {
    mkdirSync(orgDataDir(orgId), { recursive: true });
  }

  return orgsStmts.getById.get(orgId);
}

/** Update an existing org. Returns the updated org or null. */
export function updateOrg(orgId, { name, mode, color, remoteUrl, apiKey, position }) {
  const existing = orgsStmts.getById.get(orgId);
  if (!existing) return null;

  orgsStmts.update.run(
    name ?? existing.name,
    mode ?? existing.mode,
    color ?? existing.color,
    remoteUrl ?? existing.remote_url,
    apiKey ?? existing.api_key,
    position ?? existing.position,
    orgId,
  );

  return orgsStmts.getById.get(orgId);
}

/** Delete an org. Cannot delete the last one. Returns true if deleted. */
export function deleteOrg(orgId) {
  const { count } = orgsStmts.count.get();
  if (count <= 1) return false;
  orgsStmts.delete.run(orgId);
  return true;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}
