/**
 * RUM ingest clients store — per-project credentials that let a third-party
 * vendor site authenticate session-replay uploads to `POST /api/replays` with
 * an `X-RUM-Token` header. A verified token attributes the capture to its
 * project and applies a per-project ingest budget.
 *
 * Distinct from `api-keys-store.ts`:
 *   - api_keys are per-USER, live in the shared orgs.db, and grant the owning
 *     user's role for general Hub API auth.
 *   - RUM clients are per-PROJECT, live in the per-org main DB alongside
 *     session_replays, and grant exactly one capability: attributed replay
 *     ingest for that project. They carry no user identity and no role.
 *
 * ### Token format
 *   `rum_<43 url-safe base64 chars>` — 32 bytes of CSPRNG entropy. The distinct
 *   `rum_` prefix (vs `ahub_`) keeps the two credential namespaces from being
 *   confused at a glance and in logs.
 *
 * ### Storage
 *   Plaintext is returned ONCE by `mintRumClient`. The DB stores `sha256(token)`
 *   as hex (`token_hash`, UNIQUE) plus an indexed `prefix` (first 12 chars) for
 *   O(1) verify lookup. 256 bits of entropy ⇒ a single SHA-256 is sufficient;
 *   no salt/KDF (nothing brute-forceable). This mirrors api-keys-store exactly,
 *   and reuses its `hashToken` so the digest convention lives in one place.
 *
 * ### last_used_at debouncing
 *   `verifyRumToken` updates `last_used_at` at most once per minute per client,
 *   so a high-RPS ingest path doesn't turn every upload into a write.
 */
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getStmts } from './db.js';
import { hashToken } from './api-keys-store.js';
import type { RumClientRow } from './types.js';

const TOKEN_PREFIX = 'rum_';
const TOKEN_RANDOM_BYTES = 32;
const PREFIX_LENGTH = 12; // first 12 chars including the `rum_` prefix
const LAST_USED_DEBOUNCE_MS = 60_000;
// 32 bytes base64url-encoded → 43 chars (no padding). Total length: 47.
const TOKEN_REGEX = /^rum_[A-Za-z0-9_-]{40,}$/;

/** Public-facing client metadata. Never includes the plaintext token or hash. */
export interface RumClientRecord {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface MintedRumClient extends RumClientRecord {
  /** The plaintext token. Only ever returned at mint time. */
  token: string;
}

/** Result of a successful `verifyRumToken`: the client id + the project to
 *  attribute the replay to. */
export interface VerifiedRumClient {
  clientId: string;
  projectId: string;
  name: string;
}

function generateRawToken(): string {
  const raw = randomBytes(TOKEN_RANDOM_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${TOKEN_PREFIX}${raw}`;
}

function rowToRecord(row: RumClientRow): RumClientRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Mint a new RUM ingest client for `projectId`. Returns the plaintext token in
 * the `token` field — the caller MUST surface it once and MUST NOT persist it;
 * later reads only ever expose `prefix`. Throws on an empty / over-long name.
 */
export function mintRumClient(
  projectId: string,
  name: string,
  createdBy?: string | null,
): MintedRumClient {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('projectId is required');
  }
  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > 100) {
    throw new Error('name must be 1-100 characters');
  }

  const id = uuidv4();
  const token = generateRawToken();
  const tokenHash = hashToken(token);
  const prefix = token.slice(0, PREFIX_LENGTH);

  getStmts().insertRumClient.run(id, projectId, trimmedName, tokenHash, prefix, createdBy ?? null);

  const row = getStmts().getRumClient.get(id) as RumClientRow;
  return { ...rowToRecord(row), token };
}

/** Active (non-revoked) clients for a project, newest first. */
export function listRumClients(projectId: string): RumClientRecord[] {
  const rows = getStmts().listRumClientsByProject.all(projectId) as RumClientRow[];
  return rows.map(rowToRecord);
}

/**
 * Soft-delete a client by setting `revoked_at`. Scoped to `projectId`, so a
 * clientId belonging to another project is a no-op. Returns true if a row was
 * revoked (404 from the route's perspective when false).
 */
export function revokeRumClient(projectId: string, clientId: string): boolean {
  const result = getStmts().revokeRumClient.run(clientId, projectId);
  return result.changes > 0;
}

/**
 * Verify a presented `X-RUM-Token`. Returns the owning project + client id on
 * success, or null for a malformed / unknown / revoked token. On success,
 * debounces a `last_used_at` write (max once per minute per client).
 */
export function verifyRumToken(token: unknown): VerifiedRumClient | null {
  if (typeof token !== 'string' || !TOKEN_REGEX.test(token)) return null;

  const tokenHash = hashToken(token);
  const row = getStmts().getRumClientByPrefixHash.get(token.slice(0, PREFIX_LENGTH), tokenHash) as
    | RumClientRow
    | undefined;

  if (!row) return null;
  if (row.revoked_at) return null;

  const now = Date.now();
  const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (now - last >= LAST_USED_DEBOUNCE_MS) {
    try {
      getStmts().touchRumClientLastUsed.run(row.id);
    } catch {
      // Non-critical: a failed write here only makes the "last used" stamp
      // slightly stale. Never fail an authenticated ingest over it.
    }
  }

  return { clientId: row.id, projectId: row.project_id, name: row.name };
}
