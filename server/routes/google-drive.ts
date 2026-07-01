import { Router, Request, Response } from 'express';
import { google, type drive_v3 } from 'googleapis';
import type { RouteDeps } from '../types.js';
import { getActiveAccessToken, getGoogleConnectionStatus } from '../google-connections-store.js';
import { resolveGoogleConnectionUserId } from '../google-connection-user.js';
import { registerComponent, registerPath, z } from '../openapi/registry.js';

/**
 * Google Drive proxy routes — a minimal file picker scoped to `drive.file`.
 *
 * SCOPES epic decision: v1 deliberately requests ONLY the non-sensitive
 * `drive.file` scope (app-created / app-opened files). It NEVER requests
 * `drive.readonly` or full `drive`, which are RESTRICTED and would trigger the
 * annual CASA security assessment. With `drive.file` granted, Drive only
 * returns the files this app created or that the user explicitly opened with it
 * through the Google Picker — exactly the surface a file picker needs.
 *
 * The scope gate accepts only `drive.file`. We never grant the restricted
 * scopes, so there is no back-compat case to widen the gate for, and keeping it
 * narrow makes the "no drive.readonly/full" guarantee enforceable in code.
 */

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Fixed projection sent to Drive — we only ever expose this shaped subset, so a
// caller can never coax extra metadata out by passing a `fields` param.
const DRIVE_FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'iconLink',
  'webViewLink',
  'modifiedTime',
  'createdTime',
  'size',
  'owners(displayName,emailAddress)',
  'trashed',
] as const;
const DRIVE_LIST_FIELDS = `nextPageToken, incompleteSearch, files(${DRIVE_FILE_FIELDS.join(',')})`;
const DRIVE_GET_FIELDS = DRIVE_FILE_FIELDS.join(',');

const ErrorResponse = registerComponent(
  'GoogleDriveErrorResponse',
  z.object({
    error: z.string(),
    code: z.string().optional(),
    requiredScopes: z.array(z.string()).optional(),
  }),
);

const DriveFileSchema = registerComponent(
  'GoogleDriveFile',
  z.object({
    id: z.string().nullable(),
    name: z.string().nullable(),
    mimeType: z.string().nullable(),
    iconLink: z.string().nullable(),
    webViewLink: z.string().nullable(),
    modifiedTime: z.string().nullable(),
    createdTime: z.string().nullable(),
    size: z.string().nullable(),
    owners: z
      .array(z.object({ displayName: z.string().nullable(), emailAddress: z.string().nullable() }))
      .nullable(),
    trashed: z.boolean().nullable(),
  }),
);

const ListDriveFilesQuerySchema = z.object({
  q: z.string().optional().openapi({
    description: 'Drive query string, e.g. `mimeType = "application/pdf"`.',
    example: "mimeType = 'application/vnd.google-apps.spreadsheet'",
  }),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  pageToken: z.string().optional(),
  orderBy: z.string().optional().openapi({
    description: 'Comma-separated sort keys, e.g. `modifiedTime desc`.',
    example: 'modifiedTime desc',
  }),
});

