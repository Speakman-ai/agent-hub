/**
 * Persistence for agent channel turns: which session turns came from a
 * channel post, which turn each tracked session is running, and replies
 * waiting to be posted. Schema: `hub-chat-schema.ts`. Logic:
 * `hub-chat-agent-channels.ts`.
 */
import type Database from 'better-sqlite3';
import { getDb } from './db.js';

export interface AgentTurnRow {
  turn_id: string;
  channel_id: string;
  session_id: string | null;
  started: number;
  reply_message_id: string | null;
  reply_content: string | null;
  created_at: string;
  /** Mention turns: the agent that answers. NULL on agent-channel turns. */
  agent_id?: string | null;
  project_id?: string | null;
}

function db(): Database.Database {
  return getDb();
}

export function insertAgentTurn(
  turnId: string,
  channelId: string,
  sessionId: string | null,
  agent: { agentId: string; projectId: string } | null = null,
): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO hub_chat_agent_turns
         (turn_id, channel_id, session_id, agent_id, project_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(turnId, channelId, sessionId, agent?.agentId ?? null, agent?.projectId ?? null);
}

export function getAgentTurn(turnId: string): AgentTurnRow | null {
  const row = db().prepare('SELECT * FROM hub_chat_agent_turns WHERE turn_id = ?').get(turnId) as
    | AgentTurnRow
    | undefined;
  return row ?? null;
}

/** Sets the session (when first known) and, optionally, marks the turn started. */
export function updateAgentTurn(turnId: string, sessionId: string, started: boolean): void {
  db()
    .prepare(
      `UPDATE hub_chat_agent_turns
         SET session_id = ?, started = MAX(started, ?)
       WHERE turn_id = ?`,
    )
    .run(sessionId, started ? 1 : 0, turnId);
}

export function setAgentTurnReply(turnId: string, messageId: string, content: string): void {
  db()
    .prepare(
      `UPDATE hub_chat_agent_turns SET reply_message_id = ?, reply_content = ? WHERE turn_id = ?`,
    )
    .run(messageId, content, turnId);
}

export function deleteAgentTurn(turnId: string): void {
  db().prepare('DELETE FROM hub_chat_agent_turns WHERE turn_id = ?').run(turnId);
}

/** Outstanding turns of a session, oldest first. */
export function listAgentTurnsForSession(sessionId: string): AgentTurnRow[] {
  return db()
    .prepare(`SELECT * FROM hub_chat_agent_turns WHERE session_id = ? ORDER BY created_at, rowid`)
    .all(sessionId) as AgentTurnRow[];
}

export function countAgentTurnsForSession(sessionId: string): number {
  const row = db()
    .prepare('SELECT COUNT(*) AS n FROM hub_chat_agent_turns WHERE session_id = ?')
    .get(sessionId) as { n: number };
  return row.n;
}

/** Sessions with outstanding turns. */
export function listSessionsWithAgentTurns(): string[] {
  return (
    db()
      .prepare(
        `SELECT DISTINCT session_id AS id FROM hub_chat_agent_turns WHERE session_id IS NOT NULL`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}

/**
 * Turns that never started and are not queued: their message never reached
 * the session (the server stopped first), so they cannot run.
 */
export function listOrphanedAgentTurns(): AgentTurnRow[] {
  return db()
    .prepare(
      `SELECT * FROM hub_chat_agent_turns t
       WHERE t.started = 0
         AND NOT EXISTS (SELECT 1 FROM message_queue q WHERE q.id = t.turn_id)
       ORDER BY t.created_at, t.rowid`,
    )
    .all() as AgentTurnRow[];
}

export function getSessionCurrentTurn(sessionId: string): string | null {
  const row = db()
    .prepare('SELECT turn_id FROM hub_chat_agent_session_turns WHERE session_id = ?')
    .get(sessionId) as { turn_id: string } | undefined;
  return row?.turn_id ?? null;
}

export function setSessionCurrentTurn(sessionId: string, turnId: string): void {
  db()
    .prepare(
      `INSERT INTO hub_chat_agent_session_turns (session_id, turn_id) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET turn_id = excluded.turn_id`,
    )
    .run(sessionId, turnId);
}

export function clearSessionCurrentTurn(sessionId: string): void {
  db().prepare('DELETE FROM hub_chat_agent_session_turns WHERE session_id = ?').run(sessionId);
}

/** The session a poster's mentions of an agent in a channel run in. */
export function getMentionSession(
  channelId: string,
  agentId: string,
  userId: string,
): string | null {
  const row = db()
    .prepare(
      `SELECT session_id FROM hub_chat_mention_sessions
       WHERE channel_id = ? AND agent_id = ? AND user_id = ?`,
    )
    .get(channelId, agentId, userId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setMentionSession(
  channelId: string,
  agentId: string,
  userId: string,
  sessionId: string,
): void {
  db()
    .prepare(
      `INSERT INTO hub_chat_mention_sessions (channel_id, agent_id, user_id, session_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id, agent_id, user_id) DO UPDATE SET session_id = excluded.session_id`,
    )
    .run(channelId, agentId, userId, sessionId);
}
