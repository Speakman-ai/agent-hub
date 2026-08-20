/**
 * Release gate evaluator — the pure completion-condition decision. Sessions and
 * epics resolve to complete / pending / missing; the gate is satisfied only when
 * every selection is complete, and blocked (never satisfied) when any selection
 * was deleted. Uses injected resolvers — no database.
 */
import { describe, it, expect } from 'vitest';
import { evaluateReleaseGate, type ReleaseGateResolvers } from './release-gate-evaluator.js';
import type { DeploymentEnvironmentReleaseGateRow } from '../types.js';

function gate(sessionIds: string[], epicIds: string[]): DeploymentEnvironmentReleaseGateRow {
  return {
    id: 'g1',
    project_id: 'p1',
    environment_name: 'prod',
    ref: 'main',
    session_ids: JSON.stringify(sessionIds),
    epic_ids: JSON.stringify(epicIds),
    owner_user_id: null,
    status: 'armed',
    enabled: 1,
    fired_deployment_id: null,
    last_error: null,
    resolved_at: null,
    meta: null,
    created_at: '',
    updated_at: '',
  };
}

function resolvers(
  sessions: Record<string, 'complete' | 'pending' | 'missing'>,
  epics: Record<string, 'complete' | 'pending' | 'missing'>,
): ReleaseGateResolvers {
  return {
    sessionState: (id) => sessions[id] ?? 'missing',
    epicState: (id) => epics[id] ?? 'missing',
  };
}

describe('evaluateReleaseGate', () => {
  it('is satisfied when every session and epic is complete', () => {
    const e = evaluateReleaseGate(
      gate(['s1', 's2'], ['e1']),
      resolvers({ s1: 'complete', s2: 'complete' }, { e1: 'complete' }),
    );
    expect(e.satisfied).toBe(true);
    expect(e.blocked).toBe(false);
    expect(e).toMatchObject({
      sessionsComplete: 2,
      sessionsTotal: 2,
      epicsComplete: 1,
      epicsTotal: 1,
    });
  });

  it('is pending (not satisfied) when a session is not yet merged', () => {
    const e = evaluateReleaseGate(
      gate(['s1', 's2'], []),
      resolvers({ s1: 'complete', s2: 'pending' }, {}),
    );
    expect(e.satisfied).toBe(false);
    expect(e.blocked).toBe(false);
    expect(e.sessionsComplete).toBe(1);
  });

  it('is pending when an epic is not done', () => {
    const e = evaluateReleaseGate(gate([], ['e1']), resolvers({}, { e1: 'pending' }));
    expect(e.satisfied).toBe(false);
    expect(e.epicsComplete).toBe(0);
  });

  it('blocks (never satisfies) when a selected session was deleted', () => {
    const e = evaluateReleaseGate(
      gate(['s1', 'gone'], ['e1']),
      resolvers({ s1: 'complete' }, { e1: 'complete' }),
    );
    expect(e.blocked).toBe(true);
    expect(e.satisfied).toBe(false);
    expect(e.sessions.find((s) => s.id === 'gone')?.state).toBe('missing');
  });

  it('blocks when a selected epic was deleted even if all sessions merged', () => {
    const e = evaluateReleaseGate(gate(['s1'], ['gone']), resolvers({ s1: 'complete' }, {}));
    expect(e.blocked).toBe(true);
    expect(e.satisfied).toBe(false);
  });

  it('supports a sessions-only gate', () => {
    const e = evaluateReleaseGate(gate(['s1'], []), resolvers({ s1: 'complete' }, {}));
    expect(e.satisfied).toBe(true);
  });

  it('supports an epics-only gate', () => {
    const e = evaluateReleaseGate(gate([], ['e1']), resolvers({}, { e1: 'complete' }));
    expect(e.satisfied).toBe(true);
  });

  it('never satisfies an empty gate (no vacuous truth)', () => {
    const e = evaluateReleaseGate(gate([], []), resolvers({}, {}));
    expect(e.satisfied).toBe(false);
  });
});
