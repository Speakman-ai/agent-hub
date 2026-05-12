/**
 * Worktree preview secrets — per-project encrypted key/value store.
 *
 * Backs the `/api/projects/:id/preview/secrets` REST surface and the
 * `loadProjectEnv()` hook the preview runtime calls at spawn time. See
 * `preview-secrets-schema.ts` for the DDL + design rationale.
 *
 * Crypto pattern is shared with skill credentials and Slack bot tokens
 * (`secret-crypto.ts`) — same key file (`<dataDir>/pr-env-secret.key`)
 * so an operator who's already managing one of those stores doesn't
 * gain a new key-rotation chore.
 *
 * Two storage kinds:
 *   - `plain`  values are returned in clear on list / read.
 *   - `secret` values are masked on list and only decrypted by
 *              `loadProjectEnvForSpawn()` — never by the list endpoint.
 *
 * The `kind` is stored alongside the ciphertext so a future "reveal"
 * action could be added per-row without re-classifying every key. This
 * card does not ship a reveal endpoint by design (the card spec says
 * "never log or echo decrypted values").
 */

import { v4 as uuidv4 } from 'uuid';
import { encryptSecret, decryptSecret, MASK } from '../secret-crypto.js';
import { getDb } from '../db.js';

// ─── Reserved namespace ─────────────────────────────────────────────

/**
 * Keys we refuse to accept from user input. AGENT_HUB_* is reserved
 * for server-injected spawn config (the spawned CLI relies on these
 * being canonical), NODE_* is the platform runtime's namespace, and
 * PATH / HOME are the two env vars whose modification can break a
 * spawned child outright.
 *
 * The regex matches the exact production rule called out in the card.
 * Tests live in `preview-secrets-store.test.ts`.
 */
export const RESERVED_KEY_RE = /^(AGENT_HUB_|NODE_|PATH$|HOME$)/;

/** Env var name validation — bash-style identifier rules. */
const VALID_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Hard upper bound on stored value length. Mirrors common .env conventions. */
const MAX_VALUE_BYTES = 64 * 1024;

export type SecretKind = 'plain' | 'secret';

export interface PreviewSecretRow {
  id: string;
  project_id: string;
  key: string;
  kind: SecretKind;
  /**
   * For `plain` kind: decrypted value. For `secret` kind: the MASK
   * constant. List/GET callers should treat this as the only value
   * field they can read.
   */
  value: string;
  created_at: string;
  updated_at: string;
}

interface RawRow {
  id: string;
  project_id: string;
  key: string;
  value_ciphertext: string;
  value_iv: string;
  value_tag: string;
  kind: SecretKind;
  created_at: string;
  updated_at: string;
}

export interface PreviewSecretInput {
  key: string;
  value: string;
  /** Defaults to `secret`. */
  kind?: SecretKind;
}

export class PreviewSecretValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PreviewSecretValidationError';
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

function splitIvTag(blob: string): { iv: string; tag: string } {
  // encryptSecret returns `${iv}:${tag}:${ciphertext}` (all base64).
  // We split once here so the schema's iv/tag columns mirror the
  // canonical parts. Decryption is still done via decryptSecret(blob).
  const parts = blob.split(':');
  if (parts.length !== 3) {
    // Defensive: callers only ever pass freshly-encrypted blobs in.
    return { iv: '', tag: '' };
  }
  return { iv: parts[0], tag: parts[1] };
}

