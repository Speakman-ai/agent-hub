/**
 * Persistence for scheduled channel digests (`hub_chat_channel_digests`). One
 * row per channel. Runner: `hub-chat-digests.ts`.
 */
import { getDb } from './db.js';

export type ChannelDigestScope = 'channel' | 'project';
export type ChannelDigestStatus = 'posted' | 'skipped' | 'error';

export interface ChannelDigestRow {
  channel_id: string;
  enabled: number;
  cron: string;
  time_zone: string;
  scope: ChannelDigestScope;
  project_id: string | null;
  owner_user_id: string;
  /** Start of the span the next run summarizes. */
  window_start: string;
  /** End of the last posted or skipped run. */
  last_run_at: string | null;
  last_status: ChannelDigestStatus | null;
  last_error: string | null;
  last_message_id: string | null;
  created_at: string;
  updated_at: string;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** How far back a new (or re-enabled) digest's first window reaches. */
export const DIGEST_DEFAULT_LOOKBACK_MS = 24 * 60 * 60_000;

export function getChannelDigest(channelId: string): ChannelDigestRow | null {
  const row = getDb()
    .prepare('SELECT * FROM hub_chat_channel_digests WHERE channel_id = ?')
    .get(channelId) as ChannelDigestRow | undefined;
  return row ?? null;
}

/** Enabled digests on live (unarchived) channels. */
export function listEnabledChannelDigests(): ChannelDigestRow[] {
  return getDb()
    .prepare(
      `SELECT d.* FROM hub_chat_channel_digests d
       JOIN hub_chat_channels c ON c.id = d.channel_id
       WHERE d.enabled = 1 AND c.archived_at IS NULL`,
    )
    .all() as ChannelDigestRow[];
}

export interface UpsertChannelDigestInput {
  channelId: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChannelDigestScope;
  projectId: string | null;
  ownerUserId: string;
  now?: Date;
}

/**
 * Creates or replaces a channel's digest config. A new digest starts its
 * cursor one default lookback before now. Editing keeps the cursor, so a
 * schedule change neither re-summarizes nor drops a span; re-enabling a
 * paused digest restarts it, so the paused stretch is not summarized.
 */
export function upsertChannelDigest(input: UpsertChannelDigestInput): ChannelDigestRow {
  const initialStart = new Date(
    (input.now ?? new Date()).getTime() - DIGEST_DEFAULT_LOOKBACK_MS,
  ).toISOString();
  getDb()
    .prepare(
      `INSERT INTO hub_chat_channel_digests
         (channel_id, enabled, cron, time_zone, scope, project_id, owner_user_id, window_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         window_start = CASE
           WHEN hub_chat_channel_digests.enabled = 0 AND excluded.enabled = 1
             THEN excluded.window_start
           ELSE hub_chat_channel_digests.window_start
         END,
         enabled = excluded.enabled,
         cron = excluded.cron,
         time_zone = excluded.time_zone,
         scope = excluded.scope,
         project_id = excluded.project_id,
         owner_user_id = excluded.owner_user_id,
         updated_at = ${NOW}`,
    )
    .run(
      input.channelId,
      input.enabled ? 1 : 0,
      input.cron,
      input.timeZone,
      input.scope,
      input.projectId,
      input.ownerUserId,
      initialStart,
    );
  return getChannelDigest(input.channelId) as ChannelDigestRow;
}

export function deleteChannelDigest(channelId: string): boolean {
  return (
    getDb().prepare('DELETE FROM hub_chat_channel_digests WHERE channel_id = ?').run(channelId)
      .changes > 0
  );
}

/**
 * Closes a window after a posted or skipped run: moves the cursor from
 * `fromStart` to `windowEnd`. Compare-and-set on the cursor, so a run whose
 * window no longer starts where the cursor is (another run already closed it,
 * or the digest was restarted) changes nothing. Returns whether it moved.
 */
export function advanceChannelDigestWindow(
  channelId: string,
  fromStart: string,
  result: { status: 'posted' | 'skipped'; windowEnd: string; messageId?: string | null },
): boolean {
  const r = getDb()
    .prepare(
      `UPDATE hub_chat_channel_digests SET
         window_start = ?,
         last_run_at = ?,
         last_status = ?,
         last_error = NULL,
         last_message_id = COALESCE(?, last_message_id)
       WHERE channel_id = ? AND window_start = ?`,
    )
    .run(
      result.windowEnd,
      result.windowEnd,
      result.status,
      result.messageId ?? null,
      channelId,
      fromStart,
    );
  return r.changes > 0;
}

/** Records a failed run. The cursor stays, so the retry covers the same window. */
export function recordChannelDigestFailure(channelId: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE hub_chat_channel_digests SET last_status = 'error', last_error = ?
       WHERE channel_id = ?`,
    )
    .run(error, channelId);
}
