import { Router, Request, Response } from 'express';
import { existsSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import type { RouteDeps } from '../types.js';
import { ensureHostCliHome } from '../host-cli-home.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import {
  extractCursorLoginUrl,
  parseCursorStatusJson,
  computeCursorUiStatus,
} from '../cursor-auth-parse.js';
import { invalidateCursorAuthCache } from '../cursor-auth-cache.js';
import { registerPath, z } from '../openapi/registry.js';
import { ErrorResponse } from '../openapi/schemas/auth.js';

// ── OpenAPI registrations (Cursor Agent CLI auth) ──────────────────────
registerPath({
  method: 'get',
  path: '/api/config/cursor-auth',
  tags: ['Auth'],
  summary: 'Cursor Agent CLI auth status.',
  request: {
    query: z.object({ cursorBin: z.string().optional() }),
  },
  responses: {
    200: {
      description: 'Current Cursor auth status.',
      content: {
        'application/json': {
          schema: z.object({
            uiStatus: z.string(),
            binary: z.object({ present: z.boolean(), path: z.string() }),
            oauth: z.object({
              loggedIn: z.boolean().nullable(),
              email: z.string().nullable().optional(),
            }),
            loginInProgress: z.boolean(),
            activeMethod: z.enum(['oauth', 'none']),
            statusError: z.string().nullable(),
          }),
        },
      },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/config/cursor-auth/login',
  tags: ['Auth'],
  summary: 'Start the Cursor Agent OAuth login flow.',
  responses: {
    200: {
      description: 'Login URL emitted by cursor-agent, or login result.',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.boolean(),
            loginId: z.string().optional(),
            loginUrl: z.string().optional(),
            completed: z.boolean().optional(),
            output: z.string().optional(),
          }),
        },
      },
    },
    400: {
      description: 'Cursor binary missing.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/config/cursor-auth/cancel-login',
  tags: ['Auth'],
  summary: 'Cancel an in-progress Cursor login.',
  responses: {
    200: {
      description: 'Cancellation receipt.',
      content: {
        'application/json': {
          schema: z.object({ ok: z.literal(true), output: z.string() }),
        },
      },
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/config/cursor-auth',
  tags: ['Auth'],
  summary: 'Log the Cursor Agent CLI out.',
  responses: {
    200: {
      description: 'Logout result.',
      content: {
        'application/json': {
          schema: z.object({ ok: z.literal(true), output: z.string() }),
        },
      },
    },
    400: {
      description: 'Cursor binary missing.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
    500: {
      description: 'CLI logout failed.',
      content: { 'application/json': { schema: ErrorResponse } },
    },
  },
});

interface CursorRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCursor(
  bin: string,
  args: string[],
  home: string,
  opts: { env?: Record<string, string>; timeout?: number } = {},
): Promise<CursorRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: home,
      env: { ...process.env, HOME: home, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    const ms = opts.timeout ?? 25_000;
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

let activeLoginProc: ChildProcess | null = null;
let activeLoginId: string | null = null;

function parseCursorBinQuery(req: Request): string | null {
  const q = req.query.cursorBin;
  const raw = Array.isArray(q) ? q[0] : q;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

export default function createCursorAuthRoutes(deps: RouteDeps): Router {
  const { config, broadcast, getCursorBin } = deps;
  const router = Router();

  const hostHome = (): string => ensureHostCliHome(config.dataDir);
  const binPath = (): string => getCursorBin?.() ?? config.cursorBin;

  const resetActiveLogin = (): void => {
    activeLoginProc = null;
    activeLoginId = null;
  };

  router.get('/api/config/cursor-auth', async (req: Request, res: Response) => {
    const path = parseCursorBinQuery(req) ?? binPath();
    const binaryPresent = existsSync(path);
    const loginInProgress = !!activeLoginProc;

    if (!binaryPresent) {
      return res.json({
        uiStatus: computeCursorUiStatus({
          binaryPresent: false,
          loginInProgress,
          isAuthenticated: false,
        }),
        binary: { present: false, path },
        oauth: { loggedIn: false },
        loginInProgress,
        activeMethod: 'none' as const,
        statusError: `Cursor Agent binary not found at ${path}`,
      });
    }

    if (loginInProgress) {
      return res.json({
        uiStatus: 'pending',
        binary: { present: true, path },
        oauth: { loggedIn: null as boolean | null },
        loginInProgress: true,
        activeMethod: 'none' as const,
        statusError: null,
      });
    }

    const { stdout, stderr, code } = await runCursor(
      path,
      ['status', '--format', 'json'],
      hostHome(),
    );
    const parsed = parseCursorStatusJson(stdout, stderr);
    const isAuthenticated = parsed.ok && parsed.isAuthenticated;
    const uiStatus = computeCursorUiStatus({
      binaryPresent: true,
      loginInProgress: false,
      isAuthenticated,
    });

    res.json({
      uiStatus,
      binary: { present: true, path },
      oauth: {
        loggedIn: isAuthenticated,
        email: parsed.email ?? null,
      },
      loginInProgress: false,
      activeMethod: isAuthenticated ? ('oauth' as const) : ('none' as const),
      statusError:
        code !== 0 || !parsed.ok
          ? parsed.error || stderr.trim() || stdout.trim() || `cursor-agent status exited ${code}`
          : null,
    });
  });

  router.post('/api/config/cursor-auth/login', (_req: Request, res: Response) => {
    if (activeLoginProc) {
      try {
        killProcessGroup(activeLoginProc, 'SIGTERM');
      } catch {
        /* already dead */
      }
      resetActiveLogin();
    }

    const path = binPath();
    if (!existsSync(path)) {
      return res.status(400).json({ ok: false, error: `Cursor Agent binary not found at ${path}` });
    }

    const loginId = Date.now().toString(36);
    activeLoginId = loginId;

    const home = hostHome();
    const proc = spawn(path, ['login'], {
      cwd: home,
      env: { ...process.env, HOME: home, NO_OPEN_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
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
      if (activeLoginId === loginId) {
        resetActiveLogin();
      }

      // The login child just exited — auth state may have flipped from
      // unauthenticated → authenticated (or back, on a failed retry). The
      // cursor-auth cache used by GET /api/config/models is keyed on bin
      // path only, so without this drop the wizard's Save & Continue check
      // can keep seeing the pre-login `false` for up to 60s. Invalidate
      // unconditionally so the next models poll re-probes `cursor-agent
      // status` against reality.
      invalidateCursorAuthCache();

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
            type: 'cursor-auth-update',
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

  router.post('/api/config/cursor-auth/cancel-login', (_req: Request, res: Response) => {
    if (activeLoginProc) {
      try {
        killProcessGroup(activeLoginProc, 'SIGTERM');
      } catch {
        /* ignore */
      }
      resetActiveLogin();
      res.json({ ok: true, output: 'Login cancelled' });
    } else {
      res.json({ ok: true, output: 'No login in progress' });
    }
  });

  router.delete('/api/config/cursor-auth', async (_req: Request, res: Response) => {
    const path = binPath();
    if (!existsSync(path)) {
      return res.status(400).json({ error: `Cursor Agent binary not found at ${path}` });
    }
    const { stdout, stderr, code } = await runCursor(path, ['logout'], hostHome(), {
      timeout: 30_000,
    });
    const combined = (stdout + stderr).trim();
    if (code !== 0 && !/logout successful|not logged in/i.test(combined)) {
      return res.status(500).json({
        ok: false,
        error: combined || `cursor-agent logout exited with code ${code}`,
      });
    }
    // Auth state just flipped to logged-out; clear the cache so the next
    // models poll reflects reality instead of a cached `true`.
    invalidateCursorAuthCache();
    res.json({ ok: true, output: combined || 'Logged out' });
  });

  return router;
}
