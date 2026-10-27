/**
 * Google Chat stays single-account: one explicit Chat account per user that
 * survives default switches, can only be a Workspace account, and tears the
 * old account's push subscription and pending drafts down when it changes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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

const { initDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { __resetSecretCryptoForTests } = await import('../secret-crypto.js');
const { upsertGoogleConnection, setDefaultGoogleConnection, deleteGoogleConnection } =
  await import('../google-connections-store.js');
const chatAccount = await import('../google-chat-account.js');
const { upsertChatSubscription, getChatSubscription, recordUnreadMessage, listUnread } =
  await import('../google-chat-events-store.js');
const { createChatDraft, getChatDraft, claimChatDraftForSend } =
  await import('../google-chat-drafts-store.js');
const { hostedDomainFromUserInfo } = await import('../google-oauth.js');
const { default: createGoogleChatAccountRoutes } = await import('./google-chat-account.js');
const { ensureChatSubscription } = await import('../google-chat-events.js');

const CHAT_READ = 'https://www.googleapis.com/auth/chat.messages.readonly';
const CHAT_SEND = 'https://www.googleapis.com/auth/chat.messages.create';

let userId = '';
const broadcast = vi.fn();

function link(
  sub: string,
  email: string,
  opts: { scopes?: string[]; hostedDomain?: string | null; token?: string } = {},
): string {
  return upsertGoogleConnection({
    userId,
    googleSub: sub,
    googleEmail: email,
    accessToken: opts.token ?? `token-${sub}`,
    tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken: 'rt',
    grantedScopes: opts.scopes ?? [CHAT_READ, CHAT_SEND],
    hostedDomain: opts.hostedDomain === undefined ? 'work.example' : opts.hostedDomain,
  });
}

function eventsClientSpy() {
  const deleted: Array<{ token: string; name: string }> = [];
  const eventsClient = (token: string) =>
    ({
      subscriptions: {
        delete: async ({ name }: { name: string }) => {
          deleted.push({ token, name });
          return { data: { done: true } };
        },
      },
      operations: { get: async () => ({ data: { done: true } }) },
    }) as never;
  return { deleted, eventsClient };
}

function makeApp(eventsClient?: (token: string) => never) {
  const deps = {
    config: { googleOAuth: { clientId: 'id', clientSecret: 'secret' } },
    stmts: {},
    broadcast,
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { authUserId?: string }).authUserId = userId;
    next();
  });
  app.use(
    createGoogleChatAccountRoutes(deps, { eventsDeps: eventsClient ? { eventsClient } : {} }),
  );
  return app;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'chat-account-'));
  __resetSecretCryptoForTests();
  initDb(TMP_DIR);
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  userId = createUser({ username: 'chatty', passwordHash: 'x' }).id;
  broadcast.mockClear();
});

describe('Chat account binding', () => {
  it('binds the first Workspace account with Chat access and keeps it across default switches', async () => {
    const personal = link('sub-p', 'me@gmail.com', { hostedDomain: '' });
    const work = link('sub-w', 'me@work.example');
    expect(chatAccount.getChatAccount(userId)?.accountId).toBe(work);

    setDefaultGoogleConnection(userId, personal);
    const other = link('sub-o', 'me@other.example');
    setDefaultGoogleConnection(userId, other);
    expect(chatAccount.getChatAccount(userId)?.accountId).toBe(work);
    expect(await chatAccount.getChatAccessToken(userId, null)).toBe('token-sub-w');

    const res = await request(makeApp()).get('/api/google/chat/account');
    expect(res.status).toBe(200);
    expect(res.body.account).toEqual({ accountId: work, email: 'me@work.example' });
    expect(
      res.body.candidates.find((c: { accountId: string }) => c.accountId === personal),
    ).toMatchObject({ workspace: false, hasChatScope: true });
  });

  it('refuses personal accounts and accounts that are not linked', async () => {
    link('sub-w', 'me@work.example');
    const personal = link('sub-p', 'someone@gmail.com', { hostedDomain: null });
    const app = makeApp();
    const consumer = await request(app)
      .put('/api/google/chat/account')
      .send({ accountId: personal });
    expect(consumer.status).toBe(400);
    expect(consumer.body.code).toBe('google_chat_workspace_required');
    const missing = await request(app).put('/api/google/chat/account').send({ accountId: 'nope' });
    expect(missing.status).toBe(404);
  });

  it('switching tears down the old subscription, unread state, and pending drafts', async () => {
    const work = link('sub-w', 'me@work.example');
    const second = link('sub-2', 'me@second.example');
    expect(chatAccount.getChatAccount(userId)?.accountId).toBe(work);
    upsertChatSubscription({
      userId,
      subscriptionName: 'subscriptions/old-sub',
      authority: 'users/sub-w',
      state: 'ACTIVE',
      expireTime: new Date(Date.now() + 3_600_000).toISOString(),
    });
    recordUnreadMessage({
      userId,
      spaceName: 'spaces/AAA',
      messageName: 'spaces/AAA/messages/m1',
      createTime: new Date().toISOString(),
    });
    const draft = createChatDraft({ userId, sessionId: 's1', spaceId: 'AAA', text: 'hi' });
    const spy = eventsClientSpy();

    const res = await request(makeApp(spy.eventsClient))
      .put('/api/google/chat/account')
      .send({ accountId: second });

    expect(res.status).toBe(200);
    expect(res.body.account).toEqual({ accountId: second, email: 'me@second.example' });
    // Deleted at Google with the OLD account's token.
    expect(spy.deleted).toEqual([{ token: 'token-sub-w', name: 'subscriptions/old-sub' }]);
    expect(getChatSubscription(userId)).toBeNull();
    expect(listUnread(userId)).toEqual([]);
    expect(getChatDraft(draft.id, userId)?.status).toBe('discarded');
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'google_chat_events_status', subscription: null }),
    );
    expect(await chatAccount.getChatAccessToken(userId, null)).toBe('token-sub-2');
    expect(chatAccount.getChatAccountSub(userId)).toBe('sub-2');
  });

  it('picking the current account again changes nothing', async () => {
    const work = link('sub-w', 'me@work.example');
    chatAccount.getChatAccount(userId);
    upsertChatSubscription({
      userId,
      subscriptionName: 'subscriptions/keep',
      authority: 'users/sub-w',
      state: 'ACTIVE',
      expireTime: null,
    });
    const spy = eventsClientSpy();
    const res = await request(makeApp(spy.eventsClient))
      .put('/api/google/chat/account')
      .send({ accountId: work });
    expect(res.status).toBe(200);
    expect(spy.deleted).toEqual([]);
    expect(getChatSubscription(userId)?.subscriptionName).toBe('subscriptions/keep');
  });

  it('removing the Chat account clears its push state and never moves Chat on its own', () => {
    link('sub-w', 'me@work.example');
    const second = link('sub-2', 'me@second.example');
    const work = chatAccount.getChatAccount(userId)!.accountId;
    upsertChatSubscription({
      userId,
      subscriptionName: 'subscriptions/w',
      authority: 'users/sub-w',
      state: 'ACTIVE',
      expireTime: null,
    });

    deleteGoogleConnection(userId, { accountId: work });

    expect(getChatSubscription(userId)).toBeNull();
    expect(chatAccount.getChatAccountBinding(userId)).toEqual({
      account: null,
      boundEmail: 'me@work.example',
    });
    expect(chatAccount.getChatConnectionStatus(userId)).toMatchObject({
      connected: true,
      accountId: null,
      grantedScopes: [],
    });
    // With the bound account gone, consenting Chat on another account binds it.
    expect(chatAccount.bindChatAccountIfUnbound(userId, second).bound).toBe(true);
    expect(chatAccount.getChatAccount(userId)?.accountId).toBe(second);
  });

  it('relinking the same Google account restores Chat', () => {
    const work = link('sub-w', 'me@work.example');
    expect(chatAccount.getChatAccount(userId)?.accountId).toBe(work);
    const second = link('sub-2', 'me@second.example');
    deleteGoogleConnection(userId, { accountId: work });
    expect(chatAccount.getChatAccount(userId)).toBeNull();
    // A bound, still-linked account is never replaced by a consent elsewhere.
    const relinked = link('sub-w', 'me@work.example');
    expect(chatAccount.getChatAccount(userId)?.accountId).toBe(relinked);
    expect(chatAccount.bindChatAccountIfUnbound(userId, second).bound).toBe(false);
    expect(chatAccount.getChatAccount(userId)?.accountId).toBe(relinked);
  });

  it('counts only a recorded hd claim as Workspace, never the email domain', () => {
    expect(chatAccount.isWorkspaceAccount({ hostedDomain: 'acme.com' })).toBe(true);
    // Confirmed absence (fresh callback without hd), e.g. a personal account
    // registered with an Outlook or custom-domain address.
    expect(chatAccount.isWorkspaceAccount({ hostedDomain: '' })).toBe(false);
    // Linked before hd was recorded: not eligible until reconnected.
    expect(chatAccount.isWorkspaceAccount({ hostedDomain: null })).toBe(false);
    expect(hostedDomainFromUserInfo({ hd: 'Acme.com' })).toBe('acme.com');
    expect(hostedDomainFromUserInfo({})).toBe('');
  });

  it('refuses a personal account with a custom-domain address', async () => {
    link('sub-w', 'me@work.example');
    const personal = link('sub-p', 'me@mycompany.example', { hostedDomain: '' });
    const res = await request(makeApp())
      .put('/api/google/chat/account')
      .send({ accountId: personal });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('google_chat_workspace_required');
    const state = await request(makeApp()).get('/api/google/chat/account');
    expect(
      state.body.candidates.find((c: { accountId: string }) => c.accountId === personal).workspace,
    ).toBe(false);
  });

  it('removing the Chat account then consenting on another discards the old held replies', () => {
    const work = link('sub-w', 'me@work.example');
    const second = link('sub-2', 'me@second.example');
    expect(chatAccount.getChatAccount(userId)?.accountId).toBe(work);
    const draft = createChatDraft({
      userId,
      sessionId: 's1',
      spaceId: 'AAA',
      accountSub: 'sub-w',
      text: 'hi',
    });

    deleteGoogleConnection(userId, { accountId: work });
    const bound = chatAccount.bindChatAccountIfUnbound(userId, second);

    expect(bound.bound).toBe(true);
    expect(bound.discarded.map((d) => d.id)).toEqual([draft.id]);
    expect(getChatDraft(draft.id, userId)?.status).toBe('discarded');
    // Even a draft that escaped the discard could not send as the new account.
    const claim = claimChatDraftForSend(draft.id, userId, {
      expectedRevision: 1,
      accountSub: 'sub-2',
      replyThread: null,
    });
    expect(claim.ok).toBe(false);
  });

  it('invalidates old held replies before the slow teardown, so approval during it fails', async () => {
    link('sub-w', 'me@work.example');
    const second = link('sub-2', 'me@second.example');
    chatAccount.getChatAccount(userId);
    upsertChatSubscription({
      userId,
      subscriptionName: 'subscriptions/old',
      authority: 'users/sub-w',
      state: 'ACTIVE',
      expireTime: null,
    });
    const pending = createChatDraft({
      userId,
      sessionId: 's1',
      spaceId: 'AAA',
      accountSub: 'sub-w',
      text: 'pending',
    });
    const retrying = createChatDraft({
      userId,
      sessionId: 's1',
      spaceId: 'AAA',
      accountSub: 'sub-w',
      text: 'unconfirmed',
    });
    getOrgsDb()
      .prepare(
        `UPDATE google_chat_drafts SET status = 'unconfirmed', request_id = 'r1' WHERE id = ?`,
      )
      .run(retrying.id);

    let releaseDelete: () => void = () => {};
    let markStarted: () => void = () => {};
    const deleteStarted = new Promise<void>((r) => (markStarted = r));
    const eventsClient = () =>
      ({
        subscriptions: {
          delete: () =>
            new Promise((resolve) => {
              releaseDelete = () => resolve({ data: { done: true } });
              markStarted();
            }),
        },
        operations: { get: async () => ({ data: { done: true } }) },
      }) as never;
    const switching = request(makeApp(eventsClient))
      .put('/api/google/chat/account')
      .send({ accountId: second })
      .then((r) => r);

    await deleteStarted;
    // Teardown is paused at Google. The new identity is live, the pending
    // reply is already discarded, and an approval with the new account's
    // token is refused for the reply that survived (unconfirmed).
    expect(chatAccount.getChatAccountSub(userId)).toBe('sub-2');
    expect(getChatDraft(pending.id, userId)?.status).toBe('discarded');
    for (const id of [pending.id, retrying.id]) {
      const claim = claimChatDraftForSend(id, userId, {
        expectedRevision: 1,
        accountSub: 'sub-2',
        replyThread: null,
      });
      expect(claim.ok).toBe(false);
    }
    expect(getChatDraft(retrying.id, userId)?.status).toBe('unconfirmed');

    releaseDelete();
    expect((await switching).status).toBe(200);
  });

  it('reports the Chat account (or the account to enable Chat on) for consent checks', () => {
    const personal = link('sub-p', 'me@gmail.com', { hostedDomain: '', scopes: [] });
    const work = link('sub-w', 'me@work.example', { scopes: [] });
    // Nothing bound yet and the default is personal: suggest the work account.
    expect(chatAccount.getChatAccountSummary(userId)).toEqual({
      accountId: work,
      email: 'me@work.example',
      grantedScopes: [],
      bound: false,
    });
    expect(personal).toBeTruthy();
    // Consenting Chat there binds it, and the summary carries its scopes.
    link('sub-w', 'me@work.example', { scopes: [CHAT_READ] });
    expect(chatAccount.bindChatAccountIfUnbound(userId, work).bound).toBe(true);
    expect(chatAccount.getChatAccountSummary(userId)).toMatchObject({
      accountId: work,
      grantedScopes: [CHAT_READ],
      bound: true,
    });
  });

  it('a reconcile paused at Google saves nothing once its account is removed', async () => {
    for (const outcome of ['created', 'failed'] as const) {
      // A fresh user each round: a removed bound account stays bound.
      userId = createUser({ username: `paused-${outcome}`, passwordHash: 'x' }).id;
      const work = link(`sub-${outcome}`, `${outcome}@work.example`);
      expect(chatAccount.getChatAccount(userId)?.accountId).toBe(work);
      let finish: () => void = () => {};
      let markStarted: () => void = () => {};
      const started = new Promise<void>((r) => (markStarted = r));
      const eventsClient = () =>
        ({
          subscriptions: {
            create: () =>
              new Promise((resolve, reject) => {
                finish = () =>
                  outcome === 'created'
                    ? resolve({
                        data: {
                          done: true,
                          response: {
                            name: `subscriptions/${outcome}`,
                            state: 'ACTIVE',
                            expireTime: new Date(Date.now() + 3_600_000).toISOString(),
                          },
                        },
                      })
                    : reject(Object.assign(new Error('backend error'), { code: 500 }));
                markStarted();
              }),
          },
        }) as never;
      const reconcile = ensureChatSubscription(userId, {
        config: {
          googleOAuth: { clientId: 'id', clientSecret: 'secret' },
          googleChatEvents: { pubsubTopic: 'projects/p/topics/t' },
        } as never,
        broadcast,
        getAccessToken: async () => 'token',
        eventsClient,
      });
      await started;

      deleteGoogleConnection(userId, { accountId: work });
      finish();

      await expect(reconcile).rejects.toBeTruthy();
      // Neither the subscription Google returned nor an error row came back.
      expect(getChatSubscription(userId)).toBeNull();
    }
  });
});
