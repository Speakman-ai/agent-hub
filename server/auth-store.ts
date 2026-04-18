/**
 * File-backed single-user auth store.
 *
 * Phase 1 preserves the single-user model — exactly one credential record
 * lives on disk at `{dataDir}/auth.json`. The file is created on first
 * successful `/api/auth/setup` call and persists the JWT signing secret so
 * issued tokens survive restarts.
 *
 * Shape:
 * ```json
 * {
 *   "username": "owner",
 *   "passwordHash": "scrypt$...",
 *   "jwtSecret": "<64 hex chars>",
 *   "createdAt": "2026-04-18T..."
 * }
 * ```
 *
 * If no file exists, JWT auth is considered disabled and the existing
 * API-key flow remains the only auth mechanism — that keeps upgrades
 * non-breaking.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import config from './config.js';

export interface AuthRecord {
  username: string;
  passwordHash: string;
  jwtSecret: string;
  createdAt: string;
}

let cachedPath: string | null = null;
let cachedRecord: AuthRecord | null | undefined = undefined;

function authFilePath(): string {
  if (cachedPath) return cachedPath;
  cachedPath = path.join(config.dataDir, 'auth.json');
  return cachedPath;
}

/**
 * Return the current auth record, or null if auth isn't configured yet.
 * Cached after first read — call `reloadAuthRecord()` after writes in
 * tests that share the cache.
 */
export function getAuthRecord(): AuthRecord | null {
  if (cachedRecord !== undefined) return cachedRecord;
  const filePath = authFilePath();
  if (!existsSync(filePath)) {
    cachedRecord = null;
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<AuthRecord>;
    if (!parsed.username || !parsed.passwordHash || !parsed.jwtSecret) {
      cachedRecord = null;
      return null;
    }
    cachedRecord = {
      username: parsed.username,
      passwordHash: parsed.passwordHash,
      jwtSecret: parsed.jwtSecret,
      createdAt: parsed.createdAt || new Date().toISOString(),
    };
    return cachedRecord;
  } catch {
    cachedRecord = null;
    return null;
  }
}

/**
 * Persist a new auth record. Overwrites the existing one atomically:
 * write to a temp file then rename over the target. An interrupted write
 * leaves the old auth.json intact rather than a half-written one that
 * would lock the owner out.
 */
export function saveAuthRecord(
  record: Omit<AuthRecord, 'createdAt'> & { createdAt?: string },
): AuthRecord {
  const filePath = authFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  const full: AuthRecord = {
    username: record.username,
    passwordHash: record.passwordHash,
    jwtSecret: record.jwtSecret,
    createdAt: record.createdAt || new Date().toISOString(),
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(full, null, 2), { mode: 0o600 });
  renameSync(tmpPath, filePath);
  cachedRecord = full;
  return full;
}

/** Drop the in-memory cache so the next `getAuthRecord` re-reads from disk. */
export function reloadAuthRecord(): void {
  cachedRecord = undefined;
}

/**
 * Override the file location used by the store. Intended for tests so they
 * can point at a tmp dir; also resets the cache.
 */
export function setAuthFilePathForTests(p: string | null): void {
  cachedPath = p;
  cachedRecord = undefined;
}

/** Returns true iff auth.json exists and is valid. */
export function isAuthConfigured(): boolean {
  return getAuthRecord() !== null;
}

/** Generate a cryptographically random JWT secret (64 hex chars). */
export function generateJwtSecret(): string {
  return randomBytes(32).toString('hex');
}
