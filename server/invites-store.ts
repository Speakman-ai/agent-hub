/**
 * Invites store — Auth Phase 3.
 *
 * Org admins issue opaque invite tokens (32-byte hex) that a new user
 * redeems to join the org. Accepting an invite creates a `users` row
 * (if needed) plus a `memberships` row, then marks the invite consumed.
 *
 * Tokens never grant Owner — that role is reserved for explicit
 * promotion by an existing Owner, to keep the invite flow from
 * accidentally elevating strangers to full privilege.
 */
import { randomBytes } from 'crypto';
import { getOrgsDb } from './orgs.js';

export interface InviteRow {
  token: string;
  org_id: string;
  email: string | null;
  role: 'Admin' | 'User';
  expires_at: string;
  created_by: string;
  created_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  /**
   * JSON-encoded array of project ids to assign the invited user to on
   * acceptance (the per-project visibility ACL). `null` / absent for invites
   * with no pre-assignment. Validated against the issuer's visible project
   * set at creation time; consumed in the accept transaction. Use
   * `inviteProjectIds(row)` to decode safely.
   */
  project_ids: string | null;
}

/** Safely decode `InviteRow.project_ids` into a string[] (empty on null/garbage). */
export function inviteProjectIds(row: Pick<InviteRow, 'project_ids'>): string[] {
  if (!row.project_ids) return [];
  try {
    const parsed = JSON.parse(row.project_ids);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

const DEFAULT_TTL_HOURS = 72;
const MAX_TTL_HOURS = 24 * 30; // 30 days

export function generateInviteToken(): string {
  return randomBytes(32).toString('hex');
}

/** Resolve ttl → expires_at ISO string. Clamped into the allowed range. */
export function computeExpiresAt(ttlHours?: number, nowMs: number = Date.now()): string {
  let hours =
    typeof ttlHours === 'number' && Number.isFinite(ttlHours) ? ttlHours : DEFAULT_TTL_HOURS;
  if (hours < 1) hours = 1;
  if (hours > MAX_TTL_HOURS) hours = MAX_TTL_HOURS;
  return new Date(nowMs + hours * 60 * 60 * 1000).toISOString();
}

export function createInvite(opts: {
  orgId: string;
  role: 'Admin' | 'User';
  email?: string | null;
  createdBy: string;
  ttlHours?: number;
  token?: string;
  projectIds?: string[];
}): InviteRow {
  const db = getOrgsDb();
  const token = opts.token || generateInviteToken();
  const expiresAt = computeExpiresAt(opts.ttlHours);
  const projectIdsJson =
    opts.projectIds && opts.projectIds.length > 0 ? JSON.stringify(opts.projectIds) : null;
  db.prepare(
    `INSERT INTO invites (token, org_id, email, role, expires_at, created_by, project_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    opts.orgId,
    opts.email ?? null,
    opts.role,
    expiresAt,
    opts.createdBy,
    projectIdsJson,
  );
  return getInvite(token)!;
}

export function getInvite(token: string): InviteRow | null {
  const db = getOrgsDb();
  const row = db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as
    | InviteRow
    | undefined;
  return row || null;
}

export function deleteInvite(token: string): void {
  const db = getOrgsDb();
  db.prepare('DELETE FROM invites WHERE token = ?').run(token);
}

/** Active = not accepted, not expired. Pass `nowIso` to inject a clock in tests. */
export function listActiveInvitesForOrg(orgId: string, nowIso?: string): InviteRow[] {
  const db = getOrgsDb();
  const now = nowIso || new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM invites
       WHERE org_id = ? AND accepted_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(orgId, now) as InviteRow[];
}

export type InviteState = 'valid' | 'not-found' | 'expired' | 'already-accepted';

export function inviteState(row: InviteRow | null, nowIso?: string): InviteState {
  if (!row) return 'not-found';
  if (row.accepted_at) return 'already-accepted';
  if ((nowIso || new Date().toISOString()) > row.expires_at) return 'expired';
  return 'valid';
}

/**
 * Mark an invite accepted by `userId`. Returns true if this call was the
 * one that flipped it from pending → accepted (so the caller knows to
 * grant the membership). Returns false if the row doesn't exist or was
 * already consumed; callers should treat that as "invite no longer valid".
 */
export function markInviteAccepted(token: string, userId: string, nowIso?: string): boolean {
  const db = getOrgsDb();
  const now = nowIso || new Date().toISOString();
  const info = db
    .prepare(
      `UPDATE invites
       SET accepted_by = ?, accepted_at = ?
       WHERE token = ? AND accepted_at IS NULL AND expires_at > ?`,
    )
    .run(userId, now, token, now);
  return info.changes > 0;
}
