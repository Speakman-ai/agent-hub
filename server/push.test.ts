import { describe, it, expect, vi } from 'vitest';
import {
  sessionCompletePush,
  changesReadyPush,
  prCreationStalePush,
  cardStartedPush,
  cardReviewPush,
  prMergedPush,
  threadCreatedPush,
  threadEntryPush,
  dispatchFailurePush,
  cronCompletePush,
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
  it('formats session complete with agent, session, preview', () => {
    expect(
      sessionCompletePush({ agentName: 'Hub Backend', sessionName: 'Add push', preview: 'Done.' }),
    ).toEqual({ title: 'Hub Backend — Done', body: '"Add push" — Done.' });
  });

  it('falls back to "Agent" and a default body when nothing is provided', () => {
    expect(sessionCompletePush({})).toEqual({
      title: 'Agent — Done',
      body: 'Session completed',
    });
  });

  it('truncates preview longer than 120 chars from the end', () => {
    const long = 'x'.repeat(200);
    const { body } = sessionCompletePush({ agentName: 'A', preview: long });
    expect(body.startsWith('…')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(200);
  });

  it('formats changes ready with and without context', () => {
    expect(
      changesReadyPush({ agentName: 'Hub', sessionName: 'Ship', branch: 'feat/x' }).body,
    ).toContain('Hub — "Ship"');
    expect(changesReadyPush({ branch: 'feat/x' }).body).toMatch(
      /An agent has changes on .*feat\/x.*awaiting/,
    );
  });

  it('formats pr_creation_stale with session, branch, and age', () => {
    const { title, body } = prCreationStalePush({
      agentName: 'Hub',
      sessionName: 'Ship it',
      branch: 'feature/x',
      ageMinutes: 42,
    });
    expect(title).toBe('Still waiting — Create PR?');
    expect(body).toBe('"Ship it" on `feature/x` has had changes awaiting PR for 42 min');
  });

  it('formats pr_creation_stale falling back when session/agent absent', () => {
    const { body } = prCreationStalePush({ branch: 'feat/y', ageMinutes: 31 });
    expect(body).toBe('A session on `feat/y` has had changes awaiting PR for 31 min');
  });

  it('formats pr_creation_stale without age suffix when age is missing or non-positive', () => {
    expect(prCreationStalePush({ sessionName: 'S' }).body).toBe('"S" has had changes awaiting PR');
    expect(prCreationStalePush({ sessionName: 'S', ageMinutes: 0 }).body).toBe(
      '"S" has had changes awaiting PR',
    );
  });

  it('formats card started / review / pr merged', () => {
    expect(cardStartedPush({ cardTitle: 'X', assignee: 'A' }).body).toBe('"X" started by A');
    expect(cardReviewPush({ cardTitle: 'X' }).body).toBe('"X" moved to Review');
    expect(prMergedPush({ cardTitle: 'X', prNumber: 12, mergedBy: 'dev' }).body).toBe(
      'PR #12 merged by dev: "X"',
    );
  });

  it('formats thread events with heartbeat vs cron labels', () => {
    expect(threadCreatedPush({ threadName: 'T', threadType: 'heartbeat' }).body).toContain(
      'Heartbeat',
    );
    expect(threadEntryPush({ threadName: 'T', threadType: 'cron', isError: true }).title).toBe(
      'Cron Error',
    );
    const trimmed = threadEntryPush({
      threadName: 'T',
      threadType: 'cron',
      preview: 'y'.repeat(200),
    }).body;
    expect(trimmed.endsWith('…')).toBe(true);
  });

  it('formats dispatch failure and truncates long messages', () => {
    const long = 'z'.repeat(300);
    const { title, body } = dispatchFailurePush({ message: long });
    expect(title).toBe('Dispatch Failure');
    expect(body.endsWith('…')).toBe(true);
  });

  it('formats cron completion and truncates long results', () => {
    const long = 'q'.repeat(300);
    const { title, body } = cronCompletePush({ cronName: 'nightly', result: long });
    expect(title).toBe('Cron: nightly');
    expect(body.endsWith('...')).toBe(true);
  });
});

