// Engine authentication status — single source of truth for "can we spawn
// any AI agent right now?" used by /api/config/models and /api/setup/status.
//
// Auth resolution mirrors `buildSpawnEnv` (server/config.ts): per-user Claude
// credentials take precedence over host fallback for the Claude engine, and
// host-level config / env vars / on-disk OAuth are checked in the same order
// the spawn path uses. Cursor and Codex are host-level only today.
//
// This module is async because the cursor probe shells out to
// `cursor-agent status`. The result is memoized by `cursor-auth-cache` so
// repeated calls inside a single client poll don't multiply CLI invocations.

import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import os from 'os';
import { detectCodexAuthMode } from './codex-auth.js';
import { getCursorAuthenticatedCached } from './cursor-auth-cache.js';
import { parseCursorStatusJson } from './cursor-auth-parse.js';
import { normalizeOAuthExpiresAtMs } from './oauth-expiry.js';
import { getUserClaudeAuth } from './users-store.js';

export interface EngineAuthStatus {
  claude: boolean;
  cursor: boolean;
  codex: boolean;
  /** True iff at least one engine has a usable credential. */
  any: boolean;
}

/**
 * Returns true when `~/.claude/.credentials.json` holds an unexpired Anthropic
 * OAuth session. Mirrors `buildSpawnEnv`'s claude OAuth fallback.
 */
export function hasClaudeHostOauth(): boolean {
  const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
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

/**
 * Default cursor-status probe — resolves to `true` when `cursor-agent status
 * --format json` reports an authenticated session. Used as the runner for
 * `getCursorAuthenticatedCached`. Kept here (rather than in
 * `cursor-auth-cache.ts`) so the cache module stays free of `child_process`
 * plumbing and remains trivial to test.
 */
export function probeCursorStatus(binPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(binPath)) return resolve(false);
    const proc = execFile(
      binPath,
      ['status', '--format', 'json'],
      { cwd: os.homedir(), timeout: 12_000, env: process.env },
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
  };
  cursorBin: string;
  /** Authenticated user id, when the calling route has `AuthenticatedRequest`. */
  userId?: string | null;
  /** Override the cursor probe (tests). Defaults to `probeCursorStatus`. */
  cursorProbe?: (bin: string) => Promise<boolean>;
}

export async function getEngineAuthStatus(opts: EngineAuthInputs): Promise<EngineAuthStatus> {
  const { config, cursorBin, userId, cursorProbe = probeCursorStatus } = opts;

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
    hasClaudeHostOauth()
  );

  const codexApiKey = !!(
    config.codexApiKey ||
    process.env.CODEX_API_KEY ||
    process.env.OPENAI_API_KEY
  );
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const codexFs = detectCodexAuthMode(codexHome);
  const codex =
    codexApiKey || (codexFs.present && (codexFs.mode === 'chatgpt' || codexFs.mode === 'apikey'));

  const cursor = await getCursorAuthenticatedCached(cursorBin, cursorProbe);

  return {
    claude,
    cursor,
    codex,
    any: claude || cursor || codex,
  };
}
