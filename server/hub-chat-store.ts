/**
 * Persistence for Agent Hub chat: channels, DMs, membership, messages, refs and
 * per-member read state. Schema: `hub-chat-schema.ts`.
 *
 * Authorization (who may post, edit or read) belongs to the API layer; this
 * module only enforces data invariants: one DM per user pair, monotonic
 * per-channel `seq`, and read pointers that never move backwards.
 */
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import type {
  HubChatAuthorKind,
  HubChatChannelKind,
  HubChatChannelRow,
  HubChatChannelSummary,
  HubChatMemberRole,
  HubChatMemberRow,
  HubChatMessageRow,
  HubChatNotifyLevel,
  HubChatPinRow,
  HubChatReactionRow,
  HubChatRefInput,
  HubChatRefKind,
  HubChatRefRow,
} from './types.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** Kinds that are never joinable without an invite. */
const ALWAYS_PRIVATE: ReadonlySet<HubChatChannelKind> = new Set(['dm', 'group', 'summary']);

function db(): Database.Database {
  return getDb();
}

export function dmKey(userA: string, userB: string): string {
  return [userA, userB].sort().join(':');
}

function lastSeq(conn: Database.Database, channelId: string): number {
  const row = conn
    .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM hub_chat_messages WHERE channel_id = ?')
    .get(channelId) as { s: number };
  return row.s;
}

function insertMember(
  conn: Database.Database,
  channelId: string,
  userId: string,
  role: HubChatMemberRole,
  lastReadSeq: number,
): void {
  conn
    .prepare(
      `INSERT OR IGNORE INTO hub_chat_members (channel_id, user_id, role, last_read_seq)
       VALUES (?, ?, ?, ?)`,
    )
    .run(channelId, userId, role, lastReadSeq);
}

export function getChannel(channelId: string): HubChatChannelRow | null {
  const row = db().prepare('SELECT * FROM hub_chat_channels WHERE id = ?').get(channelId) as
    | HubChatChannelRow
    | undefined;
  return row ?? null;
}

export interface CreateChannelInput {
  orgId: string;
  kind: Exclude<HubChatChannelKind, 'dm'>;
  name: string;
  topic?: string | null;
  isPrivate?: boolean;
  projectId?: string | null;
  agentId?: string | null;
  createdByUserId?: string | null;
  /** Extra members besides the creator (who joins as owner). */
  memberUserIds?: string[];
}

