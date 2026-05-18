/**
 * Per-user Codex device-login state and helpers.
 *
 * Codex is the easier half of the P3/P4 "Sign in with browser" epic
 * because the CLI honors `CODEX_HOME` as an explicit env knob — we can
 * carve each Hub user an isolated cache without redirecting the whole
 * spawn's HOME. The shape that this module commits to is:
 *
 *   <dataDir>/per-user-cli-home/codex/<userId>/auth.json
 *
 * The path is produced by `perUserCliHomePath('codex', userId, dataDir)`
 * (see `per-user-cli-home.ts`) so that one helper is the only place that
 * knows the filesystem layout — keeping spawn-env wiring, route handlers,
 * and tests aligned.
 *
 * State:
 *   - `activeCodexDeviceLogins` tracks in-flight `codex login
 *     --device-auth` processes by `userId`. Two users can be in the
 *     middle of a login simultaneously without stepping on each other.
 *
 * Helpers:
 *   - `hasPopulatedCodexDeviceAuth(userId, dataDir)` is the spawn-env
 *     check: does the per-user CODEX_HOME contain an `auth.json` we
 *     consider "logged in"? When true, `buildSpawnEnv` injects
 *     `CODEX_HOME` so subsequent chat / heartbeat / cron spawns see the
 *     same cached tokens.
 *
 * Why this module is split out from `per-user-engine-auth.ts`: both the
 * routes (POST login + GET status extension) and `buildSpawnEnv` need to
 * read the same in-flight Map. A standalone module keeps the routes
 * layer decoupled from `config.ts` and avoids cross-importing test
 * fixtures.
 */
import type { ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { detectCodexAuthMode } from './codex-auth.js';
import { perUserCliHomePath } from './per-user-cli-home.js';

export interface CodexDeviceLoginRecord {
  proc: ChildProcess;
  loginId: string;
}

const activeCodexDeviceLogins = new Map<string, CodexDeviceLoginRecord>();

/** Return the per-user CODEX_HOME path. Pure path math — does not touch the filesystem. */
export function perUserCodexHomePath(userId: string, dataDir: string): string {
  return perUserCliHomePath('codex', userId, dataDir);
}

export function setActiveCodexDeviceLogin(userId: string, rec: CodexDeviceLoginRecord): void {
  activeCodexDeviceLogins.set(userId, rec);
}

export function getActiveCodexDeviceLogin(userId: string): CodexDeviceLoginRecord | undefined {
  return activeCodexDeviceLogins.get(userId);
}

export function clearActiveCodexDeviceLogin(userId: string, loginId?: string): boolean {
  const current = activeCodexDeviceLogins.get(userId);
  if (!current) return false;
  if (loginId && current.loginId !== loginId) return false;
  activeCodexDeviceLogins.delete(userId);
  return true;
}

export function isCodexDeviceLoginInProgress(userId: string): boolean {
  return activeCodexDeviceLogins.has(userId);
}

/**
 * "Does this user have a populated per-user Codex device-login cache?"
 *
 * Returns true iff `<dataDir>/per-user-cli-home/codex/<userId>/auth.json`
 * exists AND reports a recognised auth mode (`chatgpt` or `apikey`).
 *
 * Used by `buildSpawnEnv` to decide whether to inject `CODEX_HOME` for
 * the spawn. We deliberately do NOT inject `CODEX_HOME` just because the
 * directory exists — the directory is created eagerly when a login is
 * attempted, and an aborted login leaves an empty dir that should still
 * fall through to the host's `~/.codex` (or, with per-user HOME pinned,
 * the per-user HOME's `.codex`).
 *
 * Never throws: every filesystem error collapses to `false` so a
 * transient FS hiccup cannot block a chat spawn.
 */
export function hasPopulatedCodexDeviceAuth(userId: string, dataDir: string): boolean {
  let codexHome: string;
  try {
    codexHome = perUserCodexHomePath(userId, dataDir);
  } catch {
    // Invalid userId / unknown engine — never recover, never inject.
    return false;
  }
  const authPath = path.join(codexHome, 'auth.json');
  if (!existsSync(authPath)) return false;
  const info = detectCodexAuthMode(codexHome);
  return info.present && (info.mode === 'chatgpt' || info.mode === 'apikey');
}

/** Test-only: drop every active record. Server code should use `clearActiveCodexDeviceLogin`. */
export function resetActiveCodexDeviceLoginsForTest(): void {
  activeCodexDeviceLogins.clear();
}
