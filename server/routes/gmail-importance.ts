/**
 * Gmail importance scan routes: per-user settings, the cached list of
 * important threads, and a manual scan trigger. The scan itself runs in the
 * background (it can take minutes across several model calls), so clients
 * poll the GET while `running` is true.
 */
import { Router, type Request, type Response } from 'express';
import type { RouteDeps } from '../types.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { getGoogleConnectionStatus } from '../google-connections-store.js';
import { GMAIL_READONLY_SCOPE, hasGmailReadScope } from '../google-scopes.js';
import {
  GMAIL_IMPORTANCE_AUTO_SCAN,
  getGmailImportanceSettings,
  listImportantGmailThreads,
  updateGmailImportanceSettings,
} from '../gmail-importance-store.js';
import {
  isGmailImportanceScanRunning,
  startGmailImportanceScan,
  type GmailImportanceScanDeps,
} from '../gmail-importance.js';
import { registerComponent, registerPath, z } from '../openapi/registry.js';

const WindowDaysSchema = z
  .union([z.literal(1), z.literal(7), z.literal(30)])
  .openapi({ description: 'How far back the scan looks, in days.', example: 7 });

const AutoScanSchema = z
  .enum(GMAIL_IMPORTANCE_AUTO_SCAN)
  .openapi({ description: 'Automated scan cadence. `off` disables automated scans.' });

const ErrorResponse = registerComponent(
  'GmailImportanceErrorResponse',
  z.object({
    error: z.string(),
    code: z.string().optional(),
    requiredScopes: z.array(z.string()).optional(),
  }),
);

const SettingsSchema = registerComponent(
  'GmailImportanceSettings',
  z.object({
    enabled: z.boolean().openapi({ description: 'Show important threads above the inbox list.' }),
    windowDays: WindowDaysSchema,
    autoScan: AutoScanSchema,
    lastScanAt: z.string().nullable(),
    lastScanStatus: z.enum(['idle', 'running', 'ok', 'error']),
    lastScanError: z.string().nullable(),
    lastScanEngine: z.string().nullable(),
    lastScanModel: z.string().nullable(),
    lastScanFailover: z
      .string()
      .nullable()
      .openapi({ description: 'Set when the last scan had to switch AI engines.' }),
  }),
);

const ImportantThreadSchema = registerComponent(
  'GmailImportantThread',
  z.object({
    threadId: z.string(),
    historyId: z.string().nullable(),
    important: z.boolean(),
    score: z.number().int().openapi({ description: 'Importance 0-100, higher first.' }),
    reason: z.string().nullable(),
    subject: z.string().nullable(),
    from: z.string().nullable(),
    snippet: z.string().nullable(),
    lastMessageAt: z.string().nullable(),
    scannedAt: z.string(),
  }),
);

const ImportanceStateSchema = registerComponent(
  'GmailImportanceState',
  z.object({
    settings: SettingsSchema,
    running: z.boolean().openapi({ description: 'A scan is in progress for this user.' }),
    threads: z.array(ImportantThreadSchema),
  }),
);

export const UpdateGmailImportanceSettingsBody = z
  .object({
    enabled: z.boolean().optional(),
    windowDays: WindowDaysSchema.optional(),
    autoScan: AutoScanSchema.optional(),
  })
  .strict();

export const StartGmailImportanceScanBody = z
  .object({ windowDays: WindowDaysSchema.optional() })
  .strict();

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponse } },
});

const stateResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ImportanceStateSchema } },
});