export function createChannel(input: CreateChannelInput): HubChatChannelRow {
  const conn = db();
  const id = randomUUID();
  const isPrivate = ALWAYS_PRIVATE.has(input.kind) || input.isPrivate === true;
  conn.transaction(() => {
    conn
      .prepare(
        `INSERT INTO hub_chat_channels
           (id, org_id, kind, name, topic, is_private, project_id, agent_id, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.orgId,
        input.kind,
        input.name,
        input.topic ?? null,
        isPrivate ? 1 : 0,
        input.projectId ?? null,
        input.agentId ?? null,
        input.createdByUserId ?? null,
      );
    if (input.createdByUserId) insertMember(conn, id, input.createdByUserId, 'owner', 0);
    for (const userId of input.memberUserIds ?? []) insertMember(conn, id, userId, 'member', 0);
  })();
  return getChannel(id) as HubChatChannelRow;
}

/**
 * Returns the DM between two users, creating it on first use. The same pair in
 * either order always resolves to the same channel.
 */
export function getOrCreateDm(
  orgId: string,
  userA: string,
  userB: string,
): { channel: HubChatChannelRow; created: boolean } {
  const conn = db();
  const key = dmKey(userA, userB);
  const find = () =>
    conn
      .prepare('SELECT * FROM hub_chat_channels WHERE org_id = ? AND dm_key = ?')
      .get(orgId, key) as HubChatChannelRow | undefined;

  return conn
    .transaction(() => {
      const existing = find();
      if (existing) return { channel: existing, created: false };
      const id = randomUUID();
      conn
        .prepare(
          `INSERT INTO hub_chat_channels (id, org_id, kind, name, is_private, dm_key, created_by_user_id)
           VALUES (?, ?, 'dm', '', 1, ?, ?)`,
        )
        .run(id, orgId, key, userA);
      for (const userId of new Set([userA, userB])) insertMember(conn, id, userId, 'member', 0);
      return { channel: find() as HubChatChannelRow, created: true };
    })
    .immediate();
}

/** Renames a channel or changes its topic. Fields left undefined are kept. */
export function updateChannel(
  channelId: string,
  patch: { name?: string; topic?: string | null },
): HubChatChannelRow | null {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    args.push(patch.name);
  }
  if (patch.topic !== undefined) {
    sets.push('topic = ?');
    args.push(patch.topic);
  }
  if (sets.length > 0) {
    db()
      .prepare(`UPDATE hub_chat_channels SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, channelId);
  }
  return getChannel(channelId);
}

export function archiveChannel(channelId: string): boolean {
  const r = db()
    .prepare(
      `UPDATE hub_chat_channels SET archived_at = ${NOW} WHERE id = ? AND archived_at IS NULL`,
    )
    .run(channelId);
  return r.changes > 0;
}

/**
 * Adds a member. New members start read up to the current tail, so joining a
 * busy channel does not surface its whole history as unread.
 */
export function addMember(
  channelId: string,
  userId: string,
  role: HubChatMemberRole = 'member',
): HubChatMemberRow | null {
  const conn = db();
  conn
    .transaction(() => {
      if (!getChannel(channelId)) return;
      insertMember(conn, channelId, userId, role, lastSeq(conn, channelId));
    })
    .immediate();
  return getMember(channelId, userId);
}

export function removeMember(channelId: string, userId: string): boolean {
  const r = db()
    .prepare('DELETE FROM hub_chat_members WHERE channel_id = ? AND user_id = ?')
    .run(channelId, userId);
  return r.changes > 0;
}

export function getMember(channelId: string, userId: string): HubChatMemberRow | null {
  const row = db()
    .prepare('SELECT * FROM hub_chat_members WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId) as HubChatMemberRow | undefined;
  return row ?? null;
}

export function listMembers(channelId: string): HubChatMemberRow[] {
  return db()
    .prepare('SELECT * FROM hub_chat_members WHERE channel_id = ? ORDER BY joined_at, user_id')
    .all(channelId) as HubChatMemberRow[];
}

export function updateMemberPrefs(
  channelId: string,
  userId: string,
  prefs: { notifyLevel?: HubChatNotifyLevel; mutedUntil?: string | null },
): HubChatMemberRow | null {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (prefs.notifyLevel !== undefined) {
    sets.push('notify_level = ?');
    args.push(prefs.notifyLevel);
  }
  if (prefs.mutedUntil !== undefined) {
    sets.push('muted_until = ?');
    args.push(prefs.mutedUntil);
  }
  if (sets.length > 0) {
    db()
      .prepare(
        `UPDATE hub_chat_members SET ${sets.join(', ')} WHERE channel_id = ? AND user_id = ?`,
      )
      .run(...args, channelId, userId);
  }
  return getMember(channelId, userId);
}

export interface AppendMessageInput {
  channelId: string;
  authorKind: HubChatAuthorKind;
  authorUserId?: string | null;
  authorAgentId?: string | null;
  body: string;
  refs?: HubChatRefInput[];
  payload?: unknown;
}

function writeRefs(conn: Database.Database, messageId: string, refs: HubChatRefInput[]): void {
  const ins = conn.prepare(
    `INSERT OR IGNORE INTO hub_chat_refs (message_id, kind, target_id, project_id)
     VALUES (?, ?, ?, ?)`,
  );
  for (const ref of refs) ins.run(messageId, ref.kind, ref.targetId, ref.projectId ?? null);
}

function refsJson(refs: HubChatRefInput[] | undefined): string | null {
  return refs && refs.length > 0 ? JSON.stringify(refs) : null;
}

/**
 * Appends a message with the next per-channel `seq`. Runs as an IMMEDIATE
 * transaction so two writers can never read the same tail. The author's own
 * read pointer advances past the new message.
 */
export function appendMessage(input: AppendMessageInput): HubChatMessageRow {
  const conn = db();
  const id = randomUUID();
  conn
    .transaction(() => {
      const seq = lastSeq(conn, input.channelId) + 1;
      conn
        .prepare(
          `INSERT INTO hub_chat_messages
             (id, channel_id, seq, author_kind, author_user_id, author_agent_id, body, refs_json, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.channelId,
          seq,
          input.authorKind,
          input.authorUserId ?? null,
          input.authorAgentId ?? null,
          input.body,
          refsJson(input.refs),
          input.payload === undefined ? null : JSON.stringify(input.payload),
        );
      writeRefs(conn, id, input.refs ?? []);
      if (input.authorKind === 'user' && input.authorUserId) {
        conn
          .prepare(
            `UPDATE hub_chat_members SET last_read_seq = MAX(last_read_seq, ?)
             WHERE channel_id = ? AND user_id = ?`,
          )
          .run(seq, input.channelId, input.authorUserId);
      }
    })
    .immediate();
  return getMessage(id) as HubChatMessageRow;
}

export function getMessage(messageId: string): HubChatMessageRow | null {
  const row = db().prepare('SELECT * FROM hub_chat_messages WHERE id = ?').get(messageId) as
    | HubChatMessageRow
    | undefined;
  return row ?? null;
}

export function listRefs(messageId: string): HubChatRefRow[] {
  return db()
    .prepare('SELECT * FROM hub_chat_refs WHERE message_id = ? ORDER BY kind, target_id')
    .all(messageId) as HubChatRefRow[];
}

/**
 * Pages messages in ascending `seq` order. With `before`, returns the `limit`
 * messages immediately preceding that seq; with `after`, the ones following it;
 * with neither, the latest `limit`.
 */
export function listMessages(
  channelId: string,
  opts: { before?: number; after?: number; limit?: number } = {},
): HubChatMessageRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const conn = db();
  if (opts.after !== undefined) {
    return conn
      .prepare(
        `SELECT * FROM hub_chat_messages WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(channelId, opts.after, limit) as HubChatMessageRow[];
  }
  const rows = conn
    .prepare(
      `SELECT * FROM hub_chat_messages WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(channelId, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as HubChatMessageRow[];
  return rows.reverse();
}

/** Replaces body (and refs, when given) of a live message. */
export function editMessage(
  messageId: string,
  update: { body: string; refs?: HubChatRefInput[]; payload?: unknown },
): HubChatMessageRow | null {
  const conn = db();
  const changed = conn.transaction(() => {
    const sets = ['body = ?', `edited_at = ${NOW}`];
    const args: unknown[] = [update.body];
    if (update.refs !== undefined) {
      sets.push('refs_json = ?');
      args.push(refsJson(update.refs));
    }
    if (update.payload !== undefined) {
      sets.push('payload_json = ?');
      args.push(JSON.stringify(update.payload));
    }
    const r = conn
      .prepare(
        `UPDATE hub_chat_messages SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(...args, messageId);
    if (r.changes === 0) return false;
    if (update.refs !== undefined) {
      conn.prepare('DELETE FROM hub_chat_refs WHERE message_id = ?').run(messageId);
      writeRefs(conn, messageId, update.refs);
    }
    return true;
  })();
  return changed ? getMessage(messageId) : null;
}

/**
 * Soft-deletes a message: keeps the row (and its seq) so paging stays stable,
 * but clears its content and refs so it no longer counts as a mention.
 */
export function softDeleteMessage(messageId: string): HubChatMessageRow | null {
  const conn = db();
  const changed = conn.transaction(() => {
    const r = conn
      .prepare(
        `UPDATE hub_chat_messages
           SET deleted_at = ${NOW}, body = '', refs_json = NULL, payload_json = NULL
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(messageId);
    if (r.changes === 0) return false;
    conn.prepare('DELETE FROM hub_chat_refs WHERE message_id = ?').run(messageId);
    // A deleted message keeps no reactions and drops off the pinned list.
    conn.prepare('DELETE FROM hub_chat_reactions WHERE message_id = ?').run(messageId);
    conn.prepare('DELETE FROM hub_chat_pins WHERE message_id = ?').run(messageId);
    conn
      .prepare('UPDATE hub_chat_messages SET meta_rev = meta_rev + 1 WHERE id = ?')
      .run(messageId);
    return true;
  })();
  return changed ? getMessage(messageId) : null;
}

/**
 * Moves the member's read pointer forward to `seq` (default: the channel tail),
 * clamped to the tail. Never moves it backwards. Returns the resulting pointer,
 * or null when the user is not a member.
 */
export function markRead(channelId: string, userId: string, seq?: number): number | null {
  const conn = db();
  return conn
    .transaction(() => {
      const tail = lastSeq(conn, channelId);
      const target = Math.min(seq ?? tail, tail);
      conn
        .prepare(
          `UPDATE hub_chat_members SET last_read_seq = MAX(last_read_seq, ?)
           WHERE channel_id = ? AND user_id = ?`,
        )
        .run(target, channelId, userId);
      return getMember(channelId, userId)?.last_read_seq ?? null;
    })
    .immediate();
}

// A message is unread for member `m` when it is past their pointer, not
// deleted, and not written by them.
const UNREAD_FILTER = `
  x.channel_id = m.channel_id
  AND x.seq > m.last_read_seq
  AND x.deleted_at IS NULL
  AND (x.author_kind <> 'user' OR x.author_user_id IS NULL OR x.author_user_id <> m.user_id)`;

const SUMMARY_SELECT = `
  SELECT c.*, m.role, m.last_read_seq, m.notify_level, m.muted_until,
    (SELECT COALESCE(MAX(seq), 0) FROM hub_chat_messages WHERE channel_id = c.id) AS last_seq,
    (SELECT COUNT(*) FROM hub_chat_messages x WHERE ${UNREAD_FILTER}) AS unread_count,
    (SELECT COUNT(DISTINCT x.id) FROM hub_chat_messages x
       JOIN hub_chat_refs r ON r.message_id = x.id AND r.kind = 'user' AND r.target_id = m.user_id
     WHERE ${UNREAD_FILTER}) AS mention_count
  FROM hub_chat_members m
  JOIN hub_chat_channels c ON c.id = m.channel_id`;

/** Channels the user belongs to in an org, each with their unread + mention counts. */
export function listChannelsForUser(
  orgId: string,
  userId: string,
  opts: { includeArchived?: boolean } = {},
): HubChatChannelSummary[] {
  return db()
    .prepare(
      `${SUMMARY_SELECT}
       WHERE m.user_id = ? AND c.org_id = ? ${opts.includeArchived ? '' : 'AND c.archived_at IS NULL'}
       ORDER BY c.created_at, c.id`,
    )
    .all(userId, orgId) as HubChatChannelSummary[];
}

/** One channel's summary for a member, or null when they are not a member. */
export function getChannelSummary(channelId: string, userId: string): HubChatChannelSummary | null {
  const row = db()
    .prepare(`${SUMMARY_SELECT} WHERE m.channel_id = ? AND m.user_id = ?`)
    .get(channelId, userId) as HubChatChannelSummary | undefined;
  return row ?? null;
}

/** Highest seq in the channel, 0 when empty. */
export function getChannelTailSeq(channelId: string): number {
  return lastSeq(db(), channelId);
}

/** Public, unarchived channels in an org that the user has not joined. */
export function listJoinableChannels(orgId: string, userId: string): HubChatChannelRow[] {
  return db()
    .prepare(
      `SELECT c.* FROM hub_chat_channels c
       WHERE c.org_id = ? AND c.is_private = 0 AND c.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM hub_chat_members m WHERE m.channel_id = c.id AND m.user_id = ?
         )
       ORDER BY c.name COLLATE NOCASE, c.id`,
    )
    .all(orgId, userId) as HubChatChannelRow[];
}

/** Binds an agent channel to the session its posts run in. */
export function setChannelSession(channelId: string, sessionId: string | null): void {
  db()
    .prepare('UPDATE hub_chat_channels SET session_id = ? WHERE id = ?')
    .run(sessionId, channelId);
}

/** Live agent channels bound to a session. */
export function listAgentChannelsForSession(sessionId: string): HubChatChannelRow[] {
  return db()
    .prepare(
      `SELECT * FROM hub_chat_channels
       WHERE session_id = ? AND kind = 'agent' AND archived_at IS NULL
       ORDER BY created_at, id`,
    )
    .all(sessionId) as HubChatChannelRow[];
}

/** A live message that references an entity, with the channel it was posted in. */
export interface HubChatBacklinkRow {
  message_id: string;
  channel_id: string;
  seq: number;
  author_kind: HubChatAuthorKind;
  author_user_id: string | null;
  author_agent_id: string | null;
  body: string;
  created_at: string;
  channel_kind: HubChatChannelKind;
  channel_name: string;
  dm_key: string | null;
}

/**
 * Messages that reference `kind:targetId`, newest first, limited to channels
 * `userId` can read in `orgId`: public channels and the ones they belong to.
 * Trigger posts are left out since they are automated notices, not
 * discussion; deleted messages and archived channels are left out too.
 */
export function listRefBacklinks(
  orgId: string,
  userId: string,
  kind: HubChatRefKind,
  targetId: string,
  limit: number,
): HubChatBacklinkRow[] {
  return db()
    .prepare(
      `SELECT x.id AS message_id, x.channel_id, x.seq, x.author_kind, x.author_user_id,
              x.author_agent_id, x.body, x.created_at,
              c.kind AS channel_kind, c.name AS channel_name, c.dm_key
       FROM hub_chat_refs r
       JOIN hub_chat_messages x ON x.id = r.message_id
       JOIN hub_chat_channels c ON c.id = x.channel_id
       WHERE r.kind = ? AND r.target_id = ?
         AND x.deleted_at IS NULL AND x.author_kind <> 'trigger'
         AND c.org_id = ? AND c.archived_at IS NULL
         AND (c.is_private = 0 OR EXISTS (
           SELECT 1 FROM hub_chat_members m WHERE m.channel_id = c.id AND m.user_id = ?
         ))
       GROUP BY x.id
       ORDER BY x.created_at DESC, x.seq DESC
       LIMIT ?`,
    )
    .all(kind, targetId, orgId, userId, limit) as HubChatBacklinkRow[];
}

export interface HubChatReactionSummary {
  emoji: string;
  count: number;
  /** Who reacted, earliest first. */
  userIds: string[];
}

/** Distinct emoji a single message may carry, so a message cannot be flooded. */
export const MAX_REACTION_EMOJI_PER_MESSAGE = 20;

function bumpMetaRev(conn: Database.Database, messageId: string): void {
  conn.prepare('UPDATE hub_chat_messages SET meta_rev = meta_rev + 1 WHERE id = ?').run(messageId);
}

export type ReactionResult = 'added' | 'removed' | 'unchanged' | 'too_many';

/**
 * Adds the user's reaction. Idempotent. A new emoji on a message already
 * carrying the maximum number of distinct emoji is refused.
 */
export function addReaction(messageId: string, userId: string, emoji: string): ReactionResult {
  const conn = db();
  return conn
    .transaction((): ReactionResult => {
      const exists = conn
        .prepare(
          'SELECT 1 FROM hub_chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        )
        .get(messageId, userId, emoji);
      if (exists) return 'unchanged';
      const known = conn
        .prepare('SELECT 1 FROM hub_chat_reactions WHERE message_id = ? AND emoji = ? LIMIT 1')
        .get(messageId, emoji);
      if (!known) {
        const { n } = conn
          .prepare('SELECT COUNT(DISTINCT emoji) AS n FROM hub_chat_reactions WHERE message_id = ?')
          .get(messageId) as { n: number };
        if (n >= MAX_REACTION_EMOJI_PER_MESSAGE) return 'too_many';
      }
      conn
        .prepare('INSERT INTO hub_chat_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)')
        .run(messageId, userId, emoji);
      bumpMetaRev(conn, messageId);
      return 'added';
    })
    .immediate();
}

export function removeReaction(messageId: string, userId: string, emoji: string): ReactionResult {
  const conn = db();
  return conn.transaction((): ReactionResult => {
    const r = conn
      .prepare('DELETE FROM hub_chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(messageId, userId, emoji);
    if (r.changes === 0) return 'unchanged';
    bumpMetaRev(conn, messageId);
    return 'removed';
  })();
}

function summarizeReactions(rows: HubChatReactionRow[]): HubChatReactionSummary[] {
  const byEmoji = new Map<string, HubChatReactionSummary>();
  for (const r of rows) {
    const entry = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, userIds: [] };
    entry.count += 1;
    entry.userIds.push(r.user_id);
    byEmoji.set(r.emoji, entry);
  }
  return [...byEmoji.values()];
}

const REACTION_ORDER = 'ORDER BY created_at, rowid';

/** Reactions on one message, grouped by emoji in the order each emoji first appeared. */
export function listReactions(messageId: string): HubChatReactionSummary[] {
  const rows = db()
    .prepare(`SELECT * FROM hub_chat_reactions WHERE message_id = ? ${REACTION_ORDER}`)
    .all(messageId) as HubChatReactionRow[];
  return summarizeReactions(rows);
}

/** Pins a message in its channel. Returns false when it was already pinned. */
export function pinMessage(message: HubChatMessageRow, userId: string): boolean {
  const conn = db();
  return conn.transaction(() => {
    const r = conn
      .prepare(
        `INSERT OR IGNORE INTO hub_chat_pins (message_id, channel_id, pinned_by_user_id)
         VALUES (?, ?, ?)`,
      )
      .run(message.id, message.channel_id, userId);
    if (r.changes === 0) return false;
    bumpMetaRev(conn, message.id);
    return true;
  })();
}

export function unpinMessage(messageId: string): boolean {
  const conn = db();
  return conn.transaction(() => {
    const r = conn.prepare('DELETE FROM hub_chat_pins WHERE message_id = ?').run(messageId);
    if (r.changes === 0) return false;
    bumpMetaRev(conn, messageId);
    return true;
  })();
}

export function getPin(messageId: string): HubChatPinRow | null {
  const row = db().prepare('SELECT * FROM hub_chat_pins WHERE message_id = ?').get(messageId) as
    | HubChatPinRow
    | undefined;
  return row ?? null;
}

/** A channel's pinned messages, most recently pinned first. */
export function listPins(channelId: string): { pin: HubChatPinRow; message: HubChatMessageRow }[] {
  const rows = db()
    .prepare(
      `SELECT p.message_id AS p_message_id, p.channel_id AS p_channel_id,
              p.pinned_by_user_id AS p_pinned_by_user_id, p.pinned_at AS p_pinned_at, m.*
       FROM hub_chat_pins p JOIN hub_chat_messages m ON m.id = p.message_id
       WHERE p.channel_id = ? AND m.deleted_at IS NULL
       ORDER BY p.pinned_at DESC, p.rowid DESC`,
    )
    .all(channelId) as (HubChatMessageRow & {
    p_message_id: string;
    p_channel_id: string;
    p_pinned_by_user_id: string | null;
    p_pinned_at: string;
  })[];
  return rows.map(({ p_message_id, p_channel_id, p_pinned_by_user_id, p_pinned_at, ...m }) => ({
    pin: {
      message_id: p_message_id,
      channel_id: p_channel_id,
      pinned_by_user_id: p_pinned_by_user_id,
      pinned_at: p_pinned_at,
    },
    message: m,
  }));
}
