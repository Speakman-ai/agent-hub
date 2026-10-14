import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from './db.js';
import { HUB_CHAT_SCHEMA } from './hub-chat-schema.js';
import * as chat from './hub-chat-store.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';

let org = '';
beforeEach(() => {
  // Each test gets its own org so rows from earlier tests never leak in.
  org = `org-${randomUUID()}`;
});

function post(
  channelId: string,
  author: string,
  body = 'hi',
  refs?: chat.AppendMessageInput['refs'],
) {
  return chat.appendMessage({ channelId, authorKind: 'user', authorUserId: author, body, refs });
}

/** Resets a member's read pointer, modelling "has read nothing yet". */
function rewind(channelId: string, userId: string) {
  getDb()
    .prepare('UPDATE hub_chat_members SET last_read_seq = 0 WHERE channel_id = ? AND user_id = ?')
    .run(channelId, userId);
}

describe('hub chat schema', () => {
  it('applies cleanly more than once', () => {
    const db = new Database(':memory:');
    db.exec(HUB_CHAT_SCHEMA);
    expect(() => db.exec(HUB_CHAT_SCHEMA)).not.toThrow();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hub_chat_%' ORDER BY name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      'hub_chat_agent_session_turns',
      'hub_chat_agent_turns',
      'hub_chat_channel_digests',
      'hub_chat_channels',
      'hub_chat_members',
      'hub_chat_messages',
      'hub_chat_refs',
    ]);
  });

  it('is created by initDb on the main database', () => {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hub_chat_messages'")
      .get();
    expect(row).toBeTruthy();
  });
});

describe('DMs', () => {
  it('reuses the DM for the same pair in either order', () => {
    const first = chat.getOrCreateDm(org, ALICE, BOB);
    const again = chat.getOrCreateDm(org, BOB, ALICE);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.channel.id).toBe(first.channel.id);
    expect(first.channel).toMatchObject({ kind: 'dm', is_private: 1 });
    expect(
      chat
        .listMembers(first.channel.id)
        .map((m) => m.user_id)
        .sort(),
    ).toEqual([ALICE, BOB]);
  });

  it('keeps different pairs and different orgs apart', () => {
    const ab = chat.getOrCreateDm(org, ALICE, BOB).channel.id;
    const ac = chat.getOrCreateDm(org, ALICE, CAROL).channel.id;
    const abOther = chat.getOrCreateDm(`${org}-2`, ALICE, BOB).channel.id;
    expect(new Set([ab, ac, abOther]).size).toBe(3);
  });
});

describe('channels and members', () => {
  it('makes the creator owner and forces private for groups', () => {
    const g = chat.createChannel({
      orgId: org,
      kind: 'group',
      name: 'g',
      createdByUserId: ALICE,
      memberUserIds: [BOB],
    });
    expect(g.is_private).toBe(1);
    expect(chat.getMember(g.id, ALICE)?.role).toBe('owner');
    expect(chat.getMember(g.id, BOB)?.role).toBe('member');
    const pub = chat.createChannel({ orgId: org, kind: 'channel', name: 'general' });
    expect(pub.is_private).toBe(0);
  });

  it('starts a late joiner read up to the tail, and removes members', () => {
    const c = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'c',
      createdByUserId: ALICE,
    });
    post(c.id, ALICE);
    post(c.id, ALICE);
    expect(chat.addMember(c.id, BOB)?.last_read_seq).toBe(2);
    expect(chat.getChannelSummary(c.id, BOB)?.unread_count).toBe(0);
    expect(chat.removeMember(c.id, BOB)).toBe(true);
    expect(chat.getMember(c.id, BOB)).toBeNull();
    expect(chat.addMember('missing', BOB)).toBeNull();
  });

  it('updates notify level and mute', () => {
    const c = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'c',
      createdByUserId: ALICE,
    });
    const m = chat.updateMemberPrefs(c.id, ALICE, {
      notifyLevel: 'all',
      mutedUntil: '2030-01-01T00:00:00Z',
    });
    expect(m).toMatchObject({ notify_level: 'all', muted_until: '2030-01-01T00:00:00Z' });
  });

  it('hides archived channels from the list by default', () => {
    const c = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'c',
      createdByUserId: ALICE,
    });
    expect(chat.archiveChannel(c.id)).toBe(true);
    expect(chat.listChannelsForUser(org, ALICE)).toHaveLength(0);
    expect(chat.listChannelsForUser(org, ALICE, { includeArchived: true })).toHaveLength(1);
  });
});

