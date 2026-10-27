import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

let TMP_DIR = '';
vi.mock('../config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

vi.mock('../hub-assistant.js', () => ({
  resolveHubEngineAndModel: () => ({ engine: 'claude-code', model: 'sonnet' }),
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { __resetSecretCryptoForTests } = await import('../secret-crypto.js');
const { upsertGoogleConnection } = await import('../google-connections-store.js');

function linkAccount(userId: string, sub: string, email: string, scopes: string[]): string {
  return upsertGoogleConnection({
    userId,
    googleSub: sub,
    googleEmail: email,
    accessToken: 'at',
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'rt',
    grantedScopes: scopes,
  });
}
const store = await import('../gmail-importance-store.js');
const createGmailImportanceRoutes = (await import('./gmail-importance.js')).default;

const NOW = Date.parse('2026-10-12T12:00:00.000Z');

function deps(): RouteDeps {
  return {
    config: { googleOAuth: { clientId: 'id', clientSecret: 'secret' } },
    stmts: {},
  } as unknown as RouteDeps;
}

function makeApp(userId: string | null, scanDeps = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) (req as Request & { authUserId?: string }).authUserId = userId;
    next();
  });
  app.use(createGmailImportanceRoutes(deps(), { scanDeps, now: () => NOW }));
  return app;
}

describe('Gmail importance routes', () => {
  let userId = '';
  let key = { userId: '', accountId: '' };
  beforeEach(() => {
    vi.clearAllMocks();
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'gmail-importance-routes-'));
    __resetSecretCryptoForTests();
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    userId = createUser({ username: 'alice', passwordHash: 'x' }).id;
    key = {
      userId,
      accountId: linkAccount(userId, 'sub-alice', 'alice@example.com', [GMAIL_READONLY_SCOPE]),
    };
  });

  it('returns off-by-default settings and only in-window important threads', async () => {
    store.upsertGmailImportanceVerdicts(key, [
      {
        threadId: 'recent',
        historyId: 'h1',
        important: true,
        score: 80,
        reason: 'Deadline',
        subject: 'Q4 numbers',
        from: 'boss@example.com',
        snippet: 'Need these today',
        lastMessageAt: new Date(NOW - 2 * 86_400_000).toISOString(),
      },
      {
        threadId: 'old',
        historyId: 'h2',
        important: true,
        score: 99,
        reason: 'Old',
        subject: null,
        from: null,
        snippet: null,
        lastMessageAt: new Date(NOW - 20 * 86_400_000).toISOString(),
      },
      {
        threadId: 'noise',
        historyId: 'h3',
        important: false,
        score: 3,
        reason: null,
        subject: null,
        from: null,
        snippet: null,
        lastMessageAt: new Date(NOW - 3600_000).toISOString(),
      },
    ]);

    const res = await request(makeApp(userId)).get('/api/google/gmail/importance');
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ enabled: false, windowDays: 7, autoScan: 'off' });
    expect(res.body.running).toBe(false);
    expect(res.body.threads.map((t: { threadId: string }) => t.threadId)).toEqual(['recent']);

    const wide = await request(makeApp(userId))
      .put('/api/google/gmail/importance/settings')
      .send({ enabled: true, windowDays: 30, autoScan: 'every6h' });
    expect(wide.status).toBe(200);
    expect(wide.body.settings).toMatchObject({
      enabled: true,
      windowDays: 30,
      autoScan: 'every6h',
    });
    expect(wide.body.threads.map((t: { threadId: string }) => t.threadId)).toEqual([
      'old',
      'recent',
    ]);
  });

  it('dismisses a pinned thread until a newer message arrives', async () => {
    const at = new Date(NOW - 86_400_000).toISOString();
    const verdict = {
      threadId: 'pin',
      historyId: 'h1',
      important: true,
      score: 70,
      reason: 'Needs reply',
      subject: 'Contract',
      from: 'legal@example.com',
      snippet: null,
      lastMessageAt: at,
    };
    store.upsertGmailImportanceVerdicts(key, [verdict]);

    const res = await request(makeApp(userId)).post(
      '/api/google/gmail/importance/threads/pin/dismiss',
    );
    expect(res.status).toBe(200);
    expect(res.body.threads).toEqual([]);

    // A rescan with no new mail (only a label/history change) keeps it hidden.
    store.upsertGmailImportanceVerdicts(key, [{ ...verdict, historyId: 'h2' }]);
    const same = await request(makeApp(userId)).get('/api/google/gmail/importance');
    expect(same.body.threads).toEqual([]);

    // A newer message brings it back.
    store.upsertGmailImportanceVerdicts(key, [
      { ...verdict, historyId: 'h3', lastMessageAt: new Date(NOW - 3600_000).toISOString() },
    ]);
    const back = await request(makeApp(userId)).get('/api/google/gmail/importance');
    expect(back.body.threads.map((t: { threadId: string }) => t.threadId)).toEqual(['pin']);
  });

  it('404s dismissing an unknown thread and 401s without a user', async () => {
    const missing = await request(makeApp(userId)).post(
      '/api/google/gmail/importance/threads/nope/dismiss',
    );
    expect(missing.status).toBe(404);
    const anon = await request(makeApp(null)).post(
      '/api/google/gmail/importance/threads/nope/dismiss',
    );
    expect(anon.status).toBe(401);
  });

  it('rejects windows other than 1, 7, or 30 days and unknown cadences', async () => {
    const app = makeApp(userId);
    expect(
      (await request(app).put('/api/google/gmail/importance/settings').send({ windowDays: 3 }))
        .status,
    ).toBe(400);
    expect(
      (await request(app).put('/api/google/gmail/importance/settings').send({ autoScan: 'weekly' }))
        .status,
    ).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(makeApp(null)).get('/api/google/gmail/importance');
    expect(res.status).toBe(401);
  });

  it('refuses to scan an account without Gmail read scope', async () => {
    linkAccount(userId, 'sub-cal', 'cal@example.com', []);
    const res = await request(makeApp(userId))
      .post('/api/google/gmail/importance/scan?account=cal@example.com')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('google_gmail_scope_required');
    expect(res.body.account).toBe('cal@example.com');
  });

  it('scopes every route to the account named in `account`, default when omitted', async () => {
    const workId = linkAccount(userId, 'sub-work', 'me@work.example', [GMAIL_READONLY_SCOPE]);
    const work = { userId, accountId: workId };
    const verdict = (threadId: string) => ({
      threadId,
      historyId: 'h',
      important: true,
      score: 50,
      reason: null,
      subject: null,
      from: null,
      snippet: null,
      lastMessageAt: new Date(NOW - 3600_000).toISOString(),
    });
    store.upsertGmailImportanceVerdicts(key, [verdict('home-thread')]);
    store.upsertGmailImportanceVerdicts(work, [verdict('work-thread')]);
    const app = makeApp(userId);

    const byDefault = await request(app).get('/api/google/gmail/importance');
    expect(byDefault.body.account).toEqual({
      accountId: key.accountId,
      email: 'alice@example.com',
    });
    expect(byDefault.body.threads.map((t: { threadId: string }) => t.threadId)).toEqual([
      'home-thread',
    ]);

    const byEmail = await request(app).get('/api/google/gmail/importance?account=ME@work.example');
    expect(byEmail.body.account.accountId).toBe(workId);
    expect(byEmail.body.threads.map((t: { threadId: string }) => t.threadId)).toEqual([
      'work-thread',
    ]);

    const saved = await request(app)
      .put(`/api/google/gmail/importance/settings?account=${workId}`)
      .send({ enabled: true, autoScan: 'daily' });
    expect(saved.status).toBe(200);
    expect(store.getGmailImportanceSettings(work)).toMatchObject({ enabled: true });
    expect(store.getGmailImportanceSettings(key).enabled).toBe(false);

    // Dismissing on the wrong mailbox finds nothing.
    const wrongBox = await request(app).post(
      '/api/google/gmail/importance/threads/work-thread/dismiss',
    );
    expect(wrongBox.status).toBe(404);

    const unknown = await request(app).get('/api/google/gmail/importance?account=nobody@x.example');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('google_account_not_found');
  });

  it('returns default state for a user with no linked account but 401s writes', async () => {
    const lonely = createUser({ username: 'nobody', passwordHash: 'x' }).id;
    const app = makeApp(lonely);
    const res = await request(app).get('/api/google/gmail/importance');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ account: null, running: false, threads: [] });
    const put = await request(app)
      .put('/api/google/gmail/importance/settings')
      .send({ enabled: true });
    expect(put.status).toBe(401);
    expect(put.body.code).toBe('google_not_connected');
  });

  it('refuses a window change while a scan runs, but allows other settings', async () => {
    store.updateGmailImportanceSettings(key, { enabled: true, windowDays: 1 });
    let release: (v: string) => void = () => {};
    const tokenGate = new Promise<string>((r) => (release = r));
    const app = makeApp(userId, {
      resolveToken: () => tokenGate,
      createSource: () => ({
        listThreadIds: async () => [],
        getThread: vi.fn(),
        getThreadLabels: vi.fn(),
      }),
      now: () => NOW,
    });
    // Another client (or the auto-scan ticker) started a 1-day scan.
    expect((await request(app).post('/api/google/gmail/importance/scan').send({})).status).toBe(
      202,
    );

    const widen = await request(app)
      .put('/api/google/gmail/importance/settings')
      .send({ windowDays: 30 });
    expect(widen.status).toBe(409);
    expect(widen.body.code).toBe('scan_in_progress');
    expect(store.getGmailImportanceSettings(key).windowDays).toBe(1);

    const cadence = await request(app)
      .put('/api/google/gmail/importance/settings')
      .send({ windowDays: 1, autoScan: 'hourly' });
    expect(cadence.status).toBe(200);
    expect(cadence.body.settings).toMatchObject({ windowDays: 1, autoScan: 'hourly' });

    release('tok');
    await vi.waitFor(async () => {
      const res = await request(app).get('/api/google/gmail/importance');
      expect(res.body.running).toBe(false);
    });
    const after = await request(app)
      .put('/api/google/gmail/importance/settings')
      .send({ windowDays: 30 });
    expect(after.status).toBe(200);
    expect(after.body.settings.windowDays).toBe(30);
  });

  it('starts a background scan and returns 409 while one is running', async () => {
    let release: (v: string) => void = () => {};
    const tokenGate = new Promise<string>((r) => (release = r));
    const scanDeps = {
      resolveToken: () => tokenGate,
      createSource: () => ({
        listThreadIds: async () => [],
        getThread: vi.fn(),
        getThreadLabels: vi.fn(),
      }),
      now: () => NOW,
    };
    const app = makeApp(userId, scanDeps);

    const started = await request(app)
      .post('/api/google/gmail/importance/scan')
      .send({ windowDays: 1 });
    expect(started.status).toBe(202);
    expect(started.body.running).toBe(true);
    expect(started.body.settings.lastScanStatus).toBe('running');

    const again = await request(app).post('/api/google/gmail/importance/scan').send({});
    expect(again.status).toBe(409);

    release('tok');
    await vi.waitFor(async () => {
      const res = await request(app).get('/api/google/gmail/importance');
      expect(res.body.running).toBe(false);
      expect(res.body.settings.lastScanStatus).toBe('ok');
    });
  });
});