describe('parseEnabledEvents / tokenAcceptsEvent', () => {
  it('returns undefined (all enabled) for null/empty', () => {
    expect(parseEnabledEvents(null)).toBeUndefined();
    expect(parseEnabledEvents('')).toBeUndefined();
    expect(parseEnabledEvents(undefined)).toBeUndefined();
  });

  it('parses a JSON array into a Set', () => {
    const s = parseEnabledEvents('["cron","card_review"]');
    expect(s).toBeInstanceOf(Set);
    expect(s?.has('cron')).toBe(true);
    expect(s?.has('card_review')).toBe(true);
  });

  it('treats malformed JSON as legacy default (undefined)', () => {
    expect(parseEnabledEvents('not-json')).toBeUndefined();
    expect(parseEnabledEvents('{"oops":true}')).toBeUndefined();
  });

  it('accepts all events when token has no preferences', () => {
    expect(tokenAcceptsEvent(token('t'), 'session_complete')).toBe(true);
    expect(tokenAcceptsEvent(token('t'), 'cron')).toBe(true);
  });

  it('only accepts enumerated events when preferences are set', () => {
    const row = token('t', ['cron']);
    expect(tokenAcceptsEvent(row, 'cron')).toBe(true);
    expect(tokenAcceptsEvent(row, 'session_complete')).toBe(false);
  });

  it('PUSH_EVENT_TYPES includes every dispatched event', () => {
    const required: (typeof PUSH_EVENT_TYPES)[number][] = [
      'session_complete',
      'changes_ready',
      'pr_creation_stale',
      'card_started',
      'card_review',
      'pr_merged',
      'thread_created',
      'thread_entry',
      'dispatch_failure',
      'cron',
      // Finalize fix-dispatch stall watchdog reminder (live mode). See
      // `server/finalize/stall-watchdog.ts` + wiki §7
      // "Human-walked-away behavior".
      'finalize_stall_warning',
    ];
    for (const e of required) expect(PUSH_EVENT_TYPES).toContain(e);
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
    const tokens = [token('all'), token('cronOnly', ['cron'])];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await dispatchPushEvent(
      'session_complete',
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
      'cron',
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
      'pr_creation_stale',
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
  });

  it('maps done → session_complete and strips newlines from preview', () => {
    const r = mapBroadcastToPush({
      type: 'done',
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'Hub Backend',
      sessionName: 'My session',
      message: { content: 'All\n\ndone.' },
    });
    expect(r?.event).toBe('session_complete');
    expect(r?.payload.title).toBe('Hub Backend — Done');
    expect(r?.payload.body).toContain('All done.');
    expect(r?.payload.data?.sessionId).toBe('s1');
    // agentId is forwarded so mobile notification taps can route to the
    // right agent without a second round-trip.
    expect(r?.payload.data?.agentId).toBe('a1');
  });

  it('maps changes_ready with branch + ids in data', () => {
    const r = mapBroadcastToPush({
      type: 'changes_ready',
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'Hub Backend',
      branch: 'feat/x',
    });
    expect(r?.event).toBe('changes_ready');
    expect(r?.payload.data?.branch).toBe('feat/x');
  });

  it('maps card_moved to started/review by column name and ignores others', () => {
    expect(
      mapBroadcastToPush({
        type: 'card_moved',
        cardId: 'c',
        cardTitle: 'T',
        columnName: 'In Progress',
      })?.event,
    ).toBe('card_started');
    expect(
      mapBroadcastToPush({
        type: 'card_moved',
        cardId: 'c',
        cardTitle: 'T',
        columnName: 'Review',
      })?.event,
    ).toBe('card_review');
    expect(
      mapBroadcastToPush({
        type: 'card_moved',
        cardId: 'c',
        cardTitle: 'T',
        columnName: 'Done',
      }),
    ).toBeNull();
  });

  it('maps webhook_pr_merged, thread_created, thread_entry_created, dispatch_failure', () => {
    expect(
      mapBroadcastToPush({
        type: 'webhook_pr_merged',
        prNumber: 42,
        cardTitle: 'X',
      })?.event,
    ).toBe('pr_merged');
    expect(
      mapBroadcastToPush({
        type: 'thread_created',
        projectId: 'p',
        thread: { id: 't', name: 'Nightly', type: 'cron' },
      })?.event,
    ).toBe('thread_created');
    const entry = mapBroadcastToPush({
      type: 'thread_entry_created',
      projectId: 'p',
      threadId: 't',
      threadName: 'Nightly',
      threadType: 'cron',
      entry: { id: 'e', content: 'ERROR: boom' },
    });
    expect(entry?.event).toBe('thread_entry');
    expect(entry?.payload.title).toBe('Cron Error');
    expect(mapBroadcastToPush({ type: 'dispatch_failure', message: 'failed' })?.event).toBe(
      'dispatch_failure',
    );
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
        type: 'done',
        sessionId: 's1',
        agentName: 'Hub',
        sessionName: 'N',
        message: { content: 'ok' },
      },
      {
        fetchFn,
        getAllTokens: () => [token('a', null, 'u1')],
        removeToken: () => {},
      },
    );
    expect(sent).toBe(1);
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
        // A thread_entry_created for a cron with notify_on_run=0 — the
        // runner marks the broadcast with suppressPush so mobile devices
        // don't get a "Cron Update" push.
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
        type: 'done',
        sessionId: 's-private',
        agentName: 'Hub',
        sessionName: 'N',
        message: { content: 'ok' },
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
  it('keeps all tokens for shared projects', () => {
    const out = filterTokensForBroadcastVisibility(
      [token('a', null, 'u1'), token('b', null, 'u2')],
      { type: 'done', sessionId: 's1' },
      {
        resolveProjectId: () => 'p1',
        findProjectById: () => ({ id: 'p1', visibility: 'shared', ownerUserId: 'u1' }) as any,
      },
    );
    expect(out.map((t) => t.token)).toEqual(['a', 'b']);
  });

  it('keeps only the owner token for private projects', () => {
    const out = filterTokensForBroadcastVisibility(
      [token('owner', null, 'u1'), token('other', null, 'u2')],
      { type: 'done', sessionId: 's1' },
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
      { type: 'done', sessionId: 's1' },
      {
        resolveProjectId: () => 'p1',
        findProjectById: () => ({ id: 'p1', visibility: 'private', ownerUserId: null }) as any,
      },
    );
    expect(out.map((t) => t.token)).toEqual(['a', 'b']);
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
      { type: 'done', sessionId: 's1' },
      { getSessionOwnerById: () => 'ryan' },
    );
    expect(out.map((t) => t.token)).toEqual(['ryan-phone']);
  });

  it('keeps all tokens for an unowned session (cron/system/legacy)', () => {
    const out = filterTokensForSessionOwner(
      tokens(),
      { type: 'done', sessionId: 's1' },
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
      { type: 'done', sessionId: 's1' },
      { getSessionOwnerById: () => 'ryan' },
    );
    expect(out).toHaveLength(0);
  });

  it('handleBroadcastForPush only pushes session_complete to the owner device', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await handleBroadcastForPush(
      {
        type: 'done',
        sessionId: 'kevins-session',
        agentName: 'Hub',
        sessionName: 'N',
        message: { content: 'ok' },
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

  it('dispatchPushEvent scopes pr_creation_stale to the session owner', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      return {
        json: async () => ({ data: body.map(() => ({ status: 'ok' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sent = await dispatchPushEvent(
      'pr_creation_stale',
      { title: 'T', body: 'B', data: { sessionId: 's1', type: 'pr_creation_stale' } },
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
