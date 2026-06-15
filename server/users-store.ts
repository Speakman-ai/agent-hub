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
import { encryptSecret, decryptSecret } from './secret-crypto.js';

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

// ── Per-user engine credential encryption-at-rest ──────────────────
//
// Every per-user engine credential column (anthropic_api_key,
// claude_code_oauth_token, cursor_api_key, gemini_api_key,
// codex_api_key) is stored encrypted via the shared AES-256-GCM helper
// in `secret-crypto.ts` (same key file as Slack tokens and skill
// credentials). The encrypted blob shape is `iv:tag:ciphertext` —
// three colon-separated base64 segments where the IV decodes to 12
// bytes and the auth tag decodes to 16 bytes.
//
// We migrate legacy plaintext rows lazily. Installations predating this
// change have rows whose value is a raw API key / token string — we
// detect those by checking that the stored blob doesn't match the
// encrypted shape, decrypt-equivalent (i.e. treat as plaintext), and
// rewrite the column with an encrypted blob on the next read. Writes
// always produce encrypted blobs.
//
// Audit: every credential write emits a row to `user_engine_auth_audit`
// (one row per field, so a single PUT /api/auth/me/claude-auth that
// changes both `anthropicApiKey` and `claudeCodeOAuthToken` produces
// two rows). The action is `delete` when the new value is empty/null
// AND the previous value was set; `upsert` otherwise.

type EngineAuditTag = 'claude' | 'cursor' | 'gemini' | 'codex' | 'grok';

const ENCRYPTED_BLOB_RE = /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/**
 * Heuristic test for "this column value is a v1 encrypted blob from
 * `encryptSecret()`" vs "this column value is legacy plaintext that
 * predates encryption-at-rest".
 *
 * The blob shape is precise enough that a real API key / OAuth token
 * (typically `sk-ant-…`, `sk-…`, `oat01-…`, no embedded colons, often
 * containing characters base64 doesn't admit such as `_` or `-` at
 * positions that break the segment regex) won't false-positive into
 * the "encrypted" branch — the segment lengths and the strict charset
 * mean a base64-decode-and-length-check on IV (12 bytes) and tag (16
 * bytes) is the authoritative tie-breaker on the rare ambiguous case.
 */
function looksLikeEncryptedBlob(value: string): boolean {
  if (!value || !ENCRYPTED_BLOB_RE.test(value)) return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    if (iv.length !== 12 || tag.length !== 16) return false;
    // ciphertext can be any length (including 0 for an empty plaintext that
    // we never actually emit — encryptSecret short-circuits on '').
    return true;
  } catch {
    return false;
  }
}

/**
 * Decrypt a column value. Returns the plaintext when the value is an
 * encrypted blob; returns the value unchanged when it doesn't match the
 * blob shape (legacy plaintext row — caller is expected to backfill by
 * rewriting the column with an encrypted blob). Returns null for
 * null/empty inputs and for blobs whose AES-GCM auth tag check fails
 * (corrupt ciphertext — we'd rather surface "no credential" than throw
 * up the chain into the spawn path).
 */
function decryptCredentialColumn(value: string | null): string | null {
  if (value == null || value === '') return null;
  if (!looksLikeEncryptedBlob(value)) {
    // Legacy plaintext row predating encryption-at-rest.
    return value;
  }
  try {
    const plaintext = decryptSecret(value);
    return plaintext === '' ? null : plaintext;
  } catch {
    return null;
  }
}

/**
 * Encrypt a plaintext credential for storage. Empty / whitespace-only
 * input collapses to null so a "clear field" PUT lands as a SQL NULL
 * rather than as ciphertext-of-empty-string.
 */
function encryptCredentialForStorage(plaintext: string | null): string | null {
  if (plaintext == null) return null;
  const trimmed = plaintext.trim();
  if (trimmed.length === 0) return null;
  return encryptSecret(trimmed);
}

interface AuditOpts {
  userId: string;
  engine: EngineAuditTag;
  field: string;
  action: 'upsert' | 'delete';
  actorUserId: string;
}

