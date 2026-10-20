/**
 * Dev-server auto login.
 *
 * `npm run dev` sets `AGENT_HUB_DEV_EMAIL_USER=1`. While that is set, and
 * the process is not a production run, every request is the same generated
 * email user. The address is created once under the data dir and reused, so
 * a restart stays on that account. The password hash cannot be verified, so
 * the account is only reachable through this bypass.
 */
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import config from './config.js';
import { getActiveOrgId, getAllOrgs } from './orgs.js';
import { createMembership, getMembershipRole } from './memberships-store.js';
import { createUser, getUserById, getUserByUsername, type UserRow } from './users-store.js';
import type { Role } from './roles.js';

/** Client-side marker. The dev server never checks this string as a JWT. */
export const DEV_EMAIL_SESSION_TOKEN = 'dev-email-session';

const PASSWORD_HASH = 'dev-email-user-no-password';

export interface DevEmailSessionUser {
  id: string;
  email: string;
  needsEmailUpdate: false;
  role: Role;
}

export interface DevEmailSession {
  token: string;
  expiresAt: string;
  user: DevEmailSessionUser;
}

interface StoredDevEmailUser {
  email: string;
  userId: string;
}

export function isDevEmailUserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_HUB_DEV_EMAIL_USER === '1' && env.NODE_ENV !== 'production';
}

function storedFilePath(): string {
  return path.join(config.dataDir, 'dev-email-user.json');
}

function loadStored(): StoredDevEmailUser | null {
  const file = storedFilePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoredDevEmailUser>;
    if (typeof parsed.email !== 'string' || typeof parsed.userId !== 'string') return null;
    if (!parsed.email || !parsed.userId) return null;
    return { email: parsed.email, userId: parsed.userId };
  } catch {
    return null;
  }
}

function saveStored(record: StoredDevEmailUser): void {
  const file = storedFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function randomEmail(): string {
  return `dev-${randomBytes(6).toString('hex')}@example.com`;
}

function remember(user: UserRow): StoredDevEmailUser {
  const stored = { email: user.username, userId: user.id };
  saveStored(stored);
  return stored;
}

function ensureMemberships(userId: string): void {
  const orgIds = getAllOrgs().map((org) => org.id);
  if (orgIds.length === 0) orgIds.push(getActiveOrgId());
  for (const orgId of orgIds) {
    if (getMembershipRole(userId, orgId)) continue;
    createMembership(userId, orgId, 'Owner');
  }
}

/** Create or load the dev email user. Returns null when the bypass is off. */
export function ensureDevEmailUser(): DevEmailSession | null {
  if (!isDevEmailUserEnabled()) return null;

  const stored = loadStored();
  let user: UserRow | null = stored ? getUserById(stored.userId) : null;
  if (!user && stored) user = getUserByUsername(stored.email);
  if (!user) {
    const email = stored?.email ?? randomEmail();
    user =
      getUserByUsername(email) ??
      createUser({
        ...(stored?.userId ? { id: stored.userId } : {}),
        username: email,
        passwordHash: PASSWORD_HASH,
      });
  }
  remember(user);
  ensureMemberships(user.id);

  const role = getMembershipRole(user.id, getActiveOrgId()) ?? 'Owner';
  return {
    token: DEV_EMAIL_SESSION_TOKEN,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    user: {
      id: user.id,
      email: user.username,
      needsEmailUpdate: false,
      role,
    },
  };
}