describe('messages', () => {
  it('assigns monotonic seq per channel and pages by seq', () => {
    const a = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'a',
      createdByUserId: ALICE,
    });
    const b = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'b',
      createdByUserId: ALICE,
    });
    const seqsA = [1, 2, 3, 4, 5].map((i) => post(a.id, ALICE, `a${i}`).seq);
    const seqB = post(b.id, ALICE, 'b1').seq;
    expect(seqsA).toEqual([1, 2, 3, 4, 5]);
    expect(seqB).toBe(1);

    expect(chat.listMessages(a.id, { limit: 2 }).map((m) => m.seq)).toEqual([4, 5]);
    expect(chat.listMessages(a.id, { before: 4, limit: 2 }).map((m) => m.seq)).toEqual([2, 3]);
    expect(chat.listMessages(a.id, { after: 2, limit: 2 }).map((m) => m.seq)).toEqual([3, 4]);
  });

  it('keeps seq stable across soft deletes', () => {
    const c = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'c',
      createdByUserId: ALICE,
    });
    const m1 = post(c.id, ALICE, 'one');
    post(c.id, ALICE, 'two');
    const del = chat.softDeleteMessage(m1.id);
    expect(del).toMatchObject({ body: '', seq: 1 });
    expect(del?.deleted_at).toBeTruthy();
    expect(chat.softDeleteMessage(m1.id)).toBeNull();
    expect(post(c.id, ALICE, 'three').seq).toBe(3);
  });

  it('edits body and replaces refs, but not on deleted messages', () => {
    const c = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'c',
      createdByUserId: ALICE,
    });
    const m = post(c.id, ALICE, 'hey @bob', [{ kind: 'user', targetId: BOB }]);
    const edited = chat.editMessage(m.id, {
      body: 'hey @carol',
      refs: [{ kind: 'user', targetId: CAROL }],
    });
    expect(edited?.body).toBe('hey @carol');
    expect(edited?.edited_at).toBeTruthy();
    expect(chat.listRefs(m.id).map((r) => r.target_id)).toEqual([CAROL]);
    chat.softDeleteMessage(m.id);
    expect(chat.editMessage(m.id, { body: 'nope' })).toBeNull();
    expect(chat.listRefs(m.id)).toEqual([]);
  });

  it('stores structured payloads as JSON', () => {
    const c = chat.createChannel({ orgId: org, kind: 'trigger', name: 't' });
    const m = chat.appendMessage({
      channelId: c.id,
      authorKind: 'trigger',
      body: 'Finalize passed',
      payload: { title: 'Finalize', status: 'pass' },
    });
    expect(JSON.parse(m.payload_json as string)).toEqual({ title: 'Finalize', status: 'pass' });
    expect(m.author_user_id).toBeNull();
  });
});