function rowToPublic(row: RawRow): PreviewSecretRow {
  let value: string;
  if (row.kind === 'secret') {
    value = MASK;
  } else {
    try {
      value = decryptSecret(row.value_ciphertext);
    } catch {
      // Tampered or unreadable ciphertext — surface the mask rather
      // than throwing, so a single corrupt row doesn't 500 the whole
      // list endpoint. Operators see the row by id and can re-upsert.
      value = MASK;
    }
  }
  return {
    id: row.id,
    project_id: row.project_id,
    key: row.key,
    kind: row.kind,
    value,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function validateKeyOrThrow(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new PreviewSecretValidationError('key is required');
  }
  if (key.length > 255) {
    throw new PreviewSecretValidationError(`key "${key}" exceeds 255 chars`);
  }
  if (!VALID_KEY_RE.test(key)) {
    throw new PreviewSecretValidationError(`key "${key}" must match /^[A-Za-z_][A-Za-z0-9_]*$/`);
  }
  if (RESERVED_KEY_RE.test(key)) {
    throw new PreviewSecretValidationError(
      `key "${key}" is in the reserved namespace (AGENT_HUB_*, NODE_*, PATH, HOME)`,
    );
  }
}

function validateValueOrThrow(value: string, key: string): void {
  if (typeof value !== 'string') {
    throw new PreviewSecretValidationError(`value for "${key}" must be a string`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new PreviewSecretValidationError(`value for "${key}" exceeds ${MAX_VALUE_BYTES} bytes`);
  }
}

function validateKindOrThrow(kind: SecretKind | undefined, key: string): SecretKind {
  if (kind === undefined) return 'secret';
  if (kind !== 'plain' && kind !== 'secret') {
    throw new PreviewSecretValidationError(`kind for "${key}" must be "plain" or "secret"`);
  }
  return kind;
}

function appendAudit(opts: {
  projectId: string;
  keys: readonly string[];
  action: 'upsert' | 'delete' | 'read';
  actorUserId?: string | null;
  sessionId?: string | null;
}): void {
  // The read audit path is hot (one row per spawn); skip the INSERT
  // when there's nothing to log. upsert/delete callers always pass at
  // least one key so this filter is a no-op for them.
  if (opts.keys.length === 0) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO worktree_preview_secret_audit
       (id, project_id, keys, action, actor_user_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv4(),
    opts.projectId,
    opts.keys.join('|'),
    opts.action,
    opts.actorUserId ?? null,
    opts.sessionId ?? null,
  );
}

// ─── Internal carry-through type ────────────────────────────────────

/**
 * A pre-existing raw row to be carried through a merge without
 * re-encrypting. Used by the merge import path so secret-kind rows
 * that aren't in the import blob survive the `replacePreviewSecrets`
 * DELETE+INSERT cycle intact.
 */
export interface PreviewSecretCarryRow {
  key: string;
  kind: SecretKind;
  value_ciphertext: string;
  value_iv: string;
  value_tag: string;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * List all secrets for a project. `secret`-kind rows return the MASK
 * constant in the `value` field; `plain`-kind rows return the
 * decrypted plaintext. Ordered by key for stable rendering.
 */
export function listPreviewSecrets(projectId: string): PreviewSecretRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM worktree_preview_secrets
        WHERE project_id = ?
        ORDER BY key ASC`,
    )
    .all(projectId) as RawRow[];
  return rows.map(rowToPublic);
}

/**
 * Return raw (still-encrypted) rows for a project. Used exclusively by
 * the merge import path to carry secret-kind rows through without
 * decrypting them — `loadProjectEnvForSpawn` is the only caller that
 * decrypts, keeping the "never echo secret values" invariant intact.
 */
export function listRawPreviewSecretsForCarry(projectId: string): PreviewSecretCarryRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT key, kind, value_ciphertext, value_iv, value_tag
         FROM worktree_preview_secrets
        WHERE project_id = ?
        ORDER BY key ASC`,
    )
    .all(projectId) as PreviewSecretCarryRow[];
  return rows;
}

/**
 * Bulk-replace the project's preview secrets, carrying through
 * pre-existing raw rows (already encrypted) alongside newly-supplied
 * inputs. Used by the merge import path so secret-kind rows that are
 * absent from the import blob survive the DELETE+INSERT cycle.
 *
 * `carryRows` are inserted as-is (no re-encryption). `newInputs` are
 * validated and encrypted normally. Keys present in both arrays take
 * the `newInputs` entry (caller is responsible for deduplication).
 *
 * Returns the resulting masked list.
 */
export function replacePreviewSecretsWithCarry(
  projectId: string,
  newInputs: readonly PreviewSecretInput[],
  carryRows: readonly PreviewSecretCarryRow[],
  actorUserId?: string | null,
): PreviewSecretRow[] {
  // Validate new inputs first (abort whole batch on any error).
  const normalizedNew: Array<{ key: string; value: string; kind: SecretKind }> = [];
  const seen = new Set<string>();
  for (const raw of newInputs) {
    validateKeyOrThrow(raw.key);
    validateValueOrThrow(raw.value, raw.key);
    const kind = validateKindOrThrow(raw.kind, raw.key);
    if (seen.has(raw.key)) {
      throw new PreviewSecretValidationError(
        `duplicate key "${raw.key}" in batch — bulk replace requires unique keys`,
      );
    }
    seen.add(raw.key);
    normalizedNew.push({ key: raw.key, value: raw.value, kind });
  }
  // Carry rows must not collide with new inputs (caller deduplicates).
  const filteredCarry = carryRows.filter((r) => !seen.has(r.key));

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM worktree_preview_secrets WHERE project_id = ?`).run(projectId);
    const insert = db.prepare(
      `INSERT INTO worktree_preview_secrets
         (id, project_id, key, value_ciphertext, value_iv, value_tag, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of normalizedNew) {
      const ciphertext = encryptSecret(row.value);
      const { iv, tag } = splitIvTag(ciphertext);
      insert.run(uuidv4(), projectId, row.key, ciphertext, iv, tag, row.kind);
    }
    for (const row of filteredCarry) {
      insert.run(
        uuidv4(),
        projectId,
        row.key,
        row.value_ciphertext,
        row.value_iv,
        row.value_tag,
        row.kind,
      );
    }
  });
  tx();

  const allKeys = [
    ...normalizedNew.map((r) => r.key),
    ...filteredCarry.map((r) => r.key),
  ];
  appendAudit({ projectId, keys: allKeys, action: 'upsert', actorUserId });
  return listPreviewSecrets(projectId);
}

