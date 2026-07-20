import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';
import { encryptSecret, decryptSecret } from './secret-crypto.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_VALUE_CHARS = 4096;

export type SessionCredentialFieldType = 'text' | 'username' | 'password';

export interface SessionCredentialField {
  key: string;
  label: string;
  type: SessionCredentialFieldType;
}

export interface SubmitSessionCredentialRequestInput {
  sessionId: string;
  requestId: string;
  service: string;
  purpose: string;
  fields: SessionCredentialField[];
  values: Record<string, string>;
  ttlSeconds?: number | null;
}

export interface SessionCredentialRequestStatus {
  requestId: string;
  service: string;
  purpose: string;
  fields: SessionCredentialField[];
  status: 'submitted' | 'consumed' | 'expired';
  submittedAt: string;
  consumedAt: string | null;
  expiresAt: string;
}

interface RawSessionCredentialRequestRow {
  id: string;
  session_id: string;
  request_id: string;
  service: string;
  purpose: string;
  fields_json: string;
  values_enc: string;
  submitted_at: string;
  consumed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

let beforeConsumeUpdateForTests: (() => void) | null = null;

export function __setSessionCredentialConsumeBeforeUpdateForTests(
  callback: (() => void) | null,
): void {
  beforeConsumeUpdateForTests = callback;
}

export class SessionCredentialRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'SessionCredentialRequestError';
  }
}

function nowMs(): number {
  return Date.now();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function cleanText(value: string, fallback: string, maxLength: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return (trimmed || fallback).slice(0, maxLength);
}

function validateRequestId(requestId: string): string {
  const id = cleanText(requestId, '', 128);
  if (!REQUEST_ID_RE.test(id)) {
    throw new SessionCredentialRequestError('requestId is invalid');
  }
  return id;
}

function normalizeFields(fields: SessionCredentialField[]): SessionCredentialField[] {
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 6) {
    throw new SessionCredentialRequestError('fields must contain 1 to 6 entries');
  }
  const seen = new Set<string>();
  return fields.map((field, index) => {
    if (!field || typeof field !== 'object') {
      throw new SessionCredentialRequestError(`fields[${index}] must be an object`);
    }
    const key = cleanText(field.key, '', 64);
    if (!FIELD_KEY_RE.test(key)) {
      throw new SessionCredentialRequestError(`fields[${index}].key is invalid`);
    }
    if (seen.has(key)) {
      throw new SessionCredentialRequestError(`duplicate field key "${key}"`);
    }
    seen.add(key);
    const type = field.type === 'username' || field.type === 'password' ? field.type : 'text';
    return {
      key,
      label: cleanText(field.label, key, 80),
      type,
    };
  });
}

function normalizeValues(
  fields: SessionCredentialField[],
  values: Record<string, string>,
): Record<string, string> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new SessionCredentialRequestError('values must be an object');
  }
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new SessionCredentialRequestError(`value for "${field.key}" is required`);
    }
    if (value.length > MAX_VALUE_CHARS) {
      throw new SessionCredentialRequestError(
        `value for "${field.key}" exceeds ${MAX_VALUE_CHARS} characters`,
      );
    }
    out[field.key] = value;
  }
  return out;
}

function ttlMs(ttlSeconds?: number | null): number {
  if (ttlSeconds === undefined || ttlSeconds === null) return DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new SessionCredentialRequestError('ttlSeconds must be positive');
  }
  return Math.min(Math.floor(ttlSeconds * 1000), MAX_TTL_MS);
}

function rowIsExpired(row: RawSessionCredentialRequestRow): boolean {
  return Date.parse(row.expires_at) <= nowMs();
}

function rowStatus(row: RawSessionCredentialRequestRow): SessionCredentialRequestStatus['status'] {
  // Expiry takes precedence over the consumed state. Consumed rows now retain
  // their encrypted payload until they expire (see consume/eraseExpired), so
  // ranking 'consumed' first would report an expired-after-consume row as
  // 'consumed' and let read/list paths skip the expiry cleanup branch, leaving
  // ciphertext past its TTL and contradicting the "discarded when they expire"
  // contract.
  if (rowIsExpired(row)) return 'expired';
  if (row.consumed_at) return 'consumed';
  return 'submitted';
}

function eraseExpiredCredentialValues(
  row: RawSessionCredentialRequestRow,
): RawSessionCredentialRequestRow {
  // Values now linger (re-readable) after a consume, so an expired row must be
  // erased regardless of whether it was already consumed once.
  if (!row.values_enc || !rowIsExpired(row)) return row;
  const updatedAt = iso(nowMs());
  const result = getDb()
    .prepare(
      `UPDATE session_credential_requests
       SET values_enc = '', updated_at = ?
       WHERE id = ? AND expires_at = ? AND values_enc = ?`,
    )
    .run(updatedAt, row.id, row.expires_at, row.values_enc);
  if (result.changes !== 1) return row;
  return { ...row, values_enc: '', updated_at: updatedAt };
}

function parseFields(row: RawSessionCredentialRequestRow): SessionCredentialField[] {
  try {
    const parsed = JSON.parse(row.fields_json);
    return normalizeFields(parsed);
  } catch {
    return [];
  }
}

