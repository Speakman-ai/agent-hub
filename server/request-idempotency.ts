/**
 * `Idempotency-Key` support for routes that start work (create a session,
 * send a message). A client that lost the response, or crashed before
 * recording success, retries with the same key and gets the original result
 * back instead of a second session or a duplicated turn.
 *
 * Keys are scoped to the caller and the route, kept for a week, and bound to
 * a hash of the request: reusing a key with a different body is a 422.
 * Handlers must check and record within the same synchronous block as the
 * write, so two concurrent retries can't both get through.
 */
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { getDb } from './db.js';
import type { AuthenticatedRequest } from './auth.js';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const RETENTION = '-7 days';

export const IDEMPOTENT_REPLAY_HEADER = 'Idempotent-Replayed';

export type IdempotencyKeyResult = { key: string | null } | { error: string };

/** The request's `Idempotency-Key`, null when absent, or an error when malformed. */
export function readIdempotencyKey(req: Request): IdempotencyKeyResult {
  const raw = req.get('idempotency-key');
  if (raw === undefined) return { key: null };
  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) {
    return { error: 'Idempotency-Key must be 1-200 characters of A-Z a-z 0-9 . _ : -' };
  }
  return { key };
}

/** Who a key belongs to: the signed-in user, else the shared bypass identity. */
export function idempotencyScope(req: Request): string {
  return (req as AuthenticatedRequest).authUserId ?? 'shared';
}

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export type IdempotentLookup =
  | { kind: 'new' }
  | {
      kind: 'replay';
      sessionId: string;
      resultId: string | null;
    }
  | { kind: 'mismatch' };

export function lookupIdempotent(
  scope: string,
  route: string,
  key: string,
  hash: string,
): IdempotentLookup {
  const row = getDb()
    .prepare(
      'SELECT payload_hash, session_id, result_id FROM request_idempotency WHERE scope = ? AND route = ? AND key = ?',
    )
    .get(scope, route, key) as
    | { payload_hash: string; session_id: string; result_id: string | null }
    | undefined;
  if (!row) return { kind: 'new' };
  if (row.payload_hash !== hash) return { kind: 'mismatch' };
  return {
    kind: 'replay',
    sessionId: row.session_id,
    resultId: row.result_id,
  };
}

/** Record (or re-record, for a rerun) the result for a key. */
export function recordIdempotent(
  scope: string,
  route: string,
  key: string,
  hash: string,
  sessionId: string,
  resultId: string | null = null,
): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM request_idempotency WHERE created_at < datetime('now', '${RETENTION}')`,
  ).run();
  db.prepare(
    'INSERT OR REPLACE INTO request_idempotency (scope, route, key, payload_hash, session_id, result_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(scope, route, key, hash, sessionId, resultId);
}
