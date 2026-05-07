import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { homedir } from 'os';
import type { RouteDeps, AppConfig } from '../types.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { detectCodexAuthMode } from '../codex-auth.js';
import {
  computeCodexUiStatus,
  extractCodexDeviceUrl,
  extractCodexDeviceUserCode,
} from '../codex-device-auth-parse.js';

const HOME = homedir();

/**
 * Codex CLI auth routes.
 *
 * Auth modes (per https://developers.openai.com/codex/noninteractive and
 * `codex login --help`):
 *   - API key: `CODEX_API_KEY` / `OPENAI_API_KEY` or persisted `codexApiKey` in config.
 *   - ChatGPT OAuth: `codex login --device-auth` (UI-driven here) or interactive `codex login`.
 */
interface CodexRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCodex(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number; cwd?: string } = {},
): Promise<CodexRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const ms = opts.timeout || 30_000;
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

let activeDeviceLoginProc: ChildProcess | null = null;
let activeDeviceLoginId: string | null = null;

export default function createCodexAuthRoutes(deps: RouteDeps): Router {
  const { config, broadcast, getCodexBin } = deps;
  const router = Router();

  const binPath = (): string => getCodexBin?.() ?? config.codexBin;

  const resetDeviceLogin = (): void => {
    activeDeviceLoginProc = null;
    activeDeviceLoginId = null;
  };

  // ── Status ───────────────────────────────────────────────────────────
  router.get('/api/config/codex-auth', (_req: Request, res: Response) => {
    const bin = binPath();
    const binaryPresent = existsSync(bin);

    const apiKeyConfigured = !!(
      config.codexApiKey ||
      process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY
    );
    const apiKeySource =
      process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY
        ? 'environment'
        : config.codexApiKey
          ? 'config'
          : null;

    const rawKey =
      config.codexApiKey || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || null;
    const masked = rawKey ? `••••••••${rawKey.slice(-4)}` : null;

    const codexHome = process.env.CODEX_HOME ?? path.join(HOME, '.codex');
    const authModeInfo = detectCodexAuthMode(codexHome);
    const chatgptOAuthFromFile = authModeInfo.present && authModeInfo.mode === 'chatgpt';
    const cliApiKeyFromFile = authModeInfo.present && authModeInfo.mode === 'apikey';

    const oauthLoggedIn: boolean | null = !binaryPresent ? null : chatgptOAuthFromFile;

    const loginInProgress = !!activeDeviceLoginProc;
    const uiStatus = computeCodexUiStatus({
      binaryPresent,
      loginInProgress,
      apiKeyConfigured,
      chatgptOAuthFromFile,
      cliApiKeyFromFile,
    });

    let activeMethod: 'api-key' | 'oauth' | 'none' = 'none';
    if (apiKeyConfigured) activeMethod = 'api-key';
    else if (cliApiKeyFromFile) activeMethod = 'api-key';
    else if (chatgptOAuthFromFile) activeMethod = 'oauth';

    res.json({
      uiStatus,
      binary: { present: binaryPresent, path: bin },
      apiKey: {
        configured: apiKeyConfigured,
        source: apiKeySource,
        masked,
      },
      activeMethod,
      oauth: {
        loggedIn: oauthLoggedIn,
        mode: binaryPresent ? authModeInfo.mode : null,
        authJsonPath: binaryPresent ? authModeInfo.path : null,
      },
      loginInProgress,
      statusError: binaryPresent
        ? null
        : `Codex CLI binary not found at ${bin}. Set codexBin in Settings → General.`,
    });
  });

  // ── ChatGPT device login (headless-friendly) ─────────────────────────
  router.post('/api/config/codex-auth/device-login', (_req: Request, res: Response) => {
    if (activeDeviceLoginProc) {
      try {
        killProcessGroup(activeDeviceLoginProc, 'SIGTERM');
      } catch {
        /* ignore */
      }
      resetDeviceLogin();
    }

    const bin = binPath();
    if (!existsSync(bin)) {
      return res.status(400).json({ ok: false, error: `Codex binary not found at ${bin}` });
    }

    const loginId = Date.now().toString(36);
    activeDeviceLoginId = loginId;

    const proc = spawn(bin, ['login', '--device-auth'], {
      cwd: HOME,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);
    activeDeviceLoginProc = proc;
    trackChild(proc);

    let allOutput = '';
    let responded = false;

    const trySend = (): void => {
      if (responded) return;
      const url = extractCodexDeviceUrl(allOutput);
      const userCode = extractCodexDeviceUserCode(allOutput);
      if (url && userCode) {
        responded = true;
        res.json({ ok: true, loginId, deviceAuthUrl: url, userCode });
      }
    };

    const onData = (chunk: Buffer): void => {
      allOutput += chunk.toString();
      trySend();
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('close', (code) => {
      if (activeDeviceLoginId === loginId) {
        resetDeviceLogin();
      }

      if (!responded) {
        responded = true;
        res.json({
          ok: false,
          loginId,
          output: allOutput.trim() || `Device login exited with code ${code}`,
        });
      } else if (broadcast) {
        const status = code === 0 ? 'success' : 'failed';
        broadcast({
          type: 'codex-auth-update',
          loginId,
          status,
          ...(status === 'failed' && {
            error: allOutput.trim().slice(0, 500) || 'Device login failed',
          }),
        });
      }
    });

    proc.on('error', (err) => {
      if (activeDeviceLoginId === loginId) resetDeviceLogin();
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
          output: allOutput.trim() || 'Timed out waiting for Codex device code',
        });
        try {
          killProcessGroup(proc, 'SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }, 45_000);
  });

  router.post('/api/config/codex-auth/cancel-login', (_req: Request, res: Response) => {
    if (activeDeviceLoginProc) {
      try {
        killProcessGroup(activeDeviceLoginProc, 'SIGTERM');
      } catch {
        /* ignore */
      }
      resetDeviceLogin();
      res.json({ ok: true, output: 'Device login cancelled' });
    } else {
      res.json({ ok: true, output: 'No device login in progress' });
    }
  });

  // ── Set / clear API key ──────────────────────────────────────────────
  router.post('/api/config/codex-auth/api-key', (req: Request, res: Response) => {
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

    const mutableConfig = config as AppConfig & { codexApiKey: string | null };
    if (apiKey) {
      fileConfig.codexApiKey = apiKey;
      mutableConfig.codexApiKey = apiKey;
    } else {
      delete fileConfig.codexApiKey;
      mutableConfig.codexApiKey = null;
    }

    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    res.json({
      ok: true,
      configured: !!apiKey,
      masked: apiKey ? `••••••••${(apiKey as string).slice(-4)}` : null,
    });
  });

  // ── Validate API key against the CLI ─────────────────────────────────
  router.post('/api/config/codex-auth/validate-key', async (req: Request, res: Response) => {
    const { apiKey } = (req.body || {}) as { apiKey?: string };
    if (!apiKey) {
      return res.status(400).json({ error: 'apiKey is required' });
    }

    const bin = binPath();

    try {
      const { stdout, stderr, code } = await runCodex(
        bin,
        [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          'Reply with only the word OK',
        ],
        {
          env: { OPENAI_API_KEY: apiKey, CODEX_API_KEY: apiKey },
          timeout: 30_000,
        },
      );

      const combined = stdout + '\n' + stderr;
      const looksAuthFailed = /401|unauthorized|missing bearer|invalid api key/i.test(combined);
      const valid = code === 0 && !looksAuthFailed;

      res.json({
        valid,
        output: valid ? 'API key is valid' : stderr.trim() || stdout.trim() || 'Validation failed',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ valid: false, output: message });
    }
  });

  // ── Clear API key + CLI OAuth cache ───────────────────────────────────
  router.delete('/api/config/codex-auth', async (_req: Request, res: Response) => {
    const configPath = path.join(config.dataDir, 'config.json');
    let fileConfig: Record<string, unknown> = {};
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      /* no file yet */
    }

    delete fileConfig.codexApiKey;
    const mutableConfig = config as AppConfig & { codexApiKey: string | null };
    mutableConfig.codexApiKey = null;
    writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf-8');

    const bin = binPath();
    const parts: string[] = ['Codex API key cleared from Agent Hub config'];
    if (existsSync(bin)) {
      const { stdout, stderr, code } = await runCodex(bin, ['logout'], {
        cwd: HOME,
        timeout: 60_000,
      });
      const msg = (stdout + stderr).trim();
      if (msg) parts.unshift(msg);
      if (code !== 0 && !/not logged in|Successfully logged out/i.test(msg)) {
        parts.push(
          `codex logout exited with code ${code} — run codex logout on the host if OAuth persists`,
        );
      }
    }

    res.json({ ok: true, output: parts.join(' — ') });
  });

  return router;
}
