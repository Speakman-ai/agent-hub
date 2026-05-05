/**
 * MCP-server registry — per-user store for Model Context Protocol servers
 * that get injected into Claude Code spawns via `--mcp-config <path>`.
 *
 * Replaces the deleted Nango integration. Each row is owned by exactly
 * one Hub user; resolution at spawn time is keyed on
 * `session.owner_user_id` so users can't see / spawn against another
 * user's connections.
 *
 * Two transports supported in v1:
 *   - `stdio` — local process: `command` + `args` + `env`
 *   - `http`  — remote URL: `url` + `headers` (often `Authorization: Bearer …`)
 *
 * Secrets at rest:
 *   - `env_encrypted_json` — entire `env` object encrypted with AES-256-GCM.
 *   - `headers_encrypted_json` — entire `headers` object encrypted the same way.
 *   Encrypting the whole blob (vs. per-field) keeps the schema flat and
 *   matches the way `--mcp-config` consumes the values: as opaque key-
 *   value maps. The encryption key lives at
 *   `<dataDir>/mcp-servers-secret.key` (0600), auto-minted on first
 *   write. Lost key = lost configs (same failure mode as `pr-env-secret.key`).
 *
 * The store exposes three shapes:
 *   - `readMcpServerRow()` / `listMcpServersForUser()` — raw, decrypted
 *     (used by spawn-time mcp-config builder).
 *   - `listMcpServersMaskedForUser()` — for the Settings UI; secret values
 *     replaced with `MASK` so the user can see "this slot is set" without
 *     exposing the plaintext.
 *   - `createMcpServer()` / `updateMcpServer()` — the Settings UI write
 *     paths; `MASK` values are preserved on partial saves.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import config from './config.js';
import { getOrgsDb } from './orgs.js';
import { MCP_SERVERS_SCHEMA } from './mcp-servers-schema.js';

// Re-export so existing test imports (`from './mcp-servers-store.js'`) keep
// working while orgs.ts consumes the canonical definition from
// `./mcp-servers-schema.js`. Prevents DDL drift between prod and tests and
// avoids a circular import (store → orgs.ts → store).
export { MCP_SERVERS_SCHEMA };

export const MASK = '••••••••';

export type McpTransport = 'stdio' | 'http';

/** Public, decrypted shape of a row. Used at spawn time and by tests. */
export interface McpServerRow {
  id: string;
  userId: string;
  name: string;
  /** Catalog slug (`linear`, `notion`, `github`) or `null` for custom. */
  catalogId: string | null;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string;
  /** stdio: process env. */
  env: Record<string, string>;
  /** http: request headers (e.g. Authorization). */
  headers: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Masked shape for GET /api/mcp-servers — secret VALUES replaced with `MASK`. */
export interface McpServerMasked extends Omit<McpServerRow, 'env' | 'headers'> {
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** Create payload — id/timestamps generated server-side. */
export interface McpServerCreate {
  userId: string;
  name: string;
  catalogId?: string | null;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** Partial update — `MASK` values in env/headers are preserved. */
export interface McpServerUpdate {
  name?: string;
  catalogId?: string | null;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

// ─── Encryption key management ─────────────────────────────────────────────
// Mirrors pr-env-store.ts but with its own key file so a compromise of
// either subsystem's key doesn't compromise the other. AES-256-GCM with a
// fresh 12-byte IV per encrypt; the auth tag is part of the stored blob.

let cachedKeyPath: string | null = null;
let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  if (cachedKeyPath) return cachedKeyPath;
  cachedKeyPath = path.join(config.dataDir, 'mcp-servers-secret.key');
  return cachedKeyPath;
}

function loadOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;
  const keyPath = keyFilePath();
  mkdirSync(path.dirname(keyPath), { recursive: true });
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, 'utf-8').trim();
    if (hex.length !== 64) {
      throw new Error(
        `[mcp-servers-store] Invalid encryption key at ${keyPath} — expected 64 hex chars`,
      );
    }
    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
  }
  const fresh = randomBytes(32);
  writeFileSync(keyPath, fresh.toString('hex'), { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort */
  }
  cachedKey = fresh;
  return cachedKey;
}

function encryptJson(obj: Record<string, string>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  const plaintext = JSON.stringify(obj);
  const key = loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptJson(blob: string): Record<string, string> {
  if (!blob) return {};
  const parts = blob.split(':');
  if (parts.length !== 3) {
    throw new Error('[mcp-servers-store] Malformed ciphertext blob — expected iv:tag:ciphertext');
  }
  const [ivB64, tagB64, encB64] = parts;
  const key = loadOrCreateKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  const parsed = JSON.parse(dec.toString('utf-8')) as Record<string, string>;
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * Apply the schema to the given DB. Tests call this with a tmp DB; the
 * production path is `orgs.ts` which exec's `MCP_SERVERS_SCHEMA` directly
 * during `initOrgsDb`.
 */
export function ensureMcpServersSchema(db: Database.Database = getOrgsDb()): void {
  db.exec(MCP_SERVERS_SCHEMA);
}

// ─── Row hydration ─────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  user_id: string;
  name: string;
  catalog_id: string | null;
  transport: McpTransport;
  command: string;
  args_json: string;
  url: string;
  env_encrypted_json: string;
  headers_encrypted_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function safeJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function hydrate(raw: RawRow): McpServerRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    name: raw.name,
    catalogId: raw.catalog_id,
    transport: raw.transport,
    command: raw.command,
    args: safeJsonArray(raw.args_json),
    url: raw.url,
    env: raw.env_encrypted_json ? decryptJson(raw.env_encrypted_json) : {},
    headers: raw.headers_encrypted_json ? decryptJson(raw.headers_encrypted_json) : {},
    enabled: raw.enabled === 1,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function maskValues(o: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = v ? MASK : '';
  }
  return out;
}

function mask(row: McpServerRow): McpServerMasked {
  return {
    ...row,
    env: maskValues(row.env),
    headers: maskValues(row.headers),
  };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export function readMcpServerRow(
  id: string,
  db: Database.Database = getOrgsDb(),
): McpServerRow | null {
  const raw = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as RawRow | undefined;
  return raw ? hydrate(raw) : null;
}

export function listMcpServersForUser(
  userId: string,
  db: Database.Database = getOrgsDb(),
): McpServerRow[] {
  const rows = db
    .prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId) as RawRow[];
  return rows.map(hydrate);
}

export function listMcpServersMaskedForUser(
  userId: string,
  db: Database.Database = getOrgsDb(),
): McpServerMasked[] {
  return listMcpServersForUser(userId, db).map(mask);
}

/** Spawn-time helper — only the rows the lead actually wants injected. */
export function listEnabledMcpServersForUser(
  userId: string,
  db: Database.Database = getOrgsDb(),
): McpServerRow[] {
  const rows = db
    .prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY created_at ASC')
    .all(userId) as RawRow[];
  return rows.map(hydrate);
}

// ─── Writes ────────────────────────────────────────────────────────────────

function genId(): string {
  return `mcp_${randomBytes(12).toString('hex')}`;
}

function validateTransportFields(input: {
  transport: McpTransport;
  command?: string;
  url?: string;
}): void {
  if (input.transport === 'stdio') {
    if (!input.command || !input.command.trim()) {
      throw new Error('stdio transport requires a non-empty command');
    }
  } else if (input.transport === 'http') {
    if (!input.url || !input.url.trim()) {
      throw new Error('http transport requires a non-empty url');
    }
  }
}

/**
 * Auto-prepend `Bearer ` to bare `Authorization` header values for HTTP MCP
 * rows. Users paste a Linear PAT (`lin_api_…`) or GitHub token (`ghp_…`)
 * directly into the Settings form; before this helper they had to type the
 * `Bearer ` prefix themselves, which was easy to miss and produced a
 * malformed header that the upstream MCP server silently 401'd on.
 *
 * Detection rule: case-insensitive match on the header KEY (`authorization`),
 * skip empty / `MASK` placeholder values, and skip values that already begin
 * with a known auth scheme word followed by whitespace (`Bearer`, `Basic`,
 * `Token`, `Digest`). Anything else gets `Bearer ` prepended.
 *
 * Only runs on `http` transport rows — stdio env vars are opaque to us.
 */
const KNOWN_AUTH_SCHEMES = /^(bearer|basic|token|digest)\s/i;

export function normalizeHttpAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' && v && v !== MASK && !KNOWN_AUTH_SCHEMES.test(v)) {
      out[k] = `Bearer ${v.trim()}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createMcpServer(
  payload: McpServerCreate,
  db: Database.Database = getOrgsDb(),
): McpServerMasked {
  if (!payload.userId) throw new Error('userId is required');
  if (!payload.name || !payload.name.trim()) throw new Error('name is required');
  validateTransportFields(payload);

  const id = genId();
  const args = payload.args ?? [];
  const env = payload.env ?? {};
  const rawHeaders = payload.headers ?? {};
  const headers = payload.transport === 'http' ? normalizeHttpAuthHeaders(rawHeaders) : rawHeaders;

  db.prepare(
    `INSERT INTO mcp_servers (
       id, user_id, name, catalog_id, transport, command, args_json, url,
       env_encrypted_json, headers_encrypted_json, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    id,
    payload.userId,
    payload.name.trim(),
    payload.catalogId ?? null,
    payload.transport,
    payload.command ?? '',
    JSON.stringify(args),
    payload.url ?? '',
    encryptJson(env),
    encryptJson(headers),
    payload.enabled === false ? 0 : 1,
  );

  const row = readMcpServerRow(id, db);
  if (!row) throw new Error('createMcpServer: row missing after insert');
  return mask(row);
}

/**
 * Merge a partial update. `MASK` values inside env/headers are preserved
 * (UI sends back the masked form for fields the user didn't touch).
 * Empty string explicitly clears a key. To remove a key entirely, omit it
 * and pass the full replacement map (we replace the whole map, not patch).
 */
export function updateMcpServer(
  id: string,
  partial: McpServerUpdate,
  db: Database.Database = getOrgsDb(),
): McpServerMasked | null {
  const existing = readMcpServerRow(id, db);
  if (!existing) return null;

  const mergedHeaders = partial.headers
    ? mergeMasked(existing.headers, partial.headers)
    : existing.headers;
  const nextTransport = partial.transport ?? existing.transport;
  const next: McpServerRow = {
    ...existing,
    name: partial.name ?? existing.name,
    catalogId: partial.catalogId === undefined ? existing.catalogId : partial.catalogId,
    transport: nextTransport,
    command: partial.command ?? existing.command,
    args: partial.args ?? existing.args,
    url: partial.url ?? existing.url,
    env: partial.env ? mergeMasked(existing.env, partial.env) : existing.env,
    // Re-normalize on every update so a user editing a row to add a bare
    // token gets the same auto-`Bearer` UX as a fresh create. mergeMasked
    // preserves existing values for MASK keys, so this is idempotent for
    // already-prefixed values.
    headers: nextTransport === 'http' ? normalizeHttpAuthHeaders(mergedHeaders) : mergedHeaders,
    enabled: partial.enabled === undefined ? existing.enabled : partial.enabled,
  };

  validateTransportFields(next);

  db.prepare(
    `UPDATE mcp_servers SET
       name = ?, catalog_id = ?, transport = ?, command = ?, args_json = ?,
       url = ?, env_encrypted_json = ?, headers_encrypted_json = ?,
       enabled = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    next.name,
    next.catalogId,
    next.transport,
    next.command,
    JSON.stringify(next.args),
    next.url,
    encryptJson(next.env),
    encryptJson(next.headers),
    next.enabled ? 1 : 0,
    id,
  );

  const row = readMcpServerRow(id, db);
  return row ? mask(row) : null;
}

/**
 * Replace the existing map with `incoming`, but where `incoming[k] === MASK`
 * keep the existing value. Keys absent from `incoming` are dropped — the UI
 * is expected to round-trip the full map (with MASK for untouched secrets).
 */
function mergeMasked(
  existing: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === MASK) {
      // Keep prior value; if the user manually typed MASK as a value, that's
      // an edge case we accept losing (better than leaking the real secret).
      if (k in existing) out[k] = existing[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function deleteMcpServer(id: string, db: Database.Database = getOrgsDb()): boolean {
  const info = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  return info.changes > 0;
}

// ─── Test hooks ────────────────────────────────────────────────────────────

export function __resetMcpServersStoreForTests(): void {
  cachedKey = null;
  cachedKeyPath = null;
}

export function __setMcpServersKeyFilePathForTests(p: string | null): void {
  cachedKeyPath = p;
  cachedKey = null;
}
