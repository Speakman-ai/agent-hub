import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

const googleMock = vi.hoisted(() => {
  const values = { get: vi.fn(), append: vi.fn(), update: vi.fn() };
  const spreadsheets = { get: vi.fn(), values };
  const setCredentials = vi.fn();
  return {
    values,
    spreadsheets,
    setCredentials,
    sheets: vi.fn(() => ({ spreadsheets })),
    OAuth2: vi.fn(function OAuth2() {
      return { setCredentials };
    }),
  };
});

const connectionStoreMock = vi.hoisted(() => ({
  getActiveAccessToken: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: googleMock.OAuth2 },
    sheets: googleMock.sheets,
  },
}));

vi.mock('../google-connections-store.js', () => connectionStoreMock);

const createGoogleSheetsRoutes = (await import('./google-sheets.js')).default;

interface FakeAuth {
  authUserId?: string;
}

function buildDeps(overrides: Record<string, unknown> = {}): RouteDeps {
  return {
    config: {
      googleOAuth: {
        clientId: 'goog-client-id.apps.googleusercontent.com',
        clientSecret: 'goog-secret',
      },
      ...((overrides.config as object) || {}),
    },
  } as unknown as RouteDeps;
}

function makeApp(deps: RouteDeps, opts: FakeAuth = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as Request & FakeAuth;
    if (opts.authUserId) r.authUserId = opts.authUserId;
    next();
  });
  app.use(createGoogleSheetsRoutes(deps));
  return app;
}

function connectedStatus(scopes = [SHEETS_SCOPE]) {
  return {
    connected: true,
    email: 'user@example.com',
    grantedScopes: scopes,
    connectedAt: '2026-06-30T00:00:00.000Z',
    tokenExpiresAt: '2026-06-30T01:00:00.000Z',
  };
}

