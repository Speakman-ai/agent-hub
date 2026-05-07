import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { execFile, spawn, ChildProcess } from 'child_process';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { promisify } from 'util';
import http from 'http';
import os from 'os';
import path from 'path';
import type { RouteDeps, AppConfig } from '../types.js';
import config, { buildSpawnEnv, normalizeClaudeSetupToken } from '../config.js';
import { normalizeOAuthExpiresAtMs } from '../oauth-expiry.js';

const execFileAsync = promisify(execFile);

/** Prefer $HOME / %USERPROFILE% over raw os.homedir() so we match the user's shell & Claude CLI. */
function getUserHome(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Claude Code credentials file — must match the CLI.
 * See CLAUDE_CONFIG_DIR (custom dir) vs default ~/.claude/.credentials.json.
 */
export function getClaudeCredentialsPath(): string {
  const raw = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (raw) {
    return path.join(path.resolve(raw), '.credentials.json');
  }
  return path.join(getUserHome(), '.claude', '.credentials.json');
}

interface ClaudeRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface OAuthStatus {
  loggedIn?: boolean;
  [key: string]: unknown;
}

interface CredentialsOAuth {
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
}

/**
 * When JSON is invalid mid-write or the CLI uses slightly different keys, still detect OAuth material.
 * Conservative: require obvious token/oauth JSON keys (not just any substring).
 */
export function credentialsRawLooksLikeOAuthSession(rawText: string): boolean {
  const t = rawText.trim();
  if (!t) return false;
  if (/"(?:claudeAiOauth|claude_ai_oauth)"\s*:\s*\{/.test(t)) return true;
  if (/"(?:refresh_token|access_token|oauth_token|id_token)"\s*:\s*"/.test(t)) return true;
  return false;
}

function extractOAuthBundleFromRoot(raw: Record<string, unknown>): CredentialsOAuth | null {
  const direct = raw.claudeAiOauth ?? raw.claude_ai_oauth;
  if (direct && typeof direct === 'object') {
    return direct as CredentialsOAuth;
  }
  for (const k of Object.keys(raw)) {
    if (!/oauth|anthropic|claude|credential|session/i.test(k)) continue;
    const v = raw[k];
    if (!v || typeof v !== 'object') continue;
    const o = v as CredentialsOAuth & Record<string, unknown>;
    if (typeof o.expiresAt === 'number' || Array.isArray(o.scopes) || o.subscriptionType != null) {
      return o;
    }
    if (Object.keys(o).length > 0) {
      return o as CredentialsOAuth;
    }
  }
  return null;
}

export type ParsedCredentialsFile = {
  oauth: OAuthStatus;
  tokenInfo: Record<string, unknown> | null;
};

/** Parse ~/.claude/.credentials.json for OAuth + token display (no CLI). Exported for unit tests. */
export function parseCredentialsFileContent(rawText: string | null): ParsedCredentialsFile {
  if (!rawText?.trim()) {
    return { oauth: { loggedIn: false }, tokenInfo: null };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    if (credentialsRawLooksLikeOAuthSession(rawText)) {
      return { oauth: { loggedIn: true }, tokenInfo: null };
    }
    return { oauth: { loggedIn: false }, tokenInfo: null };
  }

  const bundle = extractOAuthBundleFromRoot(raw);
  let loggedIn = false;
  if (bundle) {
    if (typeof bundle.expiresAt === 'number') {
      loggedIn = Date.now() < normalizeOAuthExpiresAtMs(bundle.expiresAt);
    } else {
      loggedIn = Object.keys(bundle as object).length > 0;
    }
  } else {
    for (const k of Object.keys(raw)) {
      if (!/oauth|anthropic|claude|credential/i.test(k)) continue;
      const v = raw[k];
      if (v && typeof v === 'object' && Object.keys(v as object).length > 0) {
        loggedIn = true;
        break;
      }
    }
  }

  if (!loggedIn && credentialsRawLooksLikeOAuthSession(rawText)) {
    loggedIn = true;
  }

  let tokenInfo: Record<string, unknown> | null = null;
  if (bundle) {
    const rawExp = bundle.expiresAt;
    tokenInfo = {
      expiresAt: typeof rawExp === 'number' ? normalizeOAuthExpiresAtMs(rawExp) : rawExp,
      expired:
        rawExp && typeof rawExp === 'number'
          ? Date.now() > normalizeOAuthExpiresAtMs(rawExp)
          : null,
      scopes: bundle.scopes || [],
      subscriptionType: bundle.subscriptionType || null,
      rateLimitTier: bundle.rateLimitTier || null,
    };
  }

  return { oauth: { loggedIn }, tokenInfo };
}

function runClaude(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number } = {},
): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: getUserHome(),
      env: { ...buildSpawnEnv(config), ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const ms = opts.timeout || 15_000;
    const timer = setTimeout(() => killProcessGroup(proc, 'SIGTERM'), ms);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d));
    proc.stderr.on('data', (d: Buffer) => (stderr += d));

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: 1 });
    });
  });
}

