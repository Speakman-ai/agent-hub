import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

const googleMock = vi.hoisted(() => {
  const files = { list: vi.fn(), get: vi.fn() };
  const setCredentials = vi.fn();
  return {
    files,
    setCredentials,
    drive: vi.fn(() => ({ files })),
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
    drive: googleMock.drive,
  },
}));

vi.mock('../google-connections-store.js', () => connectionStoreMock);

const createGoogleDriveRoutes = (await import('./google-drive.js')).default;

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
  app.use(createGoogleDriveRoutes(deps));
  return app;
}

function connectedStatus(scopes = [DRIVE_FILE_SCOPE]) {
  return {
    connected: true,
    email: 'user@example.com',
    grantedScopes: scopes,
    connectedAt: '2026-06-30T00:00:00.000Z',
    tokenExpiresAt: '2026-06-30T01:00:00.000Z',
  };
}

describe('Google Drive picker proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connectedStatus());
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('fresh-access-token');
  });

  it('GET /files lists app-accessible files and never leaks the token', async () => {
    googleMock.files.list.mockResolvedValue({
      data: {
        files: [
          {
            id: 'f1',
            name: 'Q2.pdf',
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/f1',
            modifiedTime: '2026-06-30T00:00:00.000Z',
            size: '2048',
            owners: [{ displayName: 'Alice', emailAddress: 'alice@example.com' }],
            trashed: false,
          },
        ],
        nextPageToken: 'page-2',
        incompleteSearch: false,
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .get('/api/google/drive/files')
      .query({ q: "mimeType = 'application/pdf'", pageSize: '10', orderBy: 'modifiedTime desc' });

    expect(res.status).toBe(200);
    expect(googleMock.setCredentials).toHaveBeenCalledWith({ access_token: 'fresh-access-token' });
    expect(googleMock.files.list).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "mimeType = 'application/pdf'",
        pageSize: 10,
        orderBy: 'modifiedTime desc',
        spaces: 'drive',
        corpora: 'user',
      }),
    );
    expect(res.body).toEqual({
      files: [
        {
          id: 'f1',
          name: 'Q2.pdf',
          mimeType: 'application/pdf',
          iconLink: null,
          webViewLink: 'https://drive.google.com/file/d/f1',
          modifiedTime: '2026-06-30T00:00:00.000Z',
          createdTime: null,
          size: '2048',
          owners: [{ displayName: 'Alice', emailAddress: 'alice@example.com' }],
          trashed: false,
        },
      ],
      nextPageToken: 'page-2',
      incompleteSearch: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('fresh-access-token');
  });

  it('GET /files requests only the fixed drive.file field projection', async () => {
    googleMock.files.list.mockResolvedValue({ data: { files: [] } });
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    await request(app).get('/api/google/drive/files');

    const arg = googleMock.files.list.mock.calls[0][0];
    // The caller cannot widen the projection; we always send our own fields.
    expect(arg.fields).toContain('files(');
    expect(arg.fields).toContain('webViewLink');
    expect(arg.spaces).toBe('drive');
  });

  it('GET /files/:id reads a single file metadata', async () => {
    googleMock.files.get.mockResolvedValue({
      data: { id: 'f1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/drive/files/f1');

    expect(res.status).toBe(200);
    expect(googleMock.files.get).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'f1' }));
    expect(res.body).toMatchObject({ id: 'f1', name: 'Notes' });
  });

  it('rejects a connection that only granted restricted drive.readonly (no drive.file)', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connectedStatus([DRIVE_READONLY_SCOPE]),
    );

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/drive/files');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_drive_scope_required',
      requiredScopes: [DRIVE_FILE_SCOPE],
    });
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.files.list).not.toHaveBeenCalled();
  });

  it('rejects a connection that only granted full restricted drive scope (no drive.file)', async () => {
    // The picker gate is drive.file ONLY — the restricted scopes are never
    // requested, so they must not satisfy the gate either.
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connectedStatus([DRIVE_FULL_SCOPE]),
    );

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/drive/files');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('google_drive_scope_required');
    expect(googleMock.files.list).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range pageSize', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/drive/files').query({ pageSize: '500' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(googleMock.files.list).not.toHaveBeenCalled();
  });

  it('maps Drive quota errors to 429', async () => {
    googleMock.files.list.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: {
            message: 'User Rate Limit Exceeded',
            errors: [{ reason: 'userRateLimitExceeded' }],
          },
        },
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/drive/files');

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('google_drive_rate_limited');
  });

  it('maps a 404 from Google to a 404 not-found error', async () => {
    googleMock.files.get.mockRejectedValueOnce({ response: { status: 404, data: {} } });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/drive/files/missing');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('google_drive_not_found');
  });

  it('returns 401 when no request user can be resolved', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/google/drive/files');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('authentication_required');
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
  });

  it('returns 503 when Google OAuth is not configured on the server', async () => {
    const app = makeApp(buildDeps({ config: { googleOAuth: undefined } }), {
      authUserId: 'user-1',
    });
    const res = await request(app).get('/api/google/drive/files');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('google_oauth_not_configured');
  });
});
