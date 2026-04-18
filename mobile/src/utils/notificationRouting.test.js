import { describe, it, expect } from 'vitest';
import {
  resolveEventKey,
  resolveAgentIdForSession,
  routeNotificationTap,
} from './notificationRouting';

describe('resolveEventKey', () => {
  it('prefers `event` over `type` when both are present', () => {
    expect(resolveEventKey({ event: 'session_complete', type: 'done' })).toBe(
      'session_complete',
    );
  });
  it('falls back to `type` for server-pushed payloads', () => {
    expect(resolveEventKey({ type: 'thread_entry' })).toBe('thread_entry');
  });
  it('returns null for empty / malformed input', () => {
    expect(resolveEventKey(null)).toBeNull();
    expect(resolveEventKey(undefined)).toBeNull();
    expect(resolveEventKey({})).toBeNull();
    expect(resolveEventKey({ event: '' })).toBeNull();
    expect(resolveEventKey({ event: 42 })).toBeNull();
  });
});

describe('resolveAgentIdForSession', () => {
  it('finds agent_id (snake_case, server shape)', () => {
    const sessions = [{ id: 's1', agent_id: 'a1' }, { id: 's2', agent_id: 'a2' }];
    expect(resolveAgentIdForSession('s2', sessions)).toBe('a2');
  });
  it('falls back to agentId (camelCase)', () => {
    expect(resolveAgentIdForSession('s1', [{ id: 's1', agentId: 'a1' }])).toBe('a1');
  });
  it('returns null for missing session / missing list', () => {
    expect(resolveAgentIdForSession('sX', [{ id: 's1', agent_id: 'a1' }])).toBeNull();
    expect(resolveAgentIdForSession('s1', [])).toBeNull();
    expect(resolveAgentIdForSession('s1', null)).toBeNull();
    expect(resolveAgentIdForSession('', [{ id: '', agent_id: 'a1' }])).toBeNull();
  });
});

describe('routeNotificationTap — chat events', () => {
  it('routes session_complete (foreground payload shape) to chat', () => {
    // Foreground payloads include the full broadcast via `...data` spread,
    // so `event` + `agentId` are usually present.
    const data = { event: 'session_complete', sessionId: 's1', agentId: 'a1' };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'chat',
      agentId: 'a1',
      sessionId: 's1',
    });
  });

  it('routes session_complete (server push shape) to chat and resolves agentId from sessions', () => {
    // Server pushes only include `{ sessionId, type }` — we must look up the
    // agentId from the loaded sessions list.
    const data = { type: 'session_complete', sessionId: 's1' };
    const sessions = [{ id: 's1', agent_id: 'a1' }];
    expect(routeNotificationTap(data, { sessions })).toEqual({
      kind: 'chat',
      agentId: 'a1',
      sessionId: 's1',
    });
  });

  it('returns chat with agentId=null when session is not loaded yet', () => {
    const data = { type: 'session_complete', sessionId: 's1' };
    expect(routeNotificationTap(data, { sessions: [] })).toEqual({
      kind: 'chat',
      agentId: null,
      sessionId: 's1',
    });
  });

  it('returns null for chat events missing sessionId', () => {
    expect(routeNotificationTap({ event: 'session_complete' })).toBeNull();
    expect(routeNotificationTap({ type: 'changes_ready' })).toBeNull();
  });

  it('routes changes_ready with agentId carried in payload', () => {
    const data = {
      event: 'changes_ready',
      sessionId: 's9',
      agentId: 'a9',
      branch: 'feature/x',
    };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'chat',
      agentId: 'a9',
      sessionId: 's9',
    });
  });
});

describe('routeNotificationTap — kanban events', () => {
  it.each(['card_started', 'card_review', 'pr_merged'])(
    'routes %s to kanban with cardId',
    (event) => {
      const data = { event, cardId: 'c1', projectId: 'p1' };
      expect(routeNotificationTap(data)).toEqual({
        kind: 'kanban',
        projectId: 'p1',
        cardId: 'c1',
      });
    },
  );

  it('routes kanban events even when projectId / cardId are missing (fallbacks null)', () => {
    expect(routeNotificationTap({ type: 'card_started' })).toEqual({
      kind: 'kanban',
      projectId: null,
      cardId: null,
    });
  });
});

describe('routeNotificationTap — thread events', () => {
  it('routes thread_created to the Threads screen for the project', () => {
    const data = { event: 'thread_created', projectId: 'p1', threadId: 't1' };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'threads',
      projectId: 'p1',
      threadId: 't1',
    });
  });

  it('routes thread_entry with threadId', () => {
    const data = {
      type: 'thread_entry',
      projectId: 'p2',
      threadId: 't2',
      entryId: 'e1',
    };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'threads',
      projectId: 'p2',
      threadId: 't2',
    });
  });

  it('returns null when thread events lack projectId — no screen to open', () => {
    expect(routeNotificationTap({ event: 'thread_created', threadId: 't1' })).toBeNull();
    expect(routeNotificationTap({ type: 'thread_entry' })).toBeNull();
  });
});

describe('routeNotificationTap — dispatch_failure', () => {
  it('routes to kanban when a cardId is present', () => {
    const data = { event: 'dispatch_failure', cardId: 'c1', projectId: 'p1' };
    expect(routeNotificationTap(data)).toEqual({
      kind: 'kanban',
      projectId: 'p1',
      cardId: 'c1',
    });
  });

  it('routes to threads when only projectId is present', () => {
    expect(routeNotificationTap({ event: 'dispatch_failure', projectId: 'p1' })).toEqual({
      kind: 'threads',
      projectId: 'p1',
      threadId: null,
    });
  });

  it('returns null when neither cardId nor projectId is present', () => {
    expect(routeNotificationTap({ event: 'dispatch_failure' })).toBeNull();
  });
});

describe('routeNotificationTap — unknown / malformed', () => {
  it('returns null for unknown event keys', () => {
    expect(routeNotificationTap({ event: 'something_new', sessionId: 's1' })).toBeNull();
  });
  it('returns null for null / undefined / missing discriminator', () => {
    expect(routeNotificationTap(null)).toBeNull();
    expect(routeNotificationTap(undefined)).toBeNull();
    expect(routeNotificationTap({})).toBeNull();
    expect(routeNotificationTap({ sessionId: 's1' })).toBeNull();
  });
});