function readCredentialsFileSafe(): string | null {
  const primary = getClaudeCredentialsPath();
  const fallback = path.join(getUserHome(), '.claude', '.credentials.json');
  const paths = primary === fallback ? [primary] : [primary, fallback];
  for (const p of paths) {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf-8');
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Latest mtime among known credential file locations (detect OAuth write during paste-code). */
function credentialsFilesMaxMtime(): number | null {
  const primary = getClaudeCredentialsPath();
  const fallback = path.join(getUserHome(), '.claude', '.credentials.json');
  const paths = [...new Set([primary, fallback])];
  let max: number | null = null;
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const m = statSync(p).mtimeMs;
        max = max === null ? m : Math.max(max, m);
      }
    } catch {
      /* ignore */
    }
  }
  return max;
}

export function extractOAuthUrl(text: string): string | null {
  const match = text.match(/visit:\s*(https:\/\/\S+)/i);
  return match ? match[1] : null;
}

export function extractStateFromUrl(url: string): string | null {
  const match = url.match(/[?&]state=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Detect whether the OAuth URL indicates the CLI is in "paste-the-code" mode
 * (i.e., the user will paste the authorization code back into the terminal
 * rather than being redirected to a localhost callback server).
 *
 * Signals:
 *  - `code=true` query parameter — the CLI asks Anthropic to display the code
 *    on a public page instead of redirecting.
 *  - `redirect_uri` points at a public Anthropic host (not a loopback address).
 *
 * In paste-mode, any localhost port that happens to be open on the CLI
 * subprocess is NOT the OAuth callback — proxying the code to it will fail.
 * We must submit the code via stdin instead.
 *
 * Loopback detection covers the four common shapes the CLI could bind:
 * `127.0.0.1`, `localhost`, `[::1]` (IPv6 loopback in URL syntax), and
 * `0.0.0.0` (wildcard bind, reachable via loopback).
 */
export function isPasteCodeMode(url: string): boolean {
  if (/[?&]code=true(?:&|$|#)/.test(url)) return true;
  const redirectMatch = url.match(/[?&]redirect_uri=([^&]+)/);
  if (redirectMatch) {
    const redirect = decodeURIComponent(redirectMatch[1]);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(redirect)) {
      return true;
    }
  }
  return false;
}

/** Parse a single `lsof` LISTEN line for a locally bound TCP port (macOS/BSD output). */
export function parseCallbackPortFromLsofLine(line: string): number | null {
  const m = line.match(
    /\bTCP\s+(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|\*):(\d+)\s+\(LISTEN\)/i,
  );
  return m ? parseInt(m[1], 10) : null;
}

/** Log-friendly description of how the CLI subprocess ended (Node passes `signal` when killed). */
export function formatChildExitInfo(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) {
    return code != null && code !== 0 ? `signal=${signal} code=${code}` : `signal=${signal}`;
  }
  if (code === null) return 'code=null';
  return `code=${code}`;
}

async function detectCallbackPortLsof(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)],
      { timeout: 3000 },
    );
    for (const line of stdout.split('\n')) {
      const port = parseCallbackPortFromLsofLine(line);
      if (port) return port;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect the localhost port that `claude auth login` opens for its OAuth callback server.
 * Uses `lsof` on macOS and `ss` on Linux (EC2).
 */
async function detectCallbackPort(pid: number): Promise<number | null> {
  if (os.platform() === 'darwin') {
    return detectCallbackPortLsof(pid);
  }
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp'], { timeout: 3000 });
    const lines = stdout.split('\n').filter((l) => l.includes(`pid=${pid},`));
    for (const line of lines) {
      const match = line.match(/127\.0\.0\.1:(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
    return null;
  } catch {
    return null;
  }
}

/** Proxy the OAuth callback to the CLI's local HTTP server. */
export function proxyCallbackToLocalServer(
  port: number,
  code: string,
  state: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body }));
    });
    req.setTimeout(10_000, () => {
      req.destroy();
      resolve({ status: 504, body: 'Timeout proxying to CLI callback server' });
    });
    req.on('error', (err) => resolve({ status: 500, body: err.message }));
  });
}

