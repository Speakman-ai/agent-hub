/**
 * Per-user Summaries channel (`kind = 'summary'`): the chat home for scheduled
 * AI summaries. Each user has at most one per org, created on first use and
 * private to them. Scheduled summaries are `my_work` digests on this channel
 * (`hub-chat-digests.ts`).
 */
import { getDb } from './db.js';
import { getActiveOrgId } from './orgs.js';
import { getMembershipRole, listMembershipsForUser } from './memberships-store.js';
import { createChannel } from './hub-chat-store.js';
import type { HubChatChannelRow } from './types.js';

export const SUMMARY_CHANNEL_NAME = 'Summaries';

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
