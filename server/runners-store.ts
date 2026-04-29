/**
 * Runners store — persistent registry of user-machine runners that can
 * spawn CLI processes on behalf of the control plane.
 *
 * Phase 1: rows + plaintext-token issuance (hash stored). Live connection
 * tracking lives in the WS handler; this module only owns DB queries.
 *
 * The table is created in the per-org `agent-hub.db` (not the shared
 * `orgs.db`) so each org's runner roster is isolated. Multi-runner per
 * machine is supported by the (org_id, name) UNIQUE constraint allowing
 * arbitrarily many distinct names from the same physical box (typically
 * `<machine>-<profile>` — e.g. `alice-laptop`, `alice-laptop-work`).
 */
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { RUNNERS_SCHEMA } from './runners-schema.js';

export { RUNNERS_SCHEMA };

export interface RunnerRow {
  id: string;
  org_id: string;
  name: string;
  token_hash: string;
  capabilities: string; // JSON-encoded RunnerCapabilities
  status: 'offline' | 'online';
  last_seen_at: string | null;
  /** Phase 3 — last time the dispatcher picked this runner for a spawn.
   * NULL until the runner has been selected at least once. Used for
   * round-robin fairness among capability-equivalent runners. */
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunnerPublic {
  id: string;
  orgId: string;
  name: string;
  capabilities: Record<string, unknown>;
  status: 'offline' | 'online';
  lastSeenAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * SHA-256 hex of the plaintext token. Cheap, deterministic, and good
 * enough for opaque random tokens — these aren't passwords (no user
 * input, full entropy from `crypto.randomBytes`), so we don't need a
 * slow KDF here.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Generate a fresh URL-safe token. 32 bytes → 43 base64url chars. */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function rowToPublic(row: RunnerRow): RunnerPublic {
  let caps: Record<string, unknown> = {};
  try {
    caps = JSON.parse(row.capabilities) as Record<string, unknown>;
  } catch {
    /* corrupt JSON is non-fatal — surface as empty caps */
  }
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    capabilities: caps,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Stamp `last_used_at = now()` on a runner. Called by the dispatcher
 * each time it selects this runner for a spawn — gives round-robin
 * picking a fairness signal that survives restarts (the in-memory
 * `activeRunners` map is recreated on every server boot, but the DB
 * timestamp persists). Returns `false` if no row matched, otherwise
 * `true`.
 *
 * Tolerant of a missing `last_used_at` column for tests that apply the
 * pre-Phase-3 schema directly without the migration; the SQLite error
 * is swallowed and `false` is returned. Production code goes through
 * `initDb` which always applies the migration.
 */
export function recordRunnerUse(id: string, now: string = new Date().toISOString()): boolean {
  try {
    const info = getDb()
      .prepare('UPDATE runners SET last_used_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
    return info.changes > 0;
  } catch {
    return false;
  }
}

/**
 * Create a new runner row and return both the public view and the
 * plaintext token. The token is shown to the caller exactly once — it's
 * never recoverable from the DB after this returns.
 */
export function createRunner(opts: {
  orgId: string;
  name: string;
  capabilities?: Record<string, unknown>;
}): { runner: RunnerPublic; token: string } {
  const db = getDb();
  const id = uuidv4();
  const token = generateToken();
  const tokenHash = hashToken(token);
  const capsJson = JSON.stringify(opts.capabilities ?? {});
  db.prepare(
    `INSERT INTO runners (id, org_id, name, token_hash, capabilities)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, opts.orgId, opts.name, tokenHash, capsJson);
  const row = db.prepare('SELECT * FROM runners WHERE id = ?').get(id) as RunnerRow;
  return { runner: rowToPublic(row), token };
}

export function getRunner(id: string): RunnerPublic | null {
  const row = getDb().prepare('SELECT * FROM runners WHERE id = ?').get(id) as
    | RunnerRow
    | undefined;
  return row ? rowToPublic(row) : null;
}

/** Internal — fetch the raw row including token_hash. WS handshake only. */
export function getRunnerRow(id: string): RunnerRow | null {
  const row = getDb().prepare('SELECT * FROM runners WHERE id = ?').get(id) as
    | RunnerRow
    | undefined;
  return row ?? null;
}

export function listRunners(orgId?: string): RunnerPublic[] {
  const db = getDb();
  const rows = (
    orgId
      ? db.prepare('SELECT * FROM runners WHERE org_id = ? ORDER BY name ASC').all(orgId)
      : db.prepare('SELECT * FROM runners ORDER BY org_id, name ASC').all()
  ) as RunnerRow[];
  return rows.map(rowToPublic);
}

export function deleteRunner(id: string): boolean {
  const info = getDb().prepare('DELETE FROM runners WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * Mark a runner online/offline. Called from the WS layer on connect
 * (`online`) and disconnect (`offline`). Also bumps `last_seen_at` so
 * a stale row doesn't keep a fresh timestamp from a crashed connection.
 */
export function setRunnerStatus(
  id: string,
  status: 'online' | 'offline',
  capabilities?: Record<string, unknown>,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (capabilities !== undefined) {
    db.prepare(
      `UPDATE runners
         SET status = ?, last_seen_at = ?, capabilities = ?, updated_at = ?
       WHERE id = ?`,
    ).run(status, now, JSON.stringify(capabilities), now, id);
  } else {
    db.prepare(
      `UPDATE runners
         SET status = ?, last_seen_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(status, now, now, id);
  }
}

/**
 * Constant-time comparison of a candidate plaintext token against the
 * stored hash. Returns false if the row doesn't exist or hashes differ.
 */
export function verifyRunnerToken(id: string, token: string): boolean {
  const row = getRunnerRow(id);
  if (!row) return false;
  const candidate = hashToken(token);
  // Same length by construction (sha256 hex), so timingSafeEqual is safe.
  try {
    return crypto.timingSafeEqual(
      Buffer.from(candidate, 'hex'),
      Buffer.from(row.token_hash, 'hex'),
    );
  } catch {
    return false;
  }
}