function appendAuthAudit(opts: AuditOpts): void {
  const db = getOrgsDb();
  try {
    db.prepare(
      `INSERT INTO user_engine_auth_audit (id, user_id, engine, field, action, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(uuidv4(), opts.userId, opts.engine, opts.field, opts.action, opts.actorUserId);
  } catch {
    // Best-effort — never let an audit write failure break the credential
    // update itself. The credential write is the user-visible action; a
    // missing audit row is observable later but losing the credential is
    // not recoverable. Matches the `try/best-effort` posture in
    // `skill-credentials-store.ts::backfillPreview`.
  }
}

/**
 * Rewrite a single user column with an encrypted blob. Used during
 * lazy backfill (legacy plaintext detected on read → encrypt it in
 * place) so the on-disk shape converges to encrypted-only over time.
 */
function backfillEncryptedColumn(userId: string, column: string, plaintext: string): void {
  try {
    const enc = encryptSecret(plaintext);
    getOrgsDb().prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(enc, userId);
  } catch {
    // Best-effort — surface the plaintext value on this read regardless;
    // we'll try again on the next read.
  }
}

// ── Per-user Claude credentials ─────────────────────────────────────
//
// Each user may attach an Anthropic API key and/or a `claude setup-token`
// OAuth bearer. `buildSpawnEnv` injects these from the acting user's row
// only — Claude is strictly per-account with no host or org-owner fallback
// (a spawn for a user with no Claude creds hard-fails with
// `EngineAuthRequiredError`). Storing on the
// users row mirrors the existing GitHub OAuth columns. The two secret
// columns are encrypted-at-rest via the helpers above; OAuth-expiry and
// `claude_auth_updated_at` are non-secret metadata and stay plaintext.

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
  // Decrypt + lazy backfill: legacy plaintext rows get rewritten as
  // encrypted blobs on first read so the on-disk shape converges over
  // time without requiring a one-shot migration.
  const anthropicApiKey = decryptCredentialColumn(row.anthropic_api_key);
  if (
    anthropicApiKey !== null &&
    row.anthropic_api_key &&
    !looksLikeEncryptedBlob(row.anthropic_api_key)
  ) {
    backfillEncryptedColumn(userId, 'anthropic_api_key', anthropicApiKey);
  }
  const claudeCodeOAuthToken = decryptCredentialColumn(row.claude_code_oauth_token);
  if (
    claudeCodeOAuthToken !== null &&
    row.claude_code_oauth_token &&
    !looksLikeEncryptedBlob(row.claude_code_oauth_token)
  ) {
    backfillEncryptedColumn(userId, 'claude_code_oauth_token', claudeCodeOAuthToken);
  }
  return {
    anthropicApiKey,
    claudeCodeOAuthToken,
    claudeCodeOAuthExpiresAt: row.claude_code_oauth_expires_at ?? null,
    updatedAt: row.claude_auth_updated_at ?? null,
  };
}

/**
 * Patch the user's Claude credentials. Only fields explicitly present
 * in `patch` are written. Pass an empty string to clear a field; pass
 * `undefined` to leave it untouched.
 *
 * Secrets are encrypted at rest via `encryptSecret()` before they touch
 * the DB. Every secret-field write emits one row to
 * `user_engine_auth_audit` — `upsert` when the new value is non-empty,
 * `delete` when the new value clears a previously-set field. Pure
 * metadata writes (changing only `claudeCodeOAuthExpiresAt`) do not
 * emit audit rows; the OAuth expiry is non-sensitive bookkeeping that
 * the OAuth callback can churn without operator interest.
 *
 * `actorUserId` defaults to the row owner because today's only caller
 * is the per-user PUT route (you can only modify your own creds), but
 * keeping it as an opt-out parameter leaves room for a future
 * admin-impersonation endpoint.
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
  opts?: { actorUserId?: string },
): UserClaudeAuth | null {
  const db = getOrgsDb();
  const existing = getUserClaudeAuth(userId);
  if (!existing) return null;
  const actorUserId = opts?.actorUserId ?? userId;

  const nextAnthropic =
    patch.anthropicApiKey === undefined
      ? existing.anthropicApiKey
      : normalizeStoredCredential(patch.anthropicApiKey);
  const nextOauth =
    patch.claudeCodeOAuthToken === undefined
      ? existing.claudeCodeOAuthToken
      : normalizeStoredCredential(patch.claudeCodeOAuthToken);
  const nextExpiresAt =
    patch.claudeCodeOAuthExpiresAt === undefined
      ? existing.claudeCodeOAuthExpiresAt
      : patch.claudeCodeOAuthExpiresAt || null;
  const nextUpdatedAt = new Date().toISOString();

  db.prepare(
    `UPDATE users
     SET anthropic_api_key = ?, claude_code_oauth_token = ?, claude_code_oauth_expires_at = ?, claude_auth_updated_at = ?
     WHERE id = ?`,
  ).run(
    encryptCredentialForStorage(nextAnthropic),
    encryptCredentialForStorage(nextOauth),
    nextExpiresAt,
    nextUpdatedAt,
    userId,
  );

  // Audit. Only emit when the caller actually touched a secret field —
  // a metadata-only PUT (expiresAt) is bookkeeping and is intentionally
  // not audited.
  if (patch.anthropicApiKey !== undefined) {
    const action: 'upsert' | 'delete' =
      nextAnthropic == null && existing.anthropicApiKey != null ? 'delete' : 'upsert';
    appendAuthAudit({
      userId,
      engine: 'claude',
      field: 'anthropic_api_key',
      action,
      actorUserId,
    });
  }
  if (patch.claudeCodeOAuthToken !== undefined) {
    const action: 'upsert' | 'delete' =
      nextOauth == null && existing.claudeCodeOAuthToken != null ? 'delete' : 'upsert';
    appendAuthAudit({
      userId,
      engine: 'claude',
      field: 'claude_code_oauth_token',
      action,
      actorUserId,
    });
  }

  return {
    anthropicApiKey: nextAnthropic,
    claudeCodeOAuthToken: nextOauth,
    claudeCodeOAuthExpiresAt: nextExpiresAt,
    updatedAt: nextUpdatedAt,
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
// updated …" without needing a JOIN to an event log. `buildSpawnEnv`
// injects these per-account values when spawning a session. Cursor and
// Codex are strictly per-account (no host fallback — a spawn with no
// creds hard-fails with `EngineAuthRequiredError`). Gemini is the one
// exception: its per-user key takes precedence but falls back to the
// host-wide `config.geminiApiKey` (used for wiki embeddings / memory RAG).

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
  const decrypted = decryptCredentialColumn(row.api_key);
  // Lazy backfill: a legacy plaintext row gets rewritten as an encrypted
  // blob on first read so the column converges to encrypted-only without
  // a one-shot migration.
  if (decrypted !== null && row.api_key && !looksLikeEncryptedBlob(row.api_key)) {
    backfillEncryptedColumn(userId, keyCol, decrypted);
  }
  return {
    apiKey: decrypted,
    updatedAt: row.auth_updated_at ?? null,
  };
}

function setSingleKeyAuth(
  userId: string,
  engine: EngineAuditTag,
  keyCol: string,
  updatedCol: string,
  patch: { apiKey?: string | null },
  actorUserId?: string | null,
): UserSingleKeyAuth | null {
  const db = getOrgsDb();
  const existing = getSingleKeyAuth(userId, keyCol, updatedCol);
  if (!existing) return null;

  const nextKey =
    patch.apiKey === undefined ? existing.apiKey : normalizeStoredCredential(patch.apiKey);
  const nextUpdated = new Date().toISOString();

  db.prepare(`UPDATE users SET ${keyCol} = ?, ${updatedCol} = ? WHERE id = ?`).run(
    encryptCredentialForStorage(nextKey),
    nextUpdated,
    userId,
  );

  // Audit. Only emit when the caller passed `apiKey` explicitly — a
  // patch that omits the field is a no-op write of the same value
  // (intentional, see `patch.apiKey === undefined` above) and we don't
  // want a NO-CHANGE update from another caller to pollute the audit
  // log with phantom rotations.
  if (patch.apiKey !== undefined) {
    const action: 'upsert' | 'delete' =
      nextKey == null && existing.apiKey != null ? 'delete' : 'upsert';
    appendAuthAudit({
      userId,
      engine,
      field: keyCol,
      action,
      actorUserId: actorUserId ?? userId,
    });
  }

  return { apiKey: nextKey, updatedAt: nextUpdated };
}

export function getUserCursorAuth(userId: string): UserSingleKeyAuth | null {
  return getSingleKeyAuth(userId, 'cursor_api_key', 'cursor_auth_updated_at');
}

export function setUserCursorAuth(
  userId: string,
  patch: { apiKey?: string | null },
  opts?: { actorUserId?: string },
): UserSingleKeyAuth | null {
  return setSingleKeyAuth(
    userId,
    'cursor',
    'cursor_api_key',
    'cursor_auth_updated_at',
    patch,
    opts?.actorUserId,
  );
}

export function getUserGeminiAuth(userId: string): UserSingleKeyAuth | null {
  return getSingleKeyAuth(userId, 'gemini_api_key', 'gemini_auth_updated_at');
}

export function setUserGeminiAuth(
  userId: string,
  patch: { apiKey?: string | null },
  opts?: { actorUserId?: string },
): UserSingleKeyAuth | null {
  return setSingleKeyAuth(
    userId,
    'gemini',
    'gemini_api_key',
    'gemini_auth_updated_at',
    patch,
    opts?.actorUserId,
  );
}

export function getUserCodexAuth(userId: string): UserSingleKeyAuth | null {
  return getSingleKeyAuth(userId, 'codex_api_key', 'codex_auth_updated_at');
}

export function setUserCodexAuth(
  userId: string,
  patch: { apiKey?: string | null },
  opts?: { actorUserId?: string },
): UserSingleKeyAuth | null {
  return setSingleKeyAuth(
    userId,
    'codex',
    'codex_api_key',
    'codex_auth_updated_at',
    patch,
    opts?.actorUserId,
  );
}

export function getUserGrokAuth(userId: string): UserSingleKeyAuth | null {
  return getSingleKeyAuth(userId, 'grok_api_key', 'grok_auth_updated_at');
}

export function setUserGrokAuth(
  userId: string,
  patch: { apiKey?: string | null },
  opts?: { actorUserId?: string },
): UserSingleKeyAuth | null {
  return setSingleKeyAuth(
    userId,
    'grok',
    'grok_api_key',
    'grok_auth_updated_at',
    patch,
    opts?.actorUserId,
  );
}

// ── Audit-row reader (admin tooling + tests) ────────────────────────

export interface EngineAuthAuditRow {
  id: string;
  user_id: string;
  engine: EngineAuditTag;
  field: string;
  action: 'upsert' | 'delete';
  actor_user_id: string;
  created_at: string;
}

/**
 * Returns the audit trail for a given user's engine credentials, newest
 * first. Filterable by engine when the caller only cares about one
 * vendor. Returns [] when the user has never written a credential.
 *
 * Intended for admin tooling (the operator dashboard's "who rotated
 * what when" view) and for tests asserting that PUT routes emitted the
 * expected audit rows.
 */
export function listUserEngineAuthAudit(
  userId: string,
  filter?: { engine?: EngineAuditTag },
): EngineAuthAuditRow[] {
  const db = getOrgsDb();
  if (filter?.engine) {
    return db
      .prepare(
        `SELECT * FROM user_engine_auth_audit
         WHERE user_id = ? AND engine = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(userId, filter.engine) as EngineAuthAuditRow[];
  }
  return db
    .prepare(
      `SELECT * FROM user_engine_auth_audit
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(userId) as EngineAuthAuditRow[];
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
