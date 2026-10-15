/**
 * Persistent browser profiles: Playwright storageState (cookies,
 * localStorage, IndexedDB) per (session owner, agent, project), encrypted at
 * rest with the shared AES-256-GCM helper in `secret-crypto.ts`.
 *
 * The state is loaded into `browser.newContext({ storageState })` at launch
 * rather than living in a Chromium user-data dir, so a profile is not tied
 * to one process or one host's disk.
 *
 * Concurrency: one write lease per profile. The session that holds the lease
 * may save; any other concurrent session reads a copy and its changes are
 * discarded. Leases expire on their own, so a crashed holder frees the
 * profile once its TTL lapses without anyone having to clean up.
 *
 * Plaintext state never leaves this module except as the return value of
 * `loadBrowserProfileState`: nothing here logs, and error messages never
 * include decrypted content.
 */
import { v4 as uuidv4 } from 'uuid';
import { getOrgsDb } from './orgs.js';
import { encryptSecret, decryptSecret } from './secret-crypto.js';

export interface BrowserProfileKey {
  userId: string;
  agentId: string;
  projectId: string;
}

/**
 * The subset of Playwright's `BrowserContext.storageState()` result this
 * module reads. Other fields (IndexedDB entries, future additions) are
 * carried through untouched.
 */
