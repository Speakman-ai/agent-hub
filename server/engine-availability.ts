// Per-engine availability + auth probes for one-shot prompt sites
// (project analyze, heartbeats, crons, memory reconciliation, etc.).
//
// Why this lives in its own module:
//   - The auth-detection logic for each CLI was previously inlined in
//     `server/routes/config.ts::GET /api/config/models`. Other surfaces
//     (heartbeat, cron, project analyze) hardcoded `claude-code` and so
//     never benefited from the same probe. Lifting the logic here lets
//     the engine resolver, the config route, and any future surface share
//     one source of truth.
//   - Each engine has its own credential shape (Claude OAuth + setup
//     tokens, Cursor `cursor-agent status`, Codex `~/.codex/auth.json`,
//     Gemini env-only). Modelling the result as `{available, reason}`
//     surfaces *why* an engine is missing so callers can tell the user
//     "expired" vs "no credentials" vs "no binary".
//
// This module is read-only with respect to credentials — it never writes
// auth files.

import { existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { AppConfig } from './types.js';
import { detectCodexAuthMode } from './codex-auth.js';
import { getCursorAuthenticatedCached, invalidateCursorAuthCache } from './cursor-auth-cache.js';
import { parseCursorStatusJson } from './cursor-auth-parse.js';
import { normalizeOAuthExpiresAtMs } from './oauth-expiry.js';

export type SupportedEngine = 'claude-code' | 'cursor-agent' | 'codex-cli' | 'gemini-cli';

/**
 * Why an engine is unavailable. Used by the resolver to pick a clear
 * user-facing error message and by the config route for telemetry.
 *
 * - `no-binary`: the configured CLI binary path doesn't exist.
 * - `no-credentials`: binary exists but no auth source is configured
 *   (no env var, no OAuth file, no api-key in config).
 * - `expired`: an OAuth credential file exists but the `expiresAt` is
 *   in the past. Today only Claude reports this — the Cursor probe
 *   collapses expired-token to a generic "not authenticated" because
 *   `cursor-agent status` doesn't expose expiry; Codex also doesn't.
 * - `unknown`: probe ran but couldn't determine availability (e.g.
 *   cursor status timed out). Treated the same as unavailable but
 *   carries a distinct reason for diagnostics.
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
] as const;

/**
 * Read `~/.claude/.credentials.json` and report whether the Claude OAuth
 * login is still valid. Lifted verbatim from `routes/config.ts`. Returns
 * a tri-state so callers can distinguish "no file" from "file present
 * but expired" from "valid".
 *
 * `claudeHome` is an opt-in override mainly for tests; production reads
 * the real `~/.claude` so behavior matches the upstream config probe.
 */
export function probeClaudeOauth(claudeHome?: string): { state: 'valid' | 'expired' | 'absent' } {
  const credentialsPath = path.join(
    claudeHome ?? path.join(os.homedir(), '.claude'),
    '.credentials.json',
  );
  if (!existsSync(credentialsPath)) return { state: 'absent' };
  try {
    const raw = JSON.parse(readFileSync(credentialsPath, 'utf-8')) as {
      claudeAiOauth?: { expiresAt?: number };
    };
    if (!raw?.claudeAiOauth) return { state: 'absent' };
    const expiresAt = raw.claudeAiOauth.expiresAt;
    if (typeof expiresAt !== 'number') {
      // Some tooling omits expiresAt while OAuth is still valid; the
      // upstream config probe treats that as unauthenticated, so we keep
      // parity here.
      return { state: 'absent' };
    }
    return Date.now() < normalizeOAuthExpiresAtMs(expiresAt)
      ? { state: 'valid' }
      : { state: 'expired' };
  } catch {
    return { state: 'absent' };
  }
}

/**
 * Spawn `cursor-agent status --format json` and parse the
 * `isAuthenticated` flag. Same shape as `routes/config.ts::runCursorStatus`
 * — kept here so the resolver can share the cache.
 */
function runCursorStatus(binPath: string): Promise<boolean> {
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

interface ProbeOptions {
  /** Override env reads — primarily for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Override cursor probe — tests inject a stub so we don't shell out.
   * Production callers use the cached default.
   */
  cursorProbe?: (bin: string) => Promise<boolean>;
  /**
   * Override the directory holding `.credentials.json` for the Claude
   * OAuth probe. Tests use this so they don't read the developer's real
   * `~/.claude` (which often has valid creds).
   */
  claudeHome?: string;
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

  if (engine === 'claude-code') {
    const hasApiKey = !!(cfg.anthropicApiKey || env.ANTHROPIC_API_KEY);
    const hasSetupToken = !!(cfg.claudeCodeOAuthToken || env.CLAUDE_CODE_OAUTH_TOKEN);
    if (hasApiKey || hasSetupToken) return { engine, available: true };
    const oauth = probeClaudeOauth(opts.claudeHome);
    if (oauth.state === 'valid') return { engine, available: true };
    if (oauth.state === 'expired') {
      return {
        engine,
        available: false,
        reason: 'expired',
        detail:
          'Claude OAuth credentials at ~/.claude/.credentials.json have expired. Re-run `claude login` or set ANTHROPIC_API_KEY.',
      };
    }
    return {
      engine,
      available: false,
      reason: 'no-credentials',
      detail:
        'No Claude credentials found. Run `claude login`, set ANTHROPIC_API_KEY, or paste a setup token in Settings.',
    };
  }

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
    const probe = opts.cursorProbe ?? runCursorStatus;
    const ok = await getCursorAuthenticatedCached(bin, probe);
    if (ok) return { engine, available: true };
    return {
      engine,
      available: false,
      reason: 'no-credentials',
      detail: 'cursor-agent reports unauthenticated. Run `cursor-agent login`.',
    };
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
    const apiKeyConfigured = !!(cfg.codexApiKey || env.CODEX_API_KEY || env.OPENAI_API_KEY);
    if (apiKeyConfigured) return { engine, available: true };
    const codexHome = env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const auth = detectCodexAuthMode(codexHome);
    if (auth.present && (auth.mode === 'chatgpt' || auth.mode === 'apikey')) {
      return { engine, available: true };
    }
    return {
      engine,
      available: false,
      reason: 'no-credentials',
      detail:
        'No Codex credentials. Run `codex login`, set CODEX_API_KEY/OPENAI_API_KEY, or sign in to ChatGPT in the Codex CLI.',
    };
  }

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

  // Exhaustiveness guard — add a branch above when extending SupportedEngine.
  return {
    engine,
    available: false,
    reason: 'unknown',
    detail: `Unknown engine: ${engine as string}`,
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
