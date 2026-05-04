/**
 * user-integrations-store.ts — Per-user integration connection persistence.
 *
 * Stores the link between an Agent Hub user (`users.id` in orgs.db) and a
 * third-party app connection (Slack, Google, GitHub-via-Nango, etc.). One
 * row per `(user_id, app)` — reconnecting the same app overwrites the
 * existing row via upsert.
 *
 * Cross-user isolation is enforced at the query layer: every read is
 * parameterised on `user_id`, so a `listForUser('alice')` call can never
 * surface bob's rows even if app code forgets to scope. The composite
 * primary key `(user_id, app)` prevents two rows for the same pair.
 *
 * `metadata` is opaque JSON encoded as TEXT — providers (Nango etc.)
 * stash provider-specific shape there. Helpers JSON-parse on read and
 * stringify on write so callers work with plain objects.
 */
import { getOrgsDb } from './orgs.js';

export type UserIntegrationStatus = 'PENDING' | 'CONNECTED' | 'ERROR' | 'REVOKED';

export interface UserIntegrationRow {
  userId: string;
  app: string;
  connectionId: string;
  status: UserIntegrationStatus | string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  user_id: string;
  app: string;
  connection_id: string;
  status: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function rowToIntegration(row: RawRow): UserIntegrationRow {
  return {
    userId: row.user_id,
    app: row.app,
    connectionId: row.connection_id,
    status: row.status,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertUserIntegrationInput {
  userId: string;
  app: string;
  connectionId: string;
  status?: UserIntegrationStatus | string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert or replace the `(userId, app)` row. Subsequent calls update
 * `connection_id`, `status`, `metadata`, and `updated_at` while keeping
 * the original `created_at`.
 */
export function upsert(input: UpsertUserIntegrationInput): UserIntegrationRow {
  const db = getOrgsDb();
  const status = input.status ?? 'PENDING';
  const metadataJson =
    input.metadata === undefined || input.metadata === null ? null : JSON.stringify(input.metadata);

  db.prepare(
    `INSERT INTO user_integrations (user_id, app, connection_id, status, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, app) DO UPDATE SET
       connection_id = excluded.connection_id,
       status        = excluded.status,
       metadata      = excluded.metadata,
       updated_at    = CURRENT_TIMESTAMP`,
  ).run(input.userId, input.app, input.connectionId, status, metadataJson);

  const row = getForUser(input.userId, input.app);
  if (!row) {
    // Should be unreachable — we just inserted/updated and the PK is
    // (user_id, app). If it fires, the DB handle was swapped between
    // the write and the read.
    throw new Error('user_integrations upsert: row vanished after write');
  }
  return row;
}

/**
 * Return the integration for a single `(userId, app)` pair, or `null`
 * when no row exists. Cross-user reads are impossible — both columns
 * are bound parameters.
 */
export function getForUser(userId: string, app: string): UserIntegrationRow | null {
  const db = getOrgsDb();
  const row = db
    .prepare(
      `SELECT user_id, app, connection_id, status, metadata, created_at, updated_at
       FROM user_integrations
       WHERE user_id = ? AND app = ?`,
    )
    .get(userId, app) as RawRow | undefined;
  return row ? rowToIntegration(row) : null;
}

/**
 * List every integration row for `userId`. Returns `[]` when the user
 * has no rows (or doesn't exist) — the query filter is the only
 * isolation needed.
 */
export function listForUser(userId: string): UserIntegrationRow[] {
  const db = getOrgsDb();
  const rows = db
    .prepare(
      `SELECT user_id, app, connection_id, status, metadata, created_at, updated_at
       FROM user_integrations
       WHERE user_id = ?
       ORDER BY app ASC`,
    )
    .all(userId) as RawRow[];
  return rows.map(rowToIntegration);
}

/**
 * Remove a single `(userId, app)` row. Returns `true` when a row was
 * deleted, `false` when the row didn't exist (idempotent).
 */
function deleteForUser(userId: string, app: string): boolean {
  const db = getOrgsDb();
  const info = db
    .prepare('DELETE FROM user_integrations WHERE user_id = ? AND app = ?')
    .run(userId, app);
  return info.changes > 0;
}

// Exported as `delete` for the API contract. `delete` is a reserved
// word so the function declaration above uses `deleteForUser`; the
// alias below is what consumers import.
export { deleteForUser as delete };