/**
 * Wait for the `claude auth login` subprocess to exit, capturing any stdout/stderr
 * tail along the way. Used after submitting an OAuth callback so we can return a
 * truthful success/failure response instead of "ok" + a later WS surprise.
 *
 * Returns once the subprocess exits OR `timeoutMs` elapses (whichever first).
 * On timeout, the caller should report `pending` and rely on the WS broadcast
 * to deliver the final outcome.
 */
export function waitForLoginCompletion(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; tailOutput: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // Process may have already exited before we attach (fast CLI paths).
    if (proc.exitCode !== null) {
      resolve({ code: proc.exitCode, tailOutput: '', timedOut: false });
      return;
    }

    let tailOutput = '';
    const onTail = (chunk: Buffer): void => {
      tailOutput += chunk.toString();
    };
    proc.stdout?.on('data', onTail);
    proc.stderr?.on('data', onTail);

    const detach = (): void => {
      proc.stdout?.off('data', onTail);
      proc.stderr?.off('data', onTail);
    };

    const onClose = (code: number | null): void => {
      clearTimeout(timer);
      detach();
      resolve({ code, tailOutput, timedOut: false });
    };

    const timer = setTimeout(() => {
      proc.off('close', onClose);
      detach();
      resolve({ code: null, tailOutput, timedOut: true });
    }, timeoutMs);

    proc.once('close', onClose);
  });
}

