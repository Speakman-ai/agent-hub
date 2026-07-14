/**
 * Log-source management + ingest-token lifecycle (decision LOG-AUTH).
 *
 * Each project registers named **log sources**. A source carries an
 * independent random `ahlog_` ingest token that identifies exactly one
 * (project, source) pair and nothing else:
 *
 *   - **Write-only.** The token authenticates log *ingestion* only. It is not
 *     an Agent Hub API credential and grants no read/query/management access.
 *   - **Identity is derived from the token, never the request body**
 *     (`resolveLogSourceByToken`). An ingest caller cannot spoof a different
 *     project/source by putting other ids in the payload — the resolver only
 *     reads the token.
 *   - **Reveal once.** `createLogSource` / `rotateLogSourceToken` return the
 *     plaintext token exactly once; the DB stores only `sha256(token)` (hex)
 *     plus a short non-secret `prefix` for identification. Same storage model
 *     as `api-keys-store.ts` — 256 bits of entropy means a single SHA-256 is
 *     sufficient (nothing brute-forceable, no KDF needed).
 *
 * Every create / update / rotate / revoke / delete appends a row to
 * `log_source_audit`, attributed to the acting Agent Hub user.
 *
 * All state lives in the dedicated `logs.db` handle (decision LOG-STORE) — it
 * never touches `agent-hub.db` / `orgs.db`. Thin synchronous wrappers over
 * `better-sqlite3`, so they unit-test against a scratch data dir without
 * booting the server.
 */

import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getLogsDb } from './logs-db.js';
import {
  LOG_SOURCE_TOKEN_PREFIX,
  MAX_SOURCE_NAME_LENGTH,
  MAX_SOURCE_FACET_LENGTH,
} from './logs-schema.js';

const TOKEN_RANDOM_BYTES = 32;
/** `ahlog_` (6) + 8 chars of the random body → indexed, non-secret prefix. */
const PREFIX_LENGTH = LOG_SOURCE_TOKEN_PREFIX.length + 8;
/**
 * Wire shape: `ahlog_` + url-safe base64 of ≥32 random bytes (43 chars). The
 * `{40,}` lower bound tolerates future entropy bumps while rejecting obvious
 * junk before we bother hashing.
 */
export const LOG_SOURCE_TOKEN_REGEX = /^ahlog_[A-Za-z0-9_-]{40,}$/;

export type LogSourceAuditAction = 'create' | 'update' | 'rotate' | 'revoke' | 'delete';

/** Public source metadata. Never includes the plaintext token or its hash. */
export interface LogSourceRecord {
  id: string;
  projectId: string;
  name: string;
  serviceName: string | null;
  environment: string | null;
  /** Short, non-secret identifier of the current token (`ahlog_xxxxxxxx`). */
  tokenPrefix: string | null;
  /** `active` while a live token can ingest; `revoked` once the token is killed. */
  status: 'active' | 'revoked';
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
}

/** A create/rotate result — carries the plaintext token exactly once. */
export interface LogSourceWithToken extends LogSourceRecord {
  /** Plaintext ingest token. Surfaced to the caller once and never stored. */
  token: string;
}

/** Identity an ingest request resolves to, derived solely from its token. */
export interface ResolvedLogSource {
  projectId: string;
  sourceId: string;
  name: string;
  serviceName: string | null;
  environment: string | null;
}

interface LogSourceRow {
  id: string;
  project_id: string;
  name: string;
  service_name: string | null;
  environment: string | null;
  token_hash: string | null;
  token_prefix: string | null;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

export interface LogSourceAuditRecord {
  id: string;
  projectId: string;
  sourceId: string | null;
  action: LogSourceAuditAction;
  actorUserId: string | null;
  detail: string | null;
  createdAt: number;
}

/** Thrown for user-correctable failures (bad name, duplicate). Maps to 4xx. */
export class LogSourceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'LogSourceError';
  }
}

