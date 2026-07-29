/**
 * `user_skill_credential_audit` retention.
 *
 * The table was append-only with no reader and no bound — every credential
 * rotation added a row that nothing would ever delete. These tests pin the
 * retention window and the opportunistic prune-on-write so the table can't
 * silently return to unbounded growth.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

vi.mock('./secret-crypto.js', () => ({
  encryptSecret(s: string) {
    return Buffer.from(s, 'utf8').toString('base64url');
  },
  decryptSecret(s: string) {
    return Buffer.from(s, 'base64url').toString('utf8');
  },
}));

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const {
  upsertUserSkillCredential,
  listUserSkillCredentialAudit,
  pruneUserSkillCredentialAudit,
  SKILL_CREDENTIAL_AUDIT_RETENTION_DAYS,
} = await import('./skill-credentials-store.js');

/** Backdate every existing audit row by `days`, simulating an aged table. */
function ageAllAuditRows(days: number): void {
  getOrgsDb()
    .prepare(`UPDATE user_skill_credential_audit SET created_at = datetime('now', ?)`)
    .run(`-${days} days`);
}

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-cred-audit-'));
  setOrgsDbPathForTests(path.join(root, 'orgs.db'));
  initOrgsDb();
  // user_skill_credentials.user_id has an FK to users(id).
  for (const id of ['u1', 'u2']) {
    createUser({ id, username: `${id}@example.com`, passwordHash: 'x' });
  }
});

describe('user_skill_credential_audit retention', () => {
  it('keeps rows inside the retention window', () => {
    upsertUserSkillCredential({
      userId: 'u1',
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: 'v',
      actorUserId: 'u1',
    });
    ageAllAuditRows(SKILL_CREDENTIAL_AUDIT_RETENTION_DAYS - 1);

    expect(pruneUserSkillCredentialAudit()).toBe(0);
    expect(listUserSkillCredentialAudit('u1')).toHaveLength(1);
  });

  it('deletes rows past the retention window', () => {
    upsertUserSkillCredential({
      userId: 'u1',
      skillId: 'github',
      keyName: 'GH_TOKEN',
      value: 'v',
      actorUserId: 'u1',
    });
    ageAllAuditRows(SKILL_CREDENTIAL_AUDIT_RETENTION_DAYS + 1);

    expect(pruneUserSkillCredentialAudit()).toBe(1);
    expect(listUserSkillCredentialAudit('u1')).toHaveLength(0);
  });

  it('prunes opportunistically on the next credential write', () => {
    upsertUserSkillCredential({
      userId: 'u1',
      skillId: 'github',
      keyName: 'OLD',
      value: 'v',
      actorUserId: 'u1',
    });
    ageAllAuditRows(SKILL_CREDENTIAL_AUDIT_RETENTION_DAYS + 30);

    upsertUserSkillCredential({
      userId: 'u1',
      skillId: 'github',
      keyName: 'NEW',
      value: 'v',
      actorUserId: 'u1',
    });

    const rows = listUserSkillCredentialAudit('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0].key_name).toBe('NEW');
  });

  it('scopes the reader to one user', () => {
    upsertUserSkillCredential({
      userId: 'u1',
      skillId: 'github',
      keyName: 'K',
      value: 'v',
      actorUserId: 'u1',
    });
    upsertUserSkillCredential({
      userId: 'u2',
      skillId: 'github',
      keyName: 'K',
      value: 'v',
      actorUserId: 'u2',
    });

    expect(listUserSkillCredentialAudit('u1')).toHaveLength(1);
    expect(listUserSkillCredentialAudit('u1')[0].user_id).toBe('u1');
  });
});
