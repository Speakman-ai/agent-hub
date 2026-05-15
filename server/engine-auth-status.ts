// Engine authentication status — single source of truth for "can we spawn
// any AI agent right now?" used by /api/config/models and /api/setup/status.
//
// Auth resolution mirrors `buildSpawnEnv` (server/config.ts): per-user
// credentials take precedence over host fallback. Today that covers Claude
// (anthropic API key / OAuth token) and Cursor (per-user CURSOR_API_KEY in
// `users.cursor_api_key`, plus OAuth tokens under per-user HOME).
// Codex / Gemini also honor per-user single-key rows (see `buildSpawnEnv`).
//
// This module is async because the cursor probe shells out to
// `cursor-agent status`. The result is memoized by `cursor-auth-cache` so
// repeated calls inside a single client poll don't multiply CLI invocations.
// When a per-user Cursor key is present we short-circuit the probe entirely
// — a stored key is a strong-enough signal that spawning will work, and we
// don't want the dropdown to lie just because the host has no global login.

import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import os from 'os';
import { detectCodexAuthMode } from './codex-auth.js';
import { getCursorAuthenticatedCached } from './cursor-auth-cache.js';
import { parseCursorStatusJson } from './cursor-auth-parse.js';
import { normalizeOAuthExpiresAtMs } from './oauth-expiry.js';
import {
  getUserClaudeAuth,
  getUserCodexAuth,
  getUserCursorAuth,
  getUserGeminiAuth,
} from './users-store.js';
import { ensurePerUserHome } from './per-user-home.js';
import { operatorCliHome, ensureOperatorCliHome } from './operator-cli-home.js';

export interface EngineAuthStatus {
  claude: boolean;
  cursor: boolean;
  codex: boolean;
  gemini: boolean;
  /** True iff at least one engine has a usable credential. */
  any: boolean;
}

/**
 * Returns true when the host-level Claude OAuth credentials file exists and
 * is unexpired. `dataDir` selects the same operator HOME layout as
 * `buildSpawnEnv` (see `operator-cli-home.ts`).
 */
export function hasClaudeHostOauth(dataDir?: string | null): boolean {
  const claudeDir = dataDir
    ? path.join(operatorCliHome(dataDir), '.claude')
    : path.join(os.homedir(), '.claude');
  const credentialsPath = path.join(claudeDir, '.credentials.json');
  if (!existsSync(credentialsPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(credentialsPath, 'utf-8')) as {
      claudeAiOauth?: { expiresAt?: number };
    };
    if (!raw?.claudeAiOauth) return false;
    const expiresAt = raw.claudeAiOauth.expiresAt;
    if (typeof expiresAt === 'number') return Date.now() < normalizeOAuthExpiresAtMs(expiresAt);
    // Missing expiresAt: tooling sometimes omits it while OAuth is still valid;
    // we stay conservative and treat as unauthenticated rather than risk a
    // false-positive that hides the setup wizard.
    return false;
  } catch {
    return false;
  }
}

export interface ProbeCursorStatusOpts {
  /** Overrides merged onto `process.env` so per-user HOME matches `buildSpawnEnv`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Default cursor-status probe — resolves to `true` when `cursor-agent status
 * --format json` reports an authenticated session. Used as the runner for
 * `getCursorAuthenticatedCached`. Kept here (rather than in
 * `cursor-auth-cache.ts`) so the cache module stays free of `child_process`
 * plumbing and remains trivial to test.
 */
export function probeCursorStatus(binPath: string, opts?: ProbeCursorStatusOpts): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(binPath)) return resolve(false);
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
    const cwd = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : os.homedir();
    const proc = execFile(
      binPath,
      ['status', '--format', 'json'],
      { cwd, timeout: 12_000, env },
      (err, stdout, stderr) => {
        const stdoutText = String(stdout ?? '');
        const stderrText = String(stderr ?? '');
        if (err) {
          const parsed = parseCursorStatusJson(stdoutText, stderrText);
          return resolve(parsed.ok && !!parsed.isAuthenticated);
        }
        const parsed = parseCursorStatusJson(stdoutText, stderrText);
        resolve(parsed.ok && !!parsed.isAuthenticated);
      },
    );
    proc.on('error', () => resolve(false));
  });
}

