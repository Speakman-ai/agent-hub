import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import config from './config.js';
import type { OrgRow } from './types.js';

const HOME = process.env.HOME || '/home/' + (process.env.USER || 'user');

interface OrgsStmts {
  getAll: Database.Statement<[], OrgRow>;
  getById: Database.Statement<[string], OrgRow>;
  insert: Database.Statement<[string, string, string, string, string, string, number]>;
  update: Database.Statement<[string, string, string, string, string, number, string]>;
  delete: Database.Statement<[string]>;
  count: Database.Statement<[], { count: number }>;
  getActiveOrgId: Database.Statement<[], { org_id: string }>;
  setActiveOrgId: Database.Statement<[string]>;
}

let orgsDb: Database.Database;
let orgsStmts: OrgsStmts;

export function orgDataDir(orgId: string): string {
  if (orgId === 'default') return config.dataDir;
  return path.join(HOME, '.agent-hub', 'orgs', orgId);
}

export function initOrgsDb(): void {
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

  const { count } = orgsStmts.count.get()!;
  if (count === 0) {
    seedOrgsFromDisk();
  }
}

function seedOrgsFromDisk(): void {
  orgsStmts.insert.run('default', 'Default', 'local', '#6366f1', '', '', 0);

  const orgsDir = path.join(HOME, '.agent-hub', 'orgs');
  if (!existsSync(orgsDir)) return;

  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = readdirSync(orgsDir, { withFileTypes: true }) as typeof entries;
  } catch {
    return;
  }

  let position = 1;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const orgId = entry.name;
    const orgPath = path.join(orgsDir, orgId);

    let name = orgId;
    try {
      const projects = JSON.parse(readFileSync(path.join(orgPath, 'projects.json'), 'utf-8'));
      if (Array.isArray(projects) && projects.length > 0) {
        name = (projects[0] as { name?: string }).name || orgId;
      }
    } catch {}

    try {
      orgsStmts.insert.run(orgId, name, 'local', '#6366f1', '', '', position++);
    } catch {
      // Already exists
    }
  }
}

export function getActiveOrgId(): string {
  const row = orgsStmts.getActiveOrgId.get();
  return row?.org_id || 'default';
}

export function setActiveOrgId(orgId: string): void {
  orgsStmts.setActiveOrgId.run(orgId);
}

export function getAllOrgs(): OrgRow[] {
  return orgsStmts.getAll.all();
}

export function getOrg(orgId: string): OrgRow | undefined {
  return orgsStmts.getById.get(orgId);
}

interface CreateOrgOptions {
  id?: string;
  name: string;
  mode?: string;
  color?: string;
  remoteUrl?: string;
  apiKey?: string;
}

export function createOrg({
  id,
  name,
  mode = 'local',
  color = '#6366f1',
  remoteUrl = '',
  apiKey = '',
}: CreateOrgOptions): OrgRow | undefined {
  const orgId = id || uid();

  const existing = orgsStmts.getById.get(orgId);
  if (existing) return existing;

  const { count } = orgsStmts.count.get()!;
  orgsStmts.insert.run(orgId, name, mode, color, remoteUrl, apiKey, count);

  if (mode !== 'remote') {
    mkdirSync(orgDataDir(orgId), { recursive: true });
  }

  return orgsStmts.getById.get(orgId);
}

interface UpdateOrgOptions {
  name?: string;
  mode?: string;
  color?: string;
  remoteUrl?: string;
  apiKey?: string;
  position?: number;
}

export function updateOrg(
  orgId: string,
  { name, mode, color, remoteUrl, apiKey, position }: UpdateOrgOptions,
): OrgRow | null {
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

  return orgsStmts.getById.get(orgId) ?? null;
}

export function deleteOrg(orgId: string): boolean {
  const { count } = orgsStmts.count.get()!;
  if (count <= 1) return false;
  orgsStmts.delete.run(orgId);
  return true;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
