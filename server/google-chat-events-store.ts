/**
 * Persistence for Google Chat push: one Workspace Events API subscription per
 * Hub user, and the per-user unread state the events feed.
 *
 * Unread is tracked per message (not as a counter) so a redelivered Pub/Sub
 * message is a no-op, and a per-space `read_through` marker keeps a late
 * redelivery of an already-read message from coming back as unread. Chat
 * createTime values carry sub-millisecond precision, so ordering goes through
 * `compareRfc3339`, never `Date` or SQL string comparison.
 */
import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import { compareRfc3339 } from '../shared/utils/rfc3339.js';

export type ChatSubscriptionState = 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'ERROR';

export interface ChatEventSubscription {
  userId: string;
  subscriptionName: string | null;
  authority: string | null;
  state: ChatSubscriptionState;
  expireTime: string | null;
  suspensionReason: string | null;
  lastError: string | null;
  updatedAt: string;
  /** The user's push-state sequence number as of this read (see db.ts). */
  version: number;
}

interface SubscriptionRow {
  user_id: string;
  subscription_name: string | null;
  authority: string | null;
  state: ChatSubscriptionState;
  expire_time: string | null;
  suspension_reason: string | null;
  last_error: string | null;
  updated_at: string;
  version: number;
}

function toSubscription(row: SubscriptionRow): ChatEventSubscription {
  return {
    userId: row.user_id,
    subscriptionName: row.subscription_name,
    authority: row.authority,
    state: row.state,
    expireTime: row.expire_time,
    suspensionReason: row.suspension_reason,
    lastError: row.last_error,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

const SELECT_SUB = `SELECT s.user_id, s.subscription_name, s.authority, s.state, s.expire_time,
  s.suspension_reason, s.last_error, s.updated_at, COALESCE(q.seq, 0) AS version
  FROM google_chat_event_subscriptions s
  LEFT JOIN google_chat_user_seq q ON q.user_id = s.user_id`;

/** The user's latest push-state sequence number (0 = no changes yet). */
export function currentChatSeq(userId: string, db: Database.Database = getDb()): number {
  const row = db.prepare('SELECT seq FROM google_chat_user_seq WHERE user_id = ?').get(userId) as
    | { seq: number }
    | undefined;
  return row?.seq ?? 0;
}

/** Take the user's next sequence number. Call inside the mutation's transaction. */
function nextChatSeq(db: Database.Database, userId: string): number {
  db.prepare(
    `INSERT INTO google_chat_user_seq (user_id, seq) VALUES (?, 1)
     ON CONFLICT(user_id) DO UPDATE SET seq = seq + 1`,
  ).run(userId);
  return currentChatSeq(userId, db);
}

export function getChatSubscription(
  userId: string,
  db: Database.Database = getDb(),
): ChatEventSubscription | null {
  const row = db.prepare(`${SELECT_SUB} WHERE s.user_id = ?`).get(userId) as
    | SubscriptionRow
    | undefined;
  return row ? toSubscription(row) : null;
}

export function getChatSubscriptionByName(
  subscriptionName: string,
  db: Database.Database = getDb(),
): ChatEventSubscription | null {
  const row = db.prepare(`${SELECT_SUB} WHERE s.subscription_name = ?`).get(subscriptionName) as
    | SubscriptionRow
    | undefined;
  return row ? toSubscription(row) : null;
}

export function listChatSubscriptions(db: Database.Database = getDb()): ChatEventSubscription[] {
  return (db.prepare(`${SELECT_SUB} ORDER BY s.user_id`).all() as SubscriptionRow[]).map(
    toSubscription,
  );
}

function retireOwner(db: Database.Database, subscriptionName: string): void {
  db.prepare(
    `UPDATE google_chat_subscription_owners
        SET retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE subscription_name = ? AND retired_at IS NULL`,
  ).run(subscriptionName);
}

export interface SubscriptionOwner {
  userId: string;
  authority: string | null;
  retiredAt: string | null;
}

/** Who owns (or owned) a subscription name, current or retired. */
export function getSubscriptionOwner(
  subscriptionName: string,
  db: Database.Database = getDb(),
): SubscriptionOwner | null {
  const row = db
    .prepare(
      'SELECT user_id, authority, retired_at FROM google_chat_subscription_owners WHERE subscription_name = ?',
    )
    .get(subscriptionName) as
    | { user_id: string; authority: string | null; retired_at: string | null }
    | undefined;
  return row ? { userId: row.user_id, authority: row.authority, retiredAt: row.retired_at } : null;
}

/** Forget names retired before `cutoffIso` (past Pub/Sub's redelivery window). */
export function pruneRetiredOwners(cutoffIso: string, db: Database.Database = getDb()): number {
  return db
    .prepare(
      'DELETE FROM google_chat_subscription_owners WHERE retired_at IS NOT NULL AND retired_at < ?',
    )
    .run(cutoffIso).changes;
}

export function upsertChatSubscription(
  input: {
    userId: string;
    subscriptionName: string | null;
    authority: string | null;
    state: ChatSubscriptionState;
    expireTime: string | null;
    suspensionReason?: string | null;
    lastError?: string | null;
  },
  db: Database.Database = getDb(),
): ChatEventSubscription {
  db.transaction(() => {
    // A subscription name belongs to one user; a stale row elsewhere (an
    // account re-linked to another Hub user) would route events to the wrong
    // person.
    if (input.subscriptionName) {
      const others = db
        .prepare(
          'SELECT user_id FROM google_chat_event_subscriptions WHERE subscription_name = ? AND user_id <> ?',
        )
        .all(input.subscriptionName, input.userId) as Array<{ user_id: string }>;
      for (const other of others) {
        db.prepare('DELETE FROM google_chat_event_subscriptions WHERE user_id = ?').run(
          other.user_id,
        );
        nextChatSeq(db, other.user_id);
      }
    }
    // Ownership is history, not just the current row: a name that stops
    // being current is retired, not forgotten.
    const previous = db
      .prepare('SELECT subscription_name FROM google_chat_event_subscriptions WHERE user_id = ?')
      .get(input.userId) as { subscription_name: string | null } | undefined;
    if (previous?.subscription_name && previous.subscription_name !== input.subscriptionName) {
      retireOwner(db, previous.subscription_name);
    }
    if (input.subscriptionName) {
      db.prepare(
        `INSERT INTO google_chat_subscription_owners (subscription_name, user_id, authority, retired_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(subscription_name) DO UPDATE SET
           user_id = excluded.user_id, authority = excluded.authority, retired_at = NULL`,
      ).run(input.subscriptionName, input.userId, input.authority);
    }
    nextChatSeq(db, input.userId);
    db.prepare(
      `INSERT INTO google_chat_event_subscriptions
         (user_id, subscription_name, authority, state, expire_time, suspension_reason, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(user_id) DO UPDATE SET
         subscription_name = excluded.subscription_name,
         authority = excluded.authority,
         state = excluded.state,
         expire_time = excluded.expire_time,
         suspension_reason = excluded.suspension_reason,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
    ).run(
      input.userId,
      input.subscriptionName,
      input.authority,
      input.state,
      input.expireTime,
      input.suspensionReason ?? null,
      input.lastError ?? null,
    );
  })();
  return getChatSubscription(input.userId, db)!;
}

export function deleteChatSubscription(userId: string, db: Database.Database = getDb()): void {
  db.transaction(() => {
    const row = db
      .prepare('SELECT subscription_name FROM google_chat_event_subscriptions WHERE user_id = ?')
      .get(userId) as { subscription_name: string | null } | undefined;
    if (row?.subscription_name) retireOwner(db, row.subscription_name);
    db.prepare('DELETE FROM google_chat_event_subscriptions WHERE user_id = ?').run(userId);
    nextChatSeq(db, userId);
  })();
}

export interface SpaceUnread {
  spaceName: string;
  count: number;
  lastMessageTime: string | null;
  /**
   * The user's push-state sequence number when this space last changed (0 =
   * never). Newer state always has a higher number, whatever channel
   * delivered it.
   */
  version: number;
}

export interface UnreadSnapshot {
  spaces: SpaceUnread[];
  /** The user's latest sequence number: the snapshot reflects every change up to it. */
  version: number;
}

/** Stamp a change to (user, space) with the user's next number. Call inside the mutation's transaction. */
function bumpVersion(db: Database.Database, userId: string, spaceName: string): void {
  db.prepare(
    `INSERT INTO google_chat_unread_versions (user_id, space_name, version) VALUES (?, ?, ?)
     ON CONFLICT(user_id, space_name) DO UPDATE SET version = excluded.version`,
  ).run(userId, spaceName, nextChatSeq(db, userId));
}

function spaceVersion(db: Database.Database, userId: string, spaceName: string): number {
  const row = db
    .prepare('SELECT version FROM google_chat_unread_versions WHERE user_id = ? AND space_name = ?')
    .get(userId, spaceName) as { version: number } | undefined;
  return row?.version ?? 0;
}

/**
 * Record an unread message. Returns false when it was already recorded, or
 * the user already read the space past it.
 */
export function recordUnreadMessage(
  input: { userId: string; spaceName: string; messageName: string; createTime: string },
  db: Database.Database = getDb(),
): boolean {
  return db.transaction(() => {
    const read = db
      .prepare(
        'SELECT read_through FROM google_chat_space_reads WHERE user_id = ? AND space_name = ?',
      )
      .get(input.userId, input.spaceName) as { read_through: string } | undefined;
    if (read && compareRfc3339(input.createTime, read.read_through) <= 0) return false;
    const deleted = db
      .prepare('SELECT 1 FROM google_chat_deleted_messages WHERE user_id = ? AND message_name = ?')
      .get(input.userId, input.messageName);
    if (deleted) return false;
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO google_chat_unread_messages
           (user_id, message_name, space_name, create_time) VALUES (?, ?, ?, ?)`,
      )
      .run(input.userId, input.messageName, input.spaceName, input.createTime);
    if (info.changes > 0) bumpVersion(db, input.userId, input.spaceName);
    return info.changes > 0;
  })();
}

/**
 * A message was deleted in Chat: remember that (so a created event delivered
 * later can't bring it back) and drop it from unread. Returns the space's new
 * unread state when it changed, else null.
 */
export function recordDeletedMessage(
  input: { userId: string; spaceName: string; messageName: string },
  db: Database.Database = getDb(),
): SpaceUnread | null {
  return db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO google_chat_deleted_messages (user_id, message_name) VALUES (?, ?)`,
    ).run(input.userId, input.messageName);
    const info = db
      .prepare('DELETE FROM google_chat_unread_messages WHERE user_id = ? AND message_name = ?')
      .run(input.userId, input.messageName);
    if (info.changes === 0) return null;
    bumpVersion(db, input.userId, input.spaceName);
    return getSpaceUnread(input.userId, input.spaceName, db);
  })();
}

/** Drop deletion markers older than `cutoffIso` (past Pub/Sub's redelivery window). */
export function pruneDeletedMessageMarkers(
  cutoffIso: string,
  db: Database.Database = getDb(),
): number {
  return db.prepare('DELETE FROM google_chat_deleted_messages WHERE deleted_at < ?').run(cutoffIso)
    .changes;
}

function unreadBySpace(db: Database.Database, userId: string): Map<string, SpaceUnread> {
  const rows = db
    .prepare(
      'SELECT space_name, create_time FROM google_chat_unread_messages WHERE user_id = ? ORDER BY space_name',
    )
    .all(userId) as Array<{ space_name: string; create_time: string }>;
  const bySpace = new Map<string, SpaceUnread>();
  for (const row of rows) {
    const entry = bySpace.get(row.space_name) ?? {
      spaceName: row.space_name,
      count: 0,
      lastMessageTime: null,
      version: spaceVersion(db, userId, row.space_name),
    };
    entry.count += 1;
    if (!entry.lastMessageTime || compareRfc3339(row.create_time, entry.lastMessageTime) > 0) {
      entry.lastMessageTime = row.create_time;
    }
    bySpace.set(row.space_name, entry);
  }
  return bySpace;
}

export function getSpaceUnread(
  userId: string,
  spaceName: string,
  db: Database.Database = getDb(),
): SpaceUnread {
  return (
    unreadBySpace(db, userId).get(spaceName) ?? {
      spaceName,
      count: 0,
      lastMessageTime: null,
      version: spaceVersion(db, userId, spaceName),
    }
  );
}

/** Unread counts per space for a user, most recent message first. */
export function listUnread(userId: string, db: Database.Database = getDb()): SpaceUnread[] {
  return [...unreadBySpace(db, userId).values()].sort((a, b) =>
    compareRfc3339(b.lastMessageTime as string, a.lastMessageTime as string),
  );
}

/** Spaces with unread messages plus the version they are consistent with. */
export function getUnreadSnapshot(userId: string, db: Database.Database = getDb()): UnreadSnapshot {
  return db.transaction(() => ({
    spaces: listUnread(userId, db),
    version: currentChatSeq(userId, db),
  }))();
}

/**
 * Mark a space read through `readThrough` (inclusive). Without a bound, every
 * recorded unread message in the space is cleared and the marker moves to the
 * newest of them. The marker never moves backwards. Always takes a new
 * version: the response must supersede the caller's optimistic clear and any
 * state it saw earlier.
 */
export function markSpaceRead(
  input: { userId: string; spaceName: string; readThrough?: string | null },
  db: Database.Database = getDb(),
): SpaceUnread {
  return db.transaction(() => {
    const rows = db
      .prepare(
        'SELECT message_name, create_time FROM google_chat_unread_messages WHERE user_id = ? AND space_name = ?',
      )
      .all(input.userId, input.spaceName) as Array<{ message_name: string; create_time: string }>;
    let bound = input.readThrough ?? null;
    if (!bound) {
      for (const row of rows) {
        if (!bound || compareRfc3339(row.create_time, bound) > 0) bound = row.create_time;
      }
    }
    if (bound) {
      const del = db.prepare(
        'DELETE FROM google_chat_unread_messages WHERE user_id = ? AND message_name = ?',
      );
      for (const row of rows) {
        if (compareRfc3339(row.create_time, bound) <= 0) del.run(input.userId, row.message_name);
      }
      const current = db
        .prepare(
          'SELECT read_through FROM google_chat_space_reads WHERE user_id = ? AND space_name = ?',
        )
        .get(input.userId, input.spaceName) as { read_through: string } | undefined;
      if (!current || compareRfc3339(bound, current.read_through) > 0) {
        db.prepare(
          `INSERT INTO google_chat_space_reads (user_id, space_name, read_through) VALUES (?, ?, ?)
           ON CONFLICT(user_id, space_name) DO UPDATE SET read_through = excluded.read_through`,
        ).run(input.userId, input.spaceName, bound);
      }
    }
    bumpVersion(db, input.userId, input.spaceName);
    return getSpaceUnread(input.userId, input.spaceName, db);
  })();
}

/**
 * Drop all Chat push state for a user (Google disconnected or read access
 * gone). Returns the spaces whose unread state changed, each at its new
 * version, so the caller can tell connected clients.
 */
export function clearChatEventState(
  userId: string,
  db: Database.Database = getDb(),
): SpaceUnread[] {
  return db.transaction(() => {
    db.prepare('DELETE FROM google_chat_event_subscriptions WHERE user_id = ?').run(userId);
    // Versions stay (numbers must never repeat); cleared spaces take a new one.
    const cleared = [...unreadBySpace(db, userId).keys()];
    db.prepare('DELETE FROM google_chat_unread_messages WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM google_chat_space_reads WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM google_chat_deleted_messages WHERE user_id = ?').run(userId);
    // Access is gone: events for any of the user's subscriptions, current or
    // retired, must not reach them.
    db.prepare('DELETE FROM google_chat_subscription_owners WHERE user_id = ?').run(userId);
    for (const space of cleared) bumpVersion(db, userId, space);
    nextChatSeq(db, userId);
    return cleared.map((space) => getSpaceUnread(userId, space, db));
  })();
}

/** Most unrouted deliveries kept at once; the oldest go first. */
export const MAX_UNROUTED_EVENTS = 5000;

/** Hold a delivery for a subscription that isn't registered yet. */
export function bufferUnroutedEvent(
  subscriptionName: string,
  envelope: string,
  db: Database.Database = getDb(),
): void {
  db.transaction(() => {
    db.prepare(
      'INSERT INTO google_chat_unrouted_events (subscription_name, envelope) VALUES (?, ?)',
    ).run(subscriptionName, envelope);
    db.prepare(
      `DELETE FROM google_chat_unrouted_events WHERE id <= (
         SELECT id FROM google_chat_unrouted_events ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
    ).run(MAX_UNROUTED_EVENTS);
  })();
}

/** Held deliveries for a subscription, oldest first. Not removed: see deleteUnroutedEvent. */
export function listUnroutedEvents(
  subscriptionName: string,
  db: Database.Database = getDb(),
): Array<{ id: number; envelope: string }> {
  return db
    .prepare(
      'SELECT id, envelope FROM google_chat_unrouted_events WHERE subscription_name = ? ORDER BY id',
    )
    .all(subscriptionName) as Array<{ id: number; envelope: string }>;
}

/**
 * Remove one held delivery. Call inside the same transaction as the unread
 * changes it produced, so it is gone only if they committed.
 */
export function deleteUnroutedEvent(id: number, db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM google_chat_unrouted_events WHERE id = ?').run(id);
}

/** Drop held deliveries received before `cutoffIso`. */
export function pruneUnroutedEvents(cutoffIso: string, db: Database.Database = getDb()): number {
  return db.prepare('DELETE FROM google_chat_unrouted_events WHERE received_at < ?').run(cutoffIso)
    .changes;
}
