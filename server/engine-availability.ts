// Per-engine availability + auth probes for one-shot prompt sites
// (project analyze, heartbeats, crons, memory reconciliation, etc.).
//
// Auth model: strictly per-account. Claude / Cursor / Codex availability is
// resolved ONLY from the acting user's own stored keys and per-user HOME
// OAuth caches — there is no host or org-owner fallback. A probe with no
// `userId` reports those engines as unavailable. Gemini is the one exception:
// it is host-configured (it backs wiki embeddings + the Gemini CLI), so its
// availability reads the host `geminiApiKey` / `GEMINI_API_KEY`.
//
// This module is read-only with respect to credentials — it never writes
// auth files.

import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AppConfig } from './types.js';
import { invalidateCursorAuthCache } from './cursor-auth-cache.js';
import { userHasEngineCreds } from './per-user-cli-spawn.js';
import { getUserGrokAuth } from './users-store.js';

export type SupportedEngine =
  | 'claude-code'
  | 'cursor-agent'
  | 'codex-cli'
  | 'gemini-cli'
  | 'grok-cli';

/**
 * Why an engine is unavailable. Used by the resolver to pick a clear
 * user-facing error message and by the config route for telemetry.
 *
 * - `no-binary`: the configured CLI binary path doesn't exist.
 * - `no-credentials`: binary exists but no auth source is configured for the
 *   acting user (no stored key, no per-user OAuth cache), or there is no
 *   acting user at all.
 * - `expired`: reserved; no engine reports this anymore now that auth is
 *   per-account (we collapse expiry into `no-credentials`).
 * - `unknown`: probe ran but couldn't determine availability.
 */
export type EngineUnavailableReason = 'no-binary' | 'no-credentials' | 'expired' | 'unknown';

export interface EngineAvailability {
  engine: SupportedEngine;
  available: boolean;
  /** Populated only when `available` is false. */
  reason?: EngineUnavailableReason;
  /** Populated only when `available` is false. Short, user-readable. */
  detail?: string;
}

export const ALL_SUPPORTED_ENGINES: readonly SupportedEngine[] = [
  'claude-code',
  'cursor-agent',
  'codex-cli',
  'gemini-cli',
  'grok-cli',
] as const;

interface ProbeOptions {
  /** Override env reads — primarily for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Acting user whose per-account credentials decide Claude / Cursor / Codex
   * availability. There is no host fallback — when absent, those engines are
   * unavailable.
   */
  userId?: string | null;
}

export function resolveGrokAuthCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    (typeof env.HOME === 'string' && env.HOME.trim()) ||
    (typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim()) ||
    os.homedir();
  return path.join(home, '.grok', 'auth.json');
}

export function hasGrokCachedLogin(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return existsSync(resolveGrokAuthCachePath(env));
  } catch {
    return false;
  }
}

/**
 * Probe a single engine and return its availability. Never throws;
 * unexpected errors collapse to `{ available: false, reason: 'unknown' }`.
 */
export async function probeEngineAvailability(
  engine: SupportedEngine,
  cfg: AppConfig,
  opts: ProbeOptions = {},
): Promise<EngineAvailability> {
  const env = opts.env ?? process.env;
  const userId = opts.userId ?? null;

  // Gemini — the one host-configured engine.
  if (engine === 'gemini-cli') {
    const bin = cfg.geminiBin;
    if (!bin || !existsSync(bin)) {
      return {
        engine,
        available: false,
        reason: 'no-binary',
        detail: `gemini binary not found at "${bin || '(unset)'}". Install Gemini CLI or update geminiBin in Settings.`,
      };
    }
    if (cfg.geminiApiKey || env.GEMINI_API_KEY) return { engine, available: true };
    return {
      engine,
      available: false,
      reason: 'no-credentials',
      detail: 'No Gemini credentials. Set GEMINI_API_KEY in environment or Settings.',
    };
  }

  // Grok Build CLI — host-configured like Gemini for API-key automation, with
  // browser login accepted when the host HOME already has Grok's cached token.
  // xAI documents browser auth on first launch, but not the cache file as a
  // stable public API; this check is best-effort and read-only.
  if (engine === 'grok-cli') {
    const bin = cfg.grokBin;
    if (!bin || !existsSync(bin)) {
      return {
        engine,
        available: false,
        reason: 'no-binary',
        detail: `grok binary not found at "${bin || '(unset)'}". Install the Grok Build CLI or update grokBin in Settings.`,
      };
    }
    const userGrokKey = userId ? getUserGrokAuth(userId)?.apiKey : null;
    if (userGrokKey || cfg.xaiApiKey || env.XAI_API_KEY || hasGrokCachedLogin(env)) {
      return { engine, available: true };
    }
    return {
      engine,
      available: false,
      reason: 'no-credentials',
      detail:
        'No Grok credentials. Add your own xAI key under Account settings, set XAI_API_KEY / xaiApiKey in Settings, or run `grok login`.',
    };
  }

  // Claude / Cursor / Codex — strictly per-account.
  if (engine === 'cursor-agent') {
    const bin = cfg.cursorBin;
    if (!bin || !existsSync(bin)) {
      return {
        engine,
        available: false,
        reason: 'no-binary',
        detail: `cursor-agent binary not found at "${bin || '(unset)'}". Install Cursor Agent or update cursorBin in Settings.`,
      };
    }
  }
  if (engine === 'codex-cli') {
    const bin = cfg.codexBin;
    if (!bin || !existsSync(bin)) {
      return {
        engine,
        available: false,
        reason: 'no-binary',
        detail: `codex binary not found at "${bin || '(unset)'}". Install Codex CLI or update codexBin in Settings.`,
      };
    }
  }

  if (!userId) {
    return {
      engine,
      available: false,
      reason: 'no-credentials',
      detail: `No acting user for this ${engine} run. AI credentials are strictly per-account; attribute the run to a user with their own ${engine} login.`,
    };
  }

  if (userHasEngineCreds(engine, userId, cfg.dataDir)) {
    return { engine, available: true };
  }

  return {
    engine,
    available: false,
    reason: 'no-credentials',
    detail: `No ${engine} credentials on your account. Add your own ${engine} login under Account settings — there is no host or org-owner fallback.`,
  };
}

/**
 * Probe every supported engine in parallel. The result is keyed by engine
 * id; iteration order matches `ALL_SUPPORTED_ENGINES`.
 */
export async function probeAllEngineAvailability(
  cfg: AppConfig,
  opts: ProbeOptions = {},
): Promise<Record<SupportedEngine, EngineAvailability>> {
  const results = await Promise.all(
    ALL_SUPPORTED_ENGINES.map((engine) => probeEngineAvailability(engine, cfg, opts)),
  );
  const out: Partial<Record<SupportedEngine, EngineAvailability>> = {};
  for (const r of results) out[r.engine] = r;
  return out as Record<SupportedEngine, EngineAvailability>;
}

/**
 * Test/maintenance helper — invalidate the cursor auth cache so the next
 * probe re-runs `cursor-agent status`. Re-exported here so callers don't
 * need to import the cache module directly.
 */
export { invalidateCursorAuthCache };
