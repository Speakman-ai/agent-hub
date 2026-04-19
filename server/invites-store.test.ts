import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const {
  createInvite,
  deleteInvite,
  getInvite,
  listActiveInvitesForOrg,
  inviteState,
  markInviteAccepted,
  generateInviteToken,
  computeExpiresAt,
} = await import('./invites-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'invites-store-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('invites-store', () => {
  let creatorId: string;
  beforeEach(() => {
    freshDb();
    const user = createUser({ username: 'admin', passwordHash: 'h' });
    creatorId = user.id;
  });

  it('generateInviteToken produces a 64-hex-char string', () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computeExpiresAt clamps to the allowed range', () => {
    const now = Date.parse('2026-04-18T00:00:00Z');
    // Default 72h
    expect(new Date(computeExpiresAt(undefined, now)).getTime() - now).toBe(72 * 3600 * 1000);
    // Below minimum → 1h
    expect(new Date(computeExpiresAt(0, now)).getTime() - now).toBe(3600 * 1000);
    // Above max → 30 days
    expect(new Date(computeExpiresAt(1000, now)).getTime() - now).toBe(30 * 24 * 3600 * 1000);
  });

  it('creates an invite and retrieves it by token', () => {
    const invite = createInvite({
      orgId: 'default',
      role: 'User',
      createdBy: creatorId,
      email: 'new@example.com',
    });
    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.role).toBe('User');
    expect(getInvite(invite.token)?.email).toBe('new@example.com');
  });

  it('lists only active (non-expired, non-accepted) invites for an org', () => {
    const active = createInvite({
      orgId: 'default',
      role: 'Admin',
      createdBy: creatorId,
      ttlHours: 24,
    });
    const expired = createInvite({
      orgId: 'default',
      role: 'User',
      createdBy: creatorId,
      ttlHours: 1,
    });
    // Manually expire the second one by rewriting its expires_at
    getOrgsDb()
      .prepare('UPDATE invites SET expires_at = ? WHERE token = ?')
      .run('2000-01-01T00:00:00Z', expired.token);

    const list = listActiveInvitesForOrg('default');
    expect(list.map((r) => r.token)).toContain(active.token);
    expect(list.map((r) => r.token)).not.toContain(expired.token);
  });

  it('inviteState classifies each lifecycle state', () => {
    const invite = createInvite({ orgId: 'default', role: 'User', createdBy: creatorId });
    expect(inviteState(invite)).toBe('valid');
    expect(inviteState(null)).toBe('not-found');

    // Simulate expired
    expect(inviteState({ ...invite, expires_at: '2000-01-01T00:00:00Z' })).toBe('expired');

    // Simulate accepted
    expect(
      inviteState({
        ...invite,
        accepted_by: 'u',
        accepted_at: '2026-04-18T00:00:00Z',
      }),
    ).toBe('already-accepted');
  });

  it('markInviteAccepted succeeds once and rejects the second attempt', () => {
    const invite = createInvite({ orgId: 'default', role: 'User', createdBy: creatorId });
    const accepter = createUser({ username: 'newbie', passwordHash: 'h' });

    expect(markInviteAccepted(invite.token, accepter.id)).toBe(true);
    // Idempotency: second accept must fail — the UPDATE's WHERE clause
    // filters out rows where accepted_at is already set.
    expect(markInviteAccepted(invite.token, accepter.id)).toBe(false);
  });

  it('markInviteAccepted fails once the invite is expired', () => {
    const invite = createInvite({
      orgId: 'default',
      role: 'User',
      createdBy: creatorId,
      ttlHours: 1,
    });
    getOrgsDb()
      .prepare('UPDATE invites SET expires_at = ? WHERE token = ?')
      .run('2000-01-01T00:00:00Z', invite.token);
    const accepter = createUser({ username: 'latecomer', passwordHash: 'h' });
    expect(markInviteAccepted(invite.token, accepter.id)).toBe(false);
  });

  it('deleteInvite revokes the row', () => {
    const invite = createInvite({ orgId: 'default', role: 'User', createdBy: creatorId });
    deleteInvite(invite.token);
    expect(getInvite(invite.token)).toBeNull();
  });
});
