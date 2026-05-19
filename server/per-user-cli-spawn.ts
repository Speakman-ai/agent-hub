/**
 * Helpers for deciding when a Hub user has their own CLI identity (API keys
 * and/or browser/device OAuth caches) vs when a spawn should fall back to
 * the operator's host-wide credentials.
 */
import { existsSync, readdirSync } from 'fs';
import path from 'path';
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
