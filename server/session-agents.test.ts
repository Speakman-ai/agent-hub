import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionRow, SessionAgentRow, EnrichedAgent } from './types.js';

const getUserPreferencesRow = vi.fn(() => ({}) as Record<string, unknown>);
vi.mock('./user-preferences-store.js', () => ({ getUserPreferencesRow }));

// Dynamic imports so the mocked module is not loaded before the mock's
// closure variable is initialized (static imports hoist above the const).
const { listSessionAgents } = await import('./session-agents.js');
const { default: config } = await import('./config.js');

function fakeAgent(id: string, engine: string): EnrichedAgent {
  return {
    id,
    name: `Agent ${id}`,
    engine,
    color: '#123456',
    projectId: 'proj-1',
    projectName: 'Project One',
    cwd: '/tmp',
    ahw: '/tmp',
    workspace: '/tmp',
  } as EnrichedAgent;
}

function makeStmts(rows: SessionAgentRow[]) {
  return { getSessionAgents: { all: () => rows } } as unknown as Parameters<
    typeof listSessionAgents
  >[0];
}

const session = {
  id: 'session-1',
  agent_id: 'primary',
  engine: 'claude-code',
  model: 'claude-opus-5',
} as SessionRow;

describe('listSessionAgents engine reporting', () => {
  it('reports the override engine and marks engineOverride for a forced advisor', () => {
    const rows: SessionAgentRow[] = [
      {
        id: 'p1',
        session_id: 'session-1',
        agent_id: 'dev',
        model: null,
        engine: 'codex-cli',
        position: 0,
        added_at: '',
      },
    ];
    const roster = listSessionAgents(makeStmts(rows), session, (id) =>
      id === 'primary' ? fakeAgent('primary', 'claude-code') : fakeAgent('dev', 'claude-code'),
    );
    const advisor = roster.find((a) => a.role === 'advisor')!;
    expect(advisor.engine).toBe('codex-cli');
    expect(advisor.engineOverride).toBe('codex-cli');
  });

  it('inherits the agent engine and leaves engineOverride null when unset', () => {
    const rows: SessionAgentRow[] = [
      {
        id: 'p1',
        session_id: 'session-1',
        agent_id: 'dev',
        model: null,
        engine: null,
        position: 0,
        added_at: '',
      },
    ];
    const roster = listSessionAgents(makeStmts(rows), session, (id) =>
      id === 'primary' ? fakeAgent('primary', 'claude-code') : fakeAgent('dev', 'cursor-agent'),
    );
    const advisor = roster.find((a) => a.role === 'advisor')!;
    expect(advisor.engine).toBe('cursor-agent');
    expect(advisor.engineOverride).toBeNull();
  });
});

describe('listSessionAgents effective-engine resolution (config-aware)', () => {
  beforeEach(() => {
    getUserPreferencesRow.mockReset();
    getUserPreferencesRow.mockReturnValue({});
  });

  it('reports the per-user engine override when config is passed and no participant override exists', () => {
    // The reviewer flagged this: without config, an advisor whose owner set a
    // per-user override to Codex/Cursor was still reported as the agent's
    // Claude — diverging from the CLI the spawn actually runs.
    getUserPreferencesRow.mockReturnValue({
      agentEngineOverrides: { dev: { engine: 'cursor-agent' } },
    });
    const rows: SessionAgentRow[] = [
      {
        id: 'p1',
        session_id: 'session-1',
        agent_id: 'dev',
        model: null,
        engine: null,
        position: 0,
        added_at: '',
      },
    ];
    const ownedSession = { ...session, owner_user_id: 'user-1' } as SessionRow;
    const roster = listSessionAgents(
      makeStmts(rows),
      ownedSession,
      (id) =>
        id === 'primary' ? fakeAgent('primary', 'claude-code') : fakeAgent('dev', 'claude-code'),
      config,
    );
    const advisor = roster.find((a) => a.role === 'advisor')!;
    expect(advisor.engine).toBe('cursor-agent');
    // The stored participant override is still null — the UI shows "Agent engine".
    expect(advisor.engineOverride).toBeNull();
  });

  it('participant override still wins over a per-user override when config is passed', () => {
    getUserPreferencesRow.mockReturnValue({
      agentEngineOverrides: { dev: { engine: 'cursor-agent' } },
    });
    const rows: SessionAgentRow[] = [
      {
        id: 'p1',
        session_id: 'session-1',
        agent_id: 'dev',
        model: null,
        engine: 'codex-cli',
        position: 0,
        added_at: '',
      },
    ];
    const ownedSession = { ...session, owner_user_id: 'user-1' } as SessionRow;
    const roster = listSessionAgents(
      makeStmts(rows),
      ownedSession,
      (id) =>
        id === 'primary' ? fakeAgent('primary', 'claude-code') : fakeAgent('dev', 'claude-code'),
      config,
    );
    const advisor = roster.find((a) => a.role === 'advisor')!;
    expect(advisor.engine).toBe('codex-cli');
    expect(advisor.engineOverride).toBe('codex-cli');
  });
});
