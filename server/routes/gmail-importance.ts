/**
 * Gmail importance scan routes: per-account settings, the cached list of
 * important threads, and a manual scan trigger. The scan itself runs in the
 * background (it can take minutes across several model calls), so clients
 * poll the GET while `running` is true.
 *
 * Each linked Google account is its own mailbox with its own settings and
 * verdicts. Every route takes the `account` query parameter the Google
 * proxies use (account id or email; omitted means the default account).
 */
import { Router, type Request, type Response } from 'express';
import type { RouteDeps } from '../types.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { getGoogleConnectionStatus } from '../google-connections-store.js';
import { parseGoogleAccountSelector } from '../google-account-selector.js';
import { GoogleAccountQuerySchema, googleAccountQueryField } from '../google-proxy-account.js';
import { GMAIL_READONLY_SCOPE, hasGmailReadScope } from '../google-scopes.js';
import {
  GMAIL_IMPORTANCE_AUTO_SCAN,
  DEFAULT_GMAIL_IMPORTANCE_SETTINGS,
  dismissGmailImportanceThread,
  getGmailImportanceSettings,
  listImportantGmailThreads,
  updateGmailImportanceSettings,
  type GmailImportanceKey,
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
    account: z.string().optional(),
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
    account: z.object({ accountId: z.string(), email: z.string() }).nullable().openapi({
      description: 'The Google account this state belongs to; null when none is linked.',
    }),
    settings: SettingsSchema,
    running: z.boolean().openapi({ description: 'A scan is in progress for this account.' }),
    threads: z.array(ImportantThreadSchema),
  }),
);

