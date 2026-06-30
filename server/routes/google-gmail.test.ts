import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const googleMock = vi.hoisted(() => {
  const threads = { list: vi.fn(), get: vi.fn() };
  const messages = { send: vi.fn(), modify: vi.fn() };
  const setCredentials = vi.fn();
  return {
    threads,
    messages,
    setCredentials,
    gmail: vi.fn(() => ({ users: { threads, messages } })),
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
    gmail: googleMock.gmail,
  },
}));

vi.mock('../google-connections-store.js', () => connectionStoreMock);

const createGoogleGmailRoutes = (await import('./google-gmail.js')).default;

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
  app.use(createGoogleGmailRoutes(deps));
  return app;
}

function connectedStatus(scopes = [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE]) {
  return {
    connected: true,
    email: 'user@example.com',
    grantedScopes: scopes,
    connectedAt: '2026-06-30T00:00:00.000Z',
    tokenExpiresAt: '2026-06-30T01:00:00.000Z',
  };
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64url');
}

describe('Google Gmail proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connectedStatus());
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('fresh-access-token');
  });

  it('GET /threads lists threads with pagination and never leaks the token', async () => {
    googleMock.threads.list.mockResolvedValue({
      data: {
        threads: [
          { id: 't1', snippet: 'Hello there', historyId: '101' },
          { id: 't2', snippet: 'Second', historyId: '102' },
        ],
        nextPageToken: 'page-2',
        resultSizeEstimate: 2,
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .get('/api/google/gmail/threads')
      .query({ q: 'is:unread', labelIds: 'INBOX', maxResults: '25', pageToken: 'page-1' });

    expect(res.status).toBe(200);
    expect(connectionStoreMock.getActiveAccessToken).toHaveBeenCalledWith('user-123', {
      clientId: 'goog-client-id.apps.googleusercontent.com',
      clientSecret: 'goog-secret',
    });
    expect(googleMock.setCredentials).toHaveBeenCalledWith({ access_token: 'fresh-access-token' });
    expect(googleMock.threads.list).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        q: 'is:unread',
        labelIds: ['INBOX'],
        maxResults: 25,
        pageToken: 'page-1',
      }),
    );
    expect(res.body).toEqual({
      threads: [
        { id: 't1', snippet: 'Hello there', historyId: '101' },
        { id: 't2', snippet: 'Second', historyId: '102' },
      ],
      nextPageToken: 'page-2',
      resultSizeEstimate: 2,
    });
    expect(JSON.stringify(res.body)).not.toContain('fresh-access-token');
  });

  it('GET /threads/:id reads a thread and shapes message headers + decoded bodies', async () => {
    googleMock.threads.get.mockResolvedValue({
      data: {
        id: 't1',
        historyId: '101',
        messages: [
          {
            id: 'm1',
            threadId: 't1',
            labelIds: ['INBOX', 'UNREAD'],
            snippet: 'Hi',
            historyId: '101',
            internalDate: '1719700000000',
            sizeEstimate: 2048,
            payload: {
              headers: [
                { name: 'From', value: 'alice@example.com' },
                { name: 'To', value: 'user@example.com' },
                { name: 'Subject', value: 'Greetings' },
                { name: 'Date', value: 'Mon, 30 Jun 2026 09:00:00 -0700' },
                { name: 'Message-ID', value: '<abc@mail.example.com>' },
              ],
              parts: [
                {
                  mimeType: 'text/plain',
                  body: { data: b64url('plain body') },
                },
                {
                  mimeType: 'text/html',
                  body: { data: b64url('<p>html body</p>') },
                },
              ],
            },
          },
        ],
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/gmail/threads/t1');

    expect(res.status).toBe(200);
    expect(googleMock.threads.get).toHaveBeenCalledWith({ userId: 'me', id: 't1', format: 'full' });
    expect(res.body.id).toBe('t1');
    expect(res.body.messages[0]).toMatchObject({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      from: 'alice@example.com',
      to: 'user@example.com',
      subject: 'Greetings',
      messageIdHeader: '<abc@mail.example.com>',
      sizeEstimate: 2048,
      bodyText: 'plain body',
      bodyHtml: '<p>html body</p>',
    });
  });

  it('POST /messages builds a base64url RFC2822 message and sends it', async () => {
    googleMock.messages.send.mockResolvedValue({
      data: { id: 'sent-1', threadId: 'th-9', labelIds: ['SENT'] },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/gmail/messages')
      .send({
        to: ['bob@example.com', 'carol@example.com'],
        cc: ['dave@example.com'],
        subject: 'Status update for the team',
        text: 'plain content',
        html: '<b>rich content</b>',
        threadId: 'th-9',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'sent-1', threadId: 'th-9', labelIds: ['SENT'] });

    const sendArg = googleMock.messages.send.mock.calls[0][0];
    expect(sendArg.userId).toBe('me');
    expect(sendArg.requestBody.threadId).toBe('th-9');
    const decoded = Buffer.from(sendArg.requestBody.raw, 'base64url').toString('utf-8');
    expect(decoded).toContain('To: bob@example.com, carol@example.com');
    expect(decoded).toContain('Cc: dave@example.com');
    // Spaces in a subject are legal single-line content and must survive.
    expect(decoded).toContain('Subject: Status update for the team');
    expect(decoded).toContain('multipart/alternative');
    expect(decoded).toContain('plain content');
    expect(decoded).toContain('<b>rich content</b>');
  });

  it('POST /messages rejects CRLF header injection in subject/inReplyTo/references', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });

    for (const overrides of [
      { subject: 'Hello\r\nBcc: victim@example.com' },
      { subject: 'Hello\nBcc: victim@example.com' },
      { inReplyTo: '<id@x>\r\nX-Evil: 1' },
      { references: '<a@x>\r\nX-Evil: 1' },
    ]) {
      const res = await request(app)
        .post('/api/google/gmail/messages')
        .send({ to: ['bob@example.com'], text: 'hi', ...overrides });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    }

    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.messages.send).not.toHaveBeenCalled();
  });

  it('GET /threads forwards includeSpamTrash exactly as opted in/out', async () => {
    googleMock.threads.list.mockResolvedValue({ data: { threads: [] } });
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });

    await request(app).get('/api/google/gmail/threads').query({ includeSpamTrash: 'false' });
    expect(googleMock.threads.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeSpamTrash: false }),
    );

    await request(app).get('/api/google/gmail/threads').query({ includeSpamTrash: 'true' });
    expect(googleMock.threads.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeSpamTrash: true }),
    );

    // A non-boolean string is rejected rather than silently coerced to true.
    const bad = await request(app)
      .get('/api/google/gmail/threads')
      .query({ includeSpamTrash: 'yes' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_request');
  });

  it('POST /messages rejects a body with neither text nor html before calling Google', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/gmail/messages')
      .send({ to: ['bob@example.com'], subject: 'Empty' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.messages.send).not.toHaveBeenCalled();
  });

  it('POST /messages/:id/modify adds and removes labels', async () => {
    googleMock.messages.modify.mockResolvedValue({
      data: { id: 'm1', threadId: 't1', labelIds: ['INBOX'] },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/gmail/messages/m1/modify')
      .send({ addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] });

    expect(res.status).toBe(200);
    expect(googleMock.messages.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'm1',
      requestBody: { addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] },
    });
    expect(res.body).toMatchObject({ id: 'm1', labelIds: ['INBOX'] });
  });

  it('POST /messages/:id/modify rejects an empty label change before calling Google', async () => {
    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).post('/api/google/gmail/messages/m1/modify').send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(googleMock.messages.modify).not.toHaveBeenCalled();
  });

  it('returns 403 with the modify scope hint when only the readonly scope was granted', async () => {
    // gmail.readonly is the restricted scope we deliberately never request — it
    // must NOT satisfy our read gate (which keys on gmail.modify).
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connectedStatus([GMAIL_READONLY_SCOPE]),
    );

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/gmail/threads');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_gmail_scope_required',
      requiredScopes: [GMAIL_MODIFY_SCOPE],
    });
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(googleMock.threads.list).not.toHaveBeenCalled();
  });

  it('returns 403 with the send scope hint when only the modify scope is missing for send', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connectedStatus(['openid']));

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/gmail/messages')
      .send({ to: ['bob@example.com'], text: 'hi' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_gmail_send_scope_required',
      requiredScopes: [GMAIL_SEND_SCOPE],
    });
    expect(googleMock.messages.send).not.toHaveBeenCalled();
  });

  it('lets a modify-scoped connection send (modify implies send)', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connectedStatus([GMAIL_MODIFY_SCOPE]),
    );
    googleMock.messages.send.mockResolvedValue({ data: { id: 'sent-2', labelIds: ['SENT'] } });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app)
      .post('/api/google/gmail/messages')
      .send({ to: ['bob@example.com'], text: 'hi' });

    expect(res.status).toBe(201);
    expect(googleMock.messages.send).toHaveBeenCalled();
  });

  it('maps Gmail quota errors to 429', async () => {
    googleMock.threads.list.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] },
        },
      },
    });

    const app = makeApp(buildDeps(), { authUserId: 'user-123' });
    const res = await request(app).get('/api/google/gmail/threads');

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('google_gmail_rate_limited');
  });

  it('maps token resolution failures to JSON errors before calling Google', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    connectionStoreMock.getActiveAccessToken.mockRejectedValueOnce(new Error('database is locked'));
    try {
      const app = makeApp(buildDeps(), { authUserId: 'user-123' });
      const res = await request(app).get('/api/google/gmail/threads');
      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: 'Failed to resolve Google access token',
        code: 'google_token_resolution_failed',
      });
      expect(googleMock.threads.list).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns 401 when no request user can be resolved', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/google/gmail/threads');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('authentication_required');
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
  });

  it('returns 503 when Google OAuth is not configured on the server', async () => {
    const app = makeApp(buildDeps({ config: { googleOAuth: undefined } }), {
      authUserId: 'user-1',
    });
    const res = await request(app).get('/api/google/gmail/threads');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('google_oauth_not_configured');
  });
});
