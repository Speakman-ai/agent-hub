/**
 * Write-only ingest credential for AWS Health events.
 *
 * An operator's EventBridge API destination presents this token on every
 * delivery; it identifies exactly one project and grants no read, query, or
 * management access. Storage model copied from `log-sources-store.ts`'s
 * `ahlog_` token and `api-keys-store.ts`: a 256-bit random secret, stored as a
 * plain SHA-256 digest plus a non-secret prefix for the index seek.
 *
 * No KDF, deliberately and for the same reason the log-source token gives: at
 * 256 bits of entropy the token is not guessable and not rate-limited by
 * hashing cost — a KDF would only slow down the legitimate ingest path, which
 * runs under EventBridge's 5-second delivery timeout.
 */
import { createHash, randomBytes } from 'node:crypto';
import { getInfraDb } from './infra-db.js';
import { INFRA_HEALTH_TOKEN_PREFIX } from './infra-schema.js';

const TOKEN_RANDOM_BYTES = 32;
/** Prefix stored in the clear for the lookup seek: marker + 8 secret chars. */
const PREFIX_LENGTH = INFRA_HEALTH_TOKEN_PREFIX.length + 8;

/**
 * Wire-shape guard applied before hashing, so a malformed header is rejected
 * without touching the database.
 */
export const INFRA_HEALTH_TOKEN_REGEX = /^ahhealth_[A-Za-z0-9_-]{40,}$/;

/** Non-secret metadata; safe to return from a management read. */
export interface InfraHealthIngestTokenInfo {
  projectId: string;
  tokenPrefix: string;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

interface TokenDbRow {
  project_id: string;
  token_hash: string;
  token_prefix: string;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

function toInfo(row: TokenDbRow): InfraHealthIngestTokenInfo {
  return {
    projectId: row.project_id,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export function hashInfraHealthToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateRawToken(): string {
  const raw = randomBytes(TOKEN_RANDOM_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${INFRA_HEALTH_TOKEN_PREFIX}${raw}`;
}

/**
 * Mint (or re-mint) the project's ingest token and return the plaintext.
 *
 * The plaintext is returned exactly once and never persisted. Re-minting
 * overwrites the previous hash immediately rather than opening a grace window:
 * an operator rotating a token is already in the EventBridge console updating
 * the connection, and a second live credential is a liability, not a
 * convenience. Re-minting also clears `revoked_at`, so rotate doubles as
 * re-enable.
 */
export function createInfraHealthIngestToken(
  projectId: string,
  nowMs: number = Date.now(),
): { token: string; info: InfraHealthIngestTokenInfo } {
  const token = generateRawToken();
  const existing = getInfraHealthIngestToken(projectId);
  getInfraDb()
    .prepare(
      `INSERT INTO infra_health_ingest_tokens
         (project_id, token_hash, token_prefix, created_at, rotated_at, revoked_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         token_hash   = excluded.token_hash,
         token_prefix = excluded.token_prefix,
         rotated_at   = excluded.rotated_at,
         revoked_at   = NULL,
         last_used_at = NULL`,
    )
    .run(
      projectId,
      hashInfraHealthToken(token),
      token.slice(0, PREFIX_LENGTH),
      // created_at is the FIRST mint; a rotation keeps it and stamps rotated_at
      // instead, so "ingest has existed since" survives a key change.
      existing?.createdAt ?? nowMs,
      existing ? nowMs : null,
    );
  return { token, info: getInfraHealthIngestToken(projectId) as InfraHealthIngestTokenInfo };
}

export function getInfraHealthIngestToken(projectId: string): InfraHealthIngestTokenInfo | null {
  const row = getInfraDb()
    .prepare(`SELECT * FROM infra_health_ingest_tokens WHERE project_id = ?`)
    .get(projectId) as TokenDbRow | undefined;
  return row ? toInfo(row) : null;
}

/** Disable ingest without destroying the audit trail. Idempotent. */
export function revokeInfraHealthIngestToken(
  projectId: string,
  nowMs: number = Date.now(),
): boolean {
  const result = getInfraDb()
    .prepare(
      `UPDATE infra_health_ingest_tokens
          SET revoked_at = ?
        WHERE project_id = ? AND revoked_at IS NULL`,
    )
    .run(nowMs, projectId);
  return result.changes > 0;
}

/**
 * Resolve a presented token to its project. The single authority on ingest
 * identity — the request body never names the project.
 */
export function resolveInfraHealthIngestToken(
  token: string,
  nowMs: number = Date.now(),
): { projectId: string } | null {
  if (typeof token !== 'string' || !INFRA_HEALTH_TOKEN_REGEX.test(token)) return null;
  const row = getInfraDb()
    .prepare(
      `SELECT project_id FROM infra_health_ingest_tokens
        WHERE token_prefix = ? AND token_hash = ? AND revoked_at IS NULL`,
    )
    .get(token.slice(0, PREFIX_LENGTH), hashInfraHealthToken(token)) as
    | { project_id: string }
    | undefined;
  if (!row) return null;
  getInfraDb()
    .prepare(`UPDATE infra_health_ingest_tokens SET last_used_at = ? WHERE project_id = ?`)
    .run(nowMs, row.project_id);
  return { projectId: row.project_id };
}