/**
 * Bulk-replace the project's preview secrets. Inputs are validated up
 * front (so a single bad key aborts the whole batch atomically); the
 * write itself runs inside a transaction so partial-replace can never
 * leave the project in a half-applied state.
 *
 * Returns the resulting masked list.
 */
export function replacePreviewSecrets(
  projectId: string,
  inputs: readonly PreviewSecretInput[],
  actorUserId?: string | null,
): PreviewSecretRow[] {
  // Validate first so we don't write half a batch before throwing.
  const normalized: Array<{ key: string; value: string; kind: SecretKind }> = [];
  const seen = new Set<string>();
  for (const raw of inputs) {
    validateKeyOrThrow(raw.key);
    validateValueOrThrow(raw.value, raw.key);
    const kind = validateKindOrThrow(raw.kind, raw.key);
    if (seen.has(raw.key)) {
      throw new PreviewSecretValidationError(
        `duplicate key "${raw.key}" in batch — bulk replace requires unique keys`,
      );
    }
    seen.add(raw.key);
    normalized.push({ key: raw.key, value: raw.value, kind });
  }

  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM worktree_preview_secrets WHERE project_id = ?`).run(projectId);
    const insert = db.prepare(
      `INSERT INTO worktree_preview_secrets
         (id, project_id, key, value_ciphertext, value_iv, value_tag, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of normalized) {
      const ciphertext = encryptSecret(row.value);
      const { iv, tag } = splitIvTag(ciphertext);
      insert.run(uuidv4(), projectId, row.key, ciphertext, iv, tag, row.kind);
    }
  });
  tx();

  appendAudit({
    projectId,
    keys: normalized.map((r) => r.key),
    action: 'upsert',
    actorUserId,
  });

  return listPreviewSecrets(projectId);
}

