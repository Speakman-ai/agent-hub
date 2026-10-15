/**
 * Converts each user's daily summary schedule (`preferences_json`
 * `hubDailySummarySchedule`: local times + timezone) into one `my_work` digest
 * on their Summaries channel, which is created when missing. After this the
 * digest runner is the only thing that posts scheduled summaries.
 *
 * One digest per schedule, whatever its times: the times become the fewest
 * cron expressions that fire exactly at them (`dailySummaryTimesToCrons`),
 * joined into the digest's multi-expression schedule. One digest also keeps
 * one window cursor, so each summary covers the span since the previous one.
 * A user is converted once: the digest and the marker row share a
 * transaction, so removing the digest later does not bring it back. When the
 * channel is full, nothing is written, the owner gets one notice in the
 * channel, and the conversion is retried on every tick until a slot frees.
 */
import { getDb } from './db.js';
import {
  createChannelDigest,
  listChannelDigests,
  MAX_DIGESTS_PER_CHANNEL,
  seedChannelDigestLastRun,
} from './hub-chat-digests-store.js';
import { appendMessage } from './hub-chat-store.js';
import { broadcastHubChatMessage } from './hub-chat-broadcast.js';
import { HUB_CHAT_MESSAGE_EVENT } from './hub-chat-events.js';
import { defaultDigestName } from './hub-chat-schema.js';
import { getOrCreateSummaryChannel, summaryOrgForUser } from './hub-chat-summaries.js';
import { listUsersWithDailySummarySchedule } from './user-preferences-store.js';
import { CHAT_DIGEST_CRON_SEPARATOR } from '../shared/utils/chatDigest.js';
import type { HubDailySummarySchedule } from './daily-summary-schedule.js';
import type { BroadcastFn, HubChatChannelRow, HubChatMessageRow } from './types.js';

function parseTimes(times: ReadonlyArray<string>): Array<[hour: number, minute: number]> {
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  for (const time of [...times].sort()) {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match || seen.has(time)) continue;
    seen.add(time);
    out.push([Number(match[1]), Number(match[2])]);
  }
  return out;
}

interface CronRect {
  hours: number[];
  minutes: number[];
  /** Bit i set when the rectangle holds pairs[i]. */
  mask: number;
}

/** Above this many times the exact search is skipped; the schedule caps at 12. */
const MAX_EXACT_TIMES = 12;

/**
 * Every hours x minutes rectangle made only of configured times. A daily
 * cron `M1,M2 H1,H2 * * *` fires at exactly such a rectangle.
 */
function cronRects(pairs: ReadonlyArray<[number, number]>): CronRect[] {
  const index = new Map(pairs.map(([h, m], i) => [`${h}:${m}`, i]));
  const hours = [...new Set(pairs.map(([h]) => h))].sort((a, b) => a - b);
  const minutesOf = new Map<number, Set<number>>();
  for (const [h, m] of pairs) minutesOf.set(h, (minutesOf.get(h) ?? new Set()).add(m));
  const rects = new Map<number, CronRect>();
  for (let hs = 1; hs < 1 << hours.length; hs += 1) {
    const picked = hours.filter((_, i) => hs & (1 << i));
    const common = [...minutesOf.get(picked[0])!]
      .filter((m) => picked.every((h) => minutesOf.get(h)!.has(m)))
      .sort((a, b) => a - b);
    for (let ms = 1; ms < 1 << common.length; ms += 1) {
      const minutes = common.filter((_, i) => ms & (1 << i));
      let mask = 0;
      for (const h of picked) for (const m of minutes) mask |= 1 << index.get(`${h}:${m}`)!;
      if (!rects.has(mask)) rects.set(mask, { hours: picked, minutes, mask });
    }
  }
  return [...rects.values()];
}

/**
 * Fewest disjoint rectangles covering every time. Disjoint, so no two digests
 * fire in the same minute. Branches on the lowest uncovered time; small
 * enough to search exactly.
 */
function minimumCronCover(pairs: ReadonlyArray<[number, number]>): CronRect[] {
  const rects = cronRects(pairs);
  const full = (1 << pairs.length) - 1;
  let best: CronRect[] | null = null;
  const search = (covered: number, chosen: CronRect[]) => {
    if (covered === full) {
      if (!best || chosen.length < best.length) best = [...chosen];
      return;
    }
    if (best && chosen.length + 1 >= best.length) return;
    let bit = 0;
    while (covered & (1 << bit)) bit += 1;
    for (const rect of rects) {
      if (!(rect.mask & (1 << bit)) || rect.mask & covered) continue;
      chosen.push(rect);
      search(covered | rect.mask, chosen);
      chosen.pop();
    }
  };
  search(0, []);
  return best ?? [];
}

/**
 * The fewest daily crons that together fire at exactly `times`, each time
 * once. `['08:00','17:00']` gives `0 8,17 * * *`; `['08:00','08:30']` gives
 * `0,30 8 * * *`; mixed shapes combine both. Ordered by first fire time.
 */
export function dailySummaryTimesToCrons(times: ReadonlyArray<string>): string[] {
  const pairs = parseTimes(times);
  const rects: CronRect[] =
    pairs.length <= MAX_EXACT_TIMES
      ? minimumCronCover(pairs)
      : pairs.map(([h, m], i) => ({ hours: [h], minutes: [m], mask: 1 << i }));
  return rects
    .map((r) => ({
      first: r.hours[0] * 60 + r.minutes[0],
      cron: `${r.minutes.join(',')} ${r.hours.join(',')} * * *`,
    }))
    .sort((a, b) => a.first - b.first)
    .map((r) => r.cron);
}

