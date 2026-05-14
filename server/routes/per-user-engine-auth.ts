/**
 * Per-user "Sign in with browser" routes for Cursor Agent + Codex CLIs.
 *
 * Mirrors the host-wide endpoints in `cursor-auth.ts` / `codex-auth.ts`
 * but pins the spawned login process at a per-user HOME so each Hub
 * user can sign in under their own account. The HOME pin uses the same
 * `<dataDir>/per-user-creds/<userId>/home` layout that
 * `buildSpawnEnv({ userId })` already plumbs through every other spawn
 * site — so once a user signs in here, every downstream agent spawn
 * owned by that user shares the cache.
 *
 * Routes
 *   GET    /api/auth/me/cursor-auth/browser              status
 *   POST   /api/auth/me/cursor-auth/browser/login        start OAuth
 *   POST   /api/auth/me/cursor-auth/browser/cancel-login cancel
 *   DELETE /api/auth/me/cursor-auth/browser              wipe ~/.cursor cache
 *
 *   GET    /api/auth/me/codex-auth/browser               status
 *   POST   /api/auth/me/codex-auth/browser/device-login  start device auth
 *   POST   /api/auth/me/codex-auth/browser/cancel-login  cancel
 *   DELETE /api/auth/me/codex-auth/browser               wipe ~/.codex cache
 *
 * Auth: every endpoint requires an authenticated caller. We never
 * accept a `userId` query/body — the active caller's id (from
 * `authedReq.authUserId`) is the only addressable identity, which
 * keeps Admin A from clobbering Admin B's cache.
 */
import { Router, type Request, type Response } from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { RouteDeps } from '../types.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import {
  extractCursorLoginUrl,
  parseCursorStatusJson,
  computeCursorUiStatus,
} from '../cursor-auth-parse.js';
import {
  computeCodexUiStatus,
  extractCodexDeviceUrl,
  extractCodexDeviceUserCode,
} from '../codex-device-auth-parse.js';
import { detectCodexAuthMode } from '../codex-auth.js';
import { ensurePerUserHome, perUserHomePath, clearPerUserCliCache } from '../per-user-home.js';
import type { AuthenticatedRequest } from '../auth.js';
import { registerPath, z } from '../openapi/registry.js';
import { ErrorResponse } from '../openapi/schemas/auth.js';

// ── OpenAPI registrations ──────────────────────────────────────────────
const PerUserCursorStatus = z.object({
  uiStatus: z.string(),
  binary: z.object({ present: z.boolean(), path: z.string() }),
  oauth: z.object({
    loggedIn: z.boolean().nullable(),
    email: z.string().nullable().optional(),
  }),
  loginInProgress: z.boolean(),
  activeMethod: z.enum(['oauth', 'none']),
  statusError: z.string().nullable(),
});

const PerUserCursorLoginResponse = z.object({
  ok: z.boolean(),
  loginId: z.string().optional(),
  loginUrl: z.string().optional(),
  completed: z.boolean().optional(),
  output: z.string().optional(),
});

const PerUserCodexStatus = z.object({
  uiStatus: z.string(),
  binary: z.object({ present: z.boolean(), path: z.string() }),
  oauth: z.object({
    loggedIn: z.boolean().nullable(),
    mode: z.string().nullable().optional(),
    authJsonPath: z.string().nullable().optional(),
  }),
  loginInProgress: z.boolean(),
  activeMethod: z.enum(['oauth', 'none']),
  statusError: z.string().nullable(),
});

const PerUserCodexLoginResponse = z.object({
  ok: z.boolean(),
  loginId: z.string().optional(),
  deviceAuthUrl: z.string().optional(),
  userCode: z.string().optional(),
  output: z.string().optional(),
});

const CancelResponse = z.object({ ok: z.literal(true), output: z.string() });
const DeleteResponse = z.object({ ok: z.literal(true), output: z.string() });

