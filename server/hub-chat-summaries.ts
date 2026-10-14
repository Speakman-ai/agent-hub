/**
 * Per-user Summaries channel (`kind = 'summary'`): the chat home for scheduled
 * AI summaries. Each user has at most one per org, created on first post and
 * private to them.
 *
 * Scheduled daily summaries post here once per user per local date. The guard
 * is the message itself (`payload.type = 'daily_summary'`, `payload.date`), so
 * several configured refresh times, a ticker that fires twice, or a server
 * restart never double-post. The on-demand regenerate route never calls this.
 */
import { getDb } from './db.js';
import { getActiveOrgId } from './orgs.js';
import { getMembershipRole, listMembershipsForUser } from './memberships-store.js';
import { appendMessage, createChannel, getChannel } from './hub-chat-store.js';
import { broadcastHubChatMessage } from './hub-chat-broadcast.js';
import { HUB_CHAT_MESSAGE_EVENT } from './hub-chat-events.js';
import type { BroadcastFn, HubChatChannelRow, HubChatMessageRow } from './types.js';
import type { HubDailySummaryStored } from './user-preferences-store.js';

export const SUMMARY_CHANNEL_NAME = 'Summaries';
export const DAILY_SUMMARY_PAYLOAD_TYPE = 'daily_summary';

/**
 * The org a user's Summaries channel lives in when there is no request to read
 * it from: the active org when they belong to it, else their first membership.
 */
export function summaryOrgForUser(userId: string): string {
  const active = getActiveOrgId();
  try {
    if (getMembershipRole(userId, active)) return active;
    const first = listMembershipsForUser(userId)[0];
    if (first) return first.org_id;
  } catch {
    /* orgs store unavailable: fall back to the active org */
  }
  return active;
}

/** The user's Summaries channel in an org, or null when none exists yet. */
export function findSummaryChannel(orgId: string, userId: string): HubChatChannelRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM hub_chat_channels
       WHERE org_id = ? AND kind = 'summary' AND created_by_user_id = ? AND archived_at IS NULL
       ORDER BY created_at, id LIMIT 1`,
    )
    .get(orgId, userId) as HubChatChannelRow | undefined;
  return row ?? null;
}

/** Returns the user's Summaries channel, creating it on first use. */
export function getOrCreateSummaryChannel(
  orgId: string,
  userId: string,
): { channel: HubChatChannelRow; created: boolean } {
  const conn = getDb();
  return conn
    .transaction(() => {
      const existing = findSummaryChannel(orgId, userId);
      if (existing) return { channel: existing, created: false };
      const channel = createChannel({
        orgId,
        kind: 'summary',
        name: SUMMARY_CHANNEL_NAME,
        topic: 'Scheduled AI summaries',
        createdByUserId: userId,
      });
      return { channel, created: true };
    })
    .immediate();
}

function findDailySummaryMessage(channelId: string, date: string): HubChatMessageRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM hub_chat_messages
       WHERE channel_id = ? AND deleted_at IS NULL
         AND json_extract(payload_json, '$.type') = ?
         AND json_extract(payload_json, '$.date') = ?
       LIMIT 1`,
    )
    .get(channelId, DAILY_SUMMARY_PAYLOAD_TYPE, date) as HubChatMessageRow | undefined;
  return row ?? null;
}

export function dailySummaryChatBody(report: HubDailySummaryStored): string {
  return `Daily summary for ${report.date}\n\n${report.markdown}`;
}

export interface PostDailySummaryResult {
  channel: HubChatChannelRow;
  message: HubChatMessageRow;
  /** False when this date was already posted; nothing was written or sent. */
  posted: boolean;
}

/**
 * Posts a scheduled daily summary into the user's Summaries channel, at most
 * once per local date. The broadcast it sends is what fires the phone push.
 */
export function postDailySummaryToChannel(input: {
  userId: string;
  report: HubDailySummaryStored;
  broadcast?: BroadcastFn;
  orgId?: string;
}): PostDailySummaryResult {
  const orgId = input.orgId ?? summaryOrgForUser(input.userId);
  const { report } = input;
  const result = getDb()
    .transaction((): PostDailySummaryResult => {
      const { channel } = getOrCreateSummaryChannel(orgId, input.userId);
      const existing = findDailySummaryMessage(channel.id, report.date);
      if (existing) return { channel, message: existing, posted: false };
      const message = appendMessage({
        channelId: channel.id,
        authorKind: 'system',
        body: dailySummaryChatBody(report),
        payload: {
          type: DAILY_SUMMARY_PAYLOAD_TYPE,
          date: report.date,
          timeZone: report.timeZone,
          generatedAt: report.generatedAt,
          engine: report.engine,
          model: report.model,
        },
      });
      return { channel, message, posted: true };
    })
    .immediate();
  if (result.posted) {
    broadcastHubChatMessage(
      input.broadcast,
      HUB_CHAT_MESSAGE_EVENT,
      getChannel(result.channel.id) ?? result.channel,
      result.message,
    );
  }
  return result;
}
