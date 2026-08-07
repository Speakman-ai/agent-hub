import { describe, it, expect, vi } from 'vitest';
import {
  awaitingFeedbackPush,
  readyToPushPush,
  pushedPush,
  supportTicketCreatedPush,
  threadMessagePush,
  reviewAssignedPush,
  prMergedPush,
  infraAlertPush,
  infraHealthEventPush,
  parseEnabledEvents,
  tokenAcceptsEvent,
  buildMessages,
  sendExpoPush,
  dispatchPushEvent,
  mapBroadcastToPush,
  handleBroadcastForPush,
  filterTokensForBroadcastVisibility,
  filterTokensForSessionOwner,
  EXPO_PUSH_URL,
  PUSH_EVENT_TYPES,
  type DeviceTokenRowWithPrefs,
  type ExpoPushMessage,
} from './push.js';

function token(
  t: string,
  enabled?: string[] | null,
  userId?: string | null,
): DeviceTokenRowWithPrefs {
  return {
    id: 1,
    token: t,
    platform: 'ios',
    user_id: userId ?? null,
    created_at: '2026-04-18 00:00:00',
    last_used: null,
    enabled_events:
      enabled === undefined ? null : enabled === null ? null : JSON.stringify(enabled),
  };
}

describe('push formatters', () => {
  it('formats awaiting feedback with and without session name', () => {
    expect(awaitingFeedbackPush({ sessionName: 'Ship it' })).toEqual({
      title: 'Awaiting feedback',
      body: '"Ship it" is waiting for your input',
    });
    expect(awaitingFeedbackPush({}).body).toBe('A session is waiting for your input');
  });

  it('formats ready to push and pushed', () => {
    expect(readyToPushPush({ sessionName: 'Ship' }).body).toContain('passed review');
    expect(pushedPush({ sessionName: 'Ship', prNumber: 12 }).body).toBe(
      '"Ship" was pushed (PR #12)',
    );
    expect(pushedPush({ sessionName: 'Ship' }).body).toBe('"Ship" was pushed');
  });

  it('formats support ticket created', () => {
    expect(supportTicketCreatedPush({ subject: 'Login broken', ticketType: 'bug' }).body).toBe(
      'bug: Login broken',
    );
    expect(supportTicketCreatedPush({}).body).toBe('New ticket');
  });

  it('formats thread messages and truncates long previews', () => {
    expect(
      threadMessagePush({ threadName: 'Nightly', threadType: 'cron', isError: true }).title,
    ).toBe('Thread error');
    const long = 'y'.repeat(200);
    const trimmed = threadMessagePush({
      threadName: 'Nightly',
      threadType: 'cron',
      preview: long,
    }).body;
    expect(trimmed.endsWith('…')).toBe(true);
  });

  it('formats review assigned and PR merged', () => {
    expect(reviewAssignedPush({ cardTitle: 'X' }).body).toBe('"X" needs your review');
    expect(reviewAssignedPush({ prNumber: 42 }).body).toBe('PR #42: "Ticket" needs your review');
    expect(prMergedPush({ cardTitle: 'X', prNumber: 12, mergedBy: 'dev' }).body).toBe(
      'PR #12 merged by dev: "X"',
    );
  });

  it('formats AWS Health events, degrading when fields are missing', () => {
    expect(
      infraHealthEventPush({
        severity: 'warning',
        headline: 'EC2 AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED (us-east-1)',
        statusCode: 'upcoming',
        eventTypeCategory: 'scheduledChange',
      }),
    ).toEqual({
      title: 'Warning AWS Health event',
      body: 'EC2 AWS_EC2_INSTANCE_RETIREMENT_SCHEDULED (us-east-1) · upcoming (scheduledChange)',
    });
    expect(infraHealthEventPush({})).toEqual({
      title: 'AWS AWS Health event',
      body: 'AWS Health event',
    });
  });

  it('formats infrastructure alert transitions without account data', () => {
    expect(
      infraAlertPush({
        severity: 'critical',
        ruleName: 'CPU high',
        resourceId: 'i-123',
        fromState: 'OK',
        toState: 'ALARM',
      }),
    ).toEqual({
      title: 'Critical infrastructure alert',
      body: 'CPU high on i-123: OK → ALARM',
    });
  });
});

