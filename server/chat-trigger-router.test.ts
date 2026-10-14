import { randomUUID } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from './db.js';
import * as chat from './hub-chat-store.js';
import { createTrigger, updateTrigger } from './chat-triggers-store.js';
import {
  isChatTriggerSourceType,
  mapBroadcastToTriggerOccurrence,
  routeBroadcastToChatTriggers,
  triggerFilterMatches,
  type TriggerLookups,
} from './chat-trigger-router.js';
import { readChatTriggerCard, type ChatTriggerEvent } from '../shared/utils/chatTriggers.js';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const PROJECT = 'acme-web';

type SessionFacts = { name: string; agentId: string; ownerUserId: string | null } | null;
/** Per-test override of the session lookup: a value, null (no row), or a thrower. */
let sessionOverride: ((id: string) => SessionFacts) | null = null;
let runOverride: ReturnType<TriggerLookups['getFinalizeRun']> | undefined;

const lookups: TriggerLookups = {
  resolveProjectId: () => PROJECT,
  getSession: (id) =>
    sessionOverride
      ? sessionOverride(id)
      : id === 'sess-bob'
        ? { name: 'Bob private', agentId: 'dev', ownerUserId: BOB }
        : { name: 'Fix login', agentId: 'dev', ownerUserId: ALICE },
  getCard: () => ({
    title: 'Ship triggers',
    label: 'WEB-7',
    epicId: 'epic-chat',
    labels: ['chat', 'backend'],
    column: 'In Progress',
  }),
  getPrTitle: () => 'Add chat triggers',
  getFinalizeRun: () =>
    runOverride === undefined ? { projectId: PROJECT, sessionId: 'sess-alice' } : runOverride,
};

/** One broadcast per v1 event, and the event it should produce. */
const SAMPLES: [ChatTriggerEvent, Record<string, unknown>][] = [
  [
    'session_awaiting_input',
    { type: 'awaiting_input', sessionId: 'sess-alice', waiting: true, askIds: ['a1'] },
  ],
  [
    'session_completed',
    { type: 'done', sessionId: 'sess-alice', messageId: 'm1', message: { content: 'All done' } },
  ],
  [
    'finalize_run_completed',
    { type: 'finalize_run_completed', run_id: 'run-1', session_id: 'sess-alice', status: 'pushed' },
  ],
  ['pr_opened', { type: 'native_pr_update', projectId: PROJECT, prNumber: 12, action: 'opened' }],
  [
    'pr_review_requested',
    {
      type: 'native_pr_update',
      projectId: PROJECT,
      prNumber: 12,
      action: 'review_requested',
      reviewRequestedAt: 1000,
    },
  ],
  ['pr_merged', { type: 'native_pr_update', projectId: PROJECT, prNumber: 12, action: 'merged' }],
  [
    'card_created',
    { type: 'card_created', projectId: PROJECT, cardId: 'card-1', columnName: 'To Do' },
  ],
  [
    'card_moved',
    {
      type: 'card_moved',
      projectId: PROJECT,
      cardId: 'card-1',
      columnName: 'Review',
      moveId: 'move-1',
    },
  ],
  [
    'support_ticket_created',
    {
      type: 'support_ticket_created',
      projectId: PROJECT,
      ticket: { id: 'ticket-1', subject: 'Login broken', type: 'bug' },
    },
  ],
  [
    'cron_finished',
    {
      type: 'cron_finished',
      projectId: PROJECT,
      cronId: 3,
      cronName: 'Nightly',
      logId: 44,
      status: 'error',
      preview: 'boom',
      cronShared: true,
    },
  ],
  [
    'infra_alert',
    {
      type: 'infra_alert_transition',
      projectId: PROJECT,
      ruleId: 'r1',
      ruleName: 'CPU high',
      resourceId: 'i-123',
      severity: 'critical',
      fromState: 'OK',
      toState: 'ALARM',
      at: 1_700_000_000_000,
    },
  ],
];

let org = '';
let channel: ReturnType<typeof chat.createChannel>;

