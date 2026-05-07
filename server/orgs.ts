import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import config from './config.js';
import type { OrgRow } from './types.js';
import { MCP_SERVERS_SCHEMA } from './mcp-servers-schema.js';
import { USER_SKILL_CREDENTIALS_SCHEMA } from './skill-credentials-schema.js';

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

let orgsDb: Database.Database | null = null;
let orgsStmts: OrgsStmts;

/**
 * Override the `orgs.db` location — for tests only. Pass `null` to reset
 * back to the default (`{config.dataDir}/orgs.db`).
 */
let orgsDbPathOverride: string | null = null;
export function setOrgsDbPathForTests(p: string | null): void {
  orgsDbPathOverride = p;
  if (orgsDb) {
    try {
      orgsDb.close();
    } catch {}
    orgsDb = null;
  }
}

/**
 * Accessor for the shared orgs.db handle. Phase 3 stores (users,
 * memberships, invites) live in the same database so a user can belong
 * to multiple orgs without each per-org data-dir duplicating the
 * identity table. Throws if `initOrgsDb()` hasn't run — callers are
 * always downstream of server startup.
 */
export function getOrgsDb(): Database.Database {
  if (!orgsDb) {
    throw new Error('orgs.db not initialized — call initOrgsDb() first');
  }
  return orgsDb;
}

export function orgDataDir(orgId: string): string {
  if (orgId === 'default') return config.dataDir;
  return path.join(HOME, '.agent-hub', 'orgs', orgId);
}