/** Delete a single (project, key) entry. Returns `true` if a row was deleted. */
export function deletePreviewSecret(
  projectId: string,
  key: string,
  actorUserId?: string | null,
): boolean {
  validateKeyOrThrow(key);
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM worktree_preview_secrets WHERE project_id = ? AND key = ?`)
    .run(projectId, key);
  if (result.changes === 0) return false;
  appendAudit({ projectId, keys: [key], action: 'delete', actorUserId });
  return true;
}

/**
 * Parse a `.env`-style blob into `PreviewSecretInput` entries. The
 * default kind is `secret`. Unparseable / blank lines are skipped.
 * Duplicate keys keep the **last** occurrence — mirroring how shell
 * env-loaders treat repeated assignments.
 *
 * Recognised line shapes:
 *   - `KEY=value`
 *   - `KEY="quoted value"`     (double-quoted strings honoured)
 *   - `KEY='quoted value'`     (single-quoted strings honoured)
 *   - `# comment`              (skipped)
 *   - blank line               (skipped)
 *   - `export KEY=value`       (leading `export` stripped)
 *
 * Values are NOT shell-expanded — `$OTHER` stays literal.
 */
export function parseDotEnv(blob: string): PreviewSecretInput[] {
  if (typeof blob !== 'string' || blob.length === 0) return [];
  const out = new Map<string, PreviewSecretInput>();
  const lines = blob.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if symmetric. Inner quotes are kept verbatim.
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (!VALID_KEY_RE.test(key)) continue; // skip syntactic garbage
    // Emit kind: undefined so the route-layer defaultKind override is
    // reachable. The store's validateKindOrThrow defaults undefined to
    // 'secret', preserving the current behavior when no defaultKind is set.
    out.set(key, { key, value });
  }
  return [...out.values()];
}

/**
 * Resolve env to merge into a preview spawn. Returns a key/value map
 * with every decrypted value (both `plain` and `secret` kinds). Logs
 * an audit row recording WHICH keys were read — never the values.
 *
 * Empty result when the project has no secrets: callers don't need to
 * gate on existence — they can always merge.
 */
export function loadProjectEnvForSpawn(
  projectId: string,
  context: { sessionId?: string | null } = {},
): Record<string, string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM worktree_preview_secrets
        WHERE project_id = ?
        ORDER BY key ASC`,
    )
    .all(projectId) as RawRow[];
  const env: Record<string, string> = {};
  const keysRead: string[] = [];
  for (const row of rows) {
    try {
      // Tamper-detection lives in decryptSecret — a modified ciphertext
      // or tag throws here. Skip the row so one corrupt entry doesn't
      // block the whole spawn.
      const value = decryptSecret(row.value_ciphertext);
      env[row.key] = value;
      keysRead.push(row.key);
    } catch {
      // Swallow: the upsert audit row already records which keys exist;
      // operators can re-upsert a corrupt entry without losing the rest.
    }
  }
  appendAudit({
    projectId,
    keys: keysRead,
    action: 'read',
    sessionId: context.sessionId ?? null,
  });
  return env;
}

// ─── Test helpers (not part of the public surface) ──────────────────

/**
 * List the recent audit rows for a project. Exposed primarily so route
 * tests can assert that a read/upsert event was logged; the production
 * dashboard surface (if ever built) would call this directly.
 */
export function listPreviewSecretAudit(
  projectId: string,
  limit = 50,
): Array<{
  id: string;
  project_id: string;
  keys: string;
  action: 'upsert' | 'delete' | 'read';
  actor_user_id: string | null;
  session_id: string | null;
  created_at: string;
}> {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM worktree_preview_secret_audit
        WHERE project_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(projectId, limit) as Array<{
    id: string;
    project_id: string;
    keys: string;
    action: 'upsert' | 'delete' | 'read';
    actor_user_id: string | null;
    session_id: string | null;
    created_at: string;
  }>;
}