export interface EngineAuthInputs {
  config: {
    anthropicApiKey?: string | null;
    claudeCodeOAuthToken?: string | null;
    codexApiKey?: string | null;
    geminiApiKey?: string | null;
  };
  cursorBin: string;
  /** Authenticated user id, when the calling route has `AuthenticatedRequest`. */
  userId?: string | null;
  /**
   * Hub data dir — required with `userId` to probe Cursor OAuth under the same
   * per-user HOME `buildSpawnEnv` uses for spawns.
   */
  dataDir?: string | null;
  /** Override cursor probe — tests inject stubs; defaults to `probeCursorStatus`. */
  cursorProbe?: (bin: string, opts?: ProbeCursorStatusOpts) => Promise<boolean>;
  /**
   * Override per-user HOME Cursor probe (tests). Defaults to shelling out via
   * `probeCursorStatus` with `HOME` pinned to `ensurePerUserHome(...)`.
   */
  cursorProbePerUserHome?: (bin: string, homePath: string) => Promise<boolean>;
}

export async function getEngineAuthStatus(opts: EngineAuthInputs): Promise<EngineAuthStatus> {
  const {
    config,
    cursorBin,
    userId,
    dataDir,
    cursorProbe = probeCursorStatus,
    cursorProbePerUserHome,
  } = opts;

  // Per-user Claude credentials win over host fallback (see buildSpawnEnv).
  let userClaude = false;
  if (userId) {
    try {
      const stored = getUserClaudeAuth(userId);
      if (stored) {
        userClaude = !!(stored.anthropicApiKey || stored.claudeCodeOAuthToken);
      }
    } catch {
      // users-store schema may be missing on bare bootstraps — treat as no creds.
      userClaude = false;
    }
  }

  const claude = !!(
    userClaude ||
    config.anthropicApiKey ||
    process.env.ANTHROPIC_API_KEY ||
    config.claudeCodeOAuthToken ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    hasClaudeHostOauth(dataDir)
  );

  let userCodexKey = false;
  if (userId) {
    try {
      const stored = getUserCodexAuth(userId);
      if (stored?.apiKey?.trim()) userCodexKey = true;
    } catch {
      userCodexKey = false;
    }
  }

  const codexApiKey = !!(
    userCodexKey ||
    config.codexApiKey ||
    process.env.CODEX_API_KEY ||
    process.env.OPENAI_API_KEY
  );
  const codexHome =
    process.env.CODEX_HOME ??
    path.join(dataDir ? operatorCliHome(dataDir) : os.homedir(), '.codex');
  const codexFs = detectCodexAuthMode(codexHome);
  const codex =
    codexApiKey || (codexFs.present && (codexFs.mode === 'chatgpt' || codexFs.mode === 'apikey'));

  let userGeminiKey = false;
  if (userId) {
    try {
      const stored = getUserGeminiAuth(userId);
      if (stored?.apiKey?.trim()) userGeminiKey = true;
    } catch {
      userGeminiKey = false;
    }
  }
  const gemini = !!(userGeminiKey || config.geminiApiKey || process.env.GEMINI_API_KEY);

  // Per-user Cursor credentials win over host probe (see buildSpawnEnv
  // / chat.ts spawn auth resolution). Without this branch the engine
  // dropdown hides Cursor for any user who only logged in at the
  // per-user level, even though their spawn would actually succeed.
  let hasUserCursorApiKey = false;
  if (userId) {
    try {
      const stored = getUserCursorAuth(userId);
      if (stored && stored.apiKey) hasUserCursorApiKey = true;
    } catch {
      // users-store schema may be missing on bare bootstraps — treat as no creds.
      hasUserCursorApiKey = false;
    }
  }

  let cursor = false;
  if (hasUserCursorApiKey) {
    cursor = true;
  } else if (userId && dataDir) {
    // JWT / per-user API key callers never read the operator's ~/.cursor for
    // spawns — mirror that here so the engine picker stays aligned with chat.
    try {
      const home = ensurePerUserHome(userId, dataDir);
      const runPerUserProbe =
        cursorProbePerUserHome ??
        ((bin: string, homePath: string) => probeCursorStatus(bin, { env: { HOME: homePath } }));
      cursor = await getCursorAuthenticatedCached(cursorBin, (bin) => runPerUserProbe(bin, home), {
        scope: `uid:${userId}`,
      });
    } catch {
      cursor = false;
    }
  } else {
    if (dataDir) {
      const hostHome = ensureOperatorCliHome(dataDir);
      cursor = await getCursorAuthenticatedCached(cursorBin, (bin) =>
        cursorProbe(bin, { env: { ...process.env, HOME: hostHome } }),
      );
    } else {
      cursor = await getCursorAuthenticatedCached(cursorBin, cursorProbe);
    }
  }

  return {
    claude,
    cursor,
    codex,
    gemini,
    any: claude || cursor || codex || gemini,
  };
}
