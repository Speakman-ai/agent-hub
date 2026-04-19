/**
 * Users store — Auth Phase 3.
 *
 * Persists user identities in the shared `orgs.db`. Keeping users in the
 * orgs-level DB (rather than each per-org data-dir) lets a single account
 * hold memberships in multiple orgs without duplicating credentials.
 *
 * The table is created by `initOrgsDb()` — this module only owns queries.
 *
 * The migration helper `migrateAuthRecordIfNeeded()` handles the one-time
 * transition from the pre-Phase-3 single-user `auth.json` by inserting a
 * `users` row plus an `Owner` membership in every existing org. Callers
 * run it from server startup after `initOrgsDb()` has seeded the default
 * org. It's a no-op when the users table already has rows.
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';
import { getAuthRecord } from './auth-store.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

/** Insert a new user. Throws on duplicate username (UNIQUE constraint). */
export function createUser(opts: {
  id?: string;
  username: string;
  passwordHash: string;
  createdAt?: string;
}): UserRow {
  const db = getOrgsDb();
  const id = opts.id || uuidv4();
  const createdAt = opts.createdAt || new Date().toISOString();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    opts.username,
    opts.passwordHash,
    createdAt,
  );
  return {
    id,
    username: opts.username,
    password_hash: opts.passwordHash,
    created_at: createdAt,
  };
}

export function getUserById(id: string): UserRow | null {
  const db = getOrgsDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row || null;
}

export function getUserByUsername(username: string): UserRow | null {
  const db = getOrgsDb();
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | UserRow
    | undefined;
  return row || null;
}

export function listUsers(): UserRow[] {
  const db = getOrgsDb();
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

export function countUsers(): number {
  const db = getOrgsDb();
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return row.c;
}

export function deleteUser(id: string): void {
  const db = getOrgsDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function updateUserPassword(id: string, passwordHash: string): void {
  const db = getOrgsDb();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
}

/**
 * One-shot migration from the Phase-1/2 `auth.json` singleton to the
 * Phase-3 users + memberships tables. Safe to call on every boot:
 *   - If any users already exist, it returns immediately.
 *   - If `auth.json` is missing (truly fresh install), it also exits —
 *     setup will seed the first Owner through the normal code path.
 *
 * Creates the Owner in every existing org so legacy installs keep full
 * access after the upgrade (typically just the `default` org).
 */
export function migrateAuthRecordIfNeeded(): { migratedUserId: string } | null {
  const db = getOrgsDb();
  const userCount = countUsers();
  if (userCount > 0) return null;

  const record = getAuthRecord();
  if (!record) return null;

  // Use the auth record's original createdAt so restart behavior is
  // consistent if the process crashes mid-migration and retries.
  const user = createUser({
    username: record.username,
    passwordHash: record.passwordHash,
    createdAt: record.createdAt,
  });

  // Grant Owner in every existing org. At the time this migration fires,
  // seedOrgsFromDisk() has already populated the orgs table with
  // `default` + anything in ~/.agent-hub/orgs/.
  const orgRows = db.prepare('SELECT id FROM orgs').all() as Array<{ id: string }>;
  const insertMembership = db.prepare(
    'INSERT OR IGNORE INTO memberships (user_id, org_id, role) VALUES (?, ?, ?)',
  );
  for (const org of orgRows) {
    insertMembership.run(user.id, org.id, 'Owner');
  }

  return { migratedUserId: user.id };
}
