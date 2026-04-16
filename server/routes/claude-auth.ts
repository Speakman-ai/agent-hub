import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import os from 'os';
import path from 'path';
import type { RouteDeps, AppConfig } from '../types.js';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const CREDENTIALS_PATH = path.join(HOME, '.claude', '.credentials.json');

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

function runClaude(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number } = {},
): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: HOME,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout || 15_000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d));
    proc.stderr.on('data', (d: Buffer) => (stderr += d));

    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
  });
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

/**
 * Detect the localhost port that `claude auth login` opens for its OAuth callback server.
 * NOTE: Uses `ss` which is Linux-only. On macOS, `lsof -i -P` would be needed instead.
 * This is fine for now since the server runs on EC2 (Linux).
 */
async function detectCallbackPort(pid: number): Promise<number | null> {
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

export default function createClaudeAuthRoutes(deps: RouteDeps): Router {
  const { config, broadcast } = deps;
  const router = Router();

  let activeLoginProc: ChildProcess | null = null;
  let activeLoginId: string | null = null;
  let activeLoginPort: number | null = null;
  let activeLoginState: string | null = null;
  let activeLoginPasteMode: boolean = false;

  const resetActiveLogin = (): void => {
    activeLoginProc = null;
    activeLoginId = null;
    activeLoginPort = null;
    activeLoginState = null;
    activeLoginPasteMode = false;
  };

  router.get('/api/config/claude-auth', async (_req: Request, res: Response) => {
    try {
      const { stdout, code } = await runClaude(config.claudeBin, ['auth', 'status']);
      let oauthStatus: OAuthStatus | null = null;

      if (code === 0 && stdout.trim()) {
        try {
          oauthStatus = JSON.parse(stdout.trim()) as OAuthStatus;
        } catch {
          oauthStatus = { raw: stdout.trim() };
        }
      }

      let tokenInfo: Record<string, unknown> | null = null;
      if (existsSync(CREDENTIALS_PATH)) {
        try {
          const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8')) as {
            claudeAiOauth?: CredentialsOAuth;
          };
          const oauth = creds.claudeAiOauth;
          if (oauth) {
            tokenInfo = {
              expiresAt: oauth.expiresAt,
              expired: oauth.expiresAt ? Date.now() > oauth.expiresAt : null,
              scopes: oauth.scopes || [],
              subscriptionType: oauth.subscriptionType || null,
              rateLimitTier: oauth.rateLimitTier || null,
            };
          }
        } catch {
          /* credentials file unreadable */
        }
      }

      const apiKeyConfigured = !!(config.anthropicApiKey || process.env.ANTHROPIC_API_KEY);

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
        activeMethod: apiKeyConfigured ? 'api-key' : oauthStatus?.loggedIn ? 'oauth' : 'none',
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
        activeLoginProc.kill('SIGTERM');
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

    const proc = spawn(config.claudeBin, args, {
      cwd: HOME,
      env: { ...process.env, BROWSER: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeLoginProc = proc;

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
        console.log(
          `[claude-auth] OAuth URL indicates paste-code mode — will submit code via stdin (loginId=${loginId})`,
        );
      } else {
        // Detect the local callback server port the CLI opened
        // Retry a few times since the server may start slightly after the URL is printed
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

    proc.on('close', (code) => {
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
        console.log(
          `[claude-auth] OAuth login ${status} (loginId=${loginId})${status === 'failed' ? ` output: ${allOutput.trim().slice(0, 500)}` : ''}`,
        );
        if (broadcast) {
          broadcast({
            type: 'claude-auth-update',
            loginId,
            status,
            ...(status === 'failed' && {
              error: allOutput.trim().slice(0, 500) || 'Login process exited unexpectedly',
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
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }, 15_000);
  });

  router.post('/api/config/claude-auth/cancel-login', (_req: Request, res: Response) => {
    if (activeLoginProc) {
      try {
        activeLoginProc.kill('SIGTERM');
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

    // Paste-mode: the CLI is waiting on stdin (no valid localhost callback).
    // Proxying to whatever port happens to be open would silently fail, so
    // write the code directly to the subprocess's stdin — then wait briefly
    // to observe whether the CLI accepts it (exit 0) or rejects it (exit != 0)
    // so we can report a truthful status instead of "ok" + later WS failure.
    if (activeLoginPasteMode) {
      console.log('[claude-auth] Paste-code mode — writing code to stdin');
      const proc = activeLoginProc;
      let tailOutput = '';
      const onTail = (chunk: Buffer): void => {
        tailOutput += chunk.toString();
      };
      proc.stdout?.on('data', onTail);
      proc.stderr?.on('data', onTail);
      const detachTail = (): void => {
        proc.stdout?.off('data', onTail);
        proc.stderr?.off('data', onTail);
      };

      try {
        proc.stdin?.write(authCode + '\n');
      } catch (err: unknown) {
        detachTail();
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: `Failed to submit code via stdin: ${message}` });
      }

      // Race subprocess close against a timeout. The CLI typically finishes the
      // OAuth exchange (token write + exit) within a couple of seconds; 8s is
      // generous. If it's still running past that, fall back to the WS update.
      const closeResult = await new Promise<{ code: number | null; timedOut: boolean }>(
        (resolve) => {
          const onClose = (code: number | null): void => {
            clearTimeout(timer);
            resolve({ code, timedOut: false });
          };
          const timer = setTimeout(() => {
            proc.off('close', onClose);
            resolve({ code: null, timedOut: true });
          }, 8_000);
          proc.once('close', onClose);
        },
      );
      detachTail();

      if (closeResult.timedOut) {
        // Still running — likely finishing the token exchange. Report pending
        // and let the existing WS broadcast deliver the final status.
        return res.json({
          ok: true,
          pending: true,
          output:
            'Code submitted via stdin — waiting for login to finalize (watch for status update)',
        });
      }
      if (closeResult.code === 0) {
        return res.json({ ok: true, output: 'Code accepted — login complete' });
      }
      return res.status(502).json({
        ok: false,
        error:
          tailOutput.trim().slice(0, 500) ||
          `CLI rejected the code (exit ${closeResult.code ?? 'unknown'})`,
      });
    }

    // If we don't have the port yet, try one more time
    if (!activeLoginPort && activeLoginProc.pid) {
      activeLoginPort = await detectCallbackPort(activeLoginProc.pid);
    }

    if (!activeLoginPort || !activeLoginState) {
      // Fallback: try stdin write (legacy approach, unlikely to work)
      console.log('[claude-auth] No callback port/state — falling back to stdin write');
      try {
        activeLoginProc.stdin?.write(authCode + '\n');
        return res.json({
          ok: true,
          output: 'Code submitted via stdin fallback (callback server not detected)',
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({ error: `Failed to submit code: ${message}` });
      }
    }

    try {
      console.log(
        `[claude-auth] Proxying callback to localhost:${activeLoginPort} (state=${activeLoginState.slice(0, 8)}...)`,
      );
      const result = await proxyCallbackToLocalServer(activeLoginPort, authCode, activeLoginState);
      console.log(
        `[claude-auth] Proxy response: status=${result.status} body=${(result.body || '').slice(0, 200)}`,
      );

      if (result.status >= 200 && result.status < 400) {
        res.json({ ok: true, output: 'Authorization code submitted successfully' });
      } else {
        res.status(502).json({
          ok: false,
          error: `CLI callback returned ${result.status}: ${result.body || 'unknown error'}`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to proxy callback: ${message}` });
    }
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
        activeLoginProc.kill('SIGTERM');
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