describe('parseEnabledEvents / tokenAcceptsEvent', () => {
  it('returns undefined (all enabled) for null/empty', () => {
    expect(parseEnabledEvents(null)).toBeUndefined();
    expect(parseEnabledEvents('')).toBeUndefined();
    expect(parseEnabledEvents(undefined)).toBeUndefined();
  });

  it('parses a JSON array into a Set', () => {
    const s = parseEnabledEvents('["thread_message","pr_merged"]');
    expect(s).toBeInstanceOf(Set);
    expect(s?.has('thread_message')).toBe(true);
    expect(s?.has('pr_merged')).toBe(true);
  });

  it('treats malformed JSON as legacy default (undefined)', () => {
    expect(parseEnabledEvents('not-json')).toBeUndefined();
    expect(parseEnabledEvents('{"oops":true}')).toBeUndefined();
  });

  it('accepts all events when token has no preferences', () => {
    expect(tokenAcceptsEvent(token('t'), 'awaiting_feedback')).toBe(true);
    expect(tokenAcceptsEvent(token('t'), 'pr_merged')).toBe(true);
  });

  it('only accepts enumerated events when preferences are set', () => {
    const row = token('t', ['thread_message']);
    expect(tokenAcceptsEvent(row, 'thread_message')).toBe(true);
    expect(tokenAcceptsEvent(row, 'awaiting_feedback')).toBe(false);
  });

  it('PUSH_EVENT_TYPES includes every dispatched event', () => {
    const required: (typeof PUSH_EVENT_TYPES)[number][] = [
      'awaiting_feedback',
      'ready_to_push',
      'pushed',
      'support_ticket_created',
      'thread_message',
      'review_assigned_to_you',
      'pr_merged',
      'infra_alert',
    ];
    for (const e of required) expect(PUSH_EVENT_TYPES).toContain(e);
  });

  // Back-compat: device rows persisted under the OLD taxonomy must keep
  // receiving the renamed events instead of silently going dark.
  it('aliases retired preference keys to their renamed events', () => {
    const s = parseEnabledEvents('["session_complete","changes_ready","card_review"]');
    // Renamed equivalents now present...
    expect(s?.has('awaiting_feedback')).toBe(true);
    expect(s?.has('ready_to_push')).toBe(true);
    expect(s?.has('review_assigned_to_you')).toBe(true);
    // ...and the original legacy keys are preserved (non-destructive).
    expect(s?.has('session_complete')).toBe(true);
  });

  it('maps both legacy thread keys onto thread_message', () => {
    expect(parseEnabledEvents('["thread_entry"]')?.has('thread_message')).toBe(true);
    expect(parseEnabledEvents('["thread_created"]')?.has('thread_message')).toBe(true);
  });

  it('tokenAcceptsEvent honors a legacy-only preference for the renamed event', () => {
    const legacyRow = token('t', ['session_complete', 'changes_ready']);
    expect(tokenAcceptsEvent(legacyRow, 'awaiting_feedback')).toBe(true);
    expect(tokenAcceptsEvent(legacyRow, 'ready_to_push')).toBe(true);
    // An event the user never opted into (new or unrelated) still filtered out.
    expect(tokenAcceptsEvent(legacyRow, 'pushed')).toBe(false);
    expect(tokenAcceptsEvent(legacyRow, 'support_ticket_created')).toBe(false);
  });

  it('does not invent aliases for retired events with no current equivalent', () => {
    const s = parseEnabledEvents('["pr_creation_stale","cron"]');
    expect(s?.has('pr_creation_stale')).toBe(true);
    expect(s?.has('cron')).toBe(true);
    // No spurious current-taxonomy membership leaked in.
    for (const e of PUSH_EVENT_TYPES) expect(s?.has(e)).toBe(false);
  });
});