describe('Google Sheets proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connectedStatus());
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('fresh-access-token');
  });

  it('GET /:id/values reads a range and never leaks the token', async () => {
    googleMock.values.get.mockResolvedValue({
      data: {
        range: 'Sheet1!A1:B2',
        majorDimension: 'ROWS',
        values: [
          ['Name', 'Score'],
          ['Alice', 42],
        ],
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .get('/api/google/sheets/sheet-1/values')
      .query({ range: 'Sheet1!A1:B2', valueRenderOption: 'UNFORMATTED_VALUE' });

    expect(res.status).toBe(200);
    expect(connectionStoreMock.getActiveAccessToken).toHaveBeenCalledWith('user-123', {
      clientId: 'goog-client-id.apps.googleusercontent.com',
      clientSecret: 'goog-secret',
    });
    expect(googleMock.setCredentials).toHaveBeenCalledWith({ access_token: 'fresh-access-token' });
    expect(googleMock.values.get).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        range: 'Sheet1!A1:B2',
        valueRenderOption: 'UNFORMATTED_VALUE',
      }),
    );
    expect(res.body).toEqual({
      range: 'Sheet1!A1:B2',
      majorDimension: 'ROWS',
      values: [
        ['Name', 'Score'],
        ['Alice', 42],
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('fresh-access-token');
  });

  it('GET /:id/values requires the range query param', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/sheets/sheet-1/values');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.values.get).not.toHaveBeenCalled();
  });

  it('GET /:id reads spreadsheet metadata and shapes its tabs', async () => {
    googleMock.spreadsheets.get.mockResolvedValue({
      data: {
        spreadsheetId: 'sheet-1',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1',
        properties: { title: 'Budget', locale: 'en_US', timeZone: 'UTC' },
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: 'Tab A',
              index: 0,
              sheetType: 'GRID',
              gridProperties: { rowCount: 100, columnCount: 26 },
            },
          },
        ],
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/sheets/sheet-1');

    expect(res.status).toBe(200);
    expect(googleMock.spreadsheets.get).toHaveBeenCalledWith({
      spreadsheetId: 'sheet-1',
      includeGridData: false,
    });
    expect(res.body).toMatchObject({
      spreadsheetId: 'sheet-1',
      title: 'Budget',
      sheets: [{ sheetId: 0, title: 'Tab A', rowCount: 100, columnCount: 26 }],
    });
  });

  it('POST /:id/values/append writes rows and shapes the update summary', async () => {
    googleMock.values.append.mockResolvedValue({
      data: {
        spreadsheetId: 'sheet-1',
        tableRange: 'Sheet1!A1:B2',
        updates: {
          spreadsheetId: 'sheet-1',
          updatedRange: 'Sheet1!A3:B3',
          updatedRows: 1,
          updatedColumns: 2,
          updatedCells: 2,
        },
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/sheets/sheet-1/values/append')
      .send({ range: 'Sheet1!A1', values: [['Bob', 7]] });

    expect(res.status).toBe(200);
    expect(googleMock.values.append).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        range: 'Sheet1!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: expect.objectContaining({ values: [['Bob', 7]] }),
      }),
    );
    expect(res.body).toEqual({
      spreadsheetId: 'sheet-1',
      tableRange: 'Sheet1!A1:B2',
      updates: {
        spreadsheetId: 'sheet-1',
        updatedRange: 'Sheet1!A3:B3',
        updatedRows: 1,
        updatedColumns: 2,
        updatedCells: 2,
      },
    });
  });

  it('PUT /:id/values updates a range and shapes the summary', async () => {
    googleMock.values.update.mockResolvedValue({
      data: {
        spreadsheetId: 'sheet-1',
        updatedRange: 'Sheet1!A1:B2',
        updatedRows: 2,
        updatedColumns: 2,
        updatedCells: 4,
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .put('/api/google/sheets/sheet-1/values')
      .send({
        range: 'Sheet1!A1:B2',
        values: [
          ['a', 'b'],
          ['c', 'd'],
        ],
        valueInputOption: 'RAW',
      });

    expect(res.status).toBe(200);
    expect(googleMock.values.update).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: 'sheet-1',
        range: 'Sheet1!A1:B2',
        valueInputOption: 'RAW',
      }),
    );
    expect(res.body).toEqual({
      spreadsheetId: 'sheet-1',
      updatedRange: 'Sheet1!A1:B2',
      updatedRows: 2,
      updatedColumns: 2,
      updatedCells: 4,
    });
  });

  it('POST /:id/values/append rejects an empty value matrix before calling Google', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/sheets/sheet-1/values/append')
      .send({ range: 'Sheet1!A1', values: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.values.append).not.toHaveBeenCalled();
  });

  it('POST /:id/values/append rejects unknown body keys (strict)', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/sheets/sheet-1/values/append')
      .send({ range: 'Sheet1!A1', values: [['x']], spreadsheetId: 'evil' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(googleMock.values.append).not.toHaveBeenCalled();
  });

  it('lets a readonly-scoped connection read but not write', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connectedStatus([SHEETS_READONLY_SCOPE]),
    );
    googleMock.values.get.mockResolvedValue({ data: { range: 'A1', values: [['x']] } });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });

    const read = await request(app)
      .get('/api/google/sheets/sheet-1/values')
      .query({ range: 'Sheet1!A1' });
    expect(read.status).toBe(200);

    const write = await request(app)
      .post('/api/google/sheets/sheet-1/values/append')
      .send({ range: 'Sheet1!A1', values: [['x']] });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({
      code: 'google_sheets_write_scope_required',
      requiredScopes: [SHEETS_SCOPE],
    });
    expect(googleMock.values.append).not.toHaveBeenCalled();
  });

  it('returns 403 with the scope hint when no Sheets scope was granted', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connectedStatus(['openid']));

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .get('/api/google/sheets/sheet-1/values')
      .query({ range: 'Sheet1!A1' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_sheets_scope_required',
      requiredScopes: [SHEETS_SCOPE],
    });
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.values.get).not.toHaveBeenCalled();
  });

  it('maps Sheets quota errors to 429', async () => {
    googleMock.values.get.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
        },
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .get('/api/google/sheets/sheet-1/values')
      .query({ range: 'Sheet1!A1' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('google_sheets_rate_limited');
  });

  it('maps a 404 from Google to a 404 not-found error', async () => {
    googleMock.values.get.mockRejectedValueOnce({ response: { status: 404, data: {} } });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .get('/api/google/sheets/missing/values')
      .query({ range: 'Sheet1!A1' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('google_sheets_not_found');
  });

  it('returns 401 when no request user can be resolved', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app)
      .get('/api/google/sheets/sheet-1/values')
      .query({ range: 'Sheet1!A1' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('authentication_required');
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
  });

  it('returns 503 when Google OAuth is not configured on the server', async () => {
    const app = makeApp(buildDeps({ config: { googleOAuth: undefined } }), {
      authUserId: 'user-1',
    });
    const res = await request(app)
      .get('/api/google/sheets/sheet-1/values')
      .query({ range: 'Sheet1!A1' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('google_oauth_not_configured');
  });
});
