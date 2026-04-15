import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import type { RouteDeps, AppConfig } from '../types.js';

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

function extractOAuthUrl(text: string): string | null {
  const match = text.match(/visit:\s*(https:\/\/\S+)/i);
  return match ? match[1] : null;
}

export default function createClaudeAuthRoutes(deps: RouteDeps): Router {
  const { config, broadcast } = deps;
  const router = Router();

  let activeLoginProc: ChildProcess | null = null;
  let activeLoginId: string | null = null;

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
      activeLoginProc = null;
      activeLoginId = null;
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
      res.json({ ok: true, loginId, oauthUrl: url });
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
        activeLoginProc = null;
        activeLoginId = null;
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
        console.log(`[claude-auth] OAuth login ${status} (loginId=${loginId})`);
        if (broadcast) {
          broadcast({
            type: 'claude-auth-update',
            loginId,
            status,
          });
        }
      }
    });

    proc.on('error', (err) => {
      if (activeLoginId === loginId) {
        activeLoginProc = null;
        activeLoginId = null;
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
      activeLoginProc = null;
      activeLoginId = null;
      res.json({ ok: true, output: 'Login cancelled' });
    } else {
      res.json({ ok: true, output: 'No login in progress' });
    }
  });

  router.post('/api/config/claude-auth/callback', (req: Request, res: Response) => {
    const { code } = (req.body || {}) as { code?: string };
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'code is required (the URL copied from Anthropic)' });
    }

    if (!activeLoginProc || !activeLoginProc.stdin) {
      return res.status(409).json({ error: 'No login in progress' });
    }

    try {
      activeLoginProc.stdin.write(code.trim() + '\n');
      res.json({ ok: true, output: 'Callback code submitted' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to submit callback: ${message}` });
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
      activeLoginProc = null;
      activeLoginId = null;
    }
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  return router;
}
