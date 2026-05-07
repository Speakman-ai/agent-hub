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

export function upsertUserSkillCredential(opts: {
  userId: string;
  skillId: string;
  keyName: string;
  value: string;
  actorUserId: string;
}): SkillCredentialMaskedRow {
  const value = opts.value ?? '';
  const enc = encryptSecret(value);
  const db = getOrgsDb();

  const existing = db
    .prepare(
      'SELECT id FROM user_skill_credentials WHERE user_id = ? AND skill_id = ? AND key_name = ?',
    )
    .get(opts.userId, opts.skillId, opts.keyName) as { id: string } | undefined;

  const now = new Date().toISOString();

  if (existing) {
    db.prepare(
      `UPDATE user_skill_credentials SET value_enc = ?, updated_at = ?, last_used_at = NULL WHERE id = ?`,
    ).run(enc, now, existing.id);
    appendAudit({
      userId: opts.userId,
      skillId: opts.skillId,
      keyName: opts.keyName,
      action: 'upsert',
      actorUserId: opts.actorUserId,
    });
    const row = db
      .prepare('SELECT * FROM user_skill_credentials WHERE id = ?')
      .get(existing.id) as {
      id: string;
      skill_id: string;
      key_name: string;
      value_enc: string;
      created_at: string;
      updated_at: string;
      last_used_at: string | null;
    };
    return rowToMasked(row);
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO user_skill_credentials (id, user_id, skill_id, key_name, value_enc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.userId, opts.skillId, opts.keyName, enc, now, now);
  appendAudit({
    userId: opts.userId,
    skillId: opts.skillId,
    keyName: opts.keyName,
    action: 'upsert',
    actorUserId: opts.actorUserId,
  });
  const row = db.prepare('SELECT * FROM user_skill_credentials WHERE id = ?').get(id) as {
    id: string;
    skill_id: string;
    key_name: string;
    value_enc: string;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
  };
  return rowToMasked(row);
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
  let rows: Array<{
    id: string;
    skill_id: string;
    key_name: string;
    value_enc: string;
    created_at: string;
    updated_at: string;
    last_used_at: string | null;
  }>;
  if (skillIdFilter) {
    rows = db
      .prepare(
        'SELECT * FROM user_skill_credentials WHERE user_id = ? AND skill_id = ? ORDER BY skill_id, key_name',
      )
      .all(userId, skillIdFilter) as typeof rows;
  } else {
    rows = db
      .prepare('SELECT * FROM user_skill_credentials WHERE user_id = ? ORDER BY skill_id, key_name')
      .all(userId) as typeof rows;
  }

  return rows.map((r) => rowToMasked(r));
}

function rowToMasked(row: {
  id: string;
  skill_id: string;
  key_name: string;
  value_enc: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}): SkillCredentialMaskedRow {
  let preview: string | null = null;
  try {
    if (row.value_enc) {
      const plain = decryptSecret(row.value_enc);
      preview = maskLast4(plain);
    }
  } catch {
    preview = '••••????';
  }
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
 */
export function mergeDecryptedSkillCredentialsIntoEnv(
  userId: string,
  skillIds: string[],
  into: NodeJS.ProcessEnv,
): void {
  const ids = [...new Set(skillIds)].filter(Boolean);
  if (ids.length === 0) return;

  const db = getOrgsDb();
  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT id, skill_id, key_name, value_enc FROM user_skill_credentials
     WHERE user_id = ? AND skill_id IN (${placeholders})`,
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
