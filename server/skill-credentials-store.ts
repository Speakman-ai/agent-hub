/**
 * Per-user skill credentials — encrypted with the same AES-GCM helper as
 * PR-environment secrets (`pr-env-store.ts` / pr-env-secret.key).
 */

import { encryptSecret, decryptSecret } from './pr-env-store.js';
import { getOrgsDb } from './orgs.js';
import { v4 as uuidv4 } from 'uuid';

const LAST_USED_DEBOUNCE_MS = 60_000;

const lastUsedWriteAt = new Map<string, number>();

export interface SkillCredentialMaskedRow {
  id: string;
  skill_id: string;
  key_name: string;
  masked_preview: string | null;
  last_used_at: string | null;
  updated_at: string;
  created_at: string;
}

function maskLast4(plaintext: string): string {
  const t = plaintext.trim();
  if (t.length === 0) return '••••';
  const suffix = t.length <= 4 ? t : t.slice(-4);
  return `••••${suffix}`;
}

function appendAudit(opts: {
  userId: string;
  skillId: string;
  keyName: string;
  action: 'upsert' | 'delete';
  actorUserId: string;
}): void {
  const db = getOrgsDb();
  db.prepare(
    `INSERT INTO user_skill_credential_audit (id, user_id, skill_id, key_name, action, actor_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(uuidv4(), opts.userId, opts.skillId, opts.keyName, opts.action, opts.actorUserId);
}

export function existsUserSkillCredential(
  userId: string,
  skillId: string,
  keyName: string,
): boolean {
  const db = getOrgsDb();
  const row = db
    .prepare(
      'SELECT 1 as ok FROM user_skill_credentials WHERE user_id = ? AND skill_id = ? AND key_name = ? LIMIT 1',
    )
    .get(userId, skillId, keyName) as { ok: number } | undefined;
  return !!row;
}

interface RawCredentialRow {
  id: string;
  skill_id: string;
  key_name: string;
  value_enc: string;
  masked_preview: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export function upsertUserSkillCredential(opts: {
  userId: string;
  skillId: string;
  keyName: string;
  value: string;
  actorUserId: string;
}): SkillCredentialMaskedRow {
  const value = opts.value ?? '';
  const enc = encryptSecret(value);
  // Compute and persist the last-4 mask synchronously here so the list
  // path never has to decrypt to render. We hold the plaintext for one
  // line of code regardless; storing only its non-sensitive suffix is
  // strictly less exposure than the previous decrypt-on-list shape.
  const preview = maskLast4(value);
  const db = getOrgsDb();

  const existing = db
    .prepare(
      'SELECT id FROM user_skill_credentials WHERE user_id = ? AND skill_id = ? AND key_name = ?',
    )
    .get(opts.userId, opts.skillId, opts.keyName) as { id: string } | undefined;

  const now = new Date().toISOString();

  if (existing) {
    db.prepare(
      `UPDATE user_skill_credentials
       SET value_enc = ?, masked_preview = ?, updated_at = ?, last_used_at = NULL
       WHERE id = ?`,
    ).run(enc, preview, now, existing.id);
    appendAudit({
      userId: opts.userId,
      skillId: opts.skillId,
      keyName: opts.keyName,
      action: 'upsert',
      actorUserId: opts.actorUserId,
    });
    const row = db
      .prepare('SELECT * FROM user_skill_credentials WHERE id = ?')
      .get(existing.id) as RawCredentialRow;
    return rowToMasked(row);
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO user_skill_credentials
       (id, user_id, skill_id, key_name, value_enc, masked_preview, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.userId, opts.skillId, opts.keyName, enc, preview, now, now);
  appendAudit({
    userId: opts.userId,
    skillId: opts.skillId,
    keyName: opts.keyName,
    action: 'upsert',
    actorUserId: opts.actorUserId,
  });
  const row = db
    .prepare('SELECT * FROM user_skill_credentials WHERE id = ?')
    .get(id) as RawCredentialRow;
  return rowToMasked(row);
}

/** Delete a row by composite key (same audit path as id-based delete). */
export function deleteUserSkillCredentialByKey(
  userId: string,
  skillId: string,
  keyName: string,
  actorUserId: string,
): { ok: boolean } {
  const db = getOrgsDb();
  const row = db
    .prepare(
      'SELECT id FROM user_skill_credentials WHERE user_id = ? AND skill_id = ? AND key_name = ?',
    )
    .get(userId, skillId, keyName) as { id: string } | undefined;
  if (!row) return { ok: false };
  const result = deleteUserSkillCredential(userId, row.id, actorUserId);
  return { ok: result.ok };
}

export function deleteUserSkillCredential(
  userId: string,
  rowId: string,
  actorUserId: string,
): { ok: boolean; skillId?: string; keyName?: string } {
  const db = getOrgsDb();
  const row = db
    .prepare('SELECT * FROM user_skill_credentials WHERE id = ? AND user_id = ?')
    .get(rowId, userId) as { skill_id: string; key_name: string } | undefined;
  if (!row) return { ok: false };
  db.prepare('DELETE FROM user_skill_credentials WHERE id = ? AND user_id = ?').run(rowId, userId);
  appendAudit({
    userId,
    skillId: row.skill_id,
    keyName: row.key_name,
    action: 'delete',
    actorUserId,
  });
  return { ok: true, skillId: row.skill_id, keyName: row.key_name };
}

export function listMaskedUserSkillCredentials(
  userId: string,
  skillIdFilter?: string | null,
): SkillCredentialMaskedRow[] {
  const db = getOrgsDb();
  let rows: RawCredentialRow[];
  if (skillIdFilter) {
    rows = db
      .prepare(
        'SELECT * FROM user_skill_credentials WHERE user_id = ? AND skill_id = ? ORDER BY skill_id, key_name',
      )
      .all(userId, skillIdFilter) as RawCredentialRow[];
  } else {
    rows = db
      .prepare('SELECT * FROM user_skill_credentials WHERE user_id = ? ORDER BY skill_id, key_name')
      .all(userId) as RawCredentialRow[];
  }

  return rows.map((r) => rowToMasked(r));
}

/**
 * Lazy backfill: rows written before `masked_preview` existed land here with
 * a NULL preview. We decrypt them once, persist the suffix, and never look
 * at the ciphertext on subsequent list calls. This keeps the list path's
 * crypto cost at O(rows-without-preview) instead of O(all-rows).
 */
function backfillPreview(rowId: string, value_enc: string): string | null {
  let preview: string | null = null;
  try {
    if (value_enc) {
      preview = maskLast4(decryptSecret(value_enc));
    }
  } catch {
    preview = '••••????';
  }
  if (preview !== null) {
    try {
      getOrgsDb()
        .prepare('UPDATE user_skill_credentials SET masked_preview = ? WHERE id = ?')
        .run(preview, rowId);
    } catch {
      /* best-effort backfill — surface the value either way */
    }
  }
  return preview;
}

function rowToMasked(row: RawCredentialRow): SkillCredentialMaskedRow {
  const preview =
    row.masked_preview !== null && row.masked_preview !== undefined
      ? row.masked_preview
      : backfillPreview(row.id, row.value_enc);
  return {
    id: row.id,
    skill_id: row.skill_id,
    key_name: row.key_name,
    masked_preview: preview,
    last_used_at: row.last_used_at,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}

/**
 * Build env entries for all stored keys for the given skill ids. Does not
 * overwrite existing keys in `into` when they are already non-empty strings.
 *
 * When `allowedKeysBySkillId` is provided, rows whose `(skill_id, key_name)`
 * pair is not in the allowlist are skipped. This is what enforces the
 * spawning agent's credential-declaration boundary: a key that exists in
 * project B's `SKILL.md` (and was accepted there at PUT time) must NOT
 * decrypt into project A's spawn env. Callers that don't have a schema
 * context (tests, ad-hoc scripts) may omit the param to merge everything,
 * preserving the historical behavior for the no-context case.
 */
export function mergeDecryptedSkillCredentialsIntoEnv(
  userId: string,
  skillIds: string[],
  into: NodeJS.ProcessEnv,
  allowedKeysBySkillId?: Map<string, ReadonlySet<string>> | null,
): void {
  const ids = [...new Set(skillIds)].filter(Boolean);
  if (ids.length === 0) return;

  const db = getOrgsDb();
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT id, skill_id, key_name, value_enc FROM user_skill_credentials
     WHERE user_id = ? AND skill_id IN (${placeholders})
     ORDER BY skill_id ASC, key_name ASC, id ASC`,
  );
  const rows = stmt.all(userId, ...ids) as Array<{
    id: string;
    skill_id: string;
    key_name: string;
    value_enc: string;
  }>;

  const nowMs = Date.now();
  const touchedRowIds: string[] = [];

  for (const row of rows) {
    if (allowedKeysBySkillId) {
      const allowed = allowedKeysBySkillId.get(row.skill_id);
      // Missing entry = skill has no declared credentials in this spawn's
      // resolved schema → skip every row for it. Empty Set has the same
      // effect. Both are intentional: the schema is authoritative.
      if (!allowed || !allowed.has(row.key_name)) continue;
    }
    try {
      const val = decryptSecret(row.value_enc).trim();
      if (!val) continue;
      const k = row.key_name;
      const cur = into[k];
      if (cur !== undefined && cur !== null && String(cur).trim() !== '') {
        continue;
      }
      into[k] = val;
      touchedRowIds.push(row.id);
    } catch {
      /* skip broken ciphertext */
    }
  }

  maybeTouchLastUsedBulk(touchedRowIds, nowMs);
}

function maybeTouchLastUsedBulk(rowIds: string[], nowMs: number): void {
  if (rowIds.length === 0) return;
  const db = getOrgsDb();
  const iso = new Date(nowMs).toISOString();
  const update = db.prepare(`UPDATE user_skill_credentials SET last_used_at = ? WHERE id = ?`);

  for (const id of rowIds) {
    const last = lastUsedWriteAt.get(id) ?? 0;
    if (nowMs - last < LAST_USED_DEBOUNCE_MS) continue;
    lastUsedWriteAt.set(id, nowMs);
    update.run(iso, id);
  }
}
