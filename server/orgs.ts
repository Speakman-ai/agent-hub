import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import config from './config.js';
import type { OrgRow } from './types.js';
import { MCP_SERVERS_SCHEMA } from './mcp-servers-schema.js';
import { USER_SKILL_CREDENTIALS_SCHEMA } from './skill-credentials-schema.js';
import { GOOGLE_CONNECTIONS_SCHEMA } from './google-connections-schema.js';
import { AUTH_CREDENTIAL_AUDIT_SCHEMA } from './auth-credential-audit-schema.js';
import { RUNNER_QUEUE_SCHEMA } from './finalize/runner-queue-schema.js';
import { USER_TODOS_SCHEMA } from './user-todos-schema.js';

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
      credential_version INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS password_resets (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token_hash);
  `);

  // MCP-server registry (per-user). Replaces the deleted Nango integration.
  // Each row is a Claude Code / Cursor MCP server config that gets injected
  // into the spawn via `--mcp-config`. Owned by exactly one Hub user;
  // resolved at spawn time keyed on session.owner_user_id. See
  // server/mcp-servers-store.ts for the read/write surface.
  orgsDb.exec(MCP_SERVERS_SCHEMA);
  orgsDb.exec(USER_SKILL_CREDENTIALS_SCHEMA);
  // Per-user Google OAuth connection (tokens encrypted at rest). Separate
  // table rather than columns on `users` — keeps the encrypted token blobs
  // off the hot identity row. See google-connections-store.ts.
  orgsDb.exec(GOOGLE_CONNECTIONS_SCHEMA);
  orgsDb.exec(AUTH_CREDENTIAL_AUDIT_SCHEMA);
  // Cross-project personal todos, keyed by user_id. Global (non-project)
  // capture primitive — see user-todos-store.ts / user-todos-schema.ts.
  orgsDb.exec(USER_TODOS_SCHEMA);

  // Additive migration for installs that created user_todos before the
  // priority / do_date-window / polymorphic-link columns existed (spec
  // TODO-MODEL). CREATE TABLE IF NOT EXISTS above won't add columns to an
  // existing table, so ADD each one guarded by a probing SELECT. SQLite
  // allows a CHECK constraint on an added column, and the priority default
  // ('medium') satisfies its own CHECK for pre-existing rows. Idempotent:
  // once a column exists the probe succeeds and the ALTER is skipped.
  const userTodoColumns: Array<{ name: string; ddl: string }> = [
    {
      name: 'priority',
      ddl: "TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low'))",
    },
    { name: 'do_date', ddl: 'TEXT' },
    { name: 'do_start_at', ddl: 'TEXT' },
    { name: 'do_end_at', ddl: 'TEXT' },
    { name: 'linked_type', ddl: "TEXT CHECK(linked_type IN ('card','epic','session'))" },
    { name: 'linked_id', ddl: 'TEXT' },
  ];
  for (const col of userTodoColumns) {
    try {
      orgsDb.prepare(`SELECT ${col.name} FROM user_todos LIMIT 1`).get();
    } catch {
      orgsDb.exec(`ALTER TABLE user_todos ADD COLUMN ${col.name} ${col.ddl}`);
    }
  }
  // Backfill the polymorphic link from the deprecated linked_card_id column:
  // any row promoted to a card before the polymorphic link existed becomes
  // {linked_type:'card', linked_id:<linked_card_id>}. Idempotent — the
  // `linked_type IS NULL` guard means a second run touches nothing.
  orgsDb.exec(
    `UPDATE user_todos
        SET linked_type = 'card', linked_id = linked_card_id
      WHERE linked_card_id IS NOT NULL AND linked_type IS NULL`,
  );
  // Migration: widen the `user_engine_auth_audit.engine` CHECK to admit
  // 'grok'. `CREATE TABLE IF NOT EXISTS` can't alter an existing CHECK, so
  // DBs created before Grok per-user auth still carry the narrower
  // constraint — under which a grok audit insert silently fails (the writer
  // is best-effort). SQLite has no ALTER for CHECK, so rebuild the table
  // in place when the stored DDL predates 'grok'. The audit log is
  // append-only and small, so copy-through is cheap.
  try {
    const tableSql = (
      orgsDb
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get('user_engine_auth_audit') as { sql?: string } | undefined
    )?.sql;
    if (tableSql && !tableSql.includes("'grok'")) {
      orgsDb.exec('DROP INDEX IF EXISTS idx_uengineauth_audit_user');
      orgsDb.exec('DROP INDEX IF EXISTS idx_uengineauth_audit_engine');
      orgsDb.exec('ALTER TABLE user_engine_auth_audit RENAME TO user_engine_auth_audit_old');
      orgsDb.exec(AUTH_CREDENTIAL_AUDIT_SCHEMA);
      orgsDb.exec(
        `INSERT INTO user_engine_auth_audit
           (id, user_id, engine, field, action, actor_user_id, created_at)
         SELECT id, user_id, engine, field, action, actor_user_id, created_at
         FROM user_engine_auth_audit_old`,
      );
      orgsDb.exec('DROP TABLE user_engine_auth_audit_old');
    }
  } catch {
    // Best-effort: a failed rebuild leaves the old table intact (grok audit
    // rows just won't persist), never blocks orgs.db init.
  }
  // Multi-tenant Finalize runner control-plane queue (shared across orgs).
  orgsDb.exec(RUNNER_QUEUE_SCHEMA);

  // Add `spot_interruption_at` to runner_jobs on installs predating EC2 Spot
  // reclaim detection. Nullable column — the runner agent stamps it when IMDS
  // reports a 2-minute interruption notice so the lease reaper can classify the
  // lost job as `spot_reclaimed` (generous retry cap) rather than the generic
  // `container_unavailable`. CREATE TABLE IF NOT EXISTS above won't add it to an
  // existing table.
  try {
    orgsDb.prepare('SELECT spot_interruption_at FROM runner_jobs LIMIT 1').get();
  } catch {
    orgsDb.exec('ALTER TABLE runner_jobs ADD COLUMN spot_interruption_at INTEGER');
  }

  // Add `ecs_task_arn` to runner_agents on installs predating Hub-driven task
  // scale-in protection. Nullable column — the agent reports its ECS task ARN at
  // registration so the Hub can arm UpdateTaskProtection on that exact task.
  // Without this, the register insert fails with `no such column` on an existing
  // table (CREATE TABLE IF NOT EXISTS above won't add it).
  try {
    orgsDb.prepare('SELECT ecs_task_arn FROM runner_agents LIMIT 1').get();
  } catch {
    orgsDb.exec('ALTER TABLE runner_agents ADD COLUMN ecs_task_arn TEXT');
  }

  // Add `masked_preview` to user_skill_credentials on installs predating the
  // pre-computed mask. Nullable column → backfill happens lazily on the
  // first list/upsert that touches each row. CREATE TABLE IF NOT EXISTS
  // above is intentionally idempotent and won't add the column on its own.
  try {
    orgsDb.prepare('SELECT masked_preview FROM user_skill_credentials LIMIT 1').get();
  } catch {
    orgsDb.exec('ALTER TABLE user_skill_credentials ADD COLUMN masked_preview TEXT');
  }

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

  // Per-user CLI credentials for the other supported engines (Cursor,
  // Gemini, Codex). Mirrors the Claude pattern above: each engine has a
  // nullable API-key column plus an `<engine>_auth_updated_at` audit
  // column. `buildSpawnEnv` (see server/config.ts) prefers these values
  // when spawning a session for that user, falling back to the host-wide
  // config.*ApiKey settings. Encryption-at-rest is a tracked follow-up.
  const userEngineAuthColumns: Array<{ name: string; ddl: string }> = [
    { name: 'cursor_api_key', ddl: 'TEXT' },
    { name: 'cursor_auth_updated_at', ddl: 'TEXT' },
    { name: 'gemini_api_key', ddl: 'TEXT' },
    { name: 'gemini_auth_updated_at', ddl: 'TEXT' },
    { name: 'codex_api_key', ddl: 'TEXT' },
    { name: 'codex_auth_updated_at', ddl: 'TEXT' },
    { name: 'grok_api_key', ddl: 'TEXT' },
    { name: 'grok_auth_updated_at', ddl: 'TEXT' },
  ];
  for (const col of userEngineAuthColumns) {
    try {
      orgsDb.prepare(`SELECT ${col.name} FROM users LIMIT 1`).get();
    } catch {
      orgsDb.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.ddl}`);
    }
  }

  // Per-user MFA state. TOTP secrets are encrypted by users-store before
  // storage; recovery codes are single-use hashes in JSON so plaintext
  // backup codes only exist in the API response that generates them.
  const userMfaColumns: Array<{ name: string; ddl: string }> = [
    { name: 'credential_version', ddl: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'mfa_pending_secret', ddl: 'TEXT' },
    { name: 'mfa_totp_secret', ddl: 'TEXT' },
    { name: 'mfa_enabled', ddl: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'mfa_recovery_codes_json', ddl: "TEXT NOT NULL DEFAULT '[]'" },
    { name: 'mfa_enrolled_at', ddl: 'TEXT' },
    { name: 'mfa_updated_at', ddl: 'TEXT' },
    { name: 'mfa_reset_at', ddl: 'TEXT' },
    { name: 'mfa_reset_by_user_id', ddl: 'TEXT REFERENCES users(id) ON DELETE SET NULL' },
    { name: 'mfa_last_used_step', ddl: 'INTEGER' },
  ];
  for (const col of userMfaColumns) {
    try {
      orgsDb.prepare(`SELECT ${col.name} FROM users LIMIT 1`).get();
    } catch {
      orgsDb.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.ddl}`);
    }
  }

  try {
    orgsDb.prepare('SELECT preferences_json FROM users LIMIT 1').get();
  } catch {
    orgsDb.exec('ALTER TABLE users ADD COLUMN preferences_json TEXT');
  }

  try {
    orgsDb.prepare('SELECT credential_version FROM users LIMIT 1').get();
  } catch {
    orgsDb.exec('ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0');
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
