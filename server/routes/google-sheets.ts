import { Router, Request, Response } from 'express';
import { google, type sheets_v4 } from 'googleapis';
import type { RouteDeps } from '../types.js';
import { getActiveAccessToken, getGoogleConnectionStatus } from '../google-connections-store.js';
import { resolveOAuthConnectionUserId } from '../github-connection-user.js';
import { registerComponent, registerPath, z } from '../openapi/registry.js';

/**
 * Google Sheets proxy routes — server-side Sheets access scoped to the calling
 * user's linked Google connection. Tokens never leave the server (PROXY epic
 * decision): each handler resolves the caller's userId, fetches a fresh access
 * token from the encrypted connection store, calls the googleapis Sheets SDK,
 * and returns shaped JSON.
 *
 * Scopes (SCOPES epic decision — sensitive only, no restricted scopes):
 *   - reading values gates on the SENSITIVE `spreadsheets` scope. The narrower
 *     `spreadsheets.readonly` (also sensitive) satisfies the read gate too, so
 *     a read-only grant works, but the surface itself requests full
 *     `spreadsheets` because it also writes (append/update).
 *   - writing values (append/update) gates on full `spreadsheets`; a readonly
 *     grant cannot mutate a sheet.
 *
 * Neither scope is restricted, so this surface needs sensitive-scope consent
 * verification but NOT the annual CASA assessment.
 */

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

const ErrorResponse = registerComponent(
  'GoogleSheetsErrorResponse',
  z.object({
    error: z.string(),
    code: z.string().optional(),
    requiredScopes: z.array(z.string()).optional(),
  }),
);

const SheetsValueRangeSchema = registerComponent(
  'GoogleSheetsValueRange',
  z.object({
    range: z.string().nullable(),
    majorDimension: z.string().nullable(),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).nullable(),
  }),
);

const SheetTabSchema = registerComponent(
  'GoogleSheetsTab',
  z.object({
    sheetId: z.number().nullable(),
    title: z.string().nullable(),
    index: z.number().nullable(),
    sheetType: z.string().nullable(),
    rowCount: z.number().nullable(),
    columnCount: z.number().nullable(),
  }),
);

const SpreadsheetMetadataSchema = registerComponent(
  'GoogleSheetsSpreadsheetMetadata',
  z.object({
    spreadsheetId: z.string().nullable(),
    title: z.string().nullable(),
    locale: z.string().nullable(),
    timeZone: z.string().nullable(),
    spreadsheetUrl: z.string().nullable(),
    sheets: z.array(SheetTabSchema),
  }),
);

const UpdateSummarySchema = z.object({
  spreadsheetId: z.string().nullable(),
  updatedRange: z.string().nullable(),
  updatedRows: z.number().nullable(),
  updatedColumns: z.number().nullable(),
  updatedCells: z.number().nullable(),
});

const SpreadsheetIdParamsSchema = z.object({
  spreadsheetId: z.string().min(1),
});

const ReadValuesQuerySchema = z.object({
  range: z.string().min(1).openapi({
    description: 'A1 notation range to read, e.g. `Sheet1!A1:C10`.',
    example: 'Sheet1!A1:C10',
  }),
  majorDimension: z.enum(['ROWS', 'COLUMNS']).optional(),
  valueRenderOption: z.enum(['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']).optional(),
  dateTimeRenderOption: z.enum(['SERIAL_NUMBER', 'FORMATTED_STRING']).optional(),
});

// A row of cell values written into a sheet. We only accept primitive cell
// values (string/number/boolean) or null for an explicitly empty cell.
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const valueMatrix = z
  .array(z.array(cellValue))
  .min(1)
  .openapi({
    description: 'Row-major matrix of cell values to write.',
    example: [
      ['Name', 'Score'],
      ['Alice', 42],
    ],
  });

const AppendValuesBodySchema = z
  .object({
    range: z.string().min(1).openapi({ example: 'Sheet1!A1' }),
    values: valueMatrix,
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional(),
    insertDataOption: z.enum(['OVERWRITE', 'INSERT_ROWS']).optional(),
    majorDimension: z.enum(['ROWS', 'COLUMNS']).optional(),
  })
  .strict();

const UpdateValuesBodySchema = z
  .object({
    range: z.string().min(1).openapi({ example: 'Sheet1!A1:B2' }),
    values: valueMatrix,
    valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional(),
    majorDimension: z.enum(['ROWS', 'COLUMNS']).optional(),
  })
  .strict();

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponse),
});