const AccountQuery = z.object({ account: googleAccountQueryField() });

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
    "Returns one Google account's importance-scan settings, whether a scan is running for it, and the threads the AI marked important within the configured window.",
  request: { query: AccountQuery },
  responses: {
    200: stateResponse('Settings and important threads.'),
    400: errorResponse('Invalid account parameter.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('The named Google account is not linked.'),
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
    query: AccountQuery,
    body: { content: { 'application/json': { schema: UpdateGmailImportanceSettingsBody } } },
  },
  responses: {
    200: stateResponse('Updated settings and important threads.'),
    400: errorResponse('Invalid body.'),
    409: errorResponse('The scan window cannot change while a scan is running.'),
    401: errorResponse('Authentication required, or Google is not connected.'),
    404: errorResponse('The named Google account is not linked.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/google/gmail/importance/scan',
  tags: ['Google Gmail'],
  summary: 'Start a Gmail importance scan',
  description:
    "Starts a background scan of one account's inbox over the window, rated by the caller's own AI engine with the session failover chain. Poll the GET until `running` is false.",
  request: {
    query: AccountQuery,
    body: { content: { 'application/json': { schema: StartGmailImportanceScanBody } } },
  },
  responses: {
    202: stateResponse('Scan started.'),
    400: errorResponse('Invalid body.'),
    401: errorResponse('Authentication required, or Google is not connected.'),
    403: errorResponse('Gmail read access has not been granted for this account.'),
    404: errorResponse('The named Google account is not linked.'),
    409: errorResponse('A scan is already running.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

export const DismissGmailImportanceThreadParams = z.object({
  threadId: z.string().min(1).max(200).openapi({ description: 'Gmail thread id.' }),
});

registerPath({
  method: 'post',
  path: '/api/google/gmail/importance/threads/{threadId}/dismiss',
  tags: ['Google Gmail'],
  summary: 'Remove a thread from the important list',
  description:
    'Hides the thread from the important list. It returns only if a newer message arrives and a later scan rates it important again.',
  request: { params: DismissGmailImportanceThreadParams, query: AccountQuery },
  responses: {
    200: stateResponse('Updated settings and important threads.'),
    400: errorResponse('Invalid thread id.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse(
      'No importance verdict exists for this thread, or the account is not linked.',
    ),
  },
});

function bad(res: Response, status: number, error: string, code: string, extra = {}): void {
  res.status(status).json({ error, code, ...extra });
}

interface ResolvedMailbox {
  key: GmailImportanceKey;
  email: string;
  grantedScopes: string[];
}

function stateFor(mailbox: ResolvedMailbox | null, nowMs: number) {
  if (!mailbox) {
    return {
      account: null,
      settings: { ...DEFAULT_GMAIL_IMPORTANCE_SETTINGS },
      running: false,
      threads: [],
    };
  }
  const { key } = mailbox;
  const settings = getGmailImportanceSettings(key);
  const running = isGmailImportanceScanRunning(key);
  const since = new Date(nowMs - settings.windowDays * 24 * 60 * 60_000).toISOString();
  return {
    account: { accountId: key.accountId, email: mailbox.email },
    settings: {
      ...settings,
      lastScanStatus: running ? ('running' as const) : settings.lastScanStatus,
    },
    running,
    threads: listImportantGmailThreads(key, since),
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

  /**
   * Resolve the caller and the mailbox. `undefined` means an error was sent;
   * `null` means the caller has no linked account and named none.
   */
  const resolveMailbox = (req: Request, res: Response): ResolvedMailbox | null | undefined => {
    let selector: ReturnType<typeof parseGoogleAccountSelector>;
    if (req.query.account !== undefined) {
      const parsed = GoogleAccountQuerySchema.safeParse({ account: req.query.account });
      selector = parsed.success ? parseGoogleAccountSelector(parsed.data.account) : undefined;
      if (!selector) {
        bad(
          res,
          400,
          'account must be a linked Google account id or email; omit it to use the default',
          'invalid_request',
        );
        return undefined;
      }
    }
    const uid = resolveGoogleConnectionUserId(req, deps.stmts);
    if (!uid) {
      bad(res, 401, 'Authentication required', 'authentication_required');
      return undefined;
    }
    const status = getGoogleConnectionStatus(uid, selector);
    if (!status.connected || !status.accountId) {
      if (selector) {
        const label = selector.email ?? selector.accountId ?? '';
        bad(res, 404, `Google account ${label} is not linked`, 'google_account_not_found', {
          account: label,
        });
        return undefined;
      }
      return null;
    }
    return {
      key: { userId: uid, accountId: status.accountId },
      email: status.email ?? '',
      grantedScopes: status.grantedScopes,
    };
  };

  /** Like resolveMailbox, but a missing account is a 401. */
  const requireMailbox = (req: Request, res: Response): ResolvedMailbox | null => {
    const mailbox = resolveMailbox(req, res);
    if (mailbox === null) {
      bad(res, 401, 'Google account is not connected', 'google_not_connected');
    }
    return mailbox ?? null;
  };

  router.get('/api/google/gmail/importance', (req: Request, res: Response) => {
    const mailbox = resolveMailbox(req, res);
    if (mailbox === undefined) return;
    res.json(stateFor(mailbox, now()));
  });

  router.put('/api/google/gmail/importance/settings', (req: Request, res: Response) => {
    const parsed = UpdateGmailImportanceSettingsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const mailbox = requireMailbox(req, res);
    if (!mailbox) return;
    // A running scan covers the window it started with. Changing the window
    // under it would show the new range as scanned when most of it was never
    // rated, so the change waits until the scan finishes.
    const current = getGmailImportanceSettings(mailbox.key);
    if (
      parsed.data.windowDays !== undefined &&
      parsed.data.windowDays !== current.windowDays &&
      isGmailImportanceScanRunning(mailbox.key)
    ) {
      return bad(
        res,
        409,
        'A scan is running. Change the window when it finishes.',
        'scan_in_progress',
      );
    }
    updateGmailImportanceSettings(mailbox.key, parsed.data);
    res.json(stateFor(mailbox, now()));
  });

  router.post(
    '/api/google/gmail/importance/threads/:threadId/dismiss',
    (req: Request, res: Response) => {
      const parsed = DismissGmailImportanceThreadParams.safeParse(req.params);
      if (!parsed.success) {
        return bad(res, 400, 'Invalid thread id', 'invalid_request');
      }
      const mailbox = requireMailbox(req, res);
      if (!mailbox) return;
      if (!dismissGmailImportanceThread(mailbox.key, parsed.data.threadId)) {
        return bad(res, 404, 'Thread not found', 'not_found');
      }
      res.json(stateFor(mailbox, now()));
    },
  );

  router.post('/api/google/gmail/importance/scan', (req: Request, res: Response) => {
    const parsed = StartGmailImportanceScanBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return bad(res, 400, parsed.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    if (!deps.config.googleOAuth?.clientId || !deps.config.googleOAuth?.clientSecret) {
      // Still resolve the caller first so an anonymous request gets its 401.
      if (!resolveGoogleConnectionUserId(req, deps.stmts)) {
        return bad(res, 401, 'Authentication required', 'authentication_required');
      }
      return bad(
        res,
        503,
        'Google OAuth is not configured on this server',
        'google_oauth_not_configured',
      );
    }
    const mailbox = requireMailbox(req, res);
    if (!mailbox) return;
    if (!hasGmailReadScope(mailbox.grantedScopes)) {
      return bad(
        res,
        403,
        `Required Gmail access has not been granted for ${mailbox.email}`,
        'google_gmail_scope_required',
        {
          requiredScopes: [GMAIL_READONLY_SCOPE],
          account: mailbox.email,
        },
      );
    }
    const started = startGmailImportanceScan(
      { ...mailbox.key, config: deps.config, windowDays: parsed.data.windowDays },
      options.scanDeps,
    );
    if (!started) {
      return bad(res, 409, 'A scan is already running', 'scan_in_progress');
    }
    res.status(202).json(stateFor(mailbox, now()));
  });

  return router;
}
