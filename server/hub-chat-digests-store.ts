/**
 * Persistence for scheduled channel digests (`hub_chat_digests`). Id-keyed,
 * up to `MAX_DIGESTS_PER_CHANNEL` per channel, each with its own window
 * cursor. Runner: `hub-chat-digests.ts`.
 */
import { randomUUID } from 'crypto';
import { getDb } from './db.js';

export type ChannelDigestScope = 'channel' | 'project';
export type ChannelDigestStatus = 'posted' | 'skipped' | 'error';

export interface ChannelDigestRow {
  id: string;
  channel_id: string;
  name: string;
  enabled: number;
  cron: string;
  time_zone: string;
  scope: ChannelDigestScope;
  /** JSON array of project ids; read with `digestProjectIds`. */
  project_ids: string;
  prompt: string | null;
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

export const MAX_DIGESTS_PER_CHANNEL = 10;

/** The digest's project ids; a malformed column reads as none. */
export function digestProjectIds(row: Pick<ChannelDigestRow, 'project_ids'>): string[] {
  try {
    const parsed: unknown = JSON.parse(row.project_ids);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function getChannelDigest(digestId: string): ChannelDigestRow | null {
  const row = getDb().prepare('SELECT * FROM hub_chat_digests WHERE id = ?').get(digestId) as
    | ChannelDigestRow
    | undefined;
  return row ?? null;
}

/** A channel's digests, oldest first. */
export function listChannelDigests(channelId: string): ChannelDigestRow[] {
  return getDb()
    .prepare('SELECT * FROM hub_chat_digests WHERE channel_id = ? ORDER BY created_at, id')
    .all(channelId) as ChannelDigestRow[];
}

/** Enabled digests on live (unarchived) channels. */
export function listEnabledChannelDigests(): ChannelDigestRow[] {
  return getDb()
    .prepare(
      `SELECT d.* FROM hub_chat_digests d
       JOIN hub_chat_channels c ON c.id = d.channel_id
       WHERE d.enabled = 1 AND c.archived_at IS NULL`,
    )
    .all() as ChannelDigestRow[];
}

export interface ChannelDigestInput {
  name: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  scope: ChannelDigestScope;
  projectIds: string[];
  prompt: string | null;
  ownerUserId: string;
  now?: Date;
}

function initialWindowStart(now: Date | undefined): string {
  return new Date((now ?? new Date()).getTime() - DIGEST_DEFAULT_LOOKBACK_MS).toISOString();
}

/**
 * Adds a digest to a channel, its cursor one default lookback before now.
 * Returns null when the channel already holds `MAX_DIGESTS_PER_CHANNEL`; the
 * count and insert share a transaction so concurrent creates cannot overshoot.
 */
export function createChannelDigest(
  channelId: string,
  input: ChannelDigestInput,
): ChannelDigestRow | null {
  const db = getDb();
  const id = randomUUID();
  const created = db
    .transaction(() => {
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM hub_chat_digests WHERE channel_id = ?')
        .get(channelId) as { n: number };
      if (n >= MAX_DIGESTS_PER_CHANNEL) return false;
      db.prepare(
        `INSERT INTO hub_chat_digests
           (id, channel_id, name, enabled, cron, time_zone, scope, project_ids, prompt,
            owner_user_id, window_start)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        channelId,
        input.name,
        input.enabled ? 1 : 0,
        input.cron,
        input.timeZone,
        input.scope,
        JSON.stringify(input.projectIds),
        input.prompt,
        input.ownerUserId,
        initialWindowStart(input.now),
      );
      return true;
    })
    .immediate();
  return created ? getChannelDigest(id) : null;
}

/**
 * Replaces a digest's config. Editing keeps the cursor, so a schedule change
 * neither re-summarizes nor drops a span; re-enabling a paused digest
 * restarts it, so the paused stretch is not summarized.
 */
export function updateChannelDigest(
  digestId: string,
  input: ChannelDigestInput,
): ChannelDigestRow | null {
  const r = getDb()
    .prepare(
      `UPDATE hub_chat_digests SET
         window_start = CASE WHEN enabled = 0 AND ? = 1 THEN ? ELSE window_start END,
         name = ?,
         enabled = ?,
         cron = ?,
         time_zone = ?,
         scope = ?,
         project_ids = ?,
         prompt = ?,
         owner_user_id = ?,
         updated_at = ${NOW}
       WHERE id = ?`,
    )
    .run(
      input.enabled ? 1 : 0,
      initialWindowStart(input.now),
      input.name,
      input.enabled ? 1 : 0,
      input.cron,
      input.timeZone,
      input.scope,
      JSON.stringify(input.projectIds),
      input.prompt,
      input.ownerUserId,
      digestId,
    );
  return r.changes > 0 ? getChannelDigest(digestId) : null;
}

export function deleteChannelDigest(digestId: string): boolean {
  return getDb().prepare('DELETE FROM hub_chat_digests WHERE id = ?').run(digestId).changes > 0;
}

/**
 * Closes a window after a posted or skipped run: moves the cursor from
 * `fromStart` to `windowEnd`. Compare-and-set on the cursor, so a run whose
 * window no longer starts where the cursor is (another run already closed it,
 * or the digest was restarted) changes nothing. Returns whether it moved.
 */
export function advanceChannelDigestWindow(
  digestId: string,
  fromStart: string,
  result: { status: 'posted' | 'skipped'; windowEnd: string; messageId?: string | null },
): boolean {
  const r = getDb()
    .prepare(
      `UPDATE hub_chat_digests SET
         window_start = ?,
         last_run_at = ?,
         last_status = ?,
         last_error = NULL,
         last_message_id = COALESCE(?, last_message_id)
       WHERE id = ? AND window_start = ?`,
    )
    .run(
      result.windowEnd,
      result.windowEnd,
      result.status,
      result.messageId ?? null,
      digestId,
      fromStart,
    );
  return r.changes > 0;
}

/** Records a failed run. The cursor stays, so the retry covers the same window. */
export function recordChannelDigestFailure(digestId: string, error: string): void {
  getDb()
    .prepare(`UPDATE hub_chat_digests SET last_status = 'error', last_error = ? WHERE id = ?`)
    .run(error, digestId);
}