beforeEach(() => {
  getDb().exec('DELETE FROM project_chat_trigger_posts;');
  sessionOverride = null;
  runOverride = undefined;
  creatorAccess = true;
  getDb().prepare('DELETE FROM project_chat_triggers').run();
  org = `org-${randomUUID()}`;
  channel = chat.createChannel({
    orgId: org,
    kind: 'trigger',
    name: 'acme-activity',
    projectId: PROJECT,
    createdByUserId: ALICE,
  });
});

function trigger(
  event: ChatTriggerEvent,
  extra: Parameters<typeof createTrigger>[0]['filter'] = {},
) {
  return createTrigger({
    projectId: PROJECT,
    event,
    channelId: channel.id,
    filter: extra,
    createdBy: ALICE,
  });
}

let creatorAccess = true;

function route(data: Record<string, unknown>, broadcast = vi.fn()) {
  return routeBroadcastToChatTriggers(data, {
    lookups,
    broadcast,
    creatorCanViewProject: () => creatorAccess,
    log: () => {},
  });
}

describe('routeBroadcastToChatTriggers', () => {
  it.each(SAMPLES)('posts %s once per matching trigger', (event, data) => {
    const t1 = trigger(event);
    const t2 = trigger(event);
    // A trigger for another event in the same project stays quiet.
    trigger(event === 'pr_opened' ? 'pr_merged' : 'pr_opened');
    const broadcast = vi.fn();

    const posted = route(data, broadcast);
    expect(posted).toHaveLength(2);
    expect(
      posted
        .map((m) => readChatTriggerCard(JSON.parse(m.payload_json ?? 'null'))?.triggerId)
        .sort(),
    ).toEqual([t1.id, t2.id].sort());
    for (const m of posted) {
      expect(m.author_kind).toBe('trigger');
      const card = readChatTriggerCard(JSON.parse(m.payload_json ?? 'null'));
      expect(card?.event).toBe(event);
      expect(card?.projectId).toBe(PROJECT);
    }
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[0]![0]).toMatchObject({
      type: 'hub_chat_message',
      channelId: channel.id,
      recipientUserIds: [ALICE],
    });

    // The same occurrence broadcast again does not post twice.
    expect(route(data)).toHaveLength(0);
    expect(chat.listMessages(channel.id)).toHaveLength(2);
  });

  it('a failed post claims nothing, so the next broadcast of it posts', () => {
    trigger('pr_merged');
    const data = SAMPLES[5]![1];
    const broadcast = vi.fn();
    const failing = vi.fn(() => {
      throw new Error('disk full');
    });
    expect(
      routeBroadcastToChatTriggers(data, {
        lookups,
        broadcast,
        post: failing,
        creatorCanViewProject: () => true,
        log: () => {},
      }),
    ).toHaveLength(0);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
    expect(chat.listMessages(channel.id)).toHaveLength(0);

    const [m] = route(data, broadcast);
    expect(m).toBeDefined();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(route(data)).toHaveLength(0);
    expect(chat.listMessages(channel.id)).toHaveLength(1);
  });

  it('rolls back a message whose occurrence record fails, so nothing is half-posted', () => {
    const t = trigger('pr_merged');
    // A message written but its record rejected: the transaction must undo both.
    getDb().exec(`
      CREATE TEMP TRIGGER fail_trigger_post BEFORE INSERT ON project_chat_trigger_posts
      BEGIN SELECT RAISE(ABORT, 'record failed'); END;`);
    try {
      expect(route(SAMPLES[5]![1])).toHaveLength(0);
      expect(chat.listMessages(channel.id)).toHaveLength(0);
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS temp.fail_trigger_post');
    }
    const [m] = route(SAMPLES[5]![1]);
    expect(
      getDb()
        .prepare('SELECT message_id FROM project_chat_trigger_posts WHERE trigger_id = ?')
        .all(t.id),
    ).toEqual([{ message_id: m!.id }]);
  });

  it('remembers posted occurrences in the database, not process memory', () => {
    const t = trigger('card_moved');
    const data = SAMPLES[7]![1];
    const [m] = route(data);
    // A restart loses nothing: the record is a row, so a late duplicate is
    // still recognised.
    expect(
      getDb()
        .prepare(
          'SELECT occurrence_key, message_id FROM project_chat_trigger_posts WHERE trigger_id = ?',
        )
        .all(t.id),
    ).toEqual([{ occurrence_key: 'card_moved:card-1:move-1', message_id: m!.id }]);
    expect(route(data)).toHaveLength(0);
  });

  it('stops posting when the creator can no longer view the project', () => {
    trigger('pr_merged');
    creatorAccess = false;
    expect(route(SAMPLES[5]![1])).toHaveLength(0);
    creatorAccess = true;
    expect(route(SAMPLES[5]![1])).toHaveLength(1);
  });

  it('posts nothing through a trigger with no creator', () => {
    createTrigger({
      projectId: PROJECT,
      event: 'pr_merged',
      channelId: channel.id,
      createdBy: null,
    });
    expect(route(SAMPLES[5]![1])).toHaveLength(0);
  });

  it('a disabled trigger posts nothing', () => {
    const t = trigger('pr_opened');
    updateTrigger(t.id, { enabled: false });
    expect(route(SAMPLES[3]![1])).toHaveLength(0);
    expect(chat.listMessages(channel.id)).toHaveLength(0);
  });

  it('skips archived channels', () => {
    trigger('pr_merged');
    chat.archiveChannel(channel.id);
    expect(route(SAMPLES[5]![1])).toHaveLength(0);
  });

  it('posts an owned session only through triggers its owner created', () => {
    trigger('session_completed');
    const data = { type: 'done', sessionId: 'sess-bob', messageId: 'm9' };
    expect(route(data)).toHaveLength(0);
    createTrigger({
      projectId: PROJECT,
      event: 'session_completed',
      channelId: channel.id,
      createdBy: BOB,
    });
    chat.addMember(channel.id, BOB);
    expect(route(data)).toHaveLength(1);
  });

  it('never posts private work into a channel its owner cannot read', () => {
    // Bob's own trigger, but aimed at a channel Bob is not in (e.g. retargeted
    // by someone else): his session stays out of it.
    createTrigger({
      projectId: PROJECT,
      event: 'session_completed',
      channelId: channel.id,
      createdBy: BOB,
    });
    expect(route({ type: 'done', sessionId: 'sess-bob', messageId: 'p1' })).toHaveLength(0);

    chat.addMember(channel.id, BOB);
    expect(route({ type: 'done', sessionId: 'sess-bob', messageId: 'p2' })).toHaveLength(1);

    // Leaving the channel stops it again.
    chat.removeMember(channel.id, BOB);
    expect(route({ type: 'done', sessionId: 'sess-bob', messageId: 'p3' })).toHaveLength(0);
  });

  it('tells a new move from a duplicate, even with a move in between', () => {
    trigger('card_moved', { columns: ['Review'] });
    const move = (moveId: string, columnName: string) =>
      route({ type: 'card_moved', projectId: PROJECT, cardId: 'card-r', columnName, moveId });
    expect(move('m1', 'Review')).toHaveLength(1);
    expect(move('m1', 'Review')).toHaveLength(0); // same move, broadcast twice
    expect(move('m2', 'In Progress')).toHaveLength(0); // filtered out
    expect(move('m1', 'Review')).toHaveLength(0); // late duplicate of the first move
    expect(move('m3', 'Review')).toHaveLength(1); // a new move back to Review
    expect(chat.listMessages(channel.id)).toHaveLength(2);
  });

  it('filters on the column the producer moved the card to, not where it is now', () => {
    // The lookup says the card is In Progress now (a later move); the
    // broadcast is about the earlier move into Review.
    trigger('card_moved', { columns: ['Review'] });
    expect(route(SAMPLES[7]![1])).toHaveLength(1);
  });

  it('posts a repeated review request but not a duplicate broadcast of one', () => {
    trigger('pr_review_requested');
    const request = (reviewRequestedAt: number) =>
      route({
        type: 'native_pr_update',
        projectId: PROJECT,
        prNumber: 7,
        action: 'review_requested',
        reviewRequestedAt,
      });
    expect(request(1000)).toHaveLength(1);
    expect(request(1000)).toHaveLength(0);
    expect(request(2000)).toHaveLength(1); // requested again
    expect(request(1000)).toHaveLength(0); // late duplicate of the first request
    expect(chat.listMessages(channel.id)).toHaveLength(2);
  });

  it('does not deliver a broadcast that lacks its occurrence id', () => {
    for (const event of ['session_completed', 'card_moved', 'pr_review_requested'] as const) {
      trigger(event);
    }
    expect(route({ type: 'done', sessionId: 'sess-alice' })).toHaveLength(0);
    expect(
      route({ type: 'card_moved', projectId: PROJECT, cardId: 'card-1', columnName: 'Review' }),
    ).toHaveLength(0);
    expect(
      route({
        type: 'native_pr_update',
        projectId: PROJECT,
        prNumber: 3,
        action: 'review_requested',
      }),
    ).toHaveLength(0);
  });

  describe('when a session’s owner cannot be established', () => {
    beforeEach(() => {
      // Bob's trigger, in a channel Bob reads: it would post a run he owns.
      createTrigger({
        projectId: PROJECT,
        event: 'finalize_run_completed',
        channelId: channel.id,
        createdBy: BOB,
      });
      chat.addMember(channel.id, BOB);
    });
    const run = {
      type: 'finalize_run_completed',
      run_id: 'run-x',
      session_id: 'sess-alice',
      status: 'failed',
      failure_reason: 'ci_failed',
    };

    it('drops a Finalize run whose session lookup finds nothing', () => {
      sessionOverride = () => null;
      expect(route(run)).toHaveLength(0);
    });

    it('drops a Finalize run whose session lookup fails', () => {
      sessionOverride = () => {
        throw new Error('db busy');
      };
      expect(route(run)).toHaveLength(0);
    });

    it('drops a Finalize run whose run row is missing', () => {
      runOverride = null;
      expect(route({ ...run, session_id: undefined })).toHaveLength(0);
    });

    it('still applies ownership to a deleted session the lookup can see', () => {
      // Alice's (deleted) session never posts through Bob's trigger.
      sessionOverride = () => ({ name: 'Gone', agentId: 'dev', ownerUserId: ALICE });
      expect(route(run)).toHaveLength(0);
      sessionOverride = () => ({ name: 'Gone', agentId: 'dev', ownerUserId: BOB });
      expect(route({ ...run, run_id: 'run-y' })).toHaveLength(1);
    });

    it('posts a session-less run (push CI) as project activity', () => {
      runOverride = { projectId: PROJECT, sessionId: null };
      expect(route({ ...run, session_id: undefined, run_id: 'run-z' })).toHaveLength(1);
    });
  });

  it('treats a cron without an explicit shared flag as private', () => {
    trigger('cron_finished');
    const base = { type: 'cron_finished', projectId: PROJECT, cronId: 9, status: 'success' };
    // No flag and no owner: privacy cannot be established.
    expect(route({ ...base, logId: 1 })).toHaveLength(0);
    // No flag, owned by Bob: Alice's trigger does not get it.
    expect(route({ ...base, logId: 2, ownerUserId: BOB })).toHaveLength(0);
    // Owned by Alice, her trigger, her channel.
    expect(route({ ...base, logId: 3, ownerUserId: ALICE })).toHaveLength(1);
  });

  it('posts a private cron only through its owner’s triggers', () => {
    createTrigger({
      projectId: PROJECT,
      event: 'cron_finished',
      channelId: channel.id,
      createdBy: BOB,
    });
    const data = {
      type: 'cron_finished',
      projectId: PROJECT,
      cronId: 1,
      logId: 2,
      status: 'success',
      cronShared: false,
      ownerUserId: ALICE,
    };
    expect(route(data)).toHaveLength(0);
  });

  it('applies card filters', () => {
    trigger('card_moved', { columns: ['done'] });
    trigger('card_moved', { columns: ['review'], labels: ['CHAT'] });
    trigger('card_moved', { epicId: 'other-epic' });
    expect(route(SAMPLES[7]![1])).toHaveLength(1);
  });

  it('writes ref chips into the body and hub_chat_refs', () => {
    trigger('pr_opened');
    const [m] = route(SAMPLES[3]![1]);
    expect(m!.body).toContain(`](pr:${PROJECT}#12)`);
    expect(m!.body).toContain('Add chat triggers');
    expect(chat.listRefs(m!.id)).toEqual([
      expect.objectContaining({ kind: 'pr', target_id: `${PROJECT}#12`, project_id: PROJECT }),
    ]);
  });

  it('only channel members receive the live message', () => {
    trigger('pr_merged');
    const broadcast = vi.fn();
    route(SAMPLES[5]![1], broadcast);
    expect(broadcast.mock.calls[0]![0].recipientUserIds).toEqual([ALICE]);
    expect(chat.listChannelsForUser(org, BOB)).toHaveLength(0);
    expect(chat.listChannelsForUser(org, ALICE).map((c) => c.id)).toEqual([channel.id]);
  });

  it('ignores its own chat broadcasts and unrelated events', () => {
    trigger('pr_opened');
    expect(isChatTriggerSourceType('hub_chat_message')).toBe(false);
    expect(route({ type: 'hub_chat_message', channelId: channel.id })).toHaveLength(0);
    expect(
      route({ type: 'native_pr_update', projectId: PROJECT, prNumber: 1, action: 'commented' }),
    ).toHaveLength(0);
  });
});

