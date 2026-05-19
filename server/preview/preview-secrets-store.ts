/**
 * Worktree preview secrets — per-project encrypted key/value store.
 *
 * Backs the `/api/projects/:id/secrets` (and legacy `/preview/secrets`)
 * REST surface. Decrypted values are merged at spawn time for interactive
 * sessions, heartbeats, crons, and preview runtimes via
 * `mergeProjectSecretsSpawnEnv` / `loadProjectEnvForSpawn`. See
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

/**
 * Raw row shape used by merge-mode imports to round-trip secret-kind
 * rows without decrypting them. Callers obtain these via
 * `listRawPreviewSecretRows` and feed them back through
 * `replacePreviewSecretsMixed` so existing ciphertext is preserved
 * across a bulk-replace without ever needing the plaintext.
 *
 * Not exposed via REST — only the route layer's merge implementation
 * uses it, and only on data that just came out of the same DB.
 */
export interface PreviewSecretRawRow {
  key: string;
  value_ciphertext: string;
  value_iv: string;
  value_tag: string;
  kind: SecretKind;
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
 * Bulk-replace the project's preview secrets. Inputs are validated up
 * front (so a single bad key aborts the whole batch atomically); the
 * write itself runs inside a transaction so partial-replace can never
 * leave the project in a half-applied state.
 *
 * Returns the resulting masked list.
 */
type NormalizedSecretWrite =
  | { key: string; kind: SecretKind; mode: 'encrypt'; value: string }
  | {
      key: string;
      kind: SecretKind;
      mode: 'preserve';
      ciphertext: string;
      iv: string;
      tag: string;
    };

export function replacePreviewSecrets(
  projectId: string,
  inputs: readonly PreviewSecretInput[],
  actorUserId?: string | null,
): PreviewSecretRow[] {
  const db = getDb();
  const existingByKey = new Map<string, RawRow>();
  for (const row of db
    .prepare(`SELECT * FROM worktree_preview_secrets WHERE project_id = ?`)
    .all(projectId) as RawRow[]) {
    existingByKey.set(row.key, row);
  }

  // Validate first so we don't write half a batch before throwing.
  const normalized: NormalizedSecretWrite[] = [];
  const seen = new Set<string>();
  for (const raw of inputs) {
    validateKeyOrThrow(raw.key);
    const kind = validateKindOrThrow(raw.kind, raw.key);
    if (seen.has(raw.key)) {
      throw new PreviewSecretValidationError(
        `duplicate key "${raw.key}" in batch — bulk replace requires unique keys`,
      );
    }
    seen.add(raw.key);
    if (kind === 'secret' && raw.value === MASK) {
      const existing = existingByKey.get(raw.key);
      if (!existing) {
        throw new PreviewSecretValidationError(
          `value for "${raw.key}" is required when creating a new secret`,
        );
      }
      normalized.push({
        key: raw.key,
        kind,
        mode: 'preserve',
        ciphertext: existing.value_ciphertext,
        iv: existing.value_iv,
        tag: existing.value_tag,
      });
      continue;
    }
    validateValueOrThrow(raw.value, raw.key);
    normalized.push({ key: raw.key, value: raw.value, kind, mode: 'encrypt' });
  }

  // Diff-based write so `updated_at` reflects actual mutation time:
  //   - Keys present before AND in the new batch get UPDATEd in place
  //     (preserves id + created_at; bumps updated_at) — except for
  //     'preserve' mode rows whose ciphertext is unchanged, where the
  //     row is left fully alone so updated_at stays stable.
  //   - Keys only in the new batch get INSERTed fresh.
  //   - Keys only in the existing set get DELETEd.
  // A previous implementation used DELETE-all + INSERT-all which made
  // updated_at indistinguishable from created_at; the new diff captures
  // last-touched correctly.
  const inputKeys = new Set(normalized.map((r) => r.key));
  const tx = db.transaction(() => {
    // Delete rows that aren't in the new batch.
    const deleteStmt = db.prepare(
      `DELETE FROM worktree_preview_secrets WHERE project_id = ? AND key = ?`,
    );
    for (const existingKey of existingByKey.keys()) {
      if (!inputKeys.has(existingKey)) {
        deleteStmt.run(projectId, existingKey);
      }
    }
    const insert = db.prepare(
      `INSERT INTO worktree_preview_secrets
         (id, project_id, key, value_ciphertext, value_iv, value_tag, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE worktree_preview_secrets
          SET value_ciphertext = ?,
              value_iv         = ?,
              value_tag        = ?,
              kind             = ?,
              updated_at       = datetime('now')
        WHERE project_id = ? AND key = ?`,
    );
    for (const row of normalized) {
      const existing = existingByKey.get(row.key);
      if (row.mode === 'preserve') {
        // Ciphertext is byte-for-byte identical to what's already on
        // disk (the caller PUT MASK to signal "keep this one"). Leave
        // the row alone so updated_at is not bumped for a no-op.
        continue;
      }
      const ciphertext = encryptSecret(row.value);
      const { iv, tag } = splitIvTag(ciphertext);
      if (existing) {
        update.run(ciphertext, iv, tag, row.kind, projectId, row.key);
      } else {
        insert.run(uuidv4(), projectId, row.key, ciphertext, iv, tag, row.kind);
      }
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

/**
 * Internal helper: list raw rows (ciphertext intact) for a project.
 * Used by the route's merge-mode import path to round-trip secret-kind
 * rows without decrypting them. The returned shape exposes the stored
 * ciphertext + IV + tag — never call this from a code path that ships
 * data to a non-admin caller.
 */
export function listRawPreviewSecretRows(projectId: string): PreviewSecretRawRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT key, value_ciphertext, value_iv, value_tag, kind
         FROM worktree_preview_secrets
        WHERE project_id = ?
        ORDER BY key ASC`,
    )
    .all(projectId) as PreviewSecretRawRow[];
  return rows;
}

/**
 * Bulk-replace combining freshly-encrypted `inputs` with pre-encrypted
 * `rawPassthrough` rows. Validation + encryption runs on `inputs`; the
 * passthrough rows are inserted with their existing ciphertext intact.
 *
 * If a key appears in BOTH `inputs` and `rawPassthrough`, the input
 * (freshly-encrypted) wins — this matches merge-mode semantics ("later
 * wins" with the parsed blob being the later side).
 *
 * The whole write runs in a single transaction so a half-written merge
 * can never leave the project visible to a concurrent reader. The audit
 * log records the union of keys actually persisted.
 */
export function replacePreviewSecretsMixed(
  projectId: string,
  inputs: readonly PreviewSecretInput[],
  rawPassthrough: readonly PreviewSecretRawRow[],
  actorUserId?: string | null,
): PreviewSecretRow[] {
  // Validate inputs up front so a single bad key aborts before write.
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

  // Drop passthrough rows that overlap with new inputs ("inputs win").
  const inputKeys = new Set(normalized.map((n) => n.key));
  const passthroughFinal = rawPassthrough.filter((r) => !inputKeys.has(r.key));

  // Validate passthrough keys defensively. If a raw row's key is now in
  // the reserved namespace (config changed after the row was written),
  // refuse the entire merge — the caller can either delete the offending
  // key explicitly or re-PUT a clean set.
  for (const r of passthroughFinal) {
    validateKeyOrThrow(r.key);
  }

  // Snapshot the existing rows so we can pick UPDATE vs INSERT per key
  // (same diff-based pattern as replacePreviewSecrets). Passthrough rows
  // arrived from a fresh listRawPreviewSecretRows call upstream, so any
  // key present there is already on disk and stays untouched here —
  // overwriting it with its own ciphertext would needlessly bump
  // updated_at. We still DELETE any keys that aren't in either set.
  const db = getDb();
  const existingByKey = new Map<string, RawRow>();
  for (const row of db
    .prepare(`SELECT * FROM worktree_preview_secrets WHERE project_id = ?`)
    .all(projectId) as RawRow[]) {
    existingByKey.set(row.key, row);
  }
  const finalKeys = new Set<string>();
  for (const n of normalized) finalKeys.add(n.key);
  for (const p of passthroughFinal) finalKeys.add(p.key);

  const tx = db.transaction(() => {
    const deleteStmt = db.prepare(
      `DELETE FROM worktree_preview_secrets WHERE project_id = ? AND key = ?`,
    );
    for (const existingKey of existingByKey.keys()) {
      if (!finalKeys.has(existingKey)) {
        deleteStmt.run(projectId, existingKey);
      }
    }
    const insert = db.prepare(
      `INSERT INTO worktree_preview_secrets
         (id, project_id, key, value_ciphertext, value_iv, value_tag, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const update = db.prepare(
      `UPDATE worktree_preview_secrets
          SET value_ciphertext = ?,
              value_iv         = ?,
              value_tag        = ?,
              kind             = ?,
              updated_at       = datetime('now')
        WHERE project_id = ? AND key = ?`,
    );
    for (const row of normalized) {
      const ciphertext = encryptSecret(row.value);
      const { iv, tag } = splitIvTag(ciphertext);
      if (existingByKey.has(row.key)) {
        update.run(ciphertext, iv, tag, row.kind, projectId, row.key);
      } else {
        insert.run(uuidv4(), projectId, row.key, ciphertext, iv, tag, row.kind);
      }
    }
    // Passthrough rows: if the key already exists on disk we treat it
    // as a no-op (the caller listed it back unchanged). If it doesn't
    // (e.g. caller assembled a synthetic raw set), insert it fresh.
    for (const row of passthroughFinal) {
      if (existingByKey.has(row.key)) continue;
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

  appendAudit({
    projectId,
    keys: [...normalized.map((n) => n.key), ...passthroughFinal.map((p) => p.key)],
    action: 'upsert',
    actorUserId,
  });

  return listPreviewSecrets(projectId);
}

/** Remove all secrets (and audit rows) for a project. Used on project delete. */
export function deleteAllPreviewSecretsForProject(projectId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM worktree_preview_secrets WHERE project_id = ?`).run(projectId);
  db.prepare(`DELETE FROM worktree_preview_secret_audit WHERE project_id = ?`).run(projectId);
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
 * Parse a `.env`-style blob into `PreviewSecretInput` entries.
 *
 * `kind` is left **undefined** on each entry so callers (the import
 * route) can apply their own default — typically `secret`, but a
 * `defaultKind=plain` request lets an operator pull a curated config
 * block in clear-text. The store's own `replacePreviewSecrets` falls
 * back to `secret` when kind is undefined, matching the historical
 * default.
 *
 * Unparseable / blank lines are skipped. Duplicate keys keep the
 * **last** occurrence — mirroring how shell env-loaders treat repeated
 * assignments.
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
 *
 * **Reserved keys are dropped at parse time** (`AGENT_HUB_*`, `NODE_*`,
 * `PATH`, `HOME`). The store layer's `validateKeyOrThrow` would reject
 * them anyway; filtering here means a caller who builds inputs from the
 * parser output and skips store-layer validation (tests, ad-hoc tools)
 * can't accidentally smuggle a reserved key into a downstream import.
 *
 * **Multi-line values are NOT supported.** The parser splits on
 * `\r?\n` *before* quote-handling, so a real-`\n` between an opening
 * `"` and its closing `"` produces two malformed lines, both skipped.
 * Tools that need multi-line values (PEM blobs, JSON) should encode the
 * newlines (`\n` escape, base64) before importing and decode on read.
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
    if (RESERVED_KEY_RE.test(key)) continue; // defense in depth — store layer also rejects these
    // kind left undefined here — caller decides via defaultKind.
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
