import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';

export interface PasswordResetRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  consumed_at: string | null;
}

export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;

export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createPasswordResetToken(opts: { userId: string; ttlMinutes?: number }): {
  token: string;
  row: PasswordResetRow;
} {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashPasswordResetToken(token);
  const expiresAt = new Date(
    Date.now() + (opts.ttlMinutes ?? PASSWORD_RESET_TOKEN_TTL_MINUTES) * 60 * 1000,
  ).toISOString();
  const id = uuidv4();
  const db = getOrgsDb();
  db.prepare(
    `INSERT INTO password_resets (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, opts.userId, tokenHash, expiresAt);
  const row = db.prepare('SELECT * FROM password_resets WHERE id = ?').get(id) as PasswordResetRow;
  return { token, row };
}

export function getPasswordResetByToken(token: string): PasswordResetRow | null {
  const tokenHash = hashPasswordResetToken(token);
  const row = getOrgsDb()
    .prepare('SELECT * FROM password_resets WHERE token_hash = ?')
    .get(tokenHash) as PasswordResetRow | undefined;
  return row ?? null;
}

export function consumePasswordResetToken(token: string): PasswordResetRow | null {
  const tokenHash = hashPasswordResetToken(token);
  const db = getOrgsDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash) as
      | PasswordResetRow
      | undefined;
    if (!row || row.consumed_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    const consumedAt = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE password_resets
         SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL`,
      )
      .run(consumedAt, row.id);
    if (result.changes !== 1) return null;
    return { ...row, consumed_at: consumedAt };
  })();
}

export function consumePasswordResetTokenAndUpdatePassword(
  token: string,
  passwordHash: string,
): PasswordResetRow | null {
  const tokenHash = hashPasswordResetToken(token);
  const db = getOrgsDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash) as
      | PasswordResetRow
      | undefined;
    if (!row || row.consumed_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;

    const userResult = db
      .prepare(
        `UPDATE users
         SET password_hash = ?, credential_version = COALESCE(credential_version, 0) + 1
         WHERE id = ?`,
      )
      .run(passwordHash, row.user_id);
    if (userResult.changes !== 1) return null;

    const consumedAt = new Date().toISOString();
    const resetResult = db
      .prepare(
        `UPDATE password_resets
         SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL`,
      )
      .run(consumedAt, row.id);
    if (resetResult.changes !== 1) {
      throw new Error('password reset token consume race');
    }
    return { ...row, consumed_at: consumedAt };
  })();
}
