import { Router, Request, Response } from 'express';
import { existsSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import os from 'os';
import type { RouteDeps } from '../types.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import {
  extractCursorLoginUrl,
  parseCursorStatusJson,
  computeCursorUiStatus,
} from '../cursor-auth-parse.js';
import { invalidateCursorAuthCache } from '../cursor-auth-cache.js';

const HOME = os.homedir();

interface CursorRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCursor(
  bin: string,
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number } = {},
): Promise<CursorRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd: HOME,
      env: { ...process.env, ...opts.env },
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

    const { stdout, stderr, code } = await runCursor(path, ['status', '--format', 'json']);
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

    const proc = spawn(path, ['login'], {
      cwd: HOME,
      env: { ...process.env, NO_OPEN_BROWSER: '1' },
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
    const { stdout, stderr, code } = await runCursor(path, ['logout'], { timeout: 30_000 });
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