describe('buildMessages', () => {
  it('maps tokens to Expo messages with default sound', () => {
    const msgs = buildMessages([token('A'), token('B')], {
      title: 'T',
      body: 'B',
      data: { foo: 1 },
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ to: 'A', sound: 'default', title: 'T', body: 'B', data: { foo: 1 } });
  });

  it('omits the sound when silent', () => {
    const msgs = buildMessages([token('A')], { title: 'T', body: 'B', silent: true });
    expect(msgs[0].sound).toBeNull();
  });
});

describe('sendExpoPush', () => {
  it('POSTs chunks of up to 100 to Expo and counts OK receipts', async () => {
    const calls: { url: string; body: ExpoPushMessage[] }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as ExpoPushMessage[] });
      return {
        json: async () => ({
          data: (JSON.parse(String(init?.body)) as ExpoPushMessage[]).map(() => ({ status: 'ok' })),
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const msgs: ExpoPushMessage[] = Array.from({ length: 150 }, (_, i) => ({
      to: `t${i}`,
      sound: 'default',
      title: 'x',
      body: 'y',
    }));
    const sent = await sendExpoPush(msgs, { fetchFn });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(EXPO_PUSH_URL);
    expect(calls[0].body).toHaveLength(100);
    expect(calls[1].body).toHaveLength(50);
    expect(sent).toBe(150);
  });

  it('prunes tokens that Expo marks DeviceNotRegistered', async () => {
    const removed: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({
          data: body.map((m) =>
            m.to === 'bad'
              ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
              : { status: 'ok' },
          ),
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await sendExpoPush(
      [
        { to: 'good', sound: 'default', title: 'x', body: 'y' },
        { to: 'bad', sound: 'default', title: 'x', body: 'y' },
      ],
      { fetchFn, removeToken: (t) => removed.push(t) },
    );
    expect(sent).toBe(1);
    expect(removed).toEqual(['bad']);
  });

  it('swallows network errors and returns 0 so broadcasts never fail', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const sent = await sendExpoPush([{ to: 'x', sound: 'default', title: 't', body: 'b' }], {
      fetchFn,
      log: () => {},
    });
    expect(sent).toBe(0);
  });
});

describe('dispatchPushEvent', () => {
  it('filters by token preferences before dispatch', async () => {
    const tokens = [token('all'), token('threadOnly', ['thread_message'])];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await dispatchPushEvent(
      'awaiting_feedback',
      { title: 'T', body: 'B' },
      { fetchFn, getAllTokens: () => tokens, removeToken: () => {} },
    );
    expect(sent).toBe(1);
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = JSON.parse(String((call[1] as RequestInit).body));
    expect(payload).toHaveLength(1);
    expect(payload[0].to).toBe('all');
  });

  it('returns 0 when no tokens match', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const sent = await dispatchPushEvent(
      'thread_message',
      { title: 'T', body: 'B' },
      { fetchFn, getAllTokens: () => [], removeToken: () => {} },
    );
    expect(sent).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('filters private-project event pushes to owner tokens only', async () => {
    const tokens = [token('owner', null, 'owner-1'), token('other', null, 'u2')];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await dispatchPushEvent(
      'awaiting_feedback',
      { title: 'T', body: 'B', data: { projectId: 'proj-private' } },
      {
        fetchFn,
        getAllTokens: () => tokens,
        removeToken: () => {},
        resolveProjectId: () => 'proj-private',
        findProjectById: () =>
          ({ id: 'proj-private', visibility: 'private', ownerUserId: 'owner-1' }) as any,
      },
    );
    expect(sent).toBe(1);
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = JSON.parse(String((call[1] as RequestInit).body));
    expect(payload).toHaveLength(1);
    expect(payload[0].to).toBe('owner');
  });
});

describe('mapBroadcastToPush', () => {
  it('returns null for unknown types', () => {
    expect(mapBroadcastToPush({ type: 'room_message' })).toBeNull();
    expect(mapBroadcastToPush({})).toBeNull();
    expect(mapBroadcastToPush({ type: 'done' })).toBeNull();
  });

  it('maps awaiting_input when waiting=true', () => {
    const r = mapBroadcastToPush({
      type: 'awaiting_input',
      waiting: true,
      sessionId: 's1',
      agentId: 'a1',
      sessionName: 'My session',
    });
    expect(r?.event).toBe('awaiting_feedback');
    expect(r?.payload.title).toBe('Awaiting feedback');
    expect(r?.payload.data?.sessionId).toBe('s1');
    expect(r?.payload.data?.agentId).toBe('a1');
  });

  it('ignores awaiting_input when waiting is not true', () => {
    expect(mapBroadcastToPush({ type: 'awaiting_input', waiting: false })).toBeNull();
  });

  it('maps infra alert transitions and honors routing suppression for push', () => {
    const mapped = mapBroadcastToPush({
      type: 'infra_alert_transition',
      projectId: 'p1',
      alertId: 'alert-1',
      ruleId: 'rule-1',
      severity: 'critical',
      ruleName: 'CPU high',
      resourceId: 'i-123',
      fromState: 'OK',
      toState: 'ALARM',
    });
    expect(mapped?.event).toBe('infra_alert');
    expect(mapped?.payload.data).toMatchObject({
      projectId: 'p1',
      alertId: 'alert-1',
      resourceId: 'i-123',
      type: 'infra_alert',
    });
    expect(
      mapBroadcastToPush({
        type: 'infra_alert_transition',
        suppressPush: true,
      }),
    ).toBeNull();
  });

  it('maps AWS Health events onto the infra_alert push type', () => {
    // Reusing the existing push event type is deliberate (decision
    // INFRA-NOTIFY): per-token opt-in then works with no mobile settings
    // change. The `data.type` discriminator is what keeps the two apart.
    const mapped = mapBroadcastToPush({
      type: 'infra_health_event',
      projectId: 'p1',
      healthEventId: 'evt-1',
      eventArn: 'arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc',
      severity: 'critical',
      headline: 'EC2 AWS_EC2_OPERATIONAL_ISSUE (us-east-1)',
      statusCode: 'open',
      eventTypeCategory: 'issue',
    });
    expect(mapped?.event).toBe('infra_alert');
    expect(mapped?.payload.title).toBe('Critical AWS Health event');
    expect(mapped?.payload.body).toContain('EC2 AWS_EC2_OPERATIONAL_ISSUE');
    expect(mapped?.payload.data).toMatchObject({
      projectId: 'p1',
      healthEventId: 'evt-1',
      severity: 'critical',
      type: 'infra_health_event',
    });
  });

  it('honors push suppression for AWS Health events', () => {
    expect(mapBroadcastToPush({ type: 'infra_health_event', suppressPush: true })).toBeNull();
  });

  it('maps finalize_run_completed to ready_to_push and pushed, forwarding agentId', () => {
    const ready = mapBroadcastToPush({
      type: 'finalize_run_completed',
      status: 'ready_to_push',
      session_id: 's1',
      agentId: 'a1',
      sessionName: 'Ship',
      run_id: 'r1',
    });
    expect(ready?.event).toBe('ready_to_push');
    expect(ready?.payload.data?.sessionId).toBe('s1');
    // agentId forwarded so a cold-start tap can open the right chat.
    expect(ready?.payload.data?.agentId).toBe('a1');

    const pushed = mapBroadcastToPush({
      type: 'finalize_run_completed',
      status: 'pushed',
      sessionId: 's2',
      agentId: 'a2',
      prNumber: 42,
      run_id: 'r2',
    });
    expect(pushed?.event).toBe('pushed');
    expect(pushed?.payload.data?.prNumber).toBe(42);
    expect(pushed?.payload.data?.agentId).toBe('a2');
  });

  it('maps support_ticket_created', () => {
    const r = mapBroadcastToPush({
      type: 'support_ticket_created',
      projectId: 'p1',
      ticket: { id: 't1', subject: 'Help', type: 'bug' },
    });
    expect(r?.event).toBe('support_ticket_created');
    expect(r?.payload.data?.ticketId).toBe('t1');
  });

  it('maps card_moved to review_assigned_to_you only for Review column', () => {
    expect(
      mapBroadcastToPush({
        type: 'card_moved',
        cardId: 'c',
        cardTitle: 'T',
        columnName: 'Review',
      })?.event,
    ).toBe('review_assigned_to_you');
    expect(
      mapBroadcastToPush({
        type: 'card_moved',
        cardId: 'c',
        cardTitle: 'T',
        columnName: 'In Progress',
      }),
    ).toBeNull();
  });

  it('maps native_pr_update review_requested, thread_entry_created, webhook_pr_merged', () => {
    expect(
      mapBroadcastToPush({
        type: 'native_pr_update',
        action: 'review_requested',
        prNumber: 7,
        projectId: 'p1',
      })?.event,
    ).toBe('review_assigned_to_you');

    const entry = mapBroadcastToPush({
      type: 'thread_entry_created',
      projectId: 'p',
      threadId: 't',
      threadName: 'Nightly',
      threadType: 'cron',
      entry: { id: 'e', content: 'ERROR: boom' },
    });
    expect(entry?.event).toBe('thread_message');
    expect(entry?.payload.title).toBe('Thread error');

    expect(
      mapBroadcastToPush({
        type: 'webhook_pr_merged',
        prNumber: 42,
        cardTitle: 'X',
      })?.event,
    ).toBe('pr_merged');
  });
});

describe('handleBroadcastForPush', () => {
  it('dispatches via Expo for a recognised type', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const sent = await handleBroadcastForPush(
      {
        type: 'awaiting_input',
        waiting: true,
        sessionId: 's1',
        sessionName: 'N',
      },
      {
        fetchFn,
        getAllTokens: () => [token('a', null, 'u1')],
        removeToken: () => {},
      },
    );
    expect(sent).toBe(1);
  });

  it('honors infra alert per-token opt-out while retaining project visibility filtering', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const sent = await handleBroadcastForPush(
      {
        type: 'infra_alert_transition',
        projectId: 'project-a',
        alertId: 'alert-a',
        resourceId: 'i-123',
        severity: 'critical',
        ruleName: 'CPU high',
        fromState: 'OK',
        toState: 'ALARM',
      },
      {
        fetchFn,
        getAllTokens: () => [
          token('enabled', ['infra_alert'], 'owner'),
          token('opted-out', ['awaiting_feedback'], 'owner'),
          token('other-project', ['infra_alert'], 'other'),
        ],
        removeToken: () => {},
        findProjectById: () => ({ id: 'project-a', ownerUserId: 'owner' }) as any,
        resolveProjectId: () => 'project-a',
      },
    );
    expect(sent).toBe(1);
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = JSON.parse(String((call[1] as RequestInit).body));
    expect(payload.map((message: ExpoPushMessage) => message.to)).toEqual(['enabled']);
  });

  it('resolves agentId from the session for finalize pushes that lack it', async () => {
    // Regression: finalize_run_completed broadcasts carry no agentId, so a
    // cold-start tap couldn't open the right chat. handleBroadcastForPush must
    // resolve it from the session id before dispatch.
    let capturedData: Record<string, unknown> | undefined;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      capturedData = body[0]?.data as Record<string, unknown>;
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const getSessionAgentIdById = vi.fn((sessionId: string) =>
      sessionId === 's9' ? 'agent-9' : null,
    );
    const sent = await handleBroadcastForPush(
      { type: 'finalize_run_completed', status: 'ready_to_push', session_id: 's9', run_id: 'r1' },
      {
        fetchFn,
        getAllTokens: () => [token('a', null, 'u1')],
        removeToken: () => {},
        getSessionAgentIdById,
      },
    );
    expect(sent).toBe(1);
    expect(getSessionAgentIdById).toHaveBeenCalledWith('s9');
    expect(capturedData?.agentId).toBe('agent-9');
  });

  it('keeps the broadcast agentId without a session lookup when present', async () => {
    const getSessionAgentIdById = vi.fn(() => 'should-not-be-used');
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await handleBroadcastForPush(
      { type: 'awaiting_input', waiting: true, sessionId: 's1', agentId: 'a1' },
      {
        fetchFn,
        getAllTokens: () => [token('a', null, 'u1')],
        removeToken: () => {},
        getSessionAgentIdById,
      },
    );
    expect(getSessionAgentIdById).not.toHaveBeenCalled();
  });

  it('short-circuits for ignored types', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const sent = await handleBroadcastForPush(
      { type: 'room_message' },
      { fetchFn, getAllTokens: () => [token('a', null, 'u1')], removeToken: () => {} },
    );
    expect(sent).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('short-circuits when the broadcast opts out via suppressPush', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const sent = await handleBroadcastForPush(
      {
        type: 'thread_entry_created',
        threadId: 't1',
        projectId: 'p1',
        threadName: 'some cron',
        threadType: 'cron',
        entry: { id: 'e1', content: 'ok' },
        suppressPush: true,
      },
      { fetchFn, getAllTokens: () => [token('a')], removeToken: () => {} },
    );
    expect(sent).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('still dispatches when suppressPush is false or absent', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const sent = await handleBroadcastForPush(
      {
        type: 'thread_entry_created',
        threadId: 't1',
        projectId: 'p1',
        threadName: 'some cron',
        threadType: 'cron',
        entry: { id: 'e1', content: 'ok' },
        suppressPush: false,
      },
      { fetchFn, getAllTokens: () => [token('a')], removeToken: () => {} },
    );
    expect(sent).toBe(1);
  });

  it('filters private-project pushes to owning user tokens only', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await handleBroadcastForPush(
      {
        type: 'awaiting_input',
        waiting: true,
        sessionId: 's-private',
        sessionName: 'N',
      },
      {
        fetchFn,
        getAllTokens: () => [
          token('owner-device', null, 'owner-1'),
          token('other-device', null, 'u2'),
        ],
        removeToken: () => {},
        resolveProjectId: () => 'proj-private',
        findProjectById: () =>
          ({ id: 'proj-private', visibility: 'private', ownerUserId: 'owner-1' }) as any,
      },
    );

    expect(sent).toBe(1);
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = JSON.parse(String((call[1] as RequestInit).body));
    expect(payload).toHaveLength(1);
    expect(payload[0].to).toBe('owner-device');
  });
});

describe('filterTokensForBroadcastVisibility', () => {
  it('keeps cron owner and org Owner tokens for private cron thread entries', () => {
    const out = filterTokensForBroadcastVisibility(
      [
        token('cron-owner', null, 'cron-owner-id'),
        token('org-owner', null, 'org-owner-id'),
        token('regular-user', null, 'regular-user-id'),
        token('legacy-device', null, null),
      ],
      {
        type: 'thread_entry_created',
        projectId: 'p1',
        ownerUserId: 'cron-owner-id',
        cronShared: false,
      },
      {
        resolveProjectId: () => 'p1',
        findProjectById: () =>
          ({ id: 'p1', visibility: 'shared', ownerUserId: 'project-owner' }) as any,
        getUserRoleById: (userId) => (userId === 'org-owner-id' ? 'Owner' : 'User'),
      },
    );
    expect(out.map((t) => t.token)).toEqual(['cron-owner', 'org-owner']);
  });

  it('keeps only the owner token for shared projects with an owner', () => {
    const out = filterTokensForBroadcastVisibility(
      [token('owner', null, 'u1'), token('other', null, 'u2')],
      { type: 'awaiting_input', sessionId: 's1' },
      {
        resolveProjectId: () => 'p1',
        findProjectById: () => ({ id: 'p1', visibility: 'shared', ownerUserId: 'u1' }) as any,
      },
    );
    expect(out.map((t) => t.token)).toEqual(['owner']);
  });

  it('keeps only the owner token for private projects', () => {
    const out = filterTokensForBroadcastVisibility(
      [token('owner', null, 'u1'), token('other', null, 'u2')],
      { type: 'awaiting_input', sessionId: 's1' },
      {
        resolveProjectId: () => 'p1',
        findProjectById: () => ({ id: 'p1', visibility: 'private', ownerUserId: 'u1' }) as any,
      },
    );
    expect(out.map((t) => t.token)).toEqual(['owner']);
  });

  it('keeps all tokens when private project has no owner (legacy rows)', () => {
    const out = filterTokensForBroadcastVisibility(
      [token('a', null, 'u1'), token('b', null, 'u2')],
      { type: 'awaiting_input', sessionId: 's1' },
      {
        resolveProjectId: () => 'p1',
        findProjectById: () => ({ id: 'p1', visibility: 'private', ownerUserId: null }) as any,
      },
    );
    expect(out.map((t) => t.token)).toEqual(['a', 'b']);
  });

  it('excludes an unattributed device token from an owned project (security regression)', () => {
    // A legacy device with no user_id must NOT receive notifications for a
    // project that has an owner — only the owner's tokens should.
    const out = filterTokensForBroadcastVisibility(
      [token('owner', null, 'u1'), token('legacy', null, null)],
      { type: 'awaiting_input', sessionId: 's1' },
      {
        resolveProjectId: () => 'p1',
        findProjectById: () => ({ id: 'p1', visibility: 'private', ownerUserId: 'u1' }) as any,
      },
    );
    expect(out.map((t) => t.token)).toEqual(['owner']);
  });
});

describe('filterTokensForSessionOwner', () => {
  const tokens = () => [
    token('ryan-phone', null, 'ryan'),
    token('kevin-phone', null, 'kevin'),
    token('legacy-device', null, null),
  ];

  it('keeps only the owner devices for an owned session', () => {
    const out = filterTokensForSessionOwner(
      tokens(),
      { type: 'awaiting_input', sessionId: 's1' },
      { getSessionOwnerById: () => 'ryan' },
    );
    expect(out.map((t) => t.token)).toEqual(['ryan-phone']);
  });

  it('keeps all tokens for an unowned session (cron/system/legacy)', () => {
    const out = filterTokensForSessionOwner(
      tokens(),
      { type: 'awaiting_input', sessionId: 's1' },
      { getSessionOwnerById: () => null },
    );
    expect(out.map((t) => t.token)).toEqual(['ryan-phone', 'kevin-phone', 'legacy-device']);
  });

  it('keeps all tokens for events without a sessionId (board/thread fan-out)', () => {
    const getSessionOwnerById = vi.fn(() => 'ryan');
    const out = filterTokensForSessionOwner(
      tokens(),
      { type: 'card_moved', cardId: 'c1' },
      { getSessionOwnerById },
    );
    expect(out).toHaveLength(3);
    expect(getSessionOwnerById).not.toHaveBeenCalled();
  });

  it('excludes unattributed (NULL user) tokens for owned sessions', () => {
    const out = filterTokensForSessionOwner(
      [token('legacy-device', null, null)],
      { type: 'awaiting_input', sessionId: 's1' },
      { getSessionOwnerById: () => 'ryan' },
    );
    expect(out).toHaveLength(0);
  });

  it('handleBroadcastForPush only pushes awaiting_feedback to the owner device', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await handleBroadcastForPush(
      {
        type: 'awaiting_input',
        waiting: true,
        sessionId: 'kevins-session',
        sessionName: 'N',
      },
      {
        fetchFn,
        getAllTokens: tokens,
        removeToken: () => {},
        getSessionOwnerById: (id) => (id === 'kevins-session' ? 'kevin' : null),
      },
    );

    expect(sent).toBe(1);
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = JSON.parse(String((call[1] as RequestInit).body));
    expect(payload).toHaveLength(1);
    expect(payload[0].to).toBe('kevin-phone');
  });

  it('dispatchPushEvent scopes session events to the session owner', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await dispatchPushEvent(
      'ready_to_push',
      { title: 'T', body: 'B', data: { sessionId: 's1', type: 'ready_to_push' } },
      {
        fetchFn,
        getAllTokens: tokens,
        removeToken: () => {},
        getSessionOwnerById: () => 'ryan',
      },
    );

    expect(sent).toBe(1);
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const payload = JSON.parse(String((call[1] as RequestInit).body));
    expect(payload[0].to).toBe('ryan-phone');
  });
});
