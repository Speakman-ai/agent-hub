// Engine authentication status — single source of truth for "can we spawn
// any AI agent right now?" used by /api/config/models and /api/setup/status.
//
// Auth is strictly per-account: Claude / Cursor / Codex availability is
// resolved ONLY from the requesting user's stored keys and per-user HOME
// OAuth caches. There is no host fallback — a request with no `userId`
// reports these engines as unavailable. This mirrors `buildSpawnEnv`, which
// injects only the acting user's own credentials.
//
// This module is async because the cursor probe shells out to
// `cursor-agent status`. The result is memoized by `cursor-auth-cache` so
// repeated calls inside a single client poll don't multiply CLI invocations.
// When a per-user Cursor key is present we short-circuit the probe entirely
// — a stored key is a strong-enough signal that spawning will work.

import { existsSync } from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import os from 'os';
import { detectCodexAuthMode } from './codex-auth.js';
import { getCursorAuthenticatedCached } from './cursor-auth-cache.js';
import { parseCursorStatusJson } from './cursor-auth-parse.js';
import { getUserClaudeAuth, getUserCursorAuth, getUserCodexAuth } from './users-store.js';
import { ensurePerUserHome } from './per-user-home.js';
import {
  hasPopulatedCodexDeviceAuth,
  perUserCodexHomePath,
} from './per-user-codex-device-login.js';

export interface EngineAuthStatus {
  claude: boolean;
  cursor: boolean;
  codex: boolean;
  /** True iff at least one engine has a usable credential. */
  any: boolean;
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
  cursorBin: string;
  /** Authenticated user id. Required — there is no host fallback. */
  userId?: string | null;
  /**
   * Hub data dir — required (with `userId`) to probe Cursor / Codex OAuth
   * under the same per-user HOME `buildSpawnEnv` uses for spawns.
   */
  dataDir?: string | null;
  /**
   * Override per-user HOME Cursor probe (tests). Defaults to shelling out via
   * `probeCursorStatus` with `HOME` pinned to `ensurePerUserHome(...)`.
   */
  cursorProbePerUserHome?: (bin: string, homePath: string) => Promise<boolean>;
}

export async function getEngineAuthStatus(opts: EngineAuthInputs): Promise<EngineAuthStatus> {
  const { cursorBin, userId, dataDir, cursorProbePerUserHome } = opts;

  // Strictly per-account: with no acting user there are no credentials to
  // resolve, so every engine is unavailable. There is no host fallback.
  if (!userId) {
    return { claude: false, cursor: false, codex: false, any: false };
  }

  // Claude — per-user API key or OAuth token.
  let claude = false;
  try {
    const stored = getUserClaudeAuth(userId);
    if (stored) {
      claude = !!(stored.anthropicApiKey || stored.claudeCodeOAuthToken);
    }
  } catch {
    // users-store schema may be missing on bare bootstraps — treat as no creds.
    claude = false;
  }

  let hasUserCodexApiKey = false;
  try {
    const stored = getUserCodexAuth(userId);
    if (stored?.apiKey) hasUserCodexApiKey = true;
  } catch {
    hasUserCodexApiKey = false;
  }

  let codex = false;
  if (hasUserCodexApiKey) {
    codex = true;
  } else if (dataDir) {
    try {
      if (hasPopulatedCodexDeviceAuth(userId, dataDir)) {
        codex = true;
      } else {
        const perHome = ensurePerUserHome(userId, dataDir);
        const perFs = detectCodexAuthMode(path.join(perHome, '.codex'));
        codex = perFs.present && (perFs.mode === 'chatgpt' || perFs.mode === 'apikey');
      }
    } catch {
      codex = false;
    }
    if (!codex) {
      try {
        const isolatedHome = perUserCodexHomePath(userId, dataDir);
        const isolatedFs = detectCodexAuthMode(isolatedHome);
        codex =
          isolatedFs.present && (isolatedFs.mode === 'chatgpt' || isolatedFs.mode === 'apikey');
      } catch {
        codex = false;
      }
    }
  }

  // Cursor — per-user API key, else probe `cursor-agent status` under the
  // user's own HOME.
  let hasUserCursorApiKey = false;
  try {
    const stored = getUserCursorAuth(userId);
    if (stored && stored.apiKey) hasUserCursorApiKey = true;
  } catch {
    hasUserCursorApiKey = false;
  }

  let cursor = false;
  if (hasUserCursorApiKey) {
    cursor = true;
  } else if (dataDir) {
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
  }

  return {
    claude,
    cursor,
    codex,
    any: claude || cursor || codex,
  };
}
