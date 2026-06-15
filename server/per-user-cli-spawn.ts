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
  getUserGrokAuth,
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
   * `TOOL_ERROR` metadata when the per-user CLI auth lookup throws.
   */
  sessionId?: string | null;
  /**
   * Engine about to be spawned (`claude-code`, `cursor-agent`, `codex-cli`,
   * `gemini-cli`, `grok-cli`). For the per-account engines (claude/cursor/codex) this
   * gates the hard-fail guard: a spawn with no acting user — or a user
   * lacking creds for that engine — throws `EngineAuthRequiredError` rather
   * than running a CLI that would silently 401 or borrow another identity.
   * Omit (undefined) to skip the guard — used by callers that don't know the
   * engine yet (Cursor session create-chat probe).
   */
  engine?: string | null;
}

/** Engines whose credentials are strictly per-account (no host fallback). */
const PER_ACCOUNT_ENGINES = new Set(['claude-code', 'cursor-agent', 'codex-cli']);

/**
 * Thrown when a per-account engine spawn cannot be attributed to an acting
 * user with their own credentials. Callers should surface this to the user /
 * operator (chat error, route 4xx, cron log) instead of spawning blind.
 */
export class EngineAuthRequiredError extends Error {
  readonly engine: string;
  readonly userId: string | null;
  constructor(engine: string, userId: string | null) {
    super(
      userId
        ? `No ${engine} credentials for this account. Add your own ${engine} login under Account settings — Agent Hub spawns use your own credentials only, with no host or org-owner fallback.`
        : `Cannot spawn ${engine}: no acting user. AI credentials are strictly per-account, so this action needs an authenticated owner with their own ${engine} login.`,
    );
    this.name = 'EngineAuthRequiredError';
    this.engine = engine;
    this.userId = userId;
  }
}

/**
 * True when `userId` has usable credentials for `engine` — a stored key, or a
 * per-user HOME / device-auth OAuth cache. `gemini-cli` and unknown engines
 * return true (Gemini is host-configured; unknown engines aren't gated).
 */
export function userHasEngineCreds(
  engine: string | null | undefined,
  userId: string | null,
  dataDir: string,
): boolean {
  if (!userId?.trim() || !dataDir?.trim()) return false;
  try {
    switch (engine) {
      case 'claude-code': {
        const claude = getUserClaudeAuth(userId);
        if (claude && (claude.anthropicApiKey || claude.claudeCodeOAuthToken)) return true;
        return perUserHomeHasClaudeCache(userId, dataDir);
      }
      case 'cursor-agent': {
        const cursor = getUserCursorAuth(userId);
        if (cursor?.apiKey) return true;
        return perUserHomeHasCursorCache(userId, dataDir);
      }
      case 'codex-cli': {
        const codex = getUserCodexAuth(userId);
        if (codex?.apiKey) return true;
        if (hasPopulatedCodexDeviceAuth(userId, dataDir)) return true;
        return perUserHomeHasCodexCache(userId, dataDir);
      }
      default:
        // gemini-cli (host key allowed) + unknown engines are not gated here.
        return true;
    }
  } catch {
    return false;
  }
}

/**
 * Hard-fail guard for per-account engine spawns. Throws
 * `EngineAuthRequiredError` when `engine` is one of claude/cursor/codex and
 * `userId` is missing or has no creds for that engine. No-op for Gemini /
 * unknown engines.
 */
export function assertEngineCredsOrThrow(
  engine: string | null | undefined,
  userId: string | null,
  dataDir: string,
): void {
  if (!engine || !PER_ACCOUNT_ENGINES.has(engine)) return;
  if (!userId || !userHasEngineCreds(engine, userId, dataDir)) {
    throw new EngineAuthRequiredError(engine, userId ?? null);
  }
}

/**
 * Base CLI spawn env for a chat session (Cursor create-chat, agent spawn, …).
 * Resolves the acting user's own per-account credentials and pins HOME to
 * their per-user tree. There is no host or org-owner fallback: a per-account
 * engine spawn with no creds throws `EngineAuthRequiredError`.
 */
export function resolveSessionCliSpawnEnv(opts: ResolveSessionCliSpawnEnvOpts): NodeJS.ProcessEnv {
  const { cfg, ownerId, credsOwnerId, sessionId, engine } = opts;
  // The acting user — the only identity whose keys may flow into this spawn.
  const actingUserId = credsOwnerId ?? ownerId;

  // Hard-fail before doing any work: per-account engines must be your own.
  assertEngineCredsOrThrow(engine, actingUserId, cfg.dataDir);

  let userOverride: SpawnEnvOverride | null = null;
  try {
    if (actingUserId) {
      const userClaude = getUserClaudeAuth(actingUserId);
      const userCursor = getUserCursorAuth(actingUserId);
      const userGemini = getUserGeminiAuth(actingUserId);
      const userCodex = getUserCodexAuth(actingUserId);
      const userGrok = getUserGrokAuth(actingUserId);
      const hasAny =
        !!(userClaude && (userClaude.anthropicApiKey || userClaude.claudeCodeOAuthToken)) ||
        !!(userCursor && userCursor.apiKey) ||
        !!(userGemini && userGemini.apiKey) ||
        !!(userCodex && userCodex.apiKey) ||
        !!(userGrok && userGrok.apiKey);
      if (hasAny) {
        userOverride = {
          anthropicApiKey: userClaude?.anthropicApiKey ?? null,
          claudeCodeOAuthToken: userClaude?.claudeCodeOAuthToken ?? null,
          cursorApiKey: userCursor?.apiKey ?? null,
          geminiApiKey: userGemini?.apiKey ?? null,
          codexApiKey: userCodex?.apiKey ?? null,
          grokApiKey: userGrok?.apiKey ?? null,
        };
      }
    }
  } catch (err) {
    // Surface the lookup failure as a structured TOOL_ERROR so operator logs
    // preserve the signal. The spawn still proceeds — but the hard-fail guard
    // above already rejected per-account engines without creds, so the only
    // spawns reaching here are Gemini / unknown engines.
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
  // HOME is pinned to the acting user's per-user tree so every engine's CLI
  // cache (`.cursor`, `.codex`, `.claude`, Gemini OAuth) stays isolated under
  // their subtree. No owner → no per-user HOME pin (buildSpawnEnv keeps the
  // inherited HOME); per-account engines already hard-failed above.
  const buildOpts: BuildSpawnEnvOptions = {
    userOverride,
    userId: actingUserId,
    sessionId: sessionId ?? null,
    spawnCredsUserId: actingUserId,
    engine,
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
