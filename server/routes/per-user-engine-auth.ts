/**
 * Per-user "Sign in with browser" routes for Claude Code, Cursor Agent,
 * and Codex CLIs.
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
 *   GET    /api/auth/me/claude-auth/browser              status
 *   POST   /api/auth/me/claude-auth/browser/login        start OAuth
 *   POST   /api/auth/me/claude-auth/browser/cancel-login cancel
 *   DELETE /api/auth/me/claude-auth/browser              wipe ~/.claude cache
 *
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
 *   GET    /api/auth/me/grok-auth/browser                status
 *   POST   /api/auth/me/grok-auth/browser/device-login   start device auth
 *   POST   /api/auth/me/grok-auth/browser/cancel-login   cancel
 *   DELETE /api/auth/me/grok-auth/browser                wipe ~/.grok cache
 *
 * Auth: every endpoint requires an authenticated caller. We never
 * accept a `userId` query/body — the active caller's id (from
 * `authedReq.authUserId`) is the only addressable identity, which
 * keeps Admin A from clobbering Admin B's cache.
 */
import { Router, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'fs';
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
import {
  computeGrokUiStatus,
  detectGrokAuthMode,
  extractGrokDeviceUrl,
  extractGrokDeviceUserCode,
} from '../grok-device-auth-parse.js';
import { detectCodexAuthMode } from '../codex-auth.js';
import {
  computeClaudeUiStatus,
  extractClaudeLoginUrl,
  hasClaudeLoginCache,
} from '../claude-auth-parse.js';
import { ensurePerUserHome, perUserHomePath, clearPerUserCliCache } from '../per-user-home.js';
import { invalidateCursorAuthCacheForScope } from '../cursor-auth-cache.js';
import { ensurePerUserCliHome } from '../per-user-cli-home.js';
import {
  clearActiveCodexDeviceLogin,
  getActiveCodexDeviceLogin,
  setActiveCodexDeviceLogin,
} from '../per-user-codex-device-login.js';
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

const PerUserClaudeStatus = z.object({
  uiStatus: z.string(),
  binary: z.object({ present: z.boolean(), path: z.string() }),
  oauth: z.object({ loggedIn: z.boolean().nullable() }),
  loginInProgress: z.boolean(),
  activeMethod: z.enum(['oauth', 'none']),
  statusError: z.string().nullable(),
});

const PerUserClaudeLoginResponse = z.object({
  ok: z.boolean(),
  loginId: z.string().optional(),
  loginUrl: z.string().optional(),
  completed: z.boolean().optional(),
  output: z.string().optional(),
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
  path: '/api/auth/me/claude-auth/browser',
  tags: ['Auth'],
  summary: 'Per-user Claude Code browser-login status.',
  responses: {
    200: {
      description: 'Caller-scoped Claude Code OAuth state.',
      content: { 'application/json': { schema: PerUserClaudeStatus } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/me/claude-auth/browser/login',
  tags: ['Auth'],
  summary: 'Start a per-user Claude Code browser login.',
  responses: {
    200: {
      description: 'Login URL emitted by Claude Code or login result.',
      content: { 'application/json': { schema: PerUserClaudeLoginResponse } },
    },
    400: {
      description: 'Claude Code binary missing.',
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
  path: '/api/auth/me/claude-auth/browser/cancel-login',
  tags: ['Auth'],
  summary: 'Cancel an in-progress per-user Claude Code login.',
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
  path: '/api/auth/me/claude-auth/browser',
  tags: ['Auth'],
  summary: 'Sign the per-user Claude Code cache out.',
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

// ── P4: per-user Codex device-login (engine-isolated CODEX_HOME) ──────
//
// These supersede the `/browser/device-login` shape above for the Codex
// engine. Instead of HOME-pinning the whole spawn we set `CODEX_HOME`
// so the cache lands in a per-engine, per-user subtree at
// `<dataDir>/per-user-cli-home/codex/<userId>` (see per-user-cli-home.ts).
// The matching `buildSpawnEnv` extension reads the same path so every
// downstream spawn owned by the user inherits the same auth.
registerPath({
  method: 'post',
  path: '/api/auth/me/codex-auth/login',
  tags: ['Auth'],
  summary: 'Start a per-user Codex ChatGPT device-auth login (CODEX_HOME isolation).',
  responses: {
    200: {
      description: 'Device code emitted, or login completed/failed.',
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
  path: '/api/auth/me/codex-auth/login/cancel',
  tags: ['Auth'],
  summary: 'Cancel the active per-user Codex device-auth login.',
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

// ── Grok (xAI Grok Build CLI) ───────────────────────────────────────────
//
// Mirrors the legacy Codex `/browser/device-login` shape: `grok login
// --device-auth` prints a verification URL + short code, and the resulting
// token caches at `$HOME/.grok/auth.json`. Because the grok CLI has no
// dedicated home env var (it reads `$HOME/.grok`) and every session spawn
// already pins HOME to the acting user's per-user tree, signing in here makes
// the OAuth token visible to every downstream grok spawn the user owns — no
// extra spawn-env wiring required. The CLI prefers its cached token over the
// `XAI_API_KEY` env var, so OAuth is preferred over a pasted key automatically.
const PerUserGrokStatus = z.object({
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

const PerUserGrokLoginResponse = z.object({
  ok: z.boolean(),
  loginId: z.string().optional(),
  deviceAuthUrl: z.string().optional(),
  userCode: z.string().optional(),
  output: z.string().optional(),
});

registerPath({
  method: 'get',
  path: '/api/auth/me/grok-auth/browser',
  tags: ['Auth'],
  summary: 'Per-user Grok "Sign in with browser" status.',
  responses: {
    200: {
      description: 'Caller-scoped Grok OAuth state.',
      content: { 'application/json': { schema: PerUserGrokStatus } },
    },
    401: {
      description: 'Not authenticated.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/me/grok-auth/browser/device-login',
  tags: ['Auth'],
  summary: 'Start a per-user Grok device-auth (xAI) login.',
  responses: {
    200: {
      description: 'Device code emitted or login outcome.',
      content: { 'application/json': { schema: PerUserGrokLoginResponse } },
    },
    400: {
      description: 'Grok binary missing.',
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
  path: '/api/auth/me/grok-auth/browser/cancel-login',
  tags: ['Auth'],
  summary: 'Cancel an in-progress per-user Grok device login.',
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
  path: '/api/auth/me/grok-auth/browser',
  tags: ['Auth'],
  summary: 'Sign the per-user Grok cache out (wipe ~/.grok).',
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
  opts: { home: string; timeout?: number; extraEnv?: Record<string, string> } = {
    home: '',
  },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: opts.home,
      env: { ...process.env, HOME: opts.home, ...(opts.extraEnv ?? {}) },
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
const loginKey = (engine: 'claude' | 'cursor' | 'codex' | 'grok', userId: string): string =>
  `${engine}:${userId}`;

function cancelLogin(engine: 'claude' | 'cursor' | 'codex' | 'grok', userId: string): boolean {
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

/**
 * Cancel any in-flight P4 (`/codex-auth/login`) device login for the
 * given user. Mirrors `cancelLogin('codex', userId)` for the legacy
 * `/browser/device-login` flow — the two flows write to different
 * on-disk locations but share the same OpenAI device-code endpoint, so
 * letting both run concurrently risks invalidating each other's codes.
 */
function cancelP4CodexLogin(userId: string): boolean {
  const rec = getActiveCodexDeviceLogin(userId);
  if (!rec) return false;
  try {
    killProcessGroup(rec.proc, 'SIGTERM');
  } catch {
    /* already dead */
  }
  clearActiveCodexDeviceLogin(userId);
  return true;
}

// ── Router factory ─────────────────────────────────────────────────────
export default function createPerUserEngineAuthRoutes(deps: RouteDeps): Router {
  const { config, broadcast, getCursorBin, getCodexBin, getGrokBin } = deps;
  const router = Router();

  const cursorBinPath = (): string => getCursorBin?.() ?? config.cursorBin;
  const codexBinPath = (): string => getCodexBin?.() ?? config.codexBin;
  const grokBinPath = (): string => getGrokBin?.() ?? config.grokBin;
  const claudeBinPath = (): string => deps.getClaudeBin?.() ?? config.claudeBin;

  // ── Claude Code ─────────────────────────────────────────────────────
  // Claude Code stores browser-login credentials at
  // `$HOME/.claude/.credentials.json`. Keep the process HOME pinned to the
  // same per-user tree used by buildSpawnEnv so a mobile login is immediately
  // usable by sessions owned by that Hub user.
  router.get('/api/auth/me/claude-auth/browser', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const bin = claudeBinPath();
    const binaryPresent = existsSync(bin);
    const loginInProgress = activeLogins.has(loginKey('claude', userId));
    let home: string;
    try {
      home = ensurePerUserHome(userId, config.dataDir);
    } catch (err) {
      return res.json({
        uiStatus: 'missing',
        binary: { present: binaryPresent, path: bin },
        oauth: { loggedIn: false },
        loginInProgress,
        activeMethod: 'none' as const,
        statusError: (err as Error).message,
      });
    }

    const authenticated = hasClaudeLoginCache(home, (credentialPath) =>
      readFileSync(credentialPath, 'utf8'),
    );
    res.json({
      uiStatus: computeClaudeUiStatus({ binaryPresent, loginInProgress, authenticated }),
      binary: { present: binaryPresent, path: bin },
      oauth: { loggedIn: binaryPresent ? authenticated : null },
      loginInProgress,
      activeMethod: binaryPresent && authenticated ? ('oauth' as const) : ('none' as const),
      statusError: binaryPresent ? null : `Claude Code binary not found at ${bin}`,
    });
  });

  router.post('/api/auth/me/claude-auth/browser/login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    cancelLogin('claude', userId);

    const bin = claudeBinPath();
    if (!existsSync(bin)) {
      return res.status(400).json({ ok: false, error: `Claude Code binary not found at ${bin}` });
    }

    let home: string;
    try {
      home = ensurePerUserHome(userId, config.dataDir);
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    const loginId = Date.now().toString(36);
    const proc = spawn(bin, [], {
      cwd: home,
      env: { ...process.env, HOME: home, NO_OPEN_BROWSER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    proc.stdin?.write('/login\n');
    trackChild(proc);
    activeLogins.set(loginKey('claude', userId), { proc, loginId });

    let allOutput = '';
    let responded = false;
    let urlSent = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const clearLoginTimeout = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };
    const sendUrl = (url: string): void => {
      if (responded) return;
      responded = true;
      urlSent = true;
      clearLoginTimeout();
      res.json({ ok: true, loginId, loginUrl: url });
    };
    const onData = (chunk: Buffer): void => {
      allOutput += chunk.toString();
      const url = extractClaudeLoginUrl(allOutput);
      if (url) sendUrl(url);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('close', (code) => {
      clearLoginTimeout();
      const key = loginKey('claude', userId);
      const current = activeLogins.get(key);
      if (current?.loginId === loginId) activeLogins.delete(key);
      const authenticated = hasClaudeLoginCache(home, (credentialPath) =>
        readFileSync(credentialPath, 'utf8'),
      );
      if (!responded) {
        responded = true;
        res.json(
          code === 0 && authenticated
            ? { ok: true, loginId, completed: true, output: allOutput.trim() || 'Login completed' }
            : {
                ok: false,
                loginId,
                output:
                  allOutput.trim() ||
                  (code === 0
                    ? 'Login process exited without valid Claude credentials'
                    : 'Login process exited unexpectedly'),
              },
        );
      } else if (urlSent && broadcast) {
        broadcast({
          type: 'per-user-claude-auth-update',
          userId,
          loginId,
          status: authenticated ? 'success' : 'failed',
          ...(!authenticated && {
            error:
              allOutput.trim().slice(0, 500) ||
              (code === 0
                ? 'Login process exited without valid Claude credentials'
                : 'Login failed'),
          }),
        });
      }
    });
    proc.on('error', (err) => {
      clearLoginTimeout();
      const key = loginKey('claude', userId);
      const current = activeLogins.get(key);
      if (current?.loginId === loginId) activeLogins.delete(key);
      if (!responded) {
        responded = true;
        res.status(500).json({ ok: false, error: err.message });
      }
    });
    timeoutHandle = setTimeout(() => {
      if (responded) return;
      responded = true;
      activeLogins.delete(loginKey('claude', userId));
      res.json({ ok: false, output: allOutput.trim() || 'Timed out waiting for Claude login URL' });
      try {
        killProcessGroup(proc, 'SIGTERM');
      } catch {
        /* ignore */
      }
    }, 20_000);
  });

  router.post('/api/auth/me/claude-auth/browser/cancel-login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const cancelled = cancelLogin('claude', userId);
    res.json({ ok: true, output: cancelled ? 'Login cancelled' : 'No login in progress' });
  });

  router.delete('/api/auth/me/claude-auth/browser', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    cancelLogin('claude', userId);
    try {
      clearPerUserCliCache(userId, config.dataDir, '.claude');
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }
    res.json({ ok: true, output: 'Per-user Claude Code cache cleared' });
  });

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
      // Prefer file-backed credentials under the pinned per-user HOME so
      // Firecracker guests can sync `$HOME/.cursor/auth.json` /
      // `cli-config.json`. Keychain-only login looks "authenticated" on the
      // Hub host probe but never reaches the session VM.
      env: {
        ...process.env,
        HOME: home,
        NO_OPEN_BROWSER: '1',
        AGENT_CLI_CREDENTIAL_STORE: 'file',
      },
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

      // Drop ONLY this user's cached `cursor-agent status` entry so the
      // next models-poll re-probes their HOME against the freshly-written
      // cache. A full `invalidateCursorAuthCache()` would also wipe every
      // other user's valid `authenticated=true` answer and force them
      // through a spurious probe round-trip — bad neighbours behavior on
      // multi-tenant installs. The host-level cursor-auth route still
      // does a full clear because its bin path change can shadow every
      // entry; here the scope is exactly one user.
      invalidateCursorAuthCacheForScope(bin, `uid:${userId}`);

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
    // Also clobber any in-flight P4 (`/codex-auth/login`) attempt for
    // this user so we never have two `codex login --device-auth`
    // processes racing on the same identity (different on-disk caches
    // but identical OAuth device codes upstream).
    cancelP4CodexLogin(userId);

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

  // ── P4: per-user Codex device-login (CODEX_HOME isolated tree) ──────
  router.post('/api/auth/me/codex-auth/login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    // Replace any in-flight login for this user — the user clicked
    // "Login" a second time, treat the new attempt as authoritative.
    const existing = getActiveCodexDeviceLogin(userId);
    if (existing) {
      try {
        killProcessGroup(existing.proc, 'SIGTERM');
      } catch {
        /* ignore */
      }
      clearActiveCodexDeviceLogin(userId);
    }
    // Also clobber any in-flight legacy (`/browser/device-login`)
    // attempt for this user so we never have two `codex login
    // --device-auth` processes racing on the same identity.
    cancelLogin('codex', userId);

    const bin = codexBinPath();
    if (!existsSync(bin)) {
      return res.status(400).json({ ok: false, error: `Codex binary not found at ${bin}` });
    }

    // Carve the per-engine, per-user CODEX_HOME on demand. Mode 0700 +
    // ownership guard inside `ensurePerUserCliHome`.
    let codexHome: string;
    try {
      codexHome = ensurePerUserCliHome('codex', userId, config.dataDir);
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    const loginId = Date.now().toString(36);
    const proc = spawn(bin, ['login', '--device-auth'], {
      // `cwd` is intentionally `codexHome` so any auxiliary files (eg.
      // verifier state) the CLI writes relative to its working dir also
      // land in the per-user tree.
      cwd: codexHome,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);
    setActiveCodexDeviceLogin(userId, { proc, loginId });

    let allOutput = '';
    let responded = false;

    // Capture the 45 s timeout so close / error paths can release the
    // closure (which otherwise pins `proc` and `res` in memory for the
    // full window). Matches the `runCli` helper's pattern.
    let timeoutHandle: NodeJS.Timeout | null = null;
    const clearLoginTimeout = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const trySend = (): void => {
      if (responded) return;
      const url = extractCodexDeviceUrl(allOutput);
      const userCode = extractCodexDeviceUserCode(allOutput);
      if (url && userCode) {
        responded = true;
        clearLoginTimeout();
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
      clearLoginTimeout();
      clearActiveCodexDeviceLogin(userId, loginId);

      if (!responded) {
        responded = true;
        if (code === 0) {
          res.json({
            ok: true,
            loginId,
            output: allOutput.trim() || 'Device login completed',
          });
        } else {
          res.json({
            ok: false,
            loginId,
            output: allOutput.trim() || `Device login exited with code ${code}`,
          });
        }
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
      clearLoginTimeout();
      clearActiveCodexDeviceLogin(userId, loginId);
      if (!responded) {
        responded = true;
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
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

  router.post('/api/auth/me/codex-auth/login/cancel', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const rec = getActiveCodexDeviceLogin(userId);
    if (!rec) {
      return res.json({ ok: true, output: 'No device login in progress' });
    }
    try {
      killProcessGroup(rec.proc, 'SIGTERM');
    } catch {
      /* already dead */
    }
    clearActiveCodexDeviceLogin(userId);
    res.json({ ok: true, output: 'Device login cancelled' });
  });

  // ── Grok (xAI Grok Build CLI) device-auth ───────────────────────────
  router.get('/api/auth/me/grok-auth/browser', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const bin = grokBinPath();
    const binaryPresent = existsSync(bin);
    const loginInProgress = activeLogins.has(loginKey('grok', userId));

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

    const grokHome = path.join(home, '.grok');
    const authInfo = detectGrokAuthMode(grokHome);
    const oauthFromFile = authInfo.present && authInfo.mode === 'oauth';
    const oauthLoggedIn: boolean | null = !binaryPresent ? null : oauthFromFile;

    const uiStatus = computeGrokUiStatus({
      binaryPresent,
      loginInProgress,
      apiKeyConfigured: false,
      oauthFromFile,
    });

    res.json({
      uiStatus,
      binary: { present: binaryPresent, path: bin },
      oauth: {
        loggedIn: oauthLoggedIn,
        mode: binaryPresent ? authInfo.mode : null,
        authJsonPath: binaryPresent ? authInfo.path : null,
      },
      loginInProgress,
      activeMethod: oauthFromFile ? ('oauth' as const) : ('none' as const),
      statusError: binaryPresent
        ? null
        : `Grok binary not found at ${bin}. Set grokBin in Settings → General.`,
    });
  });

  router.post('/api/auth/me/grok-auth/browser/device-login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    cancelLogin('grok', userId);

    const bin = grokBinPath();
    if (!existsSync(bin)) {
      return res.status(400).json({ ok: false, error: `Grok binary not found at ${bin}` });
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
    activeLogins.set(loginKey('grok', userId), { proc, loginId });

    let allOutput = '';
    let responded = false;

    let timeoutHandle: NodeJS.Timeout | null = null;
    const clearLoginTimeout = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const trySend = (): void => {
      if (responded) return;
      const url = extractGrokDeviceUrl(allOutput);
      const userCode = extractGrokDeviceUserCode(allOutput);
      if (url && userCode) {
        responded = true;
        clearLoginTimeout();
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
      clearLoginTimeout();
      const key = loginKey('grok', userId);
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
          type: 'per-user-grok-auth-update',
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
      clearLoginTimeout();
      const key = loginKey('grok', userId);
      const current = activeLogins.get(key);
      if (current?.loginId === loginId) activeLogins.delete(key);
      if (!responded) {
        responded = true;
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      if (!responded) {
        responded = true;
        res.json({
          ok: false,
          output: allOutput.trim() || 'Timed out waiting for Grok device code',
        });
        try {
          killProcessGroup(proc, 'SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }, 45_000);
  });

  router.post('/api/auth/me/grok-auth/browser/cancel-login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const cancelled = cancelLogin('grok', userId);
    res.json({
      ok: true,
      output: cancelled ? 'Device login cancelled' : 'No device login in progress',
    });
  });

  router.delete('/api/auth/me/grok-auth/browser', async (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const bin = grokBinPath();
    let cliOutput = '';
    if (existsSync(bin)) {
      try {
        const home = perUserHomePath(userId, config.dataDir);
        if (existsSync(home)) {
          // `grok logout` is best-effort — not all CLI builds expose it. We
          // wipe the on-disk cache below regardless of its outcome.
          const result = await runCli(bin, ['logout'], { home, timeout: 60_000 });
          cliOutput = (result.stdout + result.stderr).trim();
        }
      } catch {
        /* ignore — proceed to local wipe regardless */
      }
    }

    try {
      clearPerUserCliCache(userId, config.dataDir, '.grok');
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    const summary = ['Per-user Grok cache cleared', cliOutput].filter(Boolean).join(' — ');
    res.json({ ok: true, output: summary });
  });

  return router;
}
