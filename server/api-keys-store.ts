/**
 * API Keys store — long-lived per-user programmatic credentials.
 *
 * Distinct from:
 *   - JWTs in `auth-store.ts` — short-lived session tokens (7 days)
 *     issued at login. No individual revocation.
 *   - Global `AGENT_HUB_API_KEY` in `config.ts` — deployment-wide
 *     break-glass shared secret with forced Owner role and no per-user
 *     attribution.
 *
 * Each `api_keys` row is owned by exactly one user and revocable on its
 * own. Auth via an API key grants the owning user's membership-derived
 * role in the active org (same as a JWT), NOT a forced Owner.
 *
 * ### Token format
 *   `ahub_<43 url-safe base64 chars>` — 32 bytes of CSPRNG entropy.
 *
 * ### Storage
 *   Plaintext is returned ONCE by `createApiKey`. The DB stores
 *   `sha256(token)` as hex. Because the token already has 256 bits of
 *   entropy, a single SHA-256 hash is sufficient — no salt or KDF (no
 *   need to slow down brute force when there's nothing brute-forceable).
 *   The `prefix` column (first 12 chars of the token) is indexed so
 *   `verifyApiKey` can do O(1) lookup; `token_hash` is also UNIQUE so
 *   a hash collision (astronomically unlikely) would surface as an
 *   insert error rather than silent ambiguity.
 *
 * ### last_used_at debouncing
 *   We update `last_used_at` at most once per minute per key. Most
 *   high-traffic API key auth would otherwise turn into a write storm
 *   on every request.
 */
import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';

/** Public-facing key metadata. Never includes the plaintext token or hash. */
export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

const TOKEN_PREFIX = 'ahub_';
const TOKEN_RANDOM_BYTES = 32;
const PREFIX_LENGTH = 12; // first 12 chars including the `ahub_` prefix
const LAST_USED_DEBOUNCE_MS = 60_000;
// 32 bytes base64url-encoded → 43 chars (no padding). Total token length: 48.
const TOKEN_REGEX = /^ahub_[A-Za-z0-9_-]{40,}$/;

/** Crypto-grade random token, url-safe base64. */
function generateRawToken(): string {
  const raw = randomBytes(TOKEN_RANDOM_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${raw}`;
}

/** Single SHA-256, hex-encoded. Deterministic — same input ⇒ same hash. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}

export interface CreatedApiKey extends ApiKeyRecord {
  /** The plaintext token. Only ever returned at creation. */
  token: string;
}

/**
 * Create a new API key for `userId`. Returns the plaintext token in the
 * `token` field — callers MUST surface it to the user immediately and
 * MUST NOT persist it server-side. Subsequent reads will never include
 * the token, only `prefix` for identification.
 *
 * @param expiresInDays optional TTL; null/undefined = never expires.
 */
export function createApiKey(
  userId: string,
  name: string,
  expiresInDays?: number | null,
): CreatedApiKey {
  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > 100) {
    throw new Error('name must be 1-100 characters');
  }
  if (
    expiresInDays != null &&
    (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)
  ) {
    throw new Error('expiresInDays must be between 1 and 3650');
  }

  const db = getOrgsDb();
  const id = uuidv4();
  const token = generateRawToken();
  const tokenHash = hashToken(token);
  const prefix = token.slice(0, PREFIX_LENGTH);
  const createdAt = new Date().toISOString();
  const expiresAt =
    expiresInDays != null
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, token_hash, prefix, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, trimmedName, tokenHash, prefix, createdAt, expiresAt);

  return {
    id,
    userId,
    name: trimmedName,
    prefix,
    token,
    createdAt,
    lastUsedAt: null,
    revokedAt: null,
    expiresAt,
  };
}

/** Active (non-revoked) keys for a user, ordered by creation time. */
export function listApiKeys(userId: string): ApiKeyRecord[] {
  const db = getOrgsDb();
  const rows = db
    .prepare(
      `SELECT id, user_id, name, token_hash, prefix, created_at, last_used_at, revoked_at, expires_at
       FROM api_keys
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all(userId) as ApiKeyRow[];
  return rows.map(rowToRecord);
}

/**
 * Soft-delete a key by setting `revoked_at`. Only succeeds if the key is
 * owned by `userId` and is not already revoked. Returns true if a row
 * was updated, false otherwise (404 from the route's perspective).
 */
export function revokeApiKey(userId: string, keyId: string): boolean {
  const db = getOrgsDb();
  const result = db
    .prepare(
      `UPDATE api_keys SET revoked_at = datetime('now')
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(keyId, userId);
  return result.changes > 0;
}

/**
 * Revoke every active key owned by `userId` with the exact `name`.
 * Returns how many rows were updated (0 when none matched).
 */
export function revokeApiKeysByName(userId: string, name: string): number {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return 0;
  const db = getOrgsDb();
  const result = db
    .prepare(
      `UPDATE api_keys SET revoked_at = datetime('now')
       WHERE user_id = ? AND name = ? AND revoked_at IS NULL`,
    )
    .run(userId, trimmedName);
  return result.changes;
}

/** Revoke active `spawn:<sessionId>` keys (any owner). Used on session purge. */
export function revokeApiKeysBySpawnSession(sessionId: string): number {
  const trimmedId = sessionId.trim();
  if (trimmedId.length === 0) return 0;
  const db = getOrgsDb();
  const result = db
    .prepare(
      `UPDATE api_keys SET revoked_at = datetime('now')
       WHERE name = ? AND revoked_at IS NULL`,
    )
    .run(`spawn:${trimmedId}`);
  return result.changes;
}

/**
 * Verify a presented token and, on success, return the owning user id.
 *
 *   - Returns null for malformed strings, unknown prefixes, expired keys,
 *     revoked keys, or hash mismatches.
 *   - On success, debounces a `last_used_at` write (max once per minute
 *     per key) so high-RPS callers don't generate a write storm.
 */
export function verifyApiKey(token: string): { userId: string; keyId: string } | null {
  if (typeof token !== 'string' || !TOKEN_REGEX.test(token)) return null;

  const db = getOrgsDb();
  const tokenHash = hashToken(token);
  // UNIQUE on token_hash means at most one row matches; we still scope
  // by prefix for the index hit + revoked/expired filters.
  const row = db
    .prepare(
      `SELECT id, user_id, last_used_at, revoked_at, expires_at
       FROM api_keys
       WHERE prefix = ? AND token_hash = ?`,
    )
    .get(token.slice(0, PREFIX_LENGTH), tokenHash) as
    | {
        id: string;
        user_id: string;
        last_used_at: string | null;
        revoked_at: string | null;
        expires_at: string | null;
      }
    | undefined;

  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  // Debounce last_used_at writes — at most once per LAST_USED_DEBOUNCE_MS.
  const now = Date.now();
  const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (now - last >= LAST_USED_DEBOUNCE_MS) {
    try {
      db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    } catch {
      // Non-critical: a failed write here just means the dashboard's
      // "last used" stays slightly stale. Don't fail the auth.
    }
  }

  return { userId: row.user_id, keyId: row.id };
}

/** Test-only helper: count keys for a user (active + revoked). */
export function countApiKeysForUser(userId: string): number {
  const db = getOrgsDb();
  const row = db.prepare('SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ?').get(userId) as {
    c: number;
  };
  return row.c;
}