const DriveFileIdParamsSchema = z.object({
  fileId: z.string().min(1),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/google/drive/files',
  tags: ['Google'],
  summary: 'List app-accessible Drive files (drive.file) for the calling user',
  request: { query: ListDriveFilesQuerySchema },
  responses: {
    200: {
      description: 'Files this app created or that the user opened with it.',
      content: jsonContent(
        z.object({
          files: z.array(DriveFileSchema),
          nextPageToken: z.string().nullable(),
          incompleteSearch: z.boolean().nullable(),
        }),
      ),
    },
    400: errorResponse('Invalid query.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Drive scope (drive.file) has not been granted.'),
    429: errorResponse('Google Drive rate limit exceeded.'),
    502: errorResponse('Google Drive request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/google/drive/files/{fileId}',
  tags: ['Google'],
  summary: 'Read metadata for an app-accessible Drive file for the calling user',
  request: { params: DriveFileIdParamsSchema },
  responses: {
    200: {
      description: 'The file metadata.',
      content: jsonContent(DriveFileSchema),
    },
    400: errorResponse('Invalid file id.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Drive scope (drive.file) has not been granted.'),
    404: errorResponse('File not found or not accessible to this app.'),
    429: errorResponse('Google Drive rate limit exceeded.'),
    502: errorResponse('Google Drive request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

interface GoogleErrorShape {
  response?: {
    status?: number;
    data?: {
      error?: string | { message?: string; status?: string; errors?: Array<{ reason?: string }> };
      message?: string;
    };
  };
  code?: number | string;
  message?: string;
}

function bad(res: Response, status: number, error: string, code?: string, extra = {}): void {
  res.status(status).json({ error, ...(code && { code }), ...extra });
}

function hasDriveFileScope(scopes: string[]): boolean {
  // Only `drive.file` — restricted scopes are never requested, so accepting
  // them here would be dead code that weakens the "drive.file only" guarantee.
  return scopes.includes(DRIVE_FILE_SCOPE);
}

/**
 * Resolve the caller, verify Google is configured + connected, and check the
 * drive.file scope. Returns the resolved userId or null (a response has already
 * been sent).
 */
function requireDriveAccess(req: Request, res: Response, deps: RouteDeps): string | null {
  const uid = resolveGoogleConnectionUserId(req, deps.stmts);
  if (!uid) {
    bad(res, 401, 'Authentication required', 'authentication_required');
    return null;
  }
  if (!deps.config.googleOAuth?.clientId || !deps.config.googleOAuth?.clientSecret) {
    bad(res, 503, 'Google OAuth is not configured on this server', 'google_oauth_not_configured');
    return null;
  }
  const status = getGoogleConnectionStatus(uid);
  if (!status.connected) {
    bad(res, 401, 'Google account is not connected', 'google_not_connected');
    return null;
  }
  if (!hasDriveFileScope(status.grantedScopes)) {
    bad(res, 403, 'Google Drive access has not been granted', 'google_drive_scope_required', {
      requiredScopes: [DRIVE_FILE_SCOPE],
    });
    return null;
  }
  return uid;
}

async function resolveDriveToken(
  userId: string,
  deps: RouteDeps,
  res: Response,
): Promise<string | null> {
  let token: string | null;
  try {
    token = await getActiveAccessToken(userId, deps.config.googleOAuth ?? null);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[google-drive] Failed to resolve token for user ${userId}: ${msg}`);
    bad(res, 502, 'Failed to resolve Google access token', 'google_token_resolution_failed');
    return null;
  }
  if (!token) {
    bad(res, 401, 'Google account must be reconnected', 'google_reconnect_required');
    return null;
  }
  return token;
}

function createDriveClient(accessToken: string): drive_v3.Drive {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

function shapeFile(file: drive_v3.Schema$File): z.infer<typeof DriveFileSchema> {
  return {
    id: file.id ?? null,
    name: file.name ?? null,
    mimeType: file.mimeType ?? null,
    iconLink: file.iconLink ?? null,
    webViewLink: file.webViewLink ?? null,
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
    size: file.size ?? null,
    owners: file.owners
      ? file.owners.map((owner) => ({
          displayName: owner.displayName ?? null,
          emailAddress: owner.emailAddress ?? null,
        }))
      : null,
    trashed: typeof file.trashed === 'boolean' ? file.trashed : null,
  };
}

function extractGoogleError(err: unknown): { status: number; error: string; code: string } {
  const e = err as GoogleErrorShape;
  const rawStatus =
    typeof e.response?.status === 'number'
      ? e.response.status
      : typeof e.code === 'number'
        ? e.code
        : Number.parseInt(String(e.code ?? ''), 10);
  const status = Number.isFinite(rawStatus) ? rawStatus : 502;
  const dataError = e.response?.data?.error;
  const nestedMessage = typeof dataError === 'object' ? dataError.message : undefined;
  const nestedReason =
    typeof dataError === 'object' ? dataError.errors?.find((item) => item.reason)?.reason : null;
  const message =
    nestedMessage ||
    e.response?.data?.message ||
    (typeof dataError === 'string' ? dataError : undefined) ||
    e.message ||
    'Google Drive request failed';

  if (status === 401) {
    return {
      status: 401,
      code: 'google_drive_auth_failed',
      error: 'Google Drive authorization failed. Reconnect Google in Account settings.',
    };
  }
  if (status === 403) {
    const isRateLimit =
      nestedReason === 'rateLimitExceeded' ||
      nestedReason === 'userRateLimitExceeded' ||
      /rate.?limit|quota/i.test(message);
    if (isRateLimit) {
      return {
        status: 429,
        code: 'google_drive_rate_limited',
        error: 'Google Drive rate limit exceeded',
      };
    }
    return { status: 403, code: 'google_drive_forbidden', error: 'Google Drive access was denied' };
  }
  if (status === 404) {
    return {
      status: 404,
      code: 'google_drive_not_found',
      error: 'Google Drive file was not found',
    };
  }
  if (status === 429) {
    return {
      status: 429,
      code: 'google_drive_rate_limited',
      error: 'Google Drive rate limit exceeded',
    };
  }
  if (status >= 400 && status < 500) {
    return { status, code: 'google_drive_bad_request', error: message.split('\n')[0] };
  }
  return { status: 502, code: 'google_drive_upstream_failed', error: message.split('\n')[0] };
}

function sendGoogleError(res: Response, err: unknown): Response {
  const mapped = extractGoogleError(err);
  return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
}

export default function createGoogleDriveRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/google/drive/files', async (req: Request, res: Response) => {
    const query = ListDriveFilesQuerySchema.safeParse(req.query);
    if (!query.success) {
      return bad(res, 400, query.error.issues[0]?.message || 'Invalid query', 'invalid_request');
    }
    const uid = requireDriveAccess(req, res, deps);
    if (!uid) return;
    const token = await resolveDriveToken(uid, deps, res);
    if (!token) return;

    try {
      const drive = createDriveClient(token);
      const result = await drive.files.list({
        q: query.data.q,
        pageSize: query.data.pageSize,
        pageToken: query.data.pageToken,
        orderBy: query.data.orderBy,
        // `user` corpus + the default `drive` space: with drive.file granted,
        // Drive already restricts results to app-created/opened files.
        spaces: 'drive',
        corpora: 'user',
        fields: DRIVE_LIST_FIELDS,
      });
      return res.json({
        files: (result.data.files ?? []).map(shapeFile),
        nextPageToken: result.data.nextPageToken ?? null,
        incompleteSearch:
          typeof result.data.incompleteSearch === 'boolean' ? result.data.incompleteSearch : null,
      });
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.get('/api/google/drive/files/:fileId', async (req: Request, res: Response) => {
    const params = DriveFileIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      return bad(res, 400, params.error.issues[0]?.message || 'Invalid file id', 'invalid_request');
    }
    const uid = requireDriveAccess(req, res, deps);
    if (!uid) return;
    const token = await resolveDriveToken(uid, deps, res);
    if (!token) return;

    try {
      const drive = createDriveClient(token);
      const result = await drive.files.get({
        fileId: params.data.fileId,
        fields: DRIVE_GET_FIELDS,
      });
      return res.json(shapeFile(result.data));
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  return router;
}
