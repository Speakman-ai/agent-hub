/**
 * Spawn-time minting for per-session Hub API credentials (W2).
 *
 * When the deployment has no global `cfg.apiKey`, interactive sessions
 * still need a stable `ahub_*` token for `ah-api.sh` / `board.sh`. The
 * env var is frozen at spawn, so we persist a per-session file that the
 * shell helpers re-read on every invocation (see `spawn-creds-file.ts`).
 *
 * Best-effort everywhere — failures are logged and never block a spawn.
 */
import { createApiKey, revokeApiKeysBySpawnSession, verifyApiKey } from './api-keys-store.js';
import {
  readSpawnCredsFile,
  removeSpawnCredsFile,
  writeSpawnCredsFile,
} from './spawn-creds-file.js';
import type { AppConfig } from './types.js';

/**
 * 7-day TTL — covers normal "step away from a session for a week" idle.
 * Spawn-creds are server-rotated (each new spawn revokes the prior key
 * for the same session) and session-purge revokes on archive cleanup, so
 * the TTL is purely a safety net for sessions that were abandoned
 * mid-flight without going through purge. Was 30 days; dropped to 7 once
 * we noticed long-idle stale rows accumulating server-side even though
 * the UI no longer surfaces them (see `isHiddenSystemKeyName`).
 */
const SPAWN_KEY_TTL_DAYS = 7;

/** Settings → API Keys label for operator visibility. */
export function spawnCredsKeyName(sessionId: string): string {
  return `spawn:${sessionId}`;
}

export interface EnsureSpawnCredsOpts {
  sessionId: string;
  ownerUserId: string;
  cfg: AppConfig;
}

/**
 * Mint (or refresh) the spawn-creds file when the deployment has no global
 * API key. Skips when `cfg.apiKey` is set — env injection handles that path.
 */
export function ensureSpawnCredsForSession(opts: EnsureSpawnCredsOpts): void {
  const { sessionId, ownerUserId, cfg } = opts;
  if (cfg.apiKey) return;
  if (!sessionId.trim() || !ownerUserId.trim()) return;

  try {
    const existing = readSpawnCredsFile(sessionId, cfg.dataDir);
    if (existing) {
      const verified = verifyApiKey(existing);
      if (verified?.userId === ownerUserId) return;
    }

    revokeApiKeysBySpawnSession(sessionId);
    const minted = createApiKey(ownerUserId, spawnCredsKeyName(sessionId), SPAWN_KEY_TTL_DAYS);
    writeSpawnCredsFile(sessionId, minted.token, cfg.dataDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[spawn-creds-mint] session=${sessionId} failed: ${message}`);
  }
}

/** Revoke DB keys + delete the on-disk token file. Best-effort. */
export function cleanupSpawnCredsForSession(sessionId: string, dataDir: string): void {
  if (!sessionId.trim()) return;
  try {
    revokeApiKeysBySpawnSession(sessionId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[spawn-creds-mint] revoke session=${sessionId} failed: ${message}`);
  }
  try {
    removeSpawnCredsFile(sessionId, dataDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[spawn-creds-mint] unlink session=${sessionId} failed: ${message}`);
  }
}
