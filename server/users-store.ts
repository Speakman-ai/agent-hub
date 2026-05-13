/**
 * Users store — Auth Phase 3.
 *
 * Persists user identities in the shared `orgs.db`. Keeping users in the
 * orgs-level DB (rather than each per-org data-dir) lets a single account
 * hold memberships in multiple orgs without duplicating credentials.
 *
 * The table is created by `initOrgsDb()` — this module only owns queries.
 *
 * The migration helper `migrateAuthRecordIfNeeded()` handles the one-time
 * transition from the pre-Phase-3 single-user `auth.json` by inserting a
 * `users` row plus an `Owner` membership in every existing org. Callers
 * run it from server startup after `initOrgsDb()` has seeded the default
 * org. It's a no-op when the users table already has rows.
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';
import { getAuthRecord } from './auth-store.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

/** Insert a new user. Throws on duplicate username (UNIQUE constraint). */
export function createUser(opts: {
  id?: string;
  username: string;
  passwordHash: string;
  createdAt?: string;
}): UserRow {
  const db = getOrgsDb();
  const id = opts.id || uuidv4();
  const createdAt = opts.createdAt || new Date().toISOString();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    opts.username,
    opts.passwordHash,
    createdAt,
  );
  return {
    id,
    username: opts.username,
    password_hash: opts.passwordHash,
    created_at: createdAt,
  };
}

export function getUserById(id: string): UserRow | null {
  const db = getOrgsDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row || null;
}

export function getUserByUsername(username: string): UserRow | null {
  const db = getOrgsDb();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
  return row || null;
}