registerPath({
  method: 'get',
  path: '/api/google/sheets/{spreadsheetId}',
  tags: ['Google'],
  summary: 'Read spreadsheet metadata (title + tabs) for the calling user',
  request: { params: SpreadsheetIdParamsSchema },
  responses: {
    200: {
      description: 'Spreadsheet metadata with its sheet tabs.',
      content: jsonContent(SpreadsheetMetadataSchema),
    },
    400: errorResponse('Invalid spreadsheet id.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Sheets scope has not been granted.'),
    404: errorResponse('Spreadsheet not found.'),
    429: errorResponse('Google Sheets rate limit exceeded.'),
    502: errorResponse('Google Sheets request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'get',
  path: '/api/google/sheets/{spreadsheetId}/values',
  tags: ['Google'],
  summary: 'Read a range of values from a spreadsheet for the calling user',
  request: { params: SpreadsheetIdParamsSchema, query: ReadValuesQuerySchema },
  responses: {
    200: {
      description: 'The values in the requested range.',
      content: jsonContent(SheetsValueRangeSchema),
    },
    400: errorResponse('Invalid range or spreadsheet id.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Sheets scope has not been granted.'),
    404: errorResponse('Spreadsheet or range not found.'),
    429: errorResponse('Google Sheets rate limit exceeded.'),
    502: errorResponse('Google Sheets request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/google/sheets/{spreadsheetId}/values/append',
  tags: ['Google'],
  summary: 'Append rows of values to a spreadsheet for the calling user',
  request: {
    params: SpreadsheetIdParamsSchema,
    body: { content: jsonContent(AppendValuesBodySchema), required: true },
  },
  responses: {
    200: {
      description: 'Append summary including the affected range.',
      content: jsonContent(
        z.object({
          spreadsheetId: z.string().nullable(),
          tableRange: z.string().nullable(),
          updates: UpdateSummarySchema.nullable(),
        }),
      ),
    },
    400: errorResponse('Invalid body or spreadsheet id.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Sheets write scope has not been granted.'),
    404: errorResponse('Spreadsheet not found.'),
    429: errorResponse('Google Sheets rate limit exceeded.'),
    502: errorResponse('Google Sheets request failed.'),
    503: errorResponse('Google OAuth is not configured.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/google/sheets/{spreadsheetId}/values',
  tags: ['Google'],
  summary: 'Update a range of values in a spreadsheet for the calling user',
  request: {
    params: SpreadsheetIdParamsSchema,
    body: { content: jsonContent(UpdateValuesBodySchema), required: true },
  },
  responses: {
    200: {
      description: 'Update summary including the affected range.',
      content: jsonContent(UpdateSummarySchema),
    },
    400: errorResponse('Invalid body or spreadsheet id.'),
    401: errorResponse('Not authenticated or Google not connected.'),
    403: errorResponse('Required Sheets write scope has not been granted.'),
    404: errorResponse('Spreadsheet or range not found.'),
    429: errorResponse('Google Sheets rate limit exceeded.'),
    502: errorResponse('Google Sheets request failed.'),
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

function hasSheetsReadScope(scopes: string[]): boolean {
  // The full `spreadsheets` scope and the narrower readonly scope both read.
  return scopes.includes(SHEETS_SCOPE) || scopes.includes(SHEETS_READONLY_SCOPE);
}

function hasSheetsWriteScope(scopes: string[]): boolean {
  // Only the full `spreadsheets` scope can mutate; readonly cannot.
  return scopes.includes(SHEETS_SCOPE);
}

/**
 * Resolve the caller, verify Google is configured + connected, and check the
 * surface scope. Returns the resolved userId or null (a response has already
 * been sent). `requiredScopes` drives the 403 payload's affordance hint.
 */
function requireSheetsAccess(
  req: Request,
  res: Response,
  deps: RouteDeps,
  check: (scopes: string[]) => boolean,
  requiredScopes: string[],
  scopeCode: string,
): string | null {
  const uid = resolveOAuthConnectionUserId(req);
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
  if (!check(status.grantedScopes)) {
    bad(res, 403, 'Required Sheets access has not been granted', scopeCode, { requiredScopes });
    return null;
  }
  return uid;
}

async function resolveSheetsToken(
  userId: string,
  deps: RouteDeps,
  res: Response,
): Promise<string | null> {
  let token: string | null;
  try {
    token = await getActiveAccessToken(userId, deps.config.googleOAuth ?? null);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[google-sheets] Failed to resolve token for user ${userId}: ${msg}`);
    bad(res, 502, 'Failed to resolve Google access token', 'google_token_resolution_failed');
    return null;
  }
  if (!token) {
    bad(res, 401, 'Google account must be reconnected', 'google_reconnect_required');
    return null;
  }
  return token;
}

function createSheetsClient(accessToken: string): sheets_v4.Sheets {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.sheets({ version: 'v4', auth });
}

function shapeValueRange(
  data: sheets_v4.Schema$ValueRange,
): z.infer<typeof SheetsValueRangeSchema> {
  return {
    range: data.range ?? null,
    majorDimension: data.majorDimension ?? null,
    values: (data.values as Array<Array<string | number | boolean>> | undefined) ?? null,
  };
}

function shapeUpdateSummary(
  data: sheets_v4.Schema$UpdateValuesResponse,
): z.infer<typeof UpdateSummarySchema> {
  return {
    spreadsheetId: data.spreadsheetId ?? null,
    updatedRange: data.updatedRange ?? null,
    updatedRows: typeof data.updatedRows === 'number' ? data.updatedRows : null,
    updatedColumns: typeof data.updatedColumns === 'number' ? data.updatedColumns : null,
    updatedCells: typeof data.updatedCells === 'number' ? data.updatedCells : null,
  };
}

function shapeSpreadsheetMetadata(
  data: sheets_v4.Schema$Spreadsheet,
): z.infer<typeof SpreadsheetMetadataSchema> {
  return {
    spreadsheetId: data.spreadsheetId ?? null,
    title: data.properties?.title ?? null,
    locale: data.properties?.locale ?? null,
    timeZone: data.properties?.timeZone ?? null,
    spreadsheetUrl: data.spreadsheetUrl ?? null,
    sheets: (data.sheets ?? []).map((sheet) => ({
      sheetId: typeof sheet.properties?.sheetId === 'number' ? sheet.properties.sheetId : null,
      title: sheet.properties?.title ?? null,
      index: typeof sheet.properties?.index === 'number' ? sheet.properties.index : null,
      sheetType: sheet.properties?.sheetType ?? null,
      rowCount:
        typeof sheet.properties?.gridProperties?.rowCount === 'number'
          ? sheet.properties.gridProperties.rowCount
          : null,
      columnCount:
        typeof sheet.properties?.gridProperties?.columnCount === 'number'
          ? sheet.properties.gridProperties.columnCount
          : null,
    })),
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
    'Google Sheets request failed';

  if (status === 401) {
    return {
      status: 401,
      code: 'google_sheets_auth_failed',
      error: 'Google Sheets authorization failed. Reconnect Google in Account settings.',
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
        code: 'google_sheets_rate_limited',
        error: 'Google Sheets rate limit exceeded',
      };
    }
    return {
      status: 403,
      code: 'google_sheets_forbidden',
      error: 'Google Sheets access was denied',
    };
  }
  if (status === 404) {
    return {
      status: 404,
      code: 'google_sheets_not_found',
      error: 'Spreadsheet or range was not found',
    };
  }
  if (status === 429) {
    return {
      status: 429,
      code: 'google_sheets_rate_limited',
      error: 'Google Sheets rate limit exceeded',
    };
  }
  if (status >= 400 && status < 500) {
    return { status, code: 'google_sheets_bad_request', error: message.split('\n')[0] };
  }
  return { status: 502, code: 'google_sheets_upstream_failed', error: message.split('\n')[0] };
}

function sendGoogleError(res: Response, err: unknown): Response {
  const mapped = extractGoogleError(err);
  return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
}

export default function createGoogleSheetsRoutes(deps: RouteDeps): Router {
  const router = Router();

  router.get('/api/google/sheets/:spreadsheetId', async (req: Request, res: Response) => {
    const params = SpreadsheetIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      return bad(
        res,
        400,
        params.error.issues[0]?.message || 'Invalid spreadsheet id',
        'invalid_request',
      );
    }
    const uid = requireSheetsAccess(
      req,
      res,
      deps,
      hasSheetsReadScope,
      [SHEETS_SCOPE],
      'google_sheets_scope_required',
    );
    if (!uid) return;
    const token = await resolveSheetsToken(uid, deps, res);
    if (!token) return;

    try {
      const sheets = createSheetsClient(token);
      const result = await sheets.spreadsheets.get({
        spreadsheetId: params.data.spreadsheetId,
        includeGridData: false,
      });
      return res.json(shapeSpreadsheetMetadata(result.data));
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.get('/api/google/sheets/:spreadsheetId/values', async (req: Request, res: Response) => {
    const params = SpreadsheetIdParamsSchema.safeParse(req.params);
    const query = ReadValuesQuerySchema.safeParse(req.query);
    if (!params.success) {
      return bad(
        res,
        400,
        params.error.issues[0]?.message || 'Invalid spreadsheet id',
        'invalid_request',
      );
    }
    if (!query.success) {
      return bad(res, 400, query.error.issues[0]?.message || 'Invalid query', 'invalid_request');
    }
    const uid = requireSheetsAccess(
      req,
      res,
      deps,
      hasSheetsReadScope,
      [SHEETS_SCOPE],
      'google_sheets_scope_required',
    );
    if (!uid) return;
    const token = await resolveSheetsToken(uid, deps, res);
    if (!token) return;

    try {
      const sheets = createSheetsClient(token);
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: params.data.spreadsheetId,
        range: query.data.range,
        majorDimension: query.data.majorDimension,
        valueRenderOption: query.data.valueRenderOption,
        dateTimeRenderOption: query.data.dateTimeRenderOption,
      });
      return res.json(shapeValueRange(result.data));
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  router.post(
    '/api/google/sheets/:spreadsheetId/values/append',
    async (req: Request, res: Response) => {
      const params = SpreadsheetIdParamsSchema.safeParse(req.params);
      const body = AppendValuesBodySchema.safeParse(req.body);
      if (!params.success) {
        return bad(
          res,
          400,
          params.error.issues[0]?.message || 'Invalid spreadsheet id',
          'invalid_request',
        );
      }
      if (!body.success) {
        return bad(res, 400, body.error.issues[0]?.message || 'Invalid body', 'invalid_request');
      }
      const uid = requireSheetsAccess(
        req,
        res,
        deps,
        hasSheetsWriteScope,
        [SHEETS_SCOPE],
        'google_sheets_write_scope_required',
      );
      if (!uid) return;
      const token = await resolveSheetsToken(uid, deps, res);
      if (!token) return;

      try {
        const sheets = createSheetsClient(token);
        const result = await sheets.spreadsheets.values.append({
          spreadsheetId: params.data.spreadsheetId,
          range: body.data.range,
          valueInputOption: body.data.valueInputOption ?? 'USER_ENTERED',
          insertDataOption: body.data.insertDataOption,
          requestBody: {
            range: body.data.range,
            majorDimension: body.data.majorDimension,
            values: body.data.values,
          },
        });
        return res.json({
          spreadsheetId: result.data.spreadsheetId ?? null,
          tableRange: result.data.tableRange ?? null,
          updates: result.data.updates ? shapeUpdateSummary(result.data.updates) : null,
        });
      } catch (err: unknown) {
        return sendGoogleError(res, err);
      }
    },
  );

  router.put('/api/google/sheets/:spreadsheetId/values', async (req: Request, res: Response) => {
    const params = SpreadsheetIdParamsSchema.safeParse(req.params);
    const body = UpdateValuesBodySchema.safeParse(req.body);
    if (!params.success) {
      return bad(
        res,
        400,
        params.error.issues[0]?.message || 'Invalid spreadsheet id',
        'invalid_request',
      );
    }
    if (!body.success) {
      return bad(res, 400, body.error.issues[0]?.message || 'Invalid body', 'invalid_request');
    }
    const uid = requireSheetsAccess(
      req,
      res,
      deps,
      hasSheetsWriteScope,
      [SHEETS_SCOPE],
      'google_sheets_write_scope_required',
    );
    if (!uid) return;
    const token = await resolveSheetsToken(uid, deps, res);
    if (!token) return;

    try {
      const sheets = createSheetsClient(token);
      const result = await sheets.spreadsheets.values.update({
        spreadsheetId: params.data.spreadsheetId,
        range: body.data.range,
        valueInputOption: body.data.valueInputOption ?? 'USER_ENTERED',
        requestBody: {
          range: body.data.range,
          majorDimension: body.data.majorDimension,
          values: body.data.values,
        },
      });
      return res.json(shapeUpdateSummary(result.data));
    } catch (err: unknown) {
      return sendGoogleError(res, err);
    }
  });

  return router;
}
