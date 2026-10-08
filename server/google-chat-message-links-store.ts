/**
 * Google Chat message → agent session links ("Send to agent").
 *
 * A link records that a Chat message was handed to a session so a second
 * dispatch can be warned about, and the message can link to the session
 * working on it. Links are not scoped to the dispatching Hub user: the point
 * is that another operator looking at the same message sees it was taken.
 *
 * `thread_name` is only stored when the space keeps replies in threads. A
 * link without one is marked replied by any post from its session into the
 * space (DMs, group chats, unthreaded spaces have no thread to reply in).
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.js';

export interface ChatMessageLink {
  id: string;
  messageName: string;
  spaceName: string;
  threadName: string | null;
  sessionId: string;
  sessionName: string | null;
  agentId: string | null;
  userId: string | null;
  createdAt: string;
  repliedAt: string | null;
  replyMessageName: string | null;
}

interface LinkRow {
  id: string;
  message_name: string;
  space_name: string;
  thread_name: string | null;
  session_id: string;
  session_name: string | null;
  agent_id: string | null;
  user_id: string | null;
  created_at: string;
  replied_at: string | null;
  reply_message_name: string | null;
}

const SELECT_LINK = `
  SELECT l.id, l.message_name, l.space_name, l.thread_name, l.session_id,
         s.name AS session_name, s.agent_id AS agent_id, l.user_id,
         l.created_at, l.replied_at, l.reply_message_name
    FROM google_chat_message_links l
    LEFT JOIN sessions s ON s.id = l.session_id`;

function toLink(row: LinkRow): ChatMessageLink {
  return {
    id: row.id,
    messageName: row.message_name,
    spaceName: row.space_name,
    threadName: row.thread_name,
    sessionId: row.session_id,
    sessionName: row.session_name,
    agentId: row.agent_id,
    userId: row.user_id,
    createdAt: row.created_at,
    repliedAt: row.replied_at,
    replyMessageName: row.reply_message_name,
  };
}

/** Links for every message in a space, oldest first. */
export function listChatMessageLinks(
  spaceName: string,
  db: Database.Database = getDb(),
): ChatMessageLink[] {
  const rows = db
    .prepare(`${SELECT_LINK} WHERE l.space_name = ? ORDER BY l.created_at ASC, l.id ASC`)
    .all(spaceName) as LinkRow[];
  return rows.map(toLink);
}

export function sessionExists(sessionId: string, db: Database.Database = getDb()): boolean {
  return !!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
}

/**
 * Record that `messageName` was sent to `sessionId`. Re-linking the same pair
 * returns the existing row unchanged. `existing` lists links to other
 * sessions that were already on the message before this call.
 */
export function createChatMessageLink(
  input: {
    messageName: string;
    spaceName: string;
    threadName: string | null;
    sessionId: string;
    userId: string | null;
  },
  db: Database.Database = getDb(),
): { link: ChatMessageLink; existing: ChatMessageLink[]; created: boolean } {
  return db.transaction(() => {
    const prior = (
      db
        .prepare(`${SELECT_LINK} WHERE l.message_name = ? ORDER BY l.created_at ASC, l.id ASC`)
        .all(input.messageName) as LinkRow[]
    ).map(toLink);
    const same = prior.find((l) => l.sessionId === input.sessionId);
    const existing = prior.filter((l) => l.sessionId !== input.sessionId);
    if (same) return { link: same, existing, created: false };
    const id = uuidv4();
    db.prepare(
      `INSERT INTO google_chat_message_links
         (id, message_name, space_name, thread_name, session_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.messageName, input.spaceName, input.threadName, input.sessionId, input.userId);
    // The session may have replied before this link existed.
    const earlier = db
      .prepare(
        `SELECT message_name, created_at FROM google_chat_session_posts
          WHERE session_id = ? AND space_name = ?
            AND (? IS NULL OR thread_name = ?)
          ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(input.sessionId, input.spaceName, input.threadName, input.threadName) as
      | { message_name: string | null; created_at: string }
      | undefined;
    if (earlier) {
      db.prepare(
        'UPDATE google_chat_message_links SET replied_at = ?, reply_message_name = ? WHERE id = ?',
      ).run(earlier.created_at, earlier.message_name, id);
    }
    const row = db.prepare(`${SELECT_LINK} WHERE l.id = ?`).get(id) as LinkRow;
    return { link: toLink(row), existing, created: true };
  })();
}

/**
 * Record that `sessionId` posted `replyMessageName` into `spaceName` (in
 * `threadName`, when the post landed in a thread) and stamp its matching
 * links as replied. The post is kept so a link created afterwards is stamped
 * too. Only the first reply is recorded. Returns how many links changed.
 */
export function recordSessionChatPost(
  input: {
    sessionId: string;
    spaceName: string;
    threadName: string | null;
    replyMessageName: string | null;
  },
  db: Database.Database = getDb(),
): number {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO google_chat_session_posts (id, session_id, space_name, thread_name, message_name)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?)`,
    ).run(
      uuidv4(),
      input.sessionId,
      input.spaceName,
      input.threadName,
      input.replyMessageName,
      input.sessionId,
    );
    const result = db
      .prepare(
        `UPDATE google_chat_message_links
          SET replied_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              reply_message_name = ?
        WHERE session_id = ?
          AND space_name = ?
          AND replied_at IS NULL
          AND (thread_name IS NULL OR thread_name = ?)`,
      )
      .run(input.replyMessageName, input.sessionId, input.spaceName, input.threadName);
    return result.changes;
  })();
}
