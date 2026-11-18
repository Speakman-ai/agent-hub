import { describe, expect, it } from 'vitest';
import { applySpawnedSessionEvent, reconcileSpawnedSnapshot } from './spawnedSessionEvents';

type Row = { id: string; name: string; agent_id: string; state?: string | null };
const asRow = (session: any, parentId: string): Row | null =>
  session?.id && session.spawned_from_session_id === parentId
    ? { id: session.id, name: session.name, agent_id: session.agent_id, state: null }
    : null;
const row = (id: string): Row => ({ id, name: id, agent_id: 'dev', state: null });

describe('reconcileSpawnedSnapshot', () => {
  it('keeps a worker created while the GET was in flight', () => {
    const out = reconcileSpawnedSnapshot(
      { sessions: [row('a')], archived: [] },
      [{ session: { id: 'b', name: 'b', agent_id: 'dev', spawned_from_session_id: 'p' } }],
      'p',
      asRow,
    );
    expect(out.sessions.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('keeps archives and restores made while the GET was in flight', () => {
    const out = reconcileSpawnedSnapshot(
      {
        sessions: [row('a')],
        archived: [{ id: 'old', name: 'old', agent_id: 'dev', deleted_at: 'x' }],
      },
      [
        { type: 'session_deleted', sessionId: 'a' },
        {
          type: 'session_restored',
          sessionId: 'old',
          session: { id: 'old', name: 'old', agent_id: 'dev', spawned_from_session_id: 'p' },
        },
      ],
      'p',
      asRow,
    );
    expect(out.sessions.map((r) => r.id)).toEqual(['old']);
    expect(out.archived.map((r) => r.id)).toEqual(['a']);
  });
});

describe('applySpawnedSessionEvent', () => {
  it('ignores events for other parents and updates state for known rows', () => {
    const start = { sessions: [row('a')], archived: [] };
    expect(
      applySpawnedSessionEvent(
        start,
        { session: { id: 'z', spawned_from_session_id: 'q' } },
        'p',
        asRow,
      ),
    ).toBe(start);
    const next = applySpawnedSessionEvent(
      start,
      { type: 'session_state', sessionId: 'a', state: 'working' },
      'p',
      asRow,
    );
    expect(next.sessions[0]!.state).toBe('working');
  });
});
