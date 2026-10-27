/**
 * Default vs explicit `account` selection across the Google proxies, against
 * the real connections store (googleapis is mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';

let TMP_DIR = '';
vi.mock('../config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const CAL = 'https://www.googleapis.com/auth/calendar.events';
const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const SHEETS = 'https://www.googleapis.com/auth/spreadsheets';
const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';

const googleMock = vi.hoisted(() => {
  const tokens: string[] = [];
  const events = { list: vi.fn() };
  const threads = { list: vi.fn() };
  const messages = { send: vi.fn() };
  const values = { get: vi.fn() };
  const files = { list: vi.fn() };
  return {
    tokens,
    events,
    threads,
    messages,
    values,
    files,
    OAuth2: vi.fn(function OAuth2() {
      return {
        setCredentials: (c: { access_token: string }) => tokens.push(c.access_token),
      };
    }),
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: googleMock.OAuth2 },
    calendar: () => ({ events: googleMock.events }),
    gmail: () => ({ users: { threads: googleMock.threads, messages: googleMock.messages } }),
    sheets: () => ({ spreadsheets: { values: googleMock.values } }),
    drive: () => ({ files: googleMock.files }),
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { __resetSecretCryptoForTests } = await import('../secret-crypto.js');
const { upsertGoogleConnection } = await import('../google-connections-store.js');
const createGoogleCalendarRoutes = (await import('./google-calendar.js')).default;
const createGoogleGmailRoutes = (await import('./google-gmail.js')).default;
const createGoogleSheetsRoutes = (await import('./google-sheets.js')).default;
const createGoogleDriveRoutes = (await import('./google-drive.js')).default;
const createGoogleAccountsRoutes = (await import('./google-accounts.js')).default;

const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'google-multi-account-test-'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

function link(userId: string, sub: string, email: string, scopes: string[]): string {
  return upsertGoogleConnection({
    userId,
    googleSub: sub,
    googleEmail: email,
    accessToken: `token-${sub}`,
    tokenExpiresAt: FAR_FUTURE,
    refreshToken: `refresh-${sub}`,
    grantedScopes: ['openid', 'email', ...scopes],
  });
}

function makeApp(authUserId: string, getSession?: { get(id: string): unknown }) {
  const deps = {
    config: { googleOAuth: { clientId: 'cid', clientSecret: 'secret' } },
    stmts: getSession ? { getSession } : {},
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authUserId) (req as Request & { authUserId?: string }).authUserId = authUserId;
    next();
  });
  app.use(createGoogleCalendarRoutes(deps));
  app.use(createGoogleGmailRoutes(deps));
  app.use(createGoogleSheetsRoutes(deps));
  app.use(createGoogleDriveRoutes(deps));
  app.use(createGoogleAccountsRoutes(deps));
  return app;
}

const CAL_QUERY = { timeMin: '2026-06-30T00:00:00Z', timeMax: '2026-07-01T00:00:00Z' };
const ALL = [CAL, GMAIL_MODIFY, SHEETS, DRIVE_FILE];

describe('Google proxies — account selection', () => {
  let userId = '';
  let homeId = '';
  let workId = '';

  beforeEach(() => {
    vi.clearAllMocks();
    googleMock.tokens.length = 0;
    freshDb();
    userId = createUser({ username: 'alice', passwordHash: 'x' }).id;
    homeId = link(userId, 'sub-home', 'alice@home.com', ALL);
    workId = link(userId, 'sub-work', 'alice@work.com', [CAL, GMAIL_MODIFY]);
    googleMock.events.list.mockResolvedValue({ data: { items: [] } });
    googleMock.threads.list.mockResolvedValue({ data: { threads: [] } });
    googleMock.values.get.mockResolvedValue({ data: { values: [] } });
    googleMock.files.list.mockResolvedValue({ data: { files: [] } });
  });

  it('uses the default account when account is omitted', async () => {
    const app = makeApp(userId);
    const res = await request(app).get('/api/google/calendar/events').query(CAL_QUERY);
    expect(res.status).toBe(200);
    expect(googleMock.tokens).toEqual(['token-sub-home']);
    expect(res.headers['x-google-account']).toBe('alice@home.com');
  });

  it('selects an account by email (case-insensitive) or by id on every surface', async () => {
    const app = makeApp(userId);
    const cal = await request(app)
      .get('/api/google/calendar/events')
      .query({ ...CAL_QUERY, account: 'Alice@Work.com' });
    expect(cal.status).toBe(200);
    expect(cal.headers['x-google-account']).toBe('alice@work.com');

    const mail = await request(app).get('/api/google/gmail/threads').query({ account: workId });
    expect(mail.status).toBe(200);
    expect(mail.headers['x-google-account']).toBe('alice@work.com');

    const sheet = await request(app)
      .get('/api/google/sheets/sheet-1/values')
      .query({ range: 'A1:B2', account: homeId });
    expect(sheet.status).toBe(200);

    const drive = await request(app)
      .get('/api/google/drive/files')
      .query({ account: 'alice@home.com' });
    expect(drive.status).toBe(200);

    expect(googleMock.tokens).toEqual([
      'token-sub-work',
      'token-sub-work',
      'token-sub-home',
      'token-sub-home',
    ]);
  });

  it('follows the default when it moves', async () => {
    link(userId, 'sub-work', 'alice@work.com', [CAL, GMAIL_MODIFY]);
    const { setDefaultGoogleConnection } = await import('../google-connections-store.js');
    setDefaultGoogleConnection(userId, workId);
    const res = await request(makeApp(userId)).get('/api/google/gmail/threads');
    expect(res.status).toBe(200);
    expect(googleMock.tokens).toEqual(['token-sub-work']);
  });

  it('returns 404 google_account_not_found for an unlinked account and never falls back', async () => {
    const app = makeApp(userId);
    for (const account of ['bob@elsewhere.com', 'no-such-id']) {
      const res = await request(app)
        .get('/api/google/calendar/events')
        .query({ ...CAL_QUERY, account });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('google_account_not_found');
      expect(res.body.account).toBe(account);
      expect(res.body.error).toContain(account);
    }
    expect(googleMock.events.list).not.toHaveBeenCalled();
  });

  it('returns 404 for an explicit account even when nothing is linked; 401 only when omitted', async () => {
    const other = createUser({ username: 'bob', passwordHash: 'x' }).id;
    const app = makeApp(other);
    const named = await request(app).get('/api/google/drive/files').query({ account: 'bob@x.com' });
    expect(named.status).toBe(404);
    expect(named.body.code).toBe('google_account_not_found');

    const omitted = await request(app).get('/api/google/drive/files');
    expect(omitted.status).toBe(401);
    expect(omitted.body.code).toBe('google_not_connected');
  });

  it('rejects a blank or repeated account on write routes without calling Google', async () => {
    const app = makeApp(userId);
    const body = { to: ['a@example.com'], subject: 'Hi', text: 'Body' };
    for (const qs of ['account=%20', 'account=', 'account=a%40x.com&account=b%40x.com']) {
      const res = await request(app).post(`/api/google/gmail/messages?${qs}`).send(body);
      expect(res.status, qs).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    }
    expect(googleMock.tokens).toEqual([]);
    expect(googleMock.messages.send).not.toHaveBeenCalled();
  });

  it('checks scopes per account and names the account in the error', async () => {
    const app = makeApp(userId);
    const sheets = await request(app)
      .get('/api/google/sheets/sheet-1/values')
      .query({ range: 'A1:B2', account: 'alice@work.com' });
    expect(sheets.status).toBe(403);
    expect(sheets.body.code).toBe('google_sheets_scope_required');
    expect(sheets.body.account).toBe('alice@work.com');
    expect(sheets.body.error).toContain('alice@work.com');

    // The default account holds the Sheets grant, so the same call without a
    // selector succeeds.
    const ok = await request(app).get('/api/google/sheets/sheet-1/values').query({ range: 'A1' });
    expect(ok.status).toBe(200);
  });

  it('GET /api/google/accounts lists accounts default first', async () => {
    const res = await request(makeApp(userId)).get('/api/google/accounts');
    expect(res.status).toBe(200);
    expect(res.body.defaultAccountId).toBe(homeId);
    expect(res.body.accounts.map((a: { email: string }) => a.email)).toEqual([
      'alice@home.com',
      'alice@work.com',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('token-');
  });

  it('GET /api/google/accounts resolves the session owner on the break-glass key', async () => {
    const getSession = {
      get: (id: string) => (id === 'sess-1' ? { id, owner_user_id: userId } : undefined),
    };
    const res = await request(makeApp('', getSession))
      .get('/api/google/accounts')
      .set('X-Agent-Hub-Session-Id', 'sess-1');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(2);
  });
});
