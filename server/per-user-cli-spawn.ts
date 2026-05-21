/**
 * Helpers for deciding when a Hub user has their own CLI identity (API keys
 * and/or browser/device OAuth caches) vs when a spawn should fall back to
 * the operator's host-wide credentials.
 */
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { buildSpawnEnv, type BuildSpawnEnvOptions, type SpawnEnvOverride } from './config.js';
import type { AppConfig } from './types.js';
import {
  getUserClaudeAuth,
  getUserCodexAuth,
  getUserCursorAuth,
  getUserGeminiAuth,
} from './users-store.js';
import { perUserHomePath } from './per-user-home.js';
import { hasPopulatedCodexDeviceAuth } from './per-user-codex-device-login.js';
import { detectCodexAuthMode } from './codex-auth.js';

function perUserHomeHasCursorCache(userId: string, dataDir: string): boolean {
  try {
    const cursorDir = path.join(perUserHomePath(userId, dataDir), '.cursor');
    if (!existsSync(cursorDir)) return false;
    return readdirSync(cursorDir).length > 0;
  } catch {
    return false;
  }
}

function perUserHomeHasCodexCache(userId: string, dataDir: string): boolean {
  try {
    const home = perUserHomePath(userId, dataDir);
    const info = detectCodexAuthMode(path.join(home, '.codex'));
    return info.present && (info.mode === 'chatgpt' || info.mode === 'apikey');
  } catch {
    return false;
  }
}

/**
 * True when the user has any per-account CLI material we should prefer over
 * the host operator's global subscription (stored API keys and/or OAuth
 * caches under their per-user HOME / CODEX_HOME).
 */
export interface ResolveSessionCliSpawnEnvOpts {
  cfg: AppConfig;
  ownerId: string | null;
  credsOwnerId: string | null;
  /**
   * Owning session id, only used for `TOOL_ERROR` observability when the
   * per-user CLI auth lookup throws. Pre-extraction the equivalent block in
   * `server/chat.ts` emitted the structured log line — keep that signal so
   * silent fallbacks to host config are still visible in operator logs.
   */
  sessionId?: string | null;
}

/**
 * Base CLI spawn env for a chat session (Cursor create-chat, agent spawn, …).
 * Mirrors the userOverride + HOME resolution in `server/chat.ts` so every
 * cursor-agent invocation for the same session shares credentials.
 */
export function resolveSessionCliSpawnEnv(opts: ResolveSessionCliSpawnEnvOpts): NodeJS.ProcessEnv {
  const { cfg, ownerId, credsOwnerId, sessionId } = opts;
  let userOverride: SpawnEnvOverride | null = null;
  try {
    if (credsOwnerId) {
      const userClaude = getUserClaudeAuth(credsOwnerId);
      const userCursor = getUserCursorAuth(credsOwnerId);
      const userGemini = getUserGeminiAuth(credsOwnerId);
      const userCodex = getUserCodexAuth(credsOwnerId);
      const hasAny =
        !!(userClaude && (userClaude.anthropicApiKey || userClaude.claudeCodeOAuthToken)) ||
        !!(userCursor && userCursor.apiKey) ||
        !!(userGemini && userGemini.apiKey) ||
        !!(userCodex && userCodex.apiKey);
      if (hasAny) {
        userOverride = {
          anthropicApiKey: userClaude?.anthropicApiKey ?? null,
          claudeCodeOAuthToken: userClaude?.claudeCodeOAuthToken ?? null,
          cursorApiKey: userCursor?.apiKey ?? null,
          geminiApiKey: userGemini?.apiKey ?? null,
          codexApiKey: userCodex?.apiKey ?? null,
        };
      }
    }
  } catch (err) {
    // Best-effort — host config remains the safety net. Surface the failure
    // as a structured TOOL_ERROR so operator logs preserve the signal the
    // equivalent inline block in `chat.ts` used to emit pre-extraction.
    const summary = (err as Error).message
      .replace(/[\r\n|]+/g, ' ')
      .trim()
      .slice(0, 200);
    const meta = JSON.stringify({
      v: 2,
      sev: 'soft',
      resolution: 'recovered',
      session: sessionId ?? null,
      tags: ['per-user-cli-auth', 'spawn'],
    });
    console.error(
      `TOOL_ERROR | ${new Date().toISOString()} | per-user-cli-auth | spawn lookup | error | ${summary} | ${meta}`,
    );
  }
  const homeUserId =
    ownerId ??
    (credsOwnerId && userHasPerUserCliIdentity(credsOwnerId, cfg.dataDir) ? credsOwnerId : null);
  const buildOpts: BuildSpawnEnvOptions = { userOverride, userId: homeUserId };
  return buildSpawnEnv(cfg, buildOpts);
}

export function userHasPerUserCliIdentity(userId: string, dataDir: string): boolean {
  if (!userId?.trim() || !dataDir?.trim()) return false;
  try {
    const claude = getUserClaudeAuth(userId);
    if (claude && (claude.anthropicApiKey || claude.claudeCodeOAuthToken)) return true;

    const cursor = getUserCursorAuth(userId);
    if (cursor?.apiKey) return true;

    const gemini = getUserGeminiAuth(userId);
    if (gemini?.apiKey) return true;

    const codex = getUserCodexAuth(userId);
    if (codex?.apiKey) return true;

    if (hasPopulatedCodexDeviceAuth(userId, dataDir)) return true;
    if (perUserHomeHasCursorCache(userId, dataDir)) return true;
    if (perUserHomeHasCodexCache(userId, dataDir)) return true;

    return false;
  } catch {
    return false;
  }
}