function toStatus(row: RawSessionCredentialRequestRow): SessionCredentialRequestStatus {
  return {
    requestId: row.request_id,
    service: row.service,
    purpose: row.purpose,
    fields: parseFields(row),
    status: rowStatus(row),
    submittedAt: row.submitted_at,
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
  };
}

export function submitSessionCredentialRequest(
  input: SubmitSessionCredentialRequestInput,
): SessionCredentialRequestStatus {
  const requestId = validateRequestId(input.requestId);
  const service = cleanText(input.service, 'Credential request', 120);
  const purpose = cleanText(input.purpose, 'Sign in for this session', 240);
  const fields = normalizeFields(input.fields);
  const values = normalizeValues(fields, input.values);
  const submittedAt = iso(nowMs());
  const expiresAt = iso(nowMs() + ttlMs(input.ttlSeconds));
  const fieldsJson = JSON.stringify(fields);
  const enc = encryptSecret(JSON.stringify(values));
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM session_credential_requests
       WHERE session_id = ? AND request_id = ?`,
    )
    .get(input.sessionId, requestId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE session_credential_requests
       SET service = ?, purpose = ?, fields_json = ?, values_enc = ?,
           submitted_at = ?, consumed_at = NULL, expires_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(service, purpose, fieldsJson, enc, submittedAt, expiresAt, submittedAt, existing.id);
  } else {
    db.prepare(
      `INSERT INTO session_credential_requests
         (id, session_id, request_id, service, purpose, fields_json, values_enc,
          submitted_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      input.sessionId,
      requestId,
      service,
      purpose,
      fieldsJson,
      enc,
      submittedAt,
      expiresAt,
      submittedAt,
      submittedAt,
    );
  }

  const row = getSessionCredentialRequestRow(input.sessionId, requestId);
  if (!row) throw new SessionCredentialRequestError('credential request was not saved', 500);
  return toStatus(row);
}

function getSessionCredentialRequestRow(
  sessionId: string,
  requestId: string,
): RawSessionCredentialRequestRow | null {
  const id = validateRequestId(requestId);
  const row = getDb()
    .prepare(
      `SELECT * FROM session_credential_requests
       WHERE session_id = ? AND request_id = ?`,
    )
    .get(sessionId, id) as RawSessionCredentialRequestRow | undefined;
  return row ?? null;
}

export function getSessionCredentialRequestStatus(
  sessionId: string,
  requestId: string,
): SessionCredentialRequestStatus | null {
  const row = getSessionCredentialRequestRow(sessionId, requestId);
  return row ? toStatus(eraseExpiredCredentialValues(row)) : null;
}

export function consumeSessionCredentialRequest(
  sessionId: string,
  requestId: string,
): {
  requestId: string;
  service: string;
  purpose: string;
  values: Record<string, string>;
} | null {
  const db = getDb();
  return db.transaction(() => {
    const row = getSessionCredentialRequestRow(sessionId, requestId);
    if (!row) return null;
    // Expired requests never return plaintext, even if consumed once before
    // expiry (rowStatus gives expiry precedence for the same reason).
    if (rowIsExpired(row)) {
      eraseExpiredCredentialValues(row);
      return null;
    }
    if (!row.values_enc) return null;

    // Stamp the first-use time once, but keep the encrypted payload
    // retrievable until the request's TTL expires. A strictly one-time read
    // turned a routine agent-sequencing mistake (consume the value inside a
    // throwaway probe subprocess, then lose it when that process exits) into a
    // "please re-enter your password" loop for the human. The secret is
    // already encrypted at rest and bounded by the TTL the user chose, so
    // allowing re-reads inside that same window does not widen exposure; it
    // just lets the agent re-consume the same requestId instead of asking the
    // user to resubmit. Expiry (eraseExpiredCredentialValues) and explicit
    // delete remain the only paths that blank the value.
    beforeConsumeUpdateForTests?.();
    if (!row.consumed_at) {
      const consumedAt = iso(nowMs());
      db.prepare(
        `UPDATE session_credential_requests
         SET consumed_at = ?, updated_at = ?
         WHERE id = ? AND consumed_at IS NULL`,
      ).run(consumedAt, consumedAt, row.id);
    }

    // Re-read the row so a concurrent delete/expiry that blanked the payload
    // between our initial read and here can never return stale plaintext.
    const fresh = getSessionCredentialRequestRow(sessionId, requestId);
    if (!fresh || !fresh.values_enc) return null;
    // The request can cross its TTL between the initial rowIsExpired(row) check
    // and here. Erase the ciphertext on that boundary instead of leaving it
    // retained past TTL until some later status/consume path cleans it up.
    if (rowIsExpired(fresh)) {
      eraseExpiredCredentialValues(fresh);
      return null;
    }
    let values: Record<string, string>;
    try {
      values = JSON.parse(decryptSecret(fresh.values_enc)) as Record<string, string>;
    } catch {
      throw new SessionCredentialRequestError('credential request cannot be decrypted', 500);
    }
    return {
      requestId: fresh.request_id,
      service: fresh.service,
      purpose: fresh.purpose,
      values,
    };
  })();
}

export function deleteSessionCredentialRequest(sessionId: string, requestId: string): boolean {
  const id = validateRequestId(requestId);
  const result = getDb()
    .prepare(
      `DELETE FROM session_credential_requests
       WHERE session_id = ? AND request_id = ?`,
    )
    .run(sessionId, id);
  return result.changes > 0;
}