export default function createClaudeAuthRoutes(deps: RouteDeps): Router {
  const { config, broadcast } = deps;
  const router = Router();

  let activeLoginProc: ChildProcess | null = null;
  let activeLoginId: string | null = null;
  let activeLoginPort: number | null = null;
  let activeLoginState: string | null = null;
  let activeLoginPasteMode: boolean = false;
  /** `mtimeMs` of ~/.claude/.credentials.json when this login attempt started (detect successful write during paste-code). */
  let credentialsMtimeAtLoginStart: number | null = null;

  const resetActiveLogin = (): void => {
    activeLoginProc = null;
    activeLoginId = null;
    activeLoginPort = null;
    activeLoginState = null;
    activeLoginPasteMode = false;
    credentialsMtimeAtLoginStart = null;
  };

  router.get('/api/config/claude-auth', async (_req: Request, res: Response) => {
    try {
      // Never call `claude auth status` here — it can hang (spawn timeout unreliable) or deadlock
      // with `auth login`. UI reads only `~/.claude/.credentials.json` (or CLAUDE_CONFIG_DIR).
      const credText = readCredentialsFileSafe();
      const parsed = parseCredentialsFileContent(credText);
      let oauthStatus: OAuthStatus = parsed.oauth;
      let tokenInfo = parsed.tokenInfo;

      if (activeLoginProc && !oauthStatus.loggedIn) {
        const now = credentialsFilesMaxMtime();
        if (
          now !== null &&
          credentialsMtimeAtLoginStart !== null &&
          now > credentialsMtimeAtLoginStart
        ) {
          oauthStatus = { loggedIn: true };
        } else if (credentialsMtimeAtLoginStart === null && credText) {
          oauthStatus = { loggedIn: true };
        }
      }

      const apiKeyConfigured = !!(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);
      const oauthTokenConfigured = !!(
        config.claudeCodeOAuthToken || process.env.CLAUDE_CODE_OAUTH_TOKEN
      );
      const oauthTokenStr =
        config.claudeCodeOAuthToken || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
      const subscriptionOAuthActive = !!(oauthStatus.loggedIn || oauthTokenConfigured);

      // Safety: clear stale process reference if the subprocess has already exited
      if (activeLoginProc && activeLoginProc.exitCode !== null) {
        console.log(
          `[claude-auth] Cleaning up stale login process (exitCode=${activeLoginProc.exitCode}, loginId=${activeLoginId})`,
        );
        resetActiveLogin();
      }
      const loginInProgress = !!activeLoginProc;

      res.json({
        oauth: oauthStatus,
        token: tokenInfo,
        apiKey: {
          configured: apiKeyConfigured,
          source: process.env.ANTHROPIC_API_KEY
            ? 'environment'
            : config.anthropicApiKey
              ? 'config'
              : null,
        },
        oauthToken: {
          configured: oauthTokenConfigured,
          source: process.env.CLAUDE_CODE_OAUTH_TOKEN
            ? 'environment'
            : config.claudeCodeOAuthToken
              ? 'config'
              : null,
          masked: oauthTokenConfigured ? `••••••••${oauthTokenStr.slice(-4)}` : null,
        },
        activeMethod: apiKeyConfigured ? 'api-key' : subscriptionOAuthActive ? 'oauth' : 'none',
        loginInProgress,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to check auth status: ${message}` });
    }
  });

  router.post('/api/config/claude-auth/login', (req: Request, res: Response) => {
    if (activeLoginProc) {
      try {
        killProcessGroup(activeLoginProc, 'SIGTERM');
      } catch {
        /* already dead */
      }
      resetActiveLogin();
    }

    const { method, email, sso } = (req.body || {}) as {
      method?: string;
      email?: string;
      sso?: boolean;
    };
    const args = ['auth', 'login'];

    if (method === 'console') {
      args.push('--console');
    }
    if (email) {
      args.push('--email', email);
    }
    if (sso) {
      args.push('--sso');
    }

    const loginId = Date.now().toString(36);
    activeLoginId = loginId;

    credentialsMtimeAtLoginStart = credentialsFilesMaxMtime();

    console.log(
      `[claude-auth] OAuth login spawn — credentials file(s): primary=${getClaudeCredentialsPath()} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? '(unset)'}`,
    );

    const proc = spawn(config.claudeBin, args, {
      cwd: getUserHome(),
      env: { ...buildSpawnEnv(config), BROWSER: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    activeLoginProc = proc;
    trackChild(proc);

    let allOutput = '';
    let urlSent = false;
    let responded = false;

    const sendUrl = (url: string): void => {
      if (responded) return;
      responded = true;
      urlSent = true;

      // Extract state from the OAuth URL for later callback proxying
      activeLoginState = extractStateFromUrl(url);
      activeLoginPasteMode = isPasteCodeMode(url);

      if (activeLoginPasteMode) {
        console.log(`[claude-auth] OAuth URL indicates paste-code mode (loginId=${loginId})`);
      }

      // Browser-redirect OAuth: detect the CLI's localhost callback server for HTTP proxy.
      // Paste-code (`code=true`): user pastes the auth code here — `lsof` may match an unrelated
      // listener on the CLI PID (ECONNREFUSED). Skip detection; POST /callback uses stdin only.
      if (!activeLoginPasteMode) {
        const detectPort = async (retries: number): Promise<void> => {
          const port = await detectCallbackPort(proc.pid!);
          if (port) {
            activeLoginPort = port;
            console.log(`[claude-auth] Detected CLI callback server on port ${port}`);
          } else if (retries > 0) {
            setTimeout(() => detectPort(retries - 1), 500);
          } else {
            console.log('[claude-auth] Could not detect CLI callback server port');
          }
        };
        detectPort(5);
      } else {
        console.log(
          `[claude-auth] Paste-code mode — skipping localhost listener detection (loginId=${loginId})`,
        );
      }

      res.json({ ok: true, loginId, oauthUrl: url, pasteMode: activeLoginPasteMode });
    };

    const onData = (chunk: Buffer): void => {
      allOutput += chunk.toString();

      if (!urlSent) {
        const url = extractOAuthUrl(allOutput);
        if (url) sendUrl(url);
      }
    };

    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);

    proc.on('close', (code, signal) => {
      if (activeLoginId === loginId) {
        resetActiveLogin();
      }

      if (!responded) {
        responded = true;
        if (code === 0) {
          res.json({
            ok: true,
            loginId,
            completed: true,
            output: 'Login completed successfully',
          });
        } else {
          res.json({
            ok: false,
            loginId,
            output: allOutput.trim() || 'Login process exited unexpectedly',
          });
        }
      } else {
        const status = code === 0 ? 'success' : 'failed';
        const tail = allOutput.trim().slice(0, 500);
        const exitInfo = status === 'failed' ? ` ${formatChildExitInfo(code, signal)}` : '';
        console.log(
          `[claude-auth] OAuth login ${status} (loginId=${loginId})${exitInfo}${status === 'failed' ? ` output: ${tail || '(empty)'}` : ''}`,
        );
        if (status === 'failed') {
          const cmd = [config.claudeBin, ...args].map((a) =>
            /\s/.test(a) ? JSON.stringify(a) : a,
          );
          console.log(
            `[claude-auth] Same login is run as: ${cmd.join(' ')}  (set claudeBin in data-dir config if wrong). If this keeps failing, run that command in a terminal or use an API key in Settings.`,
          );
        }
        if (broadcast) {
          broadcast({
            type: 'claude-auth-update',
            loginId,
            status,
            ...(status === 'failed' && {
              error:
                tail ||
                `Login process exited unexpectedly (${formatChildExitInfo(
                  code,
                  signal,
                )}). If this repeats, run the same \`claude auth login\` in a terminal or add an API key in Settings.`,
            }),
          });
        }
      }
    });

    proc.on('error', (err) => {
      if (activeLoginId === loginId) {
        resetActiveLogin();
      }
      if (!responded) {
        responded = true;
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    setTimeout(() => {
      if (!responded) {
        responded = true;
        res.json({
          ok: false,
          output: allOutput.trim() || 'Timed out waiting for OAuth URL',
        });
        try {
          killProcessGroup(proc, 'SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }, 15_000);
  });

  router.post('/api/config/claude-auth/cancel-login', (_req: Request, res: Response) => {
    if (activeLoginProc) {
      try {
        killProcessGroup(activeLoginProc, 'SIGTERM');
      } catch {
        /* already dead */
      }
      resetActiveLogin();
      res.json({ ok: true, output: 'Login cancelled' });
    } else {
      res.json({ ok: true, output: 'No login in progress' });
    }
  });

  router.post('/api/config/claude-auth/callback', async (req: Request, res: Response) => {
    const { code } = (req.body || {}) as { code?: string };
    if (!code || typeof code !== 'string') {
      return res
        .status(400)
        .json({ error: 'code is required (the authorization code from Anthropic)' });
    }

    if (!activeLoginProc) {
      return res.status(409).json({ error: 'No login in progress' });
    }

    // Extract the authorization code — user may paste just the code or a full URL containing it
    let authCode = code.trim();
    const codeFromUrl = authCode.match(/[?&]code=([^&\s]+)/);
    if (codeFromUrl) {
      authCode = decodeURIComponent(codeFromUrl[1]);
    }

    const proc = activeLoginProc;

    // Retry port detection for browser-redirect flows only (paste-code uses stdin; see sendUrl).
    if (!activeLoginPasteMode && !activeLoginPort && proc.pid) {
      activeLoginPort = await detectCallbackPort(proc.pid);
    }

    // ─── Browser redirect: HTTP proxy to CLI localhost callback server ───
    if (!activeLoginPasteMode && activeLoginPort && activeLoginState) {
      console.log(
        `[claude-auth] Proxying callback to localhost:${activeLoginPort} (state=${activeLoginState.slice(0, 8)}..., pasteMode=false)`,
      );

      let proxyResult: { status: number; body: string };
      try {
        proxyResult = await proxyCallbackToLocalServer(activeLoginPort, authCode, activeLoginState);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: `Failed to proxy callback: ${message}` });
      }
      console.log(
        `[claude-auth] Proxy response: status=${proxyResult.status} body=${(proxyResult.body || '').slice(0, 200)}`,
      );

      const proxyOk = proxyResult.status >= 200 && proxyResult.status < 400;
      const body = proxyResult.body || '';
      const proxyConnFailed =
        !proxyOk && /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT/i.test(body);

      if (proxyOk) {
        const completion = await waitForLoginCompletion(proc, 8_000);
        if (completion.timedOut) {
          return res.json({
            ok: true,
            pending: true,
            output: 'Code submitted — waiting for login to finalize (watch for status update)',
          });
        }
        if (completion.code === 0) {
          return res.json({ ok: true, output: 'Code accepted — login complete' });
        }
        return res.status(502).json({
          ok: false,
          error:
            completion.tailOutput.trim().slice(0, 500) ||
            `CLI rejected the code (exit ${completion.code ?? 'unknown'})`,
        });
      }

      if (proxyConnFailed) {
        console.log(
          `[claude-auth] Proxy unreachable (${body.slice(0, 120)}) — submitting authorization code via stdin`,
        );
      } else {
        return res.status(502).json({
          ok: false,
          error: `CLI callback returned ${proxyResult.status}: ${body || 'unknown error'}`,
        });
      }
    } else if (activeLoginPasteMode) {
      console.log('[claude-auth] Paste-code mode — submitting authorization code via stdin');
    } else {
      console.log('[claude-auth] No callback port/state — submitting authorization code via stdin');
    }

    // ─── Paste-code and fallback: write authorization code to CLI stdin ───
    try {
      const stdin = proc.stdin;
      if (stdin && !stdin.destroyed) {
        stdin.write(authCode + '\n');
        stdin.end();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Failed to submit code via stdin: ${message}` });
    }

    // Return immediately — long waits + polling would block this request and stall the UI spinner.
    // GET /claude-auth avoids `auth status` while login is active (see above); the client polls until
    // credentials show logged in or the CLI process exits.
    console.log(
      '[claude-auth] Authorization code written to stdin — returning; poll GET /claude-auth for completion',
    );
    return res.json({
      ok: true,
      pending: true,
      output: 'Code sent to Claude CLI. Completing login…',
    });
  });

  router.post('/api/config/claude-auth/api-key', (req: Request, res: Response) => {
    const { apiKey } = (req.body || {}) as { apiKey?: unknown };
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string' });
    }

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no file yet */
    }

    const mutableConfig = config as AppConfig & { anthropicApiKey: string | null };
    if (apiKey) {
      fileConfig.anthropicApiKey = apiKey;
      mutableConfig.anthropicApiKey = apiKey;
    } else {
      delete fileConfig.anthropicApiKey;
      mutableConfig.anthropicApiKey = null;
    }

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    res.json({
      ok: true,
      configured: !!apiKey,
      masked: apiKey ? `••••••••${apiKey.slice(-4)}` : null,
    });
  });

  router.post('/api/config/claude-auth/oauth-token', (req: Request, res: Response) => {
    const { oauthToken } = (req.body || {}) as { oauthToken?: unknown };
    if (oauthToken !== undefined && typeof oauthToken !== 'string') {
      return res.status(400).json({ error: 'oauthToken must be a string' });
    }

    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no file yet */
    }

    const mutableConfig = config as AppConfig & { claudeCodeOAuthToken: string | null };
    let storedToken: string | null = null;
    if (oauthToken) {
      const normalized = normalizeClaudeSetupToken(oauthToken);
      if (!normalized) {
        return res.status(400).json({ error: 'oauthToken is empty after removing whitespace' });
      }
      fileConfig.claudeCodeOAuthToken = normalized;
      mutableConfig.claudeCodeOAuthToken = normalized;
      storedToken = normalized;
    } else {
      delete fileConfig.claudeCodeOAuthToken;
      mutableConfig.claudeCodeOAuthToken = null;
    }

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    res.json({
      ok: true,
      configured: !!storedToken,
      masked: storedToken ? `••••••••${storedToken.slice(-4)}` : null,
    });
  });

  router.post('/api/config/claude-auth/validate-key', async (req: Request, res: Response) => {
    const { apiKey } = (req.body || {}) as { apiKey?: string };
    if (!apiKey) {
      return res.status(400).json({ error: 'apiKey is required' });
    }

    try {
      const { stdout, stderr, code } = await runClaude(
        config.claudeBin,
        ['--print', '--bare', '--model', 'claude-haiku-4-6', 'Reply with only the word OK'],
        {
          env: { ANTHROPIC_API_KEY: apiKey },
          timeout: 30_000,
        },
      );

      const output = stdout.trim();
      const valid = code === 0 && output.toLowerCase().includes('ok');

      res.json({
        valid,
        output: valid ? 'API key is valid' : stderr.trim() || output || 'Validation failed',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ valid: false, output: message });
    }
  });

  router.delete('/api/config/claude-auth', async (_req: Request, res: Response) => {
    try {
      const { stdout, stderr, code } = await runClaude(config.claudeBin, ['auth', 'logout']);
      res.json({
        ok: code === 0,
        output: stdout.trim() || stderr.trim() || 'Logged out',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  const cleanup = (): void => {
    if (activeLoginProc) {
      try {
        killProcessGroup(activeLoginProc, 'SIGTERM');
      } catch {
        /* already dead */
      }
      resetActiveLogin();
    }
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return router;
}