registerPath({
  method: 'get',
  path: '/api/auth/me/cursor-auth/browser',
  tags: ['Auth'],
  summary: 'Per-user Cursor "Sign in with browser" status.',
  responses: {
    200: {
      description: 'Caller-scoped Cursor OAuth state.',
      content: { 'application/json': { schema: PerUserCursorStatus } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/me/cursor-auth/browser/login',
  tags: ['Auth'],
  summary: 'Start a per-user Cursor OAuth login.',
  responses: {
    200: {
      description: 'Login URL emitted by cursor-agent or login result.',
      content: { 'application/json': { schema: PerUserCursorLoginResponse } },
    },
    400: {
      description: 'Cursor binary missing.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/me/cursor-auth/browser/cancel-login',
  tags: ['Auth'],
  summary: 'Cancel an in-progress per-user Cursor login.',
  responses: {
    200: {
      description: 'Cancellation receipt.',
      content: { 'application/json': { schema: CancelResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/me/cursor-auth/browser',
  tags: ['Auth'],
  summary: 'Sign the per-user Cursor cache out (wipe ~/.cursor).',
  responses: {
    200: {
      description: 'Cache cleared.',
      content: { 'application/json': { schema: DeleteResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'get',
  path: '/api/auth/me/codex-auth/browser',
  tags: ['Auth'],
  summary: 'Per-user Codex "Sign in with ChatGPT" status.',
  responses: {
    200: {
      description: 'Caller-scoped Codex OAuth state.',
      content: { 'application/json': { schema: PerUserCodexStatus } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/me/codex-auth/browser/device-login',
  tags: ['Auth'],
  summary: 'Start a per-user Codex device-auth (ChatGPT) login.',
  responses: {
    200: {
      description: 'Device code emitted or login outcome.',
      content: { 'application/json': { schema: PerUserCodexLoginResponse } },
    },
    400: {
      description: 'Codex binary missing.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/me/codex-auth/browser/cancel-login',
  tags: ['Auth'],
  summary: 'Cancel an in-progress per-user Codex device login.',
  responses: {
    200: {
      description: 'Cancellation receipt.',
      content: { 'application/json': { schema: CancelResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/me/codex-auth/browser',
  tags: ['Auth'],
  summary: 'Sign the per-user Codex cache out (wipe ~/.codex).',
  responses: {
    200: {
      description: 'Cache cleared.',
      content: { 'application/json': { schema: DeleteResponse } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

// ── Helpers ────────────────────────────────────────────────────────────
interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(
  bin: string,
  args: string[],
  opts: { home: string; timeout?: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: opts.home,
      env: { ...process.env, HOME: opts.home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const ms = opts.timeout ?? 25_000;
    const timer = setTimeout(() => killProcessGroup(proc, 'SIGTERM'), ms);

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => (stdout += d));
    proc.stderr?.on('data', (d: Buffer) => (stderr += d));

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

function requireAuthUserId(req: Request, res: Response): string | null {
  const authedReq = req as AuthenticatedRequest;
  if (!authedReq.authUserId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return authedReq.authUserId;
}

// Per-user in-flight login tracker. Keyed by `${engine}:${userId}` so
// two users can be in the middle of a login simultaneously without
// stomping each other (unlike the host-wide singletons in cursor-auth.ts
// / codex-auth.ts where there's one shared operator).
type LoginRecord = { proc: ChildProcess; loginId: string };
const activeLogins = new Map<string, LoginRecord>();
const loginKey = (engine: 'cursor' | 'codex', userId: string): string => `${engine}:${userId}`;

function cancelLogin(engine: 'cursor' | 'codex', userId: string): boolean {
  const key = loginKey(engine, userId);
  const rec = activeLogins.get(key);
  if (!rec) return false;
  try {
    killProcessGroup(rec.proc, 'SIGTERM');
  } catch {
    /* already dead */
  }
  activeLogins.delete(key);
  return true;
}

// ── Router factory ─────────────────────────────────────────────────────
export default function createPerUserEngineAuthRoutes(deps: RouteDeps): Router {
  const { config, broadcast, getCursorBin, getCodexBin } = deps;
  const router = Router();

  const cursorBinPath = (): string => getCursorBin?.() ?? config.cursorBin;
  const codexBinPath = (): string => getCodexBin?.() ?? config.codexBin;

  // ── Cursor ──────────────────────────────────────────────────────────
  router.get('/api/auth/me/cursor-auth/browser', async (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const bin = cursorBinPath();
    const binaryPresent = existsSync(bin);
    const loginInProgress = activeLogins.has(loginKey('cursor', userId));

    if (!binaryPresent) {
      return res.json({
        uiStatus: computeCursorUiStatus({
          binaryPresent: false,
          loginInProgress,
          isAuthenticated: false,
        }),
        binary: { present: false, path: bin },
        oauth: { loggedIn: false, email: null },
        loginInProgress,
        activeMethod: 'none' as const,
        statusError: `Cursor Agent binary not found at ${bin}`,
      });
    }

    if (loginInProgress) {
      return res.json({
        uiStatus: 'pending',
        binary: { present: true, path: bin },
        oauth: { loggedIn: null as boolean | null, email: null },
        loginInProgress: true,
        activeMethod: 'none' as const,
        statusError: null,
      });
    }

    let home: string;
    try {
      home = ensurePerUserHome(userId, config.dataDir);
    } catch (err) {
      return res.json({
        uiStatus: 'error',
        binary: { present: true, path: bin },
        oauth: { loggedIn: false, email: null },
        loginInProgress: false,
        activeMethod: 'none' as const,
        statusError: (err as Error).message,
      });
    }

    const { stdout, stderr, code } = await runCli(bin, ['status', '--format', 'json'], {
      home,
    });
    const parsed = parseCursorStatusJson(stdout, stderr);
    const isAuthenticated = parsed.ok && parsed.isAuthenticated;
    const uiStatus = computeCursorUiStatus({
      binaryPresent: true,
      loginInProgress: false,
      isAuthenticated,
    });

    res.json({
      uiStatus,
      binary: { present: true, path: bin },
      oauth: { loggedIn: isAuthenticated, email: parsed.email ?? null },
      loginInProgress: false,
      activeMethod: isAuthenticated ? ('oauth' as const) : ('none' as const),
      statusError:
        code !== 0 || !parsed.ok
          ? parsed.error || stderr.trim() || stdout.trim() || `cursor-agent status exited ${code}`
          : null,
    });
  });

  router.post('/api/auth/me/cursor-auth/browser/login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    cancelLogin('cursor', userId);

    const bin = cursorBinPath();
    if (!existsSync(bin)) {
      return res.status(400).json({ ok: false, error: `Cursor Agent binary not found at ${bin}` });
    }

    let home: string;
    try {
      home = ensurePerUserHome(userId, config.dataDir);
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    const loginId = Date.now().toString(36);
    const proc = spawn(bin, ['login'], {
      cwd: home,
      env: { ...process.env, HOME: home, NO_OPEN_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);
    activeLogins.set(loginKey('cursor', userId), { proc, loginId });

    let allOutput = '';
    let urlSent = false;
    let responded = false;

    const sendUrl = (url: string): void => {
      if (responded) return;
      responded = true;
      urlSent = true;
      res.json({ ok: true, loginId, loginUrl: url });
    };

    const onData = (chunk: Buffer): void => {
      allOutput += chunk.toString();
      if (!urlSent) {
        const url = extractCursorLoginUrl(allOutput);
        if (url) sendUrl(url);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('close', (code) => {
      const key = loginKey('cursor', userId);
      const current = activeLogins.get(key);
      if (current?.loginId === loginId) activeLogins.delete(key);

      if (!responded) {
        responded = true;
        if (code === 0) {
          res.json({
            ok: true,
            loginId,
            completed: true,
            output: allOutput.trim() || 'Login completed',
          });
        } else {
          res.json({
            ok: false,
            loginId,
            output: allOutput.trim() || 'Login process exited unexpectedly',
          });
        }
      } else if (urlSent) {
        const status = code === 0 ? 'success' : 'failed';
        if (broadcast) {
          broadcast({
            type: 'per-user-cursor-auth-update',
            userId,
            loginId,
            status,
            ...(status === 'failed' && {
              error: allOutput.trim().slice(0, 500) || 'Login failed',
            }),
          });
        }
      }
    });

    proc.on('error', (err) => {
      const key = loginKey('cursor', userId);
      const current = activeLogins.get(key);
      if (current?.loginId === loginId) activeLogins.delete(key);
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
          output: allOutput.trim() || 'Timed out waiting for login URL from cursor-agent',
        });
        try {
          killProcessGroup(proc, 'SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }, 20_000);
  });

  router.post('/api/auth/me/cursor-auth/browser/cancel-login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const cancelled = cancelLogin('cursor', userId);
    res.json({ ok: true, output: cancelled ? 'Login cancelled' : 'No login in progress' });
  });

  router.delete('/api/auth/me/cursor-auth/browser', async (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    // Best-effort: ask the CLI to logout cleanly (so any server-side
    // refresh token is invalidated) before nuking the cache directory.
    const bin = cursorBinPath();
    let cliOutput = '';
    if (existsSync(bin)) {
      try {
        const home = perUserHomePath(userId, config.dataDir);
        if (existsSync(home)) {
          const result = await runCli(bin, ['logout'], { home, timeout: 30_000 });
          cliOutput = (result.stdout + result.stderr).trim();
        }
      } catch {
        /* ignore — proceed to local wipe regardless */
      }
    }

    try {
      clearPerUserCliCache(userId, config.dataDir, '.cursor');
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    const summary = [cliOutput, 'Per-user Cursor cache cleared'].filter(Boolean).join(' — ');
    res.json({ ok: true, output: summary });
  });

  // ── Codex ───────────────────────────────────────────────────────────
  router.get('/api/auth/me/codex-auth/browser', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const bin = codexBinPath();
    const binaryPresent = existsSync(bin);
    const loginInProgress = activeLogins.has(loginKey('codex', userId));

    let home: string;
    try {
      home = ensurePerUserHome(userId, config.dataDir);
    } catch (err) {
      return res.json({
        uiStatus: 'error',
        binary: { present: binaryPresent, path: bin },
        oauth: { loggedIn: false, mode: null, authJsonPath: null },
        loginInProgress,
        activeMethod: 'none' as const,
        statusError: (err as Error).message,
      });
    }

    const codexHome = path.join(home, '.codex');
    const authModeInfo = detectCodexAuthMode(codexHome);
    const chatgptOAuth = authModeInfo.present && authModeInfo.mode === 'chatgpt';
    const oauthLoggedIn: boolean | null = !binaryPresent ? null : chatgptOAuth;

    const uiStatus = computeCodexUiStatus({
      binaryPresent,
      loginInProgress,
      apiKeyConfigured: false,
      chatgptOAuthFromFile: chatgptOAuth,
      cliApiKeyFromFile: false,
    });

    res.json({
      uiStatus,
      binary: { present: binaryPresent, path: bin },
      oauth: {
        loggedIn: oauthLoggedIn,
        mode: binaryPresent ? authModeInfo.mode : null,
        authJsonPath: binaryPresent ? authModeInfo.path : null,
      },
      loginInProgress,
      activeMethod: chatgptOAuth ? ('oauth' as const) : ('none' as const),
      statusError: binaryPresent
        ? null
        : `Codex binary not found at ${bin}. Set codexBin in Settings → General.`,
    });
  });

  router.post('/api/auth/me/codex-auth/browser/device-login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    cancelLogin('codex', userId);

    const bin = codexBinPath();
    if (!existsSync(bin)) {
      return res.status(400).json({ ok: false, error: `Codex binary not found at ${bin}` });
    }

    let home: string;
    try {
      home = ensurePerUserHome(userId, config.dataDir);
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    const loginId = Date.now().toString(36);
    const proc = spawn(bin, ['login', '--device-auth'], {
      cwd: home,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);
    activeLogins.set(loginKey('codex', userId), { proc, loginId });

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
      const key = loginKey('codex', userId);
      const current = activeLogins.get(key);
      if (current?.loginId === loginId) activeLogins.delete(key);

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
          type: 'per-user-codex-auth-update',
          userId,
          loginId,
          status,
          ...(status === 'failed' && {
            error: allOutput.trim().slice(0, 500) || 'Device login failed',
          }),
        });
      }
    });

    proc.on('error', (err) => {
      const key = loginKey('codex', userId);
      const current = activeLogins.get(key);
      if (current?.loginId === loginId) activeLogins.delete(key);
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

  router.post('/api/auth/me/codex-auth/browser/cancel-login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const cancelled = cancelLogin('codex', userId);
    res.json({
      ok: true,
      output: cancelled ? 'Device login cancelled' : 'No device login in progress',
    });
  });

  router.delete('/api/auth/me/codex-auth/browser', async (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const bin = codexBinPath();
    let cliOutput = '';
    if (existsSync(bin)) {
      try {
        const home = perUserHomePath(userId, config.dataDir);
        if (existsSync(home)) {
          const result = await runCli(bin, ['logout'], { home, timeout: 60_000 });
          cliOutput = (result.stdout + result.stderr).trim();
        }
      } catch {
        /* ignore — proceed to local wipe regardless */
      }
    }

    try {
      clearPerUserCliCache(userId, config.dataDir, '.codex');
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    const summary = [cliOutput, 'Per-user Codex cache cleared'].filter(Boolean).join(' — ');
    res.json({ ok: true, output: summary });
  });

  return router;
}
