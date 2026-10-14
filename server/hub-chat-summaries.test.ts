/**
 * Per-user Summaries channel: scheduled daily summaries post there exactly
 * once per user per local date, and the broadcast fires a phone push.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as chat from './hub-chat-store.js';
import {
  DAILY_SUMMARY_PAYLOAD_TYPE,
  findSummaryChannel,
  getOrCreateSummaryChannel,
  postDailySummaryToChannel,
} from './hub-chat-summaries.js';
import {
  resetDailySummaryFiredGuard,
  runDailySummaryScheduleTick,
  type HubDailySummarySchedule,
} from './daily-summary-schedule.js';
import { chatPushUserIdsFromStore, mapBroadcastToPush } from './push.js';
import type { RouteDeps } from './types.js';
import type { HubDailySummaryStored } from './user-preferences-store.js';

let org = '';
let alice = '';
let bob = '';
beforeEach(() => {
  org = `org-${randomUUID()}`;
  alice = `alice-${randomUUID()}`;
  bob = `bob-${randomUUID()}`;
  resetDailySummaryFiredGuard();
});

function reportFor(date: string, markdown = '## Today\n- shipped'): HubDailySummaryStored {
  return {
    date,
    timeZone: 'UTC',
    markdown,
    engine: 'claude-code',
    model: 'm',
    generatedAt: `${date}T08:00:00.000Z`,
  };
}

function summaryMessages(userId: string) {
  const channel = findSummaryChannel(org, userId);
  return channel ? chat.listMessages(channel.id, { limit: 100 }) : [];
}

describe('getOrCreateSummaryChannel', () => {
  it('creates one private summary channel per user, owned by that user only', () => {
    const first = getOrCreateSummaryChannel(org, alice);
    const again = getOrCreateSummaryChannel(org, alice);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.channel.id).toBe(first.channel.id);
    expect(first.channel.kind).toBe('summary');
    expect(first.channel.is_private).toBe(1);
    expect(chat.listMembers(first.channel.id).map((m) => m.user_id)).toEqual([alice]);
    expect(getOrCreateSummaryChannel(org, bob).channel.id).not.toBe(first.channel.id);
  });
});

describe('scheduled daily summary → Summaries channel', () => {
  it('posts exactly once per user per date, across several scheduled times', async () => {
    const schedule: HubDailySummarySchedule = {
      enabled: true,
      timeZone: 'UTC',
      times: ['08:00', '17:00'],
    };
    const broadcast = vi.fn();
    let clock = new Date('2026-10-14T08:00:10Z');
    const generate = vi.fn(async (input: { now?: Date }) =>
      reportFor((input.now ?? clock).toISOString().slice(0, 10)),
    );
    const deps = {
      routeDeps: {} as RouteDeps,
      listSchedules: () => [
        { userId: alice, schedule },
        { userId: bob, schedule },
      ],
      generate,
      onScheduledReport: (userId: string, report: HubDailySummaryStored) => {
        postDailySummaryToChannel({ userId, report, broadcast, orgId: org });
      },
      now: () => clock,
    };

    await runDailySummaryScheduleTick(deps);
    // Same minute again (ticker jitter), then the second configured time.
    await runDailySummaryScheduleTick(deps);
    clock = new Date('2026-10-14T17:00:05Z');
    await runDailySummaryScheduleTick(deps);
    // The in-memory guard is lost on restart; the channel itself still dedupes.
    resetDailySummaryFiredGuard();
    await runDailySummaryScheduleTick(deps);

    expect(generate).toHaveBeenCalledTimes(6);
    for (const user of [alice, bob]) {
      const msgs = summaryMessages(user);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].author_kind).toBe('system');
      expect(JSON.parse(msgs[0].payload_json ?? '{}')).toMatchObject({
        type: DAILY_SUMMARY_PAYLOAD_TYPE,
        date: '2026-10-14',
      });
      expect(msgs[0].body).toContain('## Today');
    }
    expect(broadcast).toHaveBeenCalledTimes(2);

    clock = new Date('2026-10-15T08:00:00Z');
    await runDailySummaryScheduleTick(deps);
    expect(summaryMessages(alice).map((m) => JSON.parse(m.payload_json ?? '{}').date)).toEqual([
      '2026-10-14',
      '2026-10-15',
    ]);
  });

  it('keeps going when posting fails for one user', async () => {
    const schedule: HubDailySummarySchedule = { enabled: true, timeZone: 'UTC', times: ['08:00'] };
    const posted: string[] = [];
    await runDailySummaryScheduleTick({
      routeDeps: {} as RouteDeps,
      listSchedules: () => [
        { userId: alice, schedule },
        { userId: bob, schedule },
      ],
      generate: async () => reportFor('2026-10-14'),
      onScheduledReport: (userId) => {
        if (userId === alice) throw new Error('db locked');
        posted.push(userId);
      },
      now: () => new Date('2026-10-14T08:00:00Z'),
    });
    expect(posted).toEqual([bob]);
  });

  it('broadcasts to the owner only and pushes the summary to them', () => {
    const broadcast = vi.fn();
    const { channel } = postDailySummaryToChannel({
      userId: alice,
      report: reportFor('2026-10-14', 'Busy day.'),
      broadcast,
      orgId: org,
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const data = broadcast.mock.calls[0][0];
    expect(data).toMatchObject({
      type: 'hub_chat_message',
      recipientUserIds: [alice],
      channelId: channel.id,
      channelKind: 'summary',
    });
    // Members default to notify_level=mentions; the Summaries channel still pushes.
    expect(chat.getMember(channel.id, alice)?.notify_level).toBe('mentions');
    expect(chatPushUserIdsFromStore(data)).toEqual([alice]);
    const push = mapBroadcastToPush(data);
    expect(push?.event).toBe('chat_message');
    expect(push?.payload.title).toBe('Summaries');
    expect(push?.payload.body).toContain('Busy day.');
  });

  it('does not push when the owner muted the channel', () => {
    const { channel } = getOrCreateSummaryChannel(org, alice);
    chat.updateMemberPrefs(channel.id, alice, { notifyLevel: 'none' });
    const broadcast = vi.fn();
    postDailySummaryToChannel({
      userId: alice,
      report: reportFor('2026-10-14'),
      broadcast,
      orgId: org,
    });
    expect(chatPushUserIdsFromStore(broadcast.mock.calls[0][0])).toEqual([]);
  });

  it('a second post for the same date is a no-op even with a newer report', () => {
    postDailySummaryToChannel({ userId: alice, report: reportFor('2026-10-14'), orgId: org });
    const again = postDailySummaryToChannel({
      userId: alice,
      report: { ...reportFor('2026-10-14', 'different'), generatedAt: '2026-10-14T12:00:00Z' },
      orgId: org,
    });
    expect(again.posted).toBe(false);
    expect(summaryMessages(alice)).toHaveLength(1);
  });
});