export function initOrgsDb(): void {
  const dbPath = orgsDbPathOverride || path.join(config.dataDir, 'orgs.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  orgsDb = new Database(dbPath);
  orgsDb.pragma('journal_mode = WAL');
  // Foreign keys are required for the ON DELETE CASCADE semantics on
  // memberships/invites — SQLite disables them by default.
  orgsDb.pragma('foreign_keys = ON');

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

    -- ── Phase 3 multi-user tables ────────────────────────────────
    -- Users live in the shared orgs.db so a single account can belong
    -- to multiple orgs. Per-org roles are expressed via memberships.
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id  TEXT NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
      role    TEXT NOT NULL CHECK(role IN ('Owner','Admin','User')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, org_id)
    );

    -- invites.created_by / accepted_by use ON DELETE SET NULL so we can
    -- still delete a user who has ever minted or accepted an invite.
    -- The audit trail (the invite row itself) stays; the user pointer
    -- becomes NULL. created_by therefore cannot be NOT NULL — a deleted
    -- admin's old invites will read as "creator unknown".
    CREATE TABLE IF NOT EXISTS invites (
      token       TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      email       TEXT,
      role        TEXT NOT NULL CHECK(role IN ('Admin','User')),
      expires_at  TEXT NOT NULL,
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);

    -- ── Per-user API keys (long-lived programmatic credentials) ────
    -- Distinct from JWTs (session tokens, 7-day TTL) and from the
    -- legacy global AGENT_HUB_API_KEY (Owner-role break-glass shared
    -- across the deployment). Each row is owned by a single user and
    -- can be revoked individually; the plaintext token is only ever
    -- returned by POST /api/auth/keys at creation time, then stored
    -- as a SHA-256 hash. Auth via these keys grants the owning user's
    -- membership-derived role in the active org, NOT Owner.
    CREATE TABLE IF NOT EXISTS api_keys (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,
      prefix        TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at  TEXT,
      revoked_at    TEXT,
      expires_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
  `);

  // MCP-server registry (per-user). Replaces the deleted Nango integration.
  // Each row is a Claude Code / Cursor MCP server config that gets injected
  // into the spawn via `--mcp-config`. Owned by exactly one Hub user;
  // resolved at spawn time keyed on session.owner_user_id. See
  // server/mcp-servers-store.ts for the read/write surface.
  orgsDb.exec(MCP_SERVERS_SCHEMA);
  orgsDb.exec(USER_SKILL_CREDENTIALS_SCHEMA);

  // Migration: drop the two Nango-era tables. The Nango integration was
  // ripped out in favour of the MCP-server registry; these tables held
  // operator-tier OAuth secrets and per-user OAuth `connection_id`s
  // that have no MCP analogue. Use IF EXISTS so fresh installs are a
  // no-op. Existing installs that had Nango connections lose them on
  // boot — there is no migration path because the data shape is wholly
  // incompatible with the MCP-server replacement.
  orgsDb.exec(`
    DROP TABLE IF EXISTS user_integrations;
    DROP TABLE IF EXISTS integration_providers;
  `);

  // Migration: earlier Phase 3 commits created `invites` with FKs that had
  // no ON DELETE action (SQLite's NO ACTION default). With foreign_keys =
  // ON, that made `DELETE FROM users` fail for any admin who had ever
  // minted or accepted an invite — which is the normal workflow. Detect
  // a pre-fix schema and rebuild the table with the correct clauses.
  try {
    const fkInfo = orgsDb.pragma('foreign_key_list(invites)') as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    const needsRebuild = fkInfo.some(
      (fk) =>
        fk.table === 'users' &&
        (fk.from === 'created_by' || fk.from === 'accepted_by') &&
        fk.on_delete !== 'SET NULL',
    );
    if (needsRebuild) {
      // Rebuild inside a transaction so a mid-migration crash leaves the
      // old table in place. Column layout is identical — only FK
      // semantics and the NOT NULL on created_by change.
      orgsDb.exec(`
        BEGIN;
        ALTER TABLE invites RENAME TO invites__old;
        CREATE TABLE invites (
          token       TEXT PRIMARY KEY,
          org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
          email       TEXT,
          role        TEXT NOT NULL CHECK(role IN ('Admin','User')),
          expires_at  TEXT NOT NULL,
          created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          accepted_at TEXT
        );
        INSERT INTO invites (token, org_id, email, role, expires_at, created_by, created_at, accepted_by, accepted_at)
          SELECT token, org_id, email, role, expires_at, created_by, created_at, accepted_by, accepted_at
          FROM invites__old;
        DROP TABLE invites__old;
        CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);
        COMMIT;
      `);
    }
  } catch {
    // invites table didn't exist yet (fresh install path already creates
    // it with the right schema above) — nothing to migrate.
  }

  try {
    orgsDb.prepare('SELECT position FROM orgs LIMIT 1').get();
  } catch {
    orgsDb.exec('ALTER TABLE orgs ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  }

  // GitHub user OAuth connection (per-user). Columns are added only if
  // missing so upgrades from any earlier Phase-3 schema pick them up
  // transparently. All six columns are nullable — an unconnected user
  // has NULL in every GitHub-related column.
  //
  // Why columns on `users` rather than a separate table: the 1:1
  // relationship is strict (a hub user links to exactly one GitHub
  // identity), the row is queried on every PR-list/merge call, and
  // keeping it inline avoids a JOIN hot-path.
  const userGithubColumns: Array<{ name: string; ddl: string }> = [
    { name: 'github_login', ddl: 'TEXT' },
    { name: 'github_user_token', ddl: 'TEXT' },
    { name: 'github_token_expires_at', ddl: 'TEXT' },
    { name: 'github_refresh_token', ddl: 'TEXT' },
    { name: 'github_refresh_expires_at', ddl: 'TEXT' },
    { name: 'github_connected_at', ddl: 'TEXT' },
  ];
  for (const col of userGithubColumns) {
    try {
      orgsDb.prepare(`SELECT ${col.name} FROM users LIMIT 1`).get();
    } catch {
      orgsDb.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.ddl}`);
    }
  }

  // Per-user Claude credentials. Lets each Agent Hub user attach their
  // own Anthropic API key or `claude setup-token` OAuth bearer; spawn
  // env (`buildSpawnEnv`) prefers the session owner's values and falls
  // back to the host-wide config.json. Stored as nullable plain TEXT to
  // match the existing GitHub-OAuth columns above; an at-rest encryption
  // pass is tracked as a follow-up.
  const userClaudeColumns: Array<{ name: string; ddl: string }> = [
    { name: 'anthropic_api_key', ddl: 'TEXT' },
    { name: 'claude_code_oauth_token', ddl: 'TEXT' },
    { name: 'claude_code_oauth_expires_at', ddl: 'TEXT' },
    { name: 'claude_auth_updated_at', ddl: 'TEXT' },
  ];
  for (const col of userClaudeColumns) {
    try {
      orgsDb.prepare(`SELECT ${col.name} FROM users LIMIT 1`).get();
    } catch {
      orgsDb.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.ddl}`);
    }
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
    // Tests point `orgsDbPathOverride` at a tmp dir; skip scanning the
    // real `~/.agent-hub/orgs/` in that case — otherwise leftover
    // worktree directories on the dev host pollute the tmp DB and
    // collide with fixture org IDs.
    if (orgsDbPathOverride) {
      orgsStmts.insert.run('default', 'Default', 'local', '#6366f1', '', '', 0);
    } else {
      seedOrgsFromDisk();
    }
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
