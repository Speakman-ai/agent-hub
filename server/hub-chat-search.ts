/**
 * Full-text search over Agent Hub chat messages.
 *
 * The index (`hub_chat_messages_fts`) and its sync triggers live in
 * `hub-chat-schema.ts`. Visibility mirrors the routes' `visibleChannel`: channels in the caller's
 * org that are public or that the caller is a member of.
 */
import { getDb } from './db.js';
import { HUB_CHAT_FTS_TABLE as FTS_TABLE } from './hub-chat-schema.js';
import type { HubChatChannelKind, HubChatMessageRow } from './types.js';

/**
 * Turns free text into an FTS5 query: every word must match, each as a
 * prefix, and FTS operators typed by the user are matched literally. Returns
 * null when nothing searchable is left.
 */
export function buildHubChatFtsQuery(text: string): string | null {
  const words = text
    .split(/[\s"]+/u)
    .map((w) => w.replace(/[^\p{L}\p{N}_]+/gu, ' ').trim())
    .flatMap((w) => w.split(/\s+/))
    .filter(Boolean);
  if (words.length === 0) return null;
  // Every word must match, so a repeated word adds nothing. No word is ever
  // dropped otherwise; the route caps the query at 200 characters.
  const unique = [...new Map(words.map((w) => [w.toLowerCase(), w])).values()];
  return unique.map((w) => `"${w}"*`).join(' ');
}

export interface HubChatSearchHit extends HubChatMessageRow {
  channel_kind: HubChatChannelKind;
  channel_name: string;
  channel_dm_key: string | null;
  channel_is_private: number;
  is_member: number;
}

export interface SearchHubChatOptions {
  /** Only this channel (still subject to visibility). */
  channelId?: string;
  limit?: number;
}

/**
 * Newest-first live messages matching `text` in channels the user can read.
 * Fetches `limit + 1` rows so callers can tell whether more exist.
 */
export function searchHubChatMessages(
  orgId: string,
  userId: string,
  text: string,
  opts: SearchHubChatOptions = {},
): HubChatSearchHit[] {
  const query = buildHubChatFtsQuery(text);
  if (!query) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 50));
  const args: unknown[] = [userId, query, orgId];
  let channelFilter = '';
  if (opts.channelId) {
    channelFilter = 'AND c.id = ?';
    args.push(opts.channelId);
  }
  args.push(limit + 1);
  return getDb()
    .prepare(
      `SELECT m.*, c.kind AS channel_kind, c.name AS channel_name, c.dm_key AS channel_dm_key,
              c.is_private AS channel_is_private,
              CASE WHEN mem.user_id IS NULL THEN 0 ELSE 1 END AS is_member
       FROM ${FTS_TABLE} f
       JOIN hub_chat_messages m ON m.rowid = f.rowid
       JOIN hub_chat_channels c ON c.id = m.channel_id
       LEFT JOIN hub_chat_members mem ON mem.channel_id = c.id AND mem.user_id = ?
       WHERE ${FTS_TABLE} MATCH ?
         AND c.org_id = ?
         AND m.deleted_at IS NULL
         AND (c.is_private = 0 OR mem.user_id IS NOT NULL)
         ${channelFilter}
       ORDER BY m.created_at DESC, m.seq DESC
       LIMIT ?`,
    )
    .all(...args) as HubChatSearchHit[];
}