registerPath({
  method: 'get',
  path: '/api/google/gmail/importance',
  tags: ['Google Gmail'],
  summary: 'Get Gmail importance settings and important threads',
  description:
    "Returns the caller's importance-scan settings, whether a scan is running, and the threads the AI marked important within the configured window.",
  responses: {
    200: stateResponse('Settings and important threads.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/google/gmail/importance/settings',
  tags: ['Google Gmail'],
  summary: 'Update Gmail importance settings',
  description:
    'Toggle the important-threads section, pick the scan window (1, 7, or 30 days), and set the automated scan cadence.',
  request: {
    body: { content: { 'application/json': { schema: UpdateGmailImportanceSettingsBody } } },
  },
  responses: {
    200: stateResponse('Updated settings and important threads.'),
    400: errorResponse('Invalid body.'),
    409: errorResponse('The scan window cannot change while a scan is running.'),
    401: errorResponse('Authentication required.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/google/gmail/importance/scan',
  tags: ['Google Gmail'],
  summary: 'Start a Gmail importance scan',
  description:
    "Starts a background scan of the caller's inbox over the window, rated by the caller's own AI engine with the session failover chain. Poll the GET until `running` is false.",
  request: {
    body: { content: { 'application/json': { schema: StartGmailImportanceScanBody } } },
  },
  responses: {
    202: stateResponse('Scan started.'),
    400: errorResponse('Invalid body.'),
    401: errorResponse('Authentication required, or Google is not connected.'),
    403: errorResponse('Gmail read access has not been granted.'),
    409: errorResponse('A scan is already running.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

function bad(res: Response, status: number, error: string, code: string, extra = {}): void {
  res.status(status).json({ error, code, ...extra });
}

function stateFor(userId: string, nowMs: number) {
  const settings = getGmailImportanceSettings(userId);
  const running = isGmailImportanceScanRunning(userId);
  const since = new Date(nowMs - settings.windowDays * 24 * 60 * 60_000).toISOString();
  return {
    settings: {
      ...settings,
      lastScanStatus: running ? ('running' as const) : settings.lastScanStatus,
    },
    running,
    threads: listImportantGmailThreads(userId, since),
  };
}

export interface GmailImportanceRouteOptions {
  scanDeps?: GmailImportanceScanDeps;
  now?: () => number;
}

export default function createGmailImportanceRoutes(
  deps: RouteDeps,
  options: GmailImportanceRouteOptions = {},
): Router {
  const router = Router();
  const now = options.now ?? Date.now;

  const requireUser = (req: Request, res: Response): string | null => {
    const uid = resolveGoogleConnectionUserId(req, deps.stmts);
    if (!uid) {
      bad(res, 401, 'Authentication required', 'authentication_required');
      return null;
    }
    return uid;
  };

  router.get('/api/google/gmail/importance', (req: Request, res: Response) => {
    const uid = requireUser(req, res);
    if (!uid) return;
    res.json(stateFor(uid, now()));
  });

  router.put('/api/google/gmail/importance/settings', (req: Request, res: Response) => {
    const parsed = UpdateGmailImportanceSettingsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const uid = requireUser(req, res);
    if (!uid) return;
    // A running scan covers the window it started with. Changing the window
    // under it would show the new range as scanned when most of it was never
    // rated, so the change waits until the scan finishes.
    const current = getGmailImportanceSettings(uid);
    if (
      parsed.data.windowDays !== undefined &&
      parsed.data.windowDays !== current.windowDays &&
      isGmailImportanceScanRunning(uid)
    ) {
      return bad(
        res,
        409,
        'A scan is running. Change the window when it finishes.',
        'scan_in_progress',
      );
    }
    updateGmailImportanceSettings(uid, parsed.data);
    res.json(stateFor(uid, now()));
  });

  router.post('/api/google/gmail/importance/scan', (req: Request, res: Response) => {
    const parsed = StartGmailImportanceScanBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const uid = requireUser(req, res);
    if (!uid) return;
    if (!deps.config.googleOAuth?.clientId || !deps.config.googleOAuth?.clientSecret) {
      return bad(
        res,
        503,
        'Google OAuth is not configured on this server',
        'google_oauth_not_configured',
      );
    }
    const status = getGoogleConnectionStatus(uid);
    if (!status.connected) {
      return bad(res, 401, 'Google account is not connected', 'google_not_connected');
    }
    if (!hasGmailReadScope(status.grantedScopes)) {
      return bad(
        res,
        403,
        'Required Gmail access has not been granted',
        'google_gmail_scope_required',
        {
          requiredScopes: [GMAIL_READONLY_SCOPE],
        },
      );
    }
    const started = startGmailImportanceScan(
      { userId: uid, config: deps.config, windowDays: parsed.data.windowDays },
      options.scanDeps,
    );
    if (!started) {
      return bad(res, 409, 'A scan is already running', 'scan_in_progress');
    }
    res.status(202).json(stateFor(uid, now()));
  });

  return router;
}
