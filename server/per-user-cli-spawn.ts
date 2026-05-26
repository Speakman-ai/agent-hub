/**
 * Helpers for deciding when a Hub user has their own CLI identity (API keys
 * and/or browser/device OAuth caches) vs when a spawn should fall back to
 * the operator's host-wide credentials.
 */
import { existsSync, readdirSync, statSync } from 'fs';
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
 * True when the user's per-user HOME contains a non-empty
 * `.claude/.credentials.json`. Claude Code stores its OAuth session there
 * after `claude login` / "Sign in with Claude"; the file is the only
 * file-based form of per-user Claude auth (the env-var path is the
 * `claude_code_oauth_token` column).
 */
function perUserHomeHasClaudeCache(userId: string, dataDir: string): boolean {
  try {
    const credPath = path.join(perUserHomePath(userId, dataDir), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return false;
    const st = statSync(credPath);
    return st.isFile() && st.size > 0;
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
   * Owning session id. Passed to `buildSpawnEnv` for per-session spawn-creds
   * minting when the deployment has no global `cfg.apiKey`. Also included in
   * `TOOL_ERROR` metadata when the per-user CLI auth lookup throws so silent
   * fallbacks to host config remain visible in operator logs.
   */
  sessionId?: string | null;
  /**
   * Engine about to be spawned (`claude-code`, `cursor-agent`, `codex-cli`,
   * `gemini-cli`). Used to route HOME selection per-engine — claude-code
   * spawns where the user has no per-user Claude identity fall back to the
   * persistent host CLI HOME so the operator's
   * `<dataDir>/host-creds/home/.claude/.credentials.json` (written by the
   * browser-flow `POST /api/config/claude-auth/login`) is reachable. Other
   * engines keep the legacy behavior: any per-user identity pins HOME to
   * the per-user tree. Omit (undefined) to preserve the legacy
   * any-identity-wins behavior — used by callers that don't know the
   * engine yet (Cursor session create-chat probe).
   */
  engine?: string | null;
}

/**
 * Base CLI spawn env for a chat session (Cursor create-chat, agent spawn, …).
 * Mirrors the userOverride + HOME resolution in `server/chat.ts` so every
 * cursor-agent invocation for the same session shares credentials.
 */
export function resolveSessionCliSpawnEnv(opts: ResolveSessionCliSpawnEnvOpts): NodeJS.ProcessEnv {
  const { cfg, ownerId, credsOwnerId, sessionId, engine } = opts;
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
  // HOME pin selection. The default rule is "any per-user identity wins" —
  // a user that has signed in to one engine per-user gets their per-user
  // HOME for every spawn so other engines' caches stay isolated under their
  // subtree. Claude Code is the outlier: its only file-based cache is
  // `.claude/.credentials.json`, and the operator-side browser login
  // (`POST /api/config/claude-auth/login`) writes that file to the
  // persistent host CLI HOME, *not* the per-user HOME. When the engine is
  // claude-code and the user has no per-user Claude identity (DB column
  // OR per-user `.credentials.json`), pinning HOME to the per-user tree
  // shadows the working host login and the spawn fails with
  // "Not logged in · Please run /login". Routing back to the host HOME in
  // that case lets the operator browser-login carry the reviewer spawn.
  // Other engines retain the legacy behavior because they CAN populate the
  // per-user cache themselves (Codex device-login, Cursor browser-login,
  // Gemini OAuth) — none of those have an analogous host-only file form.
  let homeUserId: string | null;
  if (
    engine === 'claude-code' &&
    credsOwnerId &&
    !userHasPerUserClaudeIdentity(credsOwnerId, cfg.dataDir)
  ) {
    // Fall back to host CLI HOME for this Claude spawn. `ownerId` is the
    // session owner — preserving it would re-pin HOME to per-user via the
    // first branch of the legacy rule, defeating the fallback. Reviewer
    // sessions already enter this branch with `ownerId = null`; for a
    // regular user session whose owner has no per-user Claude, the same
    // host-HOME fallback is the right answer (the env-token path still
    // bills to whichever level set CLAUDE_CODE_OAUTH_TOKEN: per-user
    // override → host config → unset, identical to before).
    homeUserId = null;
  } else {
    homeUserId =
      ownerId ??
      (credsOwnerId && userHasPerUserCliIdentity(credsOwnerId, cfg.dataDir) ? credsOwnerId : null);
  }
  const spawnCredsUserId = credsOwnerId ?? ownerId;
  const buildOpts: BuildSpawnEnvOptions = {
    userOverride,
    userId: homeUserId,
    sessionId: sessionId ?? null,
    spawnCredsUserId,
  };
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
    if (perUserHomeHasClaudeCache(userId, dataDir)) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * True iff the user has a Claude-specific identity we can attach to a
 * claude-code spawn. This is intentionally narrower than
 * `userHasPerUserCliIdentity`: the engine-aware HOME route in
 * `resolveSessionCliSpawnEnv` falls back to the host CLI HOME for
 * claude-code spawns when this returns false, because the operator
 * browser-flow login writes `.claude/.credentials.json` to the persistent
 * host HOME — not the per-user one — and we'd otherwise shadow it.
 */
export function userHasPerUserClaudeIdentity(userId: string, dataDir: string): boolean {
  if (!userId?.trim() || !dataDir?.trim()) return false;
  try {
    const claude = getUserClaudeAuth(userId);
    if (claude && (claude.anthropicApiKey || claude.claudeCodeOAuthToken)) return true;
    if (perUserHomeHasClaudeCache(userId, dataDir)) return true;
    return false;
  } catch {
    return false;
  }
}