describe('mapBroadcastToTriggerOccurrence', () => {
  it('maps every sample to its event', () => {
    for (const [event, data] of SAMPLES) {
      expect(isChatTriggerSourceType(data.type)).toBe(true);
      expect(mapBroadcastToTriggerOccurrence(data, lookups)?.event).toBe(event);
    }
  });

  it('skips non-waiting awaiting_input, SideBars and cancelled finalize runs', () => {
    expect(
      mapBroadcastToTriggerOccurrence(
        { type: 'awaiting_input', sessionId: 's', waiting: false },
        lookups,
      ),
    ).toBeNull();
    expect(
      mapBroadcastToTriggerOccurrence(
        { type: 'done', sessionId: 's', sidebarParentId: 'p' },
        lookups,
      ),
    ).toBeNull();
    expect(
      mapBroadcastToTriggerOccurrence(
        { type: 'finalize_run_completed', run_id: 'r', status: 'cancelled' },
        lookups,
      ),
    ).toBeNull();
  });

  it('classifies finalize outcomes', () => {
    const fail = mapBroadcastToTriggerOccurrence(
      {
        type: 'finalize_run_completed',
        run_id: 'r',
        status: 'failed',
        failure_reason: 'ci_failed',
      },
      lookups,
    );
    expect(fail?.facts.outcome).toBe('fail');
    expect(fail?.status).toBe('failure');
    expect(fail?.detail).toBe('ci failed');
  });
});

describe('triggerFilterMatches', () => {
  it('ignores fields the event does not use', () => {
    expect(triggerFilterMatches('pr_opened', { columns: ['Done'] }, {})).toBe(true);
  });

  it('matches outcome, agents and severities', () => {
    expect(
      triggerFilterMatches('cron_finished', { outcome: 'error' }, { outcome: 'success' }),
    ).toBe(false);
    expect(
      triggerFilterMatches('session_completed', { agentIds: ['qa'] }, { agentId: 'dev' }),
    ).toBe(false);
    expect(
      triggerFilterMatches('infra_alert', { severities: ['Critical'] }, { severity: 'critical' }),
    ).toBe(true);
  });
});
