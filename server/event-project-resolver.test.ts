import { describe, it, expect, vi } from 'vitest';
import {
  resolveProjectIdFromEvent,
  type BroadcastEvent,
  type EventProjectResolverDeps,
} from './event-project-resolver.js';

function makeDeps(overrides: Partial<EventProjectResolverDeps> = {}): EventProjectResolverDeps {
  return {
    getSessionAgentId: () => null,
    getCardBoardId: () => null,
    getBoardProjectId: () => null,
    getAgentProjectId: () => null,
    ...overrides,
  };
}

describe('resolveProjectIdFromEvent', () => {
  it('returns null for null / non-object input', () => {
    expect(resolveProjectIdFromEvent(null)).toBeNull();
    expect(resolveProjectIdFromEvent(undefined)).toBeNull();
    expect(resolveProjectIdFromEvent({} as BroadcastEvent)).toBeNull();
  });

  it('uses explicit projectId when present (fast path)', () => {
    const deps = makeDeps({
      // These should never fire because the explicit projectId wins.
      getSessionAgentId: vi.fn(),
      getAgentProjectId: vi.fn(),
    });
    expect(resolveProjectIdFromEvent({ type: 'kanban_update', projectId: 'proj-1' }, deps)).toBe(
      'proj-1',
    );
    expect(deps.getSessionAgentId).not.toHaveBeenCalled();
    expect(deps.getAgentProjectId).not.toHaveBeenCalled();
  });

  it('ignores non-string projectId values', () => {
    const deps = makeDeps({ getAgentProjectId: () => 'proj-from-agent' });
    expect(
      resolveProjectIdFromEvent(
        { projectId: 42, agentId: 'a1' } as unknown as BroadcastEvent,
        deps,
      ),
    ).toBe('proj-from-agent');
  });

  it('resolves via sessionId → agent → project', () => {
    const deps = makeDeps({
      getSessionAgentId: (sid) => (sid === 'sess-1' ? 'agent-1' : null),
      getAgentProjectId: (aid) => (aid === 'agent-1' ? 'proj-x' : null),
    });
    expect(resolveProjectIdFromEvent({ type: 'done', sessionId: 'sess-1' }, deps)).toBe('proj-x');
  });

  it('resolves via cardId → board → project', () => {
    const deps = makeDeps({
      getCardBoardId: (cid) => (cid === 'card-1' ? 'board-1' : null),
      getBoardProjectId: (bid) => (bid === 'board-1' ? 'proj-y' : null),
    });
    expect(resolveProjectIdFromEvent({ type: 'card_moved', cardId: 'card-1' }, deps)).toBe(
      'proj-y',
    );
  });

  it('resolves via agentId when no session/card info is present', () => {
    const deps = makeDeps({
      getAgentProjectId: (aid) => (aid === 'agent-7' ? 'proj-z' : null),
    });
    expect(resolveProjectIdFromEvent({ type: 'agent_event', agentId: 'agent-7' }, deps)).toBe(
      'proj-z',
    );
  });

  it('returns null when none of the lookups resolve', () => {
    const deps = makeDeps({
      // All lookups return null.
    });
    expect(resolveProjectIdFromEvent({ type: 'done', sessionId: 'unknown' }, deps)).toBeNull();
  });

  it('falls through from sessionId → cardId when session lookup misses', () => {
    const deps = makeDeps({
      // sessionId fails to resolve (e.g. session row deleted) but cardId
      // is still present and resolvable. The resolver should attempt the
      // next strategy rather than short-circuit.
      getSessionAgentId: () => null,
      getCardBoardId: (cid) => (cid === 'card-1' ? 'board-1' : null),
      getBoardProjectId: () => 'proj-fallback',
    });
    expect(
      resolveProjectIdFromEvent({ type: 'mixed', sessionId: 'gone', cardId: 'card-1' }, deps),
    ).toBe('proj-fallback');
  });

  it('falls through from cardId → agentId when card lookup misses', () => {
    const deps = makeDeps({
      getCardBoardId: () => null,
      getAgentProjectId: (aid) => (aid === 'agent-1' ? 'proj-agent' : null),
    });
    expect(
      resolveProjectIdFromEvent({ type: 'mixed', cardId: 'gone', agentId: 'agent-1' }, deps),
    ).toBe('proj-agent');
  });

  it('treats empty-string ids as absent', () => {
    const deps = makeDeps({
      getSessionAgentId: vi.fn(),
      getCardBoardId: vi.fn(),
      getAgentProjectId: vi.fn(),
    });
    expect(
      resolveProjectIdFromEvent({ projectId: '', sessionId: '', cardId: '', agentId: '' }, deps),
    ).toBeNull();
    expect(deps.getSessionAgentId).not.toHaveBeenCalled();
    expect(deps.getCardBoardId).not.toHaveBeenCalled();
    expect(deps.getAgentProjectId).not.toHaveBeenCalled();
  });
});