describe('unread and mentions', () => {
  it('excludes own messages and respects last_read_seq', () => {
    const { channel } = chat.getOrCreateDm(org, ALICE, BOB);
    post(channel.id, ALICE, 'a1');
    post(channel.id, BOB, 'b1');
    post(channel.id, BOB, 'b2');
    post(channel.id, ALICE, 'a2');

    // Bob's own posts advanced his pointer to 3; only Alice's a2 is unread.
    expect(chat.getChannelSummary(channel.id, BOB)).toMatchObject({ unread_count: 1, last_seq: 4 });
    // Alice's pointer is at her own a2 (seq 4), so Bob's b1/b2 count as read.
    expect(chat.getChannelSummary(channel.id, ALICE)?.unread_count).toBe(0);

    expect(chat.markRead(channel.id, BOB, 4)).toBe(4);
    expect(chat.getChannelSummary(channel.id, BOB)?.unread_count).toBe(0);
  });

  it('counts agent posts, skips deleted ones', () => {
    const c = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'c',
      createdByUserId: ALICE,
      memberUserIds: [BOB],
    });
    post(c.id, BOB, 'b1');
    const b2 = post(c.id, BOB, 'b2');
    chat.appendMessage({
      channelId: c.id,
      authorKind: 'agent',
      authorAgentId: 'dev',
      body: 'done',
    });
    post(c.id, ALICE, 'mine');
    // Alice's own post moved her pointer to 4, so reset it to model "read nothing".
    rewind(c.id, ALICE);
    expect(chat.getChannelSummary(c.id, ALICE)?.unread_count).toBe(3);
    chat.softDeleteMessage(b2.id);
    expect(chat.getChannelSummary(c.id, ALICE)?.unread_count).toBe(2);
    expect(chat.markRead(c.id, ALICE, 1)).toBe(1);
    expect(chat.getChannelSummary(c.id, ALICE)?.unread_count).toBe(1);
  });

  it('never moves the read pointer backwards or past the tail', () => {
    const c = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'c',
      createdByUserId: ALICE,
      memberUserIds: [BOB],
    });
    post(c.id, ALICE);
    post(c.id, ALICE);
    expect(chat.markRead(c.id, BOB, 99)).toBe(2);
    expect(chat.markRead(c.id, BOB, 1)).toBe(2);
    expect(chat.markRead(c.id, CAROL)).toBeNull();
  });

  it('counts unread messages that mention the user', () => {
    const c = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'c',
      createdByUserId: ALICE,
      memberUserIds: [BOB, CAROL],
    });
    post(c.id, ALICE, '@bob one', [{ kind: 'user', targetId: BOB }]);
    post(c.id, ALICE, '@bob @carol', [
      { kind: 'user', targetId: BOB },
      { kind: 'user', targetId: CAROL },
      { kind: 'card', targetId: 'card-1', projectId: 'p1' },
    ]);
    post(c.id, ALICE, 'card only', [{ kind: 'card', targetId: BOB }]);
    post(c.id, ALICE, 'plain');

    expect(chat.getChannelSummary(c.id, BOB)).toMatchObject({ unread_count: 4, mention_count: 2 });
    expect(chat.getChannelSummary(c.id, CAROL)).toMatchObject({
      unread_count: 4,
      mention_count: 1,
    });

    chat.markRead(c.id, BOB, 1);
    expect(chat.getChannelSummary(c.id, BOB)?.mention_count).toBe(1);

    // A self-mention is not a notification, even with the pointer rewound.
    post(c.id, CAROL, 'me', [{ kind: 'user', targetId: CAROL }]);
    rewind(c.id, CAROL);
    expect(chat.getChannelSummary(c.id, CAROL)?.mention_count).toBe(1);
  });

  it("lists only the user's channels in the org with counts", () => {
    const dm = chat.getOrCreateDm(org, ALICE, BOB).channel;
    const other = chat.createChannel({
      orgId: org,
      kind: 'channel',
      name: 'x',
      createdByUserId: CAROL,
    });
    chat.createChannel({ orgId: `${org}-2`, kind: 'channel', name: 'y', createdByUserId: BOB });
    post(dm.id, ALICE, '@bob', [{ kind: 'user', targetId: BOB }]);
    post(other.id, CAROL);

    const list = chat.listChannelsForUser(org, BOB);
    expect(list.map((c) => c.id)).toEqual([dm.id]);
    expect(list[0]).toMatchObject({
      unread_count: 1,
      mention_count: 1,
      role: 'member',
      notify_level: 'mentions',
    });
  });
});