/** Crypto-grade random ingest token, url-safe base64, `ahlog_`-prefixed. */
function generateRawToken(): string {
  const raw = randomBytes(TOKEN_RANDOM_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${LOG_SOURCE_TOKEN_PREFIX}${raw}`;
}

/** Single SHA-256, hex-encoded. Deterministic — same input ⇒ same hash. */
export function hashLogSourceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function rowToRecord(row: LogSourceRow): LogSourceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    serviceName: row.service_name,
    environment: row.environment,
    tokenPrefix: row.token_prefix,
    status: row.revoked_at != null ? 'revoked' : 'active',
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

/** Validate + trim the display name. Throws {@link LogSourceError} on bad input. */
function normalizeName(name: unknown): string {
  if (typeof name !== 'string') throw new LogSourceError('name is required');
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new LogSourceError('name is required');
  if (trimmed.length > MAX_SOURCE_NAME_LENGTH) {
    throw new LogSourceError(`name must be ${MAX_SOURCE_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}

/** Validate + trim an optional facet (service_name / environment). */
function normalizeFacet(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new LogSourceError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_SOURCE_FACET_LENGTH) {
    throw new LogSourceError(`${field} must be ${MAX_SOURCE_FACET_LENGTH} characters or fewer`);
  }
  return trimmed;
}

function appendAudit(opts: {
  projectId: string;
  sourceId: string | null;
  action: LogSourceAuditAction;
  actorUserId: string | null;
  detail?: string | null;
  nowMs: number;
}): void {
  getLogsDb()
    .prepare(
      `INSERT INTO log_source_audit (id, project_id, source_id, action, actor_user_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuidv4(),
      opts.projectId,
      opts.sourceId,
      opts.action,
      opts.actorUserId ?? null,
      opts.detail ?? null,
      opts.nowMs,
    );
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** All sources for a project, newest-first. Never includes token material. */
export function listLogSources(projectId: string): LogSourceRecord[] {
  const rows = getLogsDb()
    .prepare('SELECT * FROM log_sources WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as LogSourceRow[];
  return rows.map(rowToRecord);
}

/** One source scoped to its project, or null if not found. */
export function getLogSource(projectId: string, sourceId: string): LogSourceRecord | null {
  const row = getLogsDb()
    .prepare('SELECT * FROM log_sources WHERE id = ? AND project_id = ?')
    .get(sourceId, projectId) as LogSourceRow | undefined;
  return row ? rowToRecord(row) : null;
}

/** Lifecycle audit for a single source, newest-first. */
export function listLogSourceAudit(
  projectId: string,
  sourceId: string,
  limit = 100,
): LogSourceAuditRecord[] {
  const rows = getLogsDb()
    .prepare(
      `SELECT * FROM log_source_audit
        WHERE project_id = ? AND source_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(projectId, sourceId, Math.min(Math.max(limit, 1), 500)) as Array<{
    id: string;
    project_id: string;
    source_id: string | null;
    action: string;
    actor_user_id: string | null;
    detail: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    sourceId: r.source_id,
    action: r.action as LogSourceAuditAction,
    actorUserId: r.actor_user_id,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

// ── Ingest identity resolution ──────────────────────────────────────────────

/**
 * Resolve a presented ingest token to its (project, source) identity.
 *
 * This is the ONLY authority for who an ingest request is: identity is derived
 * from the token, never from request-body fields (decision LOG-AUTH). Returns
 * `null` for malformed strings, unknown/rotated-away hashes, or revoked
 * sources — the caller must treat `null` as 401 and write nothing.
 */
export function resolveLogSourceByToken(token: string): ResolvedLogSource | null {
  if (typeof token !== 'string' || !LOG_SOURCE_TOKEN_REGEX.test(token)) return null;
  const tokenHash = hashLogSourceToken(token);
  const row = getLogsDb()
    .prepare(
      `SELECT id, project_id, name, service_name, environment
         FROM log_sources
        WHERE token_prefix = ? AND token_hash = ? AND revoked_at IS NULL`,
    )
    .get(token.slice(0, PREFIX_LENGTH), tokenHash) as
    | {
        id: string;
        project_id: string;
        name: string;
        service_name: string | null;
        environment: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    projectId: row.project_id,
    sourceId: row.id,
    name: row.name,
    serviceName: row.service_name,
    environment: row.environment,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface CreateLogSourceInput {
  projectId: string;
  name: string;
  serviceName?: string | null;
  environment?: string | null;
  actorUserId?: string | null;
}

/**
 * Register a new source and mint its first ingest token. The plaintext token
 * is returned ONCE in `.token`; only its hash + prefix are persisted. Throws
 * {@link LogSourceError} (409) on a duplicate `(project_id, name)`.
 */
export function createLogSource(input: CreateLogSourceInput, nowMs: number): LogSourceWithToken {
  const name = normalizeName(input.name);
  const serviceName = normalizeFacet(input.serviceName, 'serviceName');
  const environment = normalizeFacet(input.environment, 'environment');

  const id = uuidv4();
  const token = generateRawToken();
  const tokenHash = hashLogSourceToken(token);
  const tokenPrefix = token.slice(0, PREFIX_LENGTH);

  const db = getLogsDb();
  try {
    db.prepare(
      `INSERT INTO log_sources
         (id, project_id, name, service_name, environment, token_hash, token_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.projectId, name, serviceName, environment, tokenHash, tokenPrefix, nowMs);
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) {
      throw new LogSourceError(`a source named "${name}" already exists in this project`, 409);
    }
    throw err;
  }

  appendAudit({
    projectId: input.projectId,
    sourceId: id,
    action: 'create',
    actorUserId: input.actorUserId ?? null,
    nowMs,
  });

  const row = db.prepare('SELECT * FROM log_sources WHERE id = ?').get(id) as LogSourceRow;
  return { ...rowToRecord(row), token };
}

export interface UpdateLogSourceInput {
  name?: string;
  serviceName?: string | null;
  environment?: string | null;
}

/**
 * Update a source's mutable metadata (name / service / environment). Token
 * material is untouched. Returns the updated record, or null if the source
 * does not exist in the project. Throws {@link LogSourceError} (409) on a
 * name collision.
 */
export function updateLogSource(
  projectId: string,
  sourceId: string,
  patch: UpdateLogSourceInput,
  actorUserId: string | null,
  nowMs: number,
): LogSourceRecord | null {
  const db = getLogsDb();
  const existing = db
    .prepare('SELECT * FROM log_sources WHERE id = ? AND project_id = ?')
    .get(sourceId, projectId) as LogSourceRow | undefined;
  if (!existing) return null;

  const name = patch.name !== undefined ? normalizeName(patch.name) : existing.name;
  const serviceName =
    patch.serviceName !== undefined
      ? normalizeFacet(patch.serviceName, 'serviceName')
      : existing.service_name;
  const environment =
    patch.environment !== undefined
      ? normalizeFacet(patch.environment, 'environment')
      : existing.environment;

  try {
    db.prepare(
      `UPDATE log_sources SET name = ?, service_name = ?, environment = ? WHERE id = ?`,
    ).run(name, serviceName, environment, sourceId);
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) {
      throw new LogSourceError(`a source named "${name}" already exists in this project`, 409);
    }
    throw err;
  }

  appendAudit({ projectId, sourceId, action: 'update', actorUserId, nowMs });
  const row = db.prepare('SELECT * FROM log_sources WHERE id = ?').get(sourceId) as LogSourceRow;
  return rowToRecord(row);
}

/**
 * Mint a fresh token for a source, invalidating the previous one and
 * re-activating a revoked source. Returns the record with the new plaintext
 * token (once), or null if the source does not exist in the project.
 */
export function rotateLogSourceToken(
  projectId: string,
  sourceId: string,
  actorUserId: string | null,
  nowMs: number,
): LogSourceWithToken | null {
  const db = getLogsDb();
  const existing = db
    .prepare('SELECT id FROM log_sources WHERE id = ? AND project_id = ?')
    .get(sourceId, projectId) as { id: string } | undefined;
  if (!existing) return null;

  const token = generateRawToken();
  const tokenHash = hashLogSourceToken(token);
  const tokenPrefix = token.slice(0, PREFIX_LENGTH);

  db.prepare(
    `UPDATE log_sources
        SET token_hash = ?, token_prefix = ?, rotated_at = ?, revoked_at = NULL
      WHERE id = ?`,
  ).run(tokenHash, tokenPrefix, nowMs, sourceId);

  appendAudit({ projectId, sourceId, action: 'rotate', actorUserId, nowMs });
  const row = db.prepare('SELECT * FROM log_sources WHERE id = ?').get(sourceId) as LogSourceRow;
  return { ...rowToRecord(row), token };
}

/**
 * Revoke a source's token (write-disable). The source row is kept for audit /
 * history; its token can no longer resolve. Returns the record, or null if the
 * source does not exist in the project. Idempotent — revoking an already-
 * revoked source is a no-op that still returns the record.
 */
export function revokeLogSourceToken(
  projectId: string,
  sourceId: string,
  actorUserId: string | null,
  nowMs: number,
): LogSourceRecord | null {
  const db = getLogsDb();
  const existing = db
    .prepare('SELECT * FROM log_sources WHERE id = ? AND project_id = ?')
    .get(sourceId, projectId) as LogSourceRow | undefined;
  if (!existing) return null;
  if (existing.revoked_at != null) return rowToRecord(existing);

  db.prepare('UPDATE log_sources SET revoked_at = ? WHERE id = ?').run(nowMs, sourceId);
  appendAudit({ projectId, sourceId, action: 'revoke', actorUserId, nowMs });
  const row = db.prepare('SELECT * FROM log_sources WHERE id = ?').get(sourceId) as LogSourceRow;
  return rowToRecord(row);
}

/**
 * Delete a source and its token entirely. Returns true if a row was removed.
 * The audit row is written before the delete so the lifecycle record survives.
 */
export function deleteLogSource(
  projectId: string,
  sourceId: string,
  actorUserId: string | null,
  nowMs: number,
): boolean {
  const db = getLogsDb();
  const existing = db
    .prepare('SELECT id FROM log_sources WHERE id = ? AND project_id = ?')
    .get(sourceId, projectId) as { id: string } | undefined;
  if (!existing) return false;

  appendAudit({ projectId, sourceId, action: 'delete', actorUserId, nowMs });
  db.prepare('DELETE FROM log_sources WHERE id = ?').run(sourceId);
  return true;
}