export function listUsers(): UserRow[] {
  const db = getOrgsDb();
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

export function countUsers(): number {
  const db = getOrgsDb();
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return row.c;
}

export function deleteUser(id: string): void {
  const db = getOrgsDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function updateUserPassword(id: string, passwordHash: string): void {
  const db = getOrgsDb();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

// ── Per-user Claude credentials ─────────────────────────────────────
//
// Each user may attach an Anthropic API key and/or a `claude setup-token`
// OAuth bearer. `buildSpawnEnv` prefers the session owner's values when
// present, falling back to the host-wide `config.json`. Storing on the
// users row mirrors the existing GitHub OAuth columns; encryption at rest
// is tracked as a follow-up.

export interface UserClaudeAuth {
  anthropicApiKey: string | null;
  claudeCodeOAuthToken: string | null;
  claudeCodeOAuthExpiresAt: string | null;
  updatedAt: string | null;
}

interface UserClaudeAuthRow {
  anthropic_api_key: string | null;
  claude_code_oauth_token: string | null;
  claude_code_oauth_expires_at: string | null;
  claude_auth_updated_at: string | null;
}

/** Returns the user's stored Claude credentials, or null when the user does not exist. */
export function getUserClaudeAuth(userId: string): UserClaudeAuth | null {
  const db = getOrgsDb();
  const row = db
    .prepare(
      `SELECT anthropic_api_key, claude_code_oauth_token, claude_code_oauth_expires_at, claude_auth_updated_at
       FROM users WHERE id = ?`,
    )
    .get(userId) as UserClaudeAuthRow | undefined;
  if (!row) return null;
  return {
    anthropicApiKey: row.anthropic_api_key ?? null,
    claudeCodeOAuthToken: row.claude_code_oauth_token ?? null,
    claudeCodeOAuthExpiresAt: row.claude_code_oauth_expires_at ?? null,
    updatedAt: row.claude_auth_updated_at ?? null,
  };
}

/**
 * Patch the user's Claude credentials. Only fields explicitly present
 * in `patch` are written. Pass an empty string to clear a field; pass
 * `undefined` to leave it untouched.
 *
 * Returns the post-update row, or null if the user does not exist.
 */
export function setUserClaudeAuth(
  userId: string,
  patch: {
    anthropicApiKey?: string | null;
    claudeCodeOAuthToken?: string | null;
    claudeCodeOAuthExpiresAt?: string | null;
  },
): UserClaudeAuth | null {
  const db = getOrgsDb();
  const existing = getUserClaudeAuth(userId);
  if (!existing) return null;

  const next = {
    anthropic_api_key:
      patch.anthropicApiKey === undefined
        ? existing.anthropicApiKey
        : normalizeStoredCredential(patch.anthropicApiKey),
    claude_code_oauth_token:
      patch.claudeCodeOAuthToken === undefined
        ? existing.claudeCodeOAuthToken
        : normalizeStoredCredential(patch.claudeCodeOAuthToken),
    claude_code_oauth_expires_at:
      patch.claudeCodeOAuthExpiresAt === undefined
        ? existing.claudeCodeOAuthExpiresAt
        : patch.claudeCodeOAuthExpiresAt || null,
    claude_auth_updated_at: new Date().toISOString(),
  };

  db.prepare(
    `UPDATE users
     SET anthropic_api_key = ?, claude_code_oauth_token = ?, claude_code_oauth_expires_at = ?, claude_auth_updated_at = ?
     WHERE id = ?`,
  ).run(
    next.anthropic_api_key,
    next.claude_code_oauth_token,
    next.claude_code_oauth_expires_at,
    next.claude_auth_updated_at,
    userId,
  );

  return {
    anthropicApiKey: next.anthropic_api_key,
    claudeCodeOAuthToken: next.claude_code_oauth_token,
    claudeCodeOAuthExpiresAt: next.claude_code_oauth_expires_at,
    updatedAt: next.claude_auth_updated_at,
  };
}

/** Empty / whitespace-only strings collapse to null so the UI clear-field path works. */
function normalizeStoredCredential(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ── Per-user Cursor / Gemini / Codex credentials ────────────────────
//
// Each non-Claude engine carries a single API key column today. The
// `<engine>_auth_updated_at` audit column lets the UI render "Last
// updated …" without needing a JOIN to an event log. As with the Claude
// helpers above, `buildSpawnEnv` prefers these values when spawning a
// session and falls back to host-wide `config.cursorApiKey` /
// `config.geminiApiKey` / `config.codexApiKey`.

export interface UserSingleKeyAuth {
  apiKey: string | null;
  updatedAt: string | null;
}

interface SingleKeyRow {
  api_key: string | null;
  auth_updated_at: string | null;
}

function getSingleKeyAuth(
  userId: string,
  keyCol: string,
  updatedCol: string,
): UserSingleKeyAuth | null {
  const db = getOrgsDb();
  const row = db
    .prepare(
      `SELECT ${keyCol} AS api_key, ${updatedCol} AS auth_updated_at
       FROM users WHERE id = ?`,
    )
    .get(userId) as SingleKeyRow | undefined;
  if (!row) return null;
  return {
    apiKey: row.api_key ?? null,
    updatedAt: row.auth_updated_at ?? null,
  };
}

function setSingleKeyAuth(
  userId: string,
  keyCol: string,
  updatedCol: string,
  patch: { apiKey?: string | null },
): UserSingleKeyAuth | null {
  const db = getOrgsDb();
  const existing = getSingleKeyAuth(userId, keyCol, updatedCol);
  if (!existing) return null;

  const nextKey =
    patch.apiKey === undefined ? existing.apiKey : normalizeStoredCredential(patch.apiKey);
  const nextUpdated = new Date().toISOString();

  db.prepare(`UPDATE users SET ${keyCol} = ?, ${updatedCol} = ? WHERE id = ?`).run(
    nextKey,
    nextUpdated,
    userId,
  );

  return { apiKey: nextKey, updatedAt: nextUpdated };
}

export function getUserCursorAuth(userId: string): UserSingleKeyAuth | null {
  return getSingleKeyAuth(userId, 'cursor_api_key', 'cursor_auth_updated_at');
}

export function setUserCursorAuth(
  userId: string,
  patch: { apiKey?: string | null },
): UserSingleKeyAuth | null {
  return setSingleKeyAuth(userId, 'cursor_api_key', 'cursor_auth_updated_at', patch);
}

export function getUserGeminiAuth(userId: string): UserSingleKeyAuth | null {
  return getSingleKeyAuth(userId, 'gemini_api_key', 'gemini_auth_updated_at');
}

export function setUserGeminiAuth(
  userId: string,
  patch: { apiKey?: string | null },
): UserSingleKeyAuth | null {
  return setSingleKeyAuth(userId, 'gemini_api_key', 'gemini_auth_updated_at', patch);
}

export function getUserCodexAuth(userId: string): UserSingleKeyAuth | null {
  return getSingleKeyAuth(userId, 'codex_api_key', 'codex_auth_updated_at');
}

export function setUserCodexAuth(
  userId: string,
  patch: { apiKey?: string | null },
): UserSingleKeyAuth | null {
  return setSingleKeyAuth(userId, 'codex_api_key', 'codex_auth_updated_at', patch);
}

/**
 * One-shot migration from the Phase-1/2 `auth.json` singleton to the
 * Phase-3 users + memberships tables. Safe to call on every boot:
 *   - If any users already exist, it returns immediately.
 *   - If `auth.json` is missing (truly fresh install), it also exits —
 *     setup will seed the first Owner through the normal code path.
 *
 * Creates the Owner in every existing org so legacy installs keep full
 * access after the upgrade (typically just the `default` org).
 */
export function migrateAuthRecordIfNeeded(): { migratedUserId: string } | null {
  const db = getOrgsDb();
  const userCount = countUsers();
  if (userCount > 0) return null;

  const record = getAuthRecord();
  if (!record) return null;

  // Use the auth record's original createdAt so restart behavior is
  // consistent if the process crashes mid-migration and retries.
  const user = createUser({
    username: record.username,
    passwordHash: record.passwordHash,
    createdAt: record.createdAt,
  });

  // Grant Owner in every existing org. At the time this migration fires,
  // seedOrgsFromDisk() has already populated the orgs table with
  // `default` + anything in ~/.agent-hub/orgs/.
  const orgRows = db.prepare('SELECT id FROM orgs').all() as Array<{ id: string }>;
  const insertMembership = db.prepare(
    'INSERT OR IGNORE INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)',
  );
  for (const org of orgRows) {
    insertMembership.run(user.id, org.id, 'Owner');
  }

  return { migratedUserId: user.id };
}
