/**
 * Per-user Muse Code (Meta) sign-in.
 *
 *   GET    /api/auth/me/muse-auth/browser                status
 *   POST   /api/auth/me/muse-auth/browser/device-login   start `muse login`
 *   POST   /api/auth/me/muse-auth/browser/cancel-login   cancel (optionally one loginId)
 *   DELETE /api/auth/me/muse-auth/browser                sign out
 *
 * `muse login` is an OAuth device-code flow against auth.meta.com: it prints a
 * verification URL and code, then polls until the user approves. The token
 * lands in `$HOME/.config/muse/auth.json`. The login runs with HOME pinned to
 * the caller's per-user tree and with XDG_CONFIG_HOME stripped, which is the
 * same environment every Muse session spawn gets, so the token is visible to
 * that user's sessions and no one else's.
 *
 * Only the authenticated caller's own id is addressable.
 */
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { existsSync, rmSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import type { RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import { ensurePerUserHome, perUserHomePath } from '../per-user-home.js';
import {
  applyMuseSpawnEnv,
  computeMuseUiStatus,
  detectMuseAuthMode,
  extractMuseDeviceUrl,
  extractMuseDeviceUserCode,
  museAuthJsonPath,
} from '../muse-cli.js';
import { registerPath, z } from '../openapi/registry.js';
import { ErrorResponse } from '../openapi/schemas/auth.js';

const PerUserMuseStatus = z.object({
  uiStatus: z.enum(['missing', 'pending', 'authenticated']),
  binary: z.object({ present: z.boolean(), path: z.string() }),
  auth: z.object({
    loggedIn: z.boolean().nullable(),
    mode: z.enum(['oauth', 'apikey', 'unknown']).nullable(),
  }),
  loginInProgress: z.boolean(),
  statusError: z.string().nullable(),
});

const PerUserMuseLoginResponse = z.object({
  ok: z.boolean(),
  loginId: z.string().optional(),
  deviceAuthUrl: z.string().optional(),
  userCode: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

const MuseOkResponse = z.object({ ok: z.literal(true), output: z.string() });

const MuseCancelRequest = z.object({
  loginId: z.string().optional().openapi({
    description:
      'Only cancel the login with this id. Omit to cancel whatever login is running; that form can kill a retry the caller started after deciding to cancel.',
  }),
});

const unauthenticated = {
  description: 'Not authenticated.',
  content: { 'application/json': { schema: ErrorResponse } },
};

registerPath({
  method: 'get',
  path: '/api/auth/me/muse-auth/browser',
  tags: ['Auth'],
  summary: 'Per-user Muse Code sign-in status.',
  responses: {
    200: {
      description: 'Caller-scoped Muse credential state.',
      content: { 'application/json': { schema: PerUserMuseStatus } },
    },
    401: unauthenticated,
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/me/muse-auth/browser/device-login',
  tags: ['Auth'],
  summary: 'Start a per-user Muse Code (Meta account) device login.',
  description:
    "Spawns `muse login` under the caller's per-user HOME and responds once the verification URL and code are printed. Completion is broadcast as a `per-user-muse-auth-update` WebSocket event.",
  responses: {
    200: {
      description: 'Device code emitted, or the login output when it ended early.',
      content: { 'application/json': { schema: PerUserMuseLoginResponse } },
    },
    400: {
      description: 'Muse binary missing.',
      content: { 'application/json': { schema: PerUserMuseLoginResponse } },
    },
    401: unauthenticated,
  },
});

registerPath({
  method: 'post',
  path: '/api/auth/me/muse-auth/browser/cancel-login',
  tags: ['Auth'],
  summary: 'Cancel an in-progress per-user Muse device login.',
  request: {
    body: { required: false, content: { 'application/json': { schema: MuseCancelRequest } } },
  },
  responses: {
    200: {
      description: 'Cancellation receipt.',
      content: { 'application/json': { schema: MuseOkResponse } },
    },
    401: unauthenticated,
  },
});

registerPath({
  method: 'delete',
  path: '/api/auth/me/muse-auth/browser',
  tags: ['Auth'],
  summary: 'Sign the caller out of Muse Code (removes the stored Meta credential).',
  responses: {
    200: {
      description: 'Credential removed.',
      content: { 'application/json': { schema: MuseOkResponse } },
    },
    401: unauthenticated,
    500: {
      description: 'Credential file could not be removed.',
      content: { 'application/json': { schema: PerUserMuseLoginResponse } },
    },
  },
});

/** How long to wait for `muse login` to print its verification URL. */
const DEVICE_CODE_TIMEOUT_MS = 45_000;

/**
 * One running `muse login`. Everything the attempt owns (its process, its
 * device-code timer, its pending HTTP response) is released through `stop`,
 * which only ever touches this attempt.
 */
interface ActiveLogin {
  loginId: string;
  stop: (reason: string) => void;
}

function museLoginEnv(home: string): NodeJS.ProcessEnv {
  return applyMuseSpawnEnv({ ...process.env, HOME: home });
}

function requireAuthUserId(req: Request, res: Response): string | null {
  const userId = (req as AuthenticatedRequest).authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return userId;
}

export default function createPerUserMuseAuthRoutes(
  deps: RouteDeps,
  opts: { deviceCodeTimeoutMs?: number } = {},
): Router {
  const deviceCodeTimeoutMs = opts.deviceCodeTimeoutMs ?? DEVICE_CODE_TIMEOUT_MS;
  const { config, broadcast } = deps;
  const router = Router();
  const activeLogins = new Map<string, ActiveLogin>();
  const museBinPath = (): string => deps.getMuseBin?.() ?? config.museBin;

  /** Kill the user's running login, or only the one named by `loginId`. */
  function cancelLogin(userId: string, loginId?: string): boolean {
    const rec = activeLogins.get(userId);
    if (!rec) return false;
    if (loginId !== undefined && rec.loginId !== loginId) return false;
    rec.stop('Device login cancelled');
    return true;
  }

  router.get('/api/auth/me/muse-auth/browser', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const bin = museBinPath();
    const binaryPresent = existsSync(bin);
    const loginInProgress = activeLogins.has(userId);
    const info = detectMuseAuthMode(perUserHomePath(userId, config.dataDir));
    const credentialPresent = info.present && info.mode !== 'unknown';
    res.json({
      uiStatus: computeMuseUiStatus({ binaryPresent, loginInProgress, credentialPresent }),
      binary: { present: binaryPresent, path: bin },
      auth: {
        loggedIn: binaryPresent ? credentialPresent : null,
        mode: info.present ? info.mode : null,
      },
      loginInProgress,
      statusError: binaryPresent
        ? null
        : `Muse binary not found at ${bin}. Set museBin in Settings → General.`,
    });
  });

  router.post('/api/auth/me/muse-auth/browser/device-login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    cancelLogin(userId);

    const bin = museBinPath();
    if (!existsSync(bin)) {
      return res.status(400).json({ ok: false, error: `Muse binary not found at ${bin}` });
    }
    let home: string;
    try {
      home = ensurePerUserHome(userId, config.dataDir);
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }

    const loginId = randomUUID();
    const proc: ChildProcess = spawn(bin, ['login'], {
      cwd: home,
      env: museLoginEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);

    let output = '';
    let responded = false;
    let timer: NodeJS.Timeout | null = null;
    const isCurrent = (): boolean => activeLogins.get(userId)?.loginId === loginId;

    const reply = (status: number, body: Record<string, unknown>): void => {
      if (responded) return;
      responded = true;
      if (timer) clearTimeout(timer);
      res.status(status).json(body);
    };

    // Ends this attempt only: a timer or cancel for an older attempt can never
    // reach a newer one, because each attempt holds its own `stop`.
    const stop = (reason: string): void => {
      if (timer) clearTimeout(timer);
      if (isCurrent()) activeLogins.delete(userId);
      reply(200, { ok: false, loginId, output: output.trim() || reason });
      try {
        killProcessGroup(proc, 'SIGTERM');
      } catch {
        /* already exited */
      }
    };
    activeLogins.set(userId, { loginId, stop });
    timer = setTimeout(() => stop('Timed out waiting for Muse device code'), deviceCodeTimeoutMs);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (responded) return;
      const deviceAuthUrl = extractMuseDeviceUrl(output);
      const userCode = extractMuseDeviceUserCode(output);
      if (deviceAuthUrl && userCode) reply(200, { ok: true, loginId, deviceAuthUrl, userCode });
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // A stopped or superseded attempt is no longer current, so it never
      // reports over the login that replaced it.
      const current = isCurrent();
      if (current) activeLogins.delete(userId);
      if (!responded) {
        reply(200, {
          ok: false,
          loginId,
          output: output.trim() || `muse login exited with code ${code}`,
        });
        return;
      }
      if (!current || !broadcast) return;
      const status = code === 0 ? 'success' : 'failed';
      broadcast({
        type: 'per-user-muse-auth-update',
        userId,
        loginId,
        status,
        ...(status === 'failed' && { error: output.trim().slice(0, 500) || 'Muse login failed' }),
      });
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (isCurrent()) activeLogins.delete(userId);
      reply(500, { ok: false, error: err.message });
    });
  });

  router.post('/api/auth/me/muse-auth/browser/cancel-login', (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const parsed = MuseCancelRequest.safeParse(req.body ?? {});
    const loginId = parsed.success ? parsed.data.loginId : undefined;
    const cancelled = cancelLogin(userId, loginId);
    res.json({
      ok: true,
      output: cancelled ? 'Device login cancelled' : 'No device login in progress',
    });
  });

  router.delete('/api/auth/me/muse-auth/browser', async (req: Request, res: Response) => {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    cancelLogin(userId);
    const home = perUserHomePath(userId, config.dataDir);
    const bin = museBinPath();
    let cliOutput = '';
    if (existsSync(bin) && existsSync(home)) {
      // Lets Muse revoke what it can; the file is removed below either way.
      cliOutput = await runMuseLogout(bin, home);
    }
    try {
      rmSync(museAuthJsonPath(home), { force: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }
    res.json({
      ok: true,
      output: ['Muse credential removed', cliOutput].filter(Boolean).join(' — '),
    });
  });

  return router;
}

function runMuseLogout(bin: string, home: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['logout'], {
      cwd: home,
      env: museLoginEnv(home),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    trackChild(proc);
    let out = '';
    const timer = setTimeout(() => killProcessGroup(proc, 'SIGTERM'), 30_000);
    proc.stdout?.on('data', (d: Buffer) => (out += d));
    proc.stderr?.on('data', (d: Buffer) => (out += d));
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}