export interface BrowserStorageState {
  cookies: Array<{ domain: string; [k: string]: unknown }>;
  origins: Array<{ origin: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

export interface BrowserProfile {
  id: string;
  userId: string;
  agentId: string;
  projectId: string;
  domains: string[];
  hasState: boolean;
  leaseHolder: string | null;
  /** Epoch ms. Null when no lease has ever been taken or it was released. */
  leaseExpiresAt: number | null;
  lastSavedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LeaseResult =
  | { acquired: true; expiresAt: number }
  | { acquired: false; holder: string; expiresAt: number };

/** Holders renew well inside this window; it bounds how long a crash blocks writes. */
export const DEFAULT_BROWSER_PROFILE_LEASE_TTL_MS = 2 * 60 * 1000;

/** Guard against a runaway IndexedDB dump bloating orgs.db. */
export const MAX_BROWSER_STORAGE_STATE_BYTES = 8 * 1024 * 1024;

/** Saved state exists but cannot be decrypted or parsed (key rotated, corrupt row). */
export class BrowserProfileDecryptError extends Error {
  readonly profileId: string;
  constructor(profileId: string) {
    super(`Browser profile ${profileId} could not be decrypted; its saved state is unreadable`);
    this.name = 'BrowserProfileDecryptError';
    this.profileId = profileId;
  }
}

/** A save was attempted without holding a live write lease. */
export class BrowserProfileLeaseError extends Error {
  constructor(profileId: string) {
    super(`Browser profile ${profileId} write lease is not held by this caller`);
    this.name = 'BrowserProfileLeaseError';
  }
}

interface RawRow {
  id: string;
  user_id: string;
  agent_id: string;
  project_id: string;
  storage_state_enc: string;
  domains_json: string;
  lease_holder: string | null;
  lease_expires_at: number | null;
  last_saved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Clock {
  now?: number;
}

function parseDomains(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function toProfile(row: RawRow): BrowserProfile {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    projectId: row.project_id,
    domains: parseDomains(row.domains_json),
    hasState: row.storage_state_enc !== '',
    leaseHolder: row.lease_holder,
    leaseExpiresAt: row.lease_expires_at,
    lastSavedAt: row.last_saved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectRow(key: BrowserProfileKey): RawRow | undefined {
  return getOrgsDb()
    .prepare(`SELECT * FROM browser_profiles WHERE user_id = ? AND agent_id = ? AND project_id = ?`)
    .get(key.userId, key.agentId, key.projectId) as RawRow | undefined;
}

function assertKey(key: BrowserProfileKey): void {
  if (!key.userId || !key.agentId || !key.projectId) {
    throw new Error('Browser profile key requires userId, agentId and projectId');
  }
}

/** Hostnames present in a storage state, lowercased, leading dots stripped, sorted. */
export function domainsFromStorageState(state: BrowserStorageState): string[] {
  const out = new Set<string>();
  for (const c of state.cookies) {
    const d = typeof c.domain === 'string' ? c.domain.trim().replace(/^\.+/, '').toLowerCase() : '';
    if (d) out.add(d);
  }
  for (const o of state.origins) {
    if (typeof o.origin !== 'string') continue;
    try {
      const host = new URL(o.origin).hostname.toLowerCase();
      if (host) out.add(host);
    } catch {
      // Opaque or malformed origin: nothing to record.
    }
  }
  return [...out].sort();
}

function isStorageState(v: unknown): v is BrowserStorageState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return Array.isArray(s.cookies) && Array.isArray(s.origins);
}

export function getBrowserProfile(key: BrowserProfileKey): BrowserProfile | null {
  assertKey(key);
  const row = selectRow(key);
  return row ? toProfile(row) : null;
}

export function getOrCreateBrowserProfile(key: BrowserProfileKey): BrowserProfile {
  assertKey(key);
  getOrgsDb()
    .prepare(
      `INSERT INTO browser_profiles (id, user_id, agent_id, project_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, agent_id, project_id) DO NOTHING`,
    )
    .run(uuidv4(), key.userId, key.agentId, key.projectId);
  return toProfile(selectRow(key)!);
}

/**
 * Decrypted storage state, or null when the profile does not exist or has
 * nothing saved. Throws `BrowserProfileDecryptError` when the blob is
 * unreadable; callers should start from a fresh context in that case.
 */
export function loadBrowserProfileState(key: BrowserProfileKey): BrowserStorageState | null {
  assertKey(key);
  const row = selectRow(key);
  if (!row || !row.storage_state_enc) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(row.storage_state_enc));
  } catch {
    // Swallow the cause: JSON.parse messages quote part of the input, which
    // would put decrypted cookie values into logs.
    throw new BrowserProfileDecryptError(row.id);
  }
  if (!isStorageState(parsed)) throw new BrowserProfileDecryptError(row.id);
  return parsed;
}

/**
 * Take the write lease, or extend it when `holder` already has it. Succeeds
 * when the lease is free, expired, or already ours; otherwise reports who
 * holds it. Creates the profile row on first use.
 */
export function acquireBrowserProfileLease(
  key: BrowserProfileKey,
  holder: string,
  ttlMs: number = DEFAULT_BROWSER_PROFILE_LEASE_TTL_MS,
  clock: Clock = {},
): LeaseResult {
  if (!holder) throw new Error('Lease holder id is required');
  const now = clock.now ?? Date.now();
  const profile = getOrCreateBrowserProfile(key);
  const expiresAt = now + ttlMs;
  const res = getOrgsDb()
    .prepare(
      `UPDATE browser_profiles
       SET lease_holder = ?, lease_expires_at = ?, updated_at = datetime('now')
       WHERE id = ?
         AND (lease_holder IS NULL OR lease_holder = ? OR lease_expires_at <= ?)`,
    )
    .run(holder, expiresAt, profile.id, holder, now);
  if (res.changes > 0) return { acquired: true, expiresAt };
  const current = selectRow(key)!;
  return {
    acquired: false,
    holder: current.lease_holder ?? '',
    expiresAt: current.lease_expires_at ?? 0,
  };
}

/**
 * Extend a live lease. Returns false when `holder` no longer has it (it
 * expired or someone else took it); the caller must then stop saving and
 * may try `acquireBrowserProfileLease` again.
 */
export function renewBrowserProfileLease(
  key: BrowserProfileKey,
  holder: string,
  ttlMs: number = DEFAULT_BROWSER_PROFILE_LEASE_TTL_MS,
  clock: Clock = {},
): boolean {
  assertKey(key);
  const now = clock.now ?? Date.now();
  const res = getOrgsDb()
    .prepare(
      `UPDATE browser_profiles
       SET lease_expires_at = ?, updated_at = datetime('now')
       WHERE user_id = ? AND agent_id = ? AND project_id = ?
         AND lease_holder = ? AND lease_expires_at > ?`,
    )
    .run(now + ttlMs, key.userId, key.agentId, key.projectId, holder, now);
  return res.changes > 0;
}

/** Drop the lease if `holder` has it. Releasing someone else's lease is a no-op. */
export function releaseBrowserProfileLease(key: BrowserProfileKey, holder: string): boolean {
  assertKey(key);
  const res = getOrgsDb()
    .prepare(
      `UPDATE browser_profiles
       SET lease_holder = NULL, lease_expires_at = NULL, updated_at = datetime('now')
       WHERE user_id = ? AND agent_id = ? AND project_id = ? AND lease_holder = ?`,
    )
    .run(key.userId, key.agentId, key.projectId, holder);
  return res.changes > 0;
}

/**
 * Encrypt and persist a storage state. The write and the lease check happen
 * in one UPDATE, so a holder whose lease lapsed mid-save cannot overwrite
 * the new holder's state. Throws `BrowserProfileLeaseError` when the lease
 * is not live for `holder`.
 */
export function saveBrowserProfileState(
  key: BrowserProfileKey,
  holder: string,
  state: BrowserStorageState,
  clock: Clock = {},
): BrowserProfile {
  assertKey(key);
  if (!isStorageState(state)) {
    throw new Error('storageState must have cookies and origins arrays');
  }
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json, 'utf-8') > MAX_BROWSER_STORAGE_STATE_BYTES) {
    throw new Error(
      `storageState exceeds ${MAX_BROWSER_STORAGE_STATE_BYTES} bytes; refusing to save`,
    );
  }
  const now = clock.now ?? Date.now();
  const res = getOrgsDb()
    .prepare(
      `UPDATE browser_profiles
       SET storage_state_enc = ?, domains_json = ?,
           last_saved_at = datetime('now'), updated_at = datetime('now')
       WHERE user_id = ? AND agent_id = ? AND project_id = ?
         AND lease_holder = ? AND lease_expires_at > ?`,
    )
    .run(
      encryptSecret(json),
      JSON.stringify(domainsFromStorageState(state)),
      key.userId,
      key.agentId,
      key.projectId,
      holder,
      now,
    );
  if (res.changes === 0) {
    const row = selectRow(key);
    throw new BrowserProfileLeaseError(row?.id ?? '(missing)');
  }
  return toProfile(selectRow(key)!);
}

/** Forget a profile's saved state while keeping the row and its lease. */
export function clearBrowserProfileState(key: BrowserProfileKey): boolean {
  assertKey(key);
  const res = getOrgsDb()
    .prepare(
      `UPDATE browser_profiles
       SET storage_state_enc = '', domains_json = '[]', updated_at = datetime('now')
       WHERE user_id = ? AND agent_id = ? AND project_id = ?`,
    )
    .run(key.userId, key.agentId, key.projectId);
  return res.changes > 0;
}

export function deleteBrowserProfile(key: BrowserProfileKey): boolean {
  assertKey(key);
  const res = getOrgsDb()
    .prepare(`DELETE FROM browser_profiles WHERE user_id = ? AND agent_id = ? AND project_id = ?`)
    .run(key.userId, key.agentId, key.projectId);
  return res.changes > 0;
}

export function listBrowserProfilesForUser(userId: string): BrowserProfile[] {
  const rows = getOrgsDb()
    .prepare(`SELECT * FROM browser_profiles WHERE user_id = ? ORDER BY project_id, agent_id`)
    .all(userId) as RawRow[];
  return rows.map(toProfile);
}
