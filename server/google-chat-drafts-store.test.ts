import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const store = await import('./google-chat-drafts-store.js');

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'google-chat-drafts-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

describe('google-chat-drafts-store', () => {
  let alice = '';
  let bob = '';
  beforeEach(() => {
    freshDb();
    alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
    bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  });

  // Act on the revision currently stored, as a client that just loaded the draft would.
  const rev = (id: string) => store.getChatDraft(id, alice)?.revision ?? 1;
  const claim = (
    id: string,
    user: string,
    opts: Omit<Parameters<typeof store.claimChatDraftForSend>[2], 'expectedRevision'> = {},
  ) => store.claimChatDraftForSend(id, user, { expectedRevision: rev(id), ...opts });
  const edit = (id: string, user: string, text: string) => {
    const r = store.updateChatDraftText(id, user, text, rev(id));
    return r.ok ? r.draft : null;
  };
  const discard = (id: string, user: string) => {
    const r = store.discardChatDraft(id, user, rev(id));
    return r.ok ? r.draft : null;
  };

  it('creates a pending draft visible only to its owner', () => {
    const d = store.createChatDraft({
      userId: alice,
      sessionId: 's1',
      spaceId: 'AAA',
      threadName: 'spaces/AAA/threads/T1',
      text: 'Done',
    });
    expect(d).toMatchObject({ status: 'pending', text: 'Done', sessionId: 's1', error: null });
    expect(store.getChatDraft(d.id, bob)).toBeNull();
    expect(store.listChatDrafts(bob)).toEqual([]);
    expect(store.listChatDrafts(alice, { sessionId: 's1', status: 'pending' })).toHaveLength(1);
    expect(store.listChatDrafts(alice, { spaceId: 'BBB' })).toEqual([]);
  });

  const claimOk = (id: string, opts?: Parameters<typeof claim>[2]) => {
    const c = claim(id, alice, opts);
    if (!c.ok) throw new Error(`claim failed: ${c.reason}`);
    return c;
  };

  it('claims a draft for sending exactly once, and only while pending', () => {
    const d = store.createChatDraft({ userId: alice, sessionId: 's1', spaceId: 'AAA', text: 'a' });
    expect(claim(d.id, bob, { replyThread: null })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    // A fresh attempt must arrive with its reply thread already resolved.
    expect(claim(d.id, alice)).toMatchObject({
      ok: false,
      reason: 'thread_unresolved',
    });
    const claimed = claimOk(d.id, { text: 'edited', replyThread: null });
    expect(claimed.retry).toBe(false);
    expect(claimed.draft).toMatchObject({ status: 'sending', text: 'edited' });
    expect(claimed.attempt.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim(d.id, alice, { replyThread: null })).toMatchObject({
      ok: false,
      reason: 'not_sendable',
    });
    expect(edit(d.id, alice, 'late')).toBeNull();
    expect(discard(d.id, alice)).toBeNull();

    // A refusal clears the request id, so the next attempt is a new request.
    const refused = store.releaseChatDraftAfterRejection(claimed.attempt, 'quota');
    expect(refused).toMatchObject({ status: 'pending', error: 'quota', requestId: null });
    const again = claimOk(d.id, { replyThread: null });
    expect(again.attempt.requestId).not.toBe(claimed.attempt.requestId);
    // A completion for the old attempt can't touch the new one.
    expect(store.markChatDraftSent(claimed.attempt, 'stale')?.status).toBe('sending');
    const sent = store.markChatDraftSent(again.attempt, 'spaces/AAA/messages/M');
    expect(sent).toMatchObject({
      status: 'sent',
      sentMessageName: 'spaces/AAA/messages/M',
      error: null,
    });
  });

  it('freezes an unconfirmed send: same request id, thread, and text on retry', () => {
    const d = store.createChatDraft({
      userId: alice,
      sessionId: 's1',
      spaceId: 'AAA',
      threadName: 'spaces/AAA/threads/T1',
      text: 'a',
    });
    const first = claimOk(d.id, { replyThread: 'spaces/AAA/threads/T1' });
    const unconfirmed = store.markChatDraftUnconfirmed(first.attempt, 'timeout');
    expect(unconfirmed).toMatchObject({ status: 'unconfirmed', error: 'timeout' });

    expect(edit(d.id, alice, 'edited')).toBeNull();
    expect(claim(d.id, alice, { text: 'edited' })).toMatchObject({
      ok: false,
      reason: 'text_changed',
    });
    const retry = claimOk(d.id, { text: 'a' });
    expect(retry.retry).toBe(true);
    expect(retry.draft).toMatchObject({
      status: 'sending',
      text: 'a',
      requestId: first.attempt.requestId,
      requestReplyThread: 'spaces/AAA/threads/T1',
    });
    store.markChatDraftUnconfirmed(retry.attempt, 'timeout again');
    expect(store.listChatDrafts(alice, { status: store.OPEN_DRAFT_STATUSES })).toHaveLength(1);
    expect(discard(d.id, alice)?.status).toBe('discarded');
  });

  it('recovers a send interrupted by a restart as unconfirmed, never re-sending it', () => {
    const d = store.createChatDraft({
      userId: alice,
      sessionId: 's1',
      spaceId: 'AAA',
      threadName: 'spaces/AAA/threads/T1',
      text: 'a',
    });
    const before = claimOk(d.id, { replyThread: 'spaces/AAA/threads/T1' });
    // Same boot: still in flight.
    expect(store.getChatDraft(d.id, alice)?.status).toBe('sending');

    store.restartChatDraftAttemptsForTests();

    const [recovered] = store.listChatDrafts(alice, { status: store.OPEN_DRAFT_STATUSES });
    expect(recovered).toMatchObject({
      status: 'unconfirmed',
      error: store.INTERRUPTED_SEND_ERROR,
      requestId: before.attempt.requestId,
      requestReplyThread: 'spaces/AAA/threads/T1',
    });
    // The dead attempt's completion can't land after the restart.
    expect(store.markChatDraftSent(before.attempt, 'late')?.status).toBe('unconfirmed');
    // Its text is frozen, and a retry repeats the identical request.
    expect(edit(d.id, alice, 'b')).toBeNull();
    const retry = claimOk(d.id);
    expect(retry.retry).toBe(true);
    expect(retry.attempt.requestId).toBe(before.attempt.requestId);
  });

  it('lets an interrupted send be discarded', () => {
    const d = store.createChatDraft({ userId: alice, sessionId: 's1', spaceId: 'AAA', text: 'a' });
    claimOk(d.id, { replyThread: null });
    store.restartChatDraftAttemptsForTests();
    expect(discard(d.id, alice)?.status).toBe('discarded');
  });

  it('edits and discards pending drafts', () => {
    const d = store.createChatDraft({ userId: alice, sessionId: 's1', spaceId: 'AAA', text: 'a' });
    expect(edit(d.id, alice, 'b')?.text).toBe('b');
    expect(discard(d.id, bob)).toBeNull();
    expect(discard(d.id, alice)?.status).toBe('discarded');
  });

  it('auto-send defaults off and is stored per user', () => {
    expect(store.getChatSettings(alice)).toEqual({ autoSendAgentReplies: false });
    store.setChatSettings(alice, { autoSendAgentReplies: true });
    expect(store.getChatSettings(alice)).toEqual({ autoSendAgentReplies: true });
    expect(store.getChatSettings(bob)).toEqual({ autoSendAgentReplies: false });
    store.setChatSettings(alice, { autoSendAgentReplies: false });
    expect(store.getChatSettings(alice).autoSendAgentReplies).toBe(false);
  });
});