/** Payload type of the summaries the previous scheduler posted. */
export const LEGACY_DAILY_SUMMARY_PAYLOAD_TYPE = 'daily_summary';

/** The newest summary the previous scheduler posted to this channel. */
function latestLegacySummaryPost(channelId: string): { at: string; messageId: string } | null {
  const row = getDb()
    .prepare(
      `SELECT id, created_at FROM hub_chat_messages
       WHERE channel_id = ? AND deleted_at IS NULL
         AND json_extract(payload_json, '$.type') = ?
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(channelId, LEGACY_DAILY_SUMMARY_PAYLOAD_TYPE) as
    | { id: string; created_at: string }
    | undefined;
  return row ? { at: row.created_at, messageId: row.id } : null;
}

/** Payload type of the one notice posted when a schedule does not fit. */
export const DAILY_SUMMARY_MIGRATION_BLOCKED_PAYLOAD_TYPE = 'daily_summary_migration_blocked';

export function isDailySummaryScheduleMigrated(userId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM hub_chat_daily_summary_migrations WHERE user_id = ?')
    .get(userId);
}

export interface DailySummaryMigrationDeps {
  listSchedules?: () => Array<{ userId: string; schedule: HubDailySummarySchedule }>;
  orgForUser?: (userId: string) => string;
  /** Announces the no-room notice, the same way digest posts are announced. */
  broadcast?: BroadcastFn;
  now?: Date;
  log?: (msg: string) => void;
}

/**
 * Converts every not-yet-converted schedule. Returns the users converted this
 * call. Safe to call on every tick: converted users are skipped, and one
 * user's failure does not stop the rest.
 */
export function migrateDailySummarySchedules(deps: DailySummaryMigrationDeps = {}): string[] {
  const log = deps.log ?? console.error;
  let entries: Array<{ userId: string; schedule: HubDailySummarySchedule }>;
  try {
    entries = (deps.listSchedules ?? listUsersWithDailySummarySchedule)();
  } catch (err) {
    log(`[daily-summary-migration] listing schedules failed: ${(err as Error).message}`);
    return [];
  }
  const migrated: string[] = [];
  for (const { userId, schedule } of entries) {
    try {
      if (isDailySummaryScheduleMigrated(userId)) continue;
      const orgId = (deps.orgForUser ?? summaryOrgForUser)(userId);
      const outcome = getDb()
        .transaction(
          ():
            | { status: 'already' | 'migrated' }
            | {
                status: 'no_room';
                channel: HubChatChannelRow;
                notice: HubChatMessageRow | null;
              } => {
            // Re-checked inside the write lock so two callers cannot both convert.
            if (isDailySummaryScheduleMigrated(userId)) return { status: 'already' };
            const { channel } = getOrCreateSummaryChannel(orgId, userId);
            const crons = dailySummaryTimesToCrons(schedule.times);
            if (listChannelDigests(channel.id).length >= MAX_DIGESTS_PER_CHANNEL) {
              return { status: 'no_room', channel, notice: postNoRoomNoticeOnce(channel.id) };
            }
            const row = createChannelDigest(channel.id, {
              name: defaultDigestName('my_work'),
              enabled: schedule.enabled,
              cron: crons.join(CHAT_DIGEST_CRON_SEPARATOR),
              timeZone: schedule.timeZone,
              scope: 'my_work',
              projectIds: [],
              prompt: null,
              ownerUserId: userId,
              now: deps.now,
            });
            // Checked above inside the same write lock, so this cannot miss.
            if (!row) throw new Error('Summaries channel filled up during the conversion');
            // The previous scheduler may have posted this very minute; carry
            // that post over so the digest does not post it again.
            const legacy = latestLegacySummaryPost(channel.id);
            if (legacy) seedChannelDigestLastRun(row.id, legacy);
            getDb()
              .prepare('INSERT INTO hub_chat_daily_summary_migrations (user_id) VALUES (?)')
              .run(userId);
            return { status: 'migrated' };
          },
        )
        .immediate();
      if (outcome.status === 'no_room' && outcome.notice) {
        broadcastHubChatMessage(
          deps.broadcast,
          HUB_CHAT_MESSAGE_EVENT,
          outcome.channel,
          outcome.notice,
        );
        log(`[daily-summary-migration] ${userId}: Summaries channel has no room; will retry`);
      }
      const done = outcome.status === 'migrated';
      if (done) migrated.push(userId);
    } catch (err) {
      log(`[daily-summary-migration] ${userId} failed: ${(err as Error).message}`);
    }
  }
  return migrated;
}

/**
 * Tells the owner, once per channel, that their schedule is waiting for a
 * free slot. Returns the posted message, or null when it is already there.
 */
function postNoRoomNoticeOnce(channelId: string): HubChatMessageRow | null {
  const existing = getDb()
    .prepare(
      `SELECT 1 FROM hub_chat_messages
       WHERE channel_id = ? AND deleted_at IS NULL
         AND json_extract(payload_json, '$.type') = ?`,
    )
    .get(channelId, DAILY_SUMMARY_MIGRATION_BLOCKED_PAYLOAD_TYPE);
  if (existing) return null;
  return appendMessage({
    channelId,
    authorKind: 'system',
    body:
      `Your daily summary schedule needs one digest on this channel, but it already holds ` +
      `the maximum of ${MAX_DIGESTS_PER_CHANNEL}. Scheduled summaries are paused until you ` +
      'remove a digest here; the schedule moves over automatically once a slot is free.',
    payload: { type: DAILY_SUMMARY_MIGRATION_BLOCKED_PAYLOAD_TYPE },
  });
}
