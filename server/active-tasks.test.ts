import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ActiveTaskRow, SessionRow, Stmts } from './types.js';
import { buildActiveTasksSnapshot, buildActiveTasksSnapshotLenient } from './active-tasks.js';
import { activeDelegationSessions, delegationSessionUiMeta } from './delegation-state.js';

describe('buildActiveTasksSnapshot', () => {
  const sessionId = 'sess-deleg';
  const agentId = 'agent-1';

  beforeEach(() => {
    activeDelegationSessions.clear();
    delegationSessionUiMeta.clear();
  });

  afterEach(() => {
    activeDelegationSessions.clear();
    delegationSessionUiMeta.clear();
  });

  it('returns DB active tasks unchanged when no delegation overlay', () => {
    const row: ActiveTaskRow = {
      session_id: sessionId,
      message_id: 'm1',
      agent_id: agentId,
      pid: 123,
      prompt: 'hi',
      streamed_output: 'out',
      engine: 'claude-code',
      model: 'opus',
      status: 'running',
      started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const stmts = {
      getAllActiveTasks: { all: () => [row] },
      getSession: { get: vi.fn() },
    } as unknown as Stmts;

    const snap = buildActiveTasksSnapshot(stmts);
    expect(snap).toHaveLength(1);
    expect(snap[0].sessionId).toBe(sessionId);
    expect(snap[0].content).toBe('out');
  });

  it('adds a synthetic row when delegation is in flight with UI meta', () => {
    activeDelegationSessions.add(sessionId);
    delegationSessionUiMeta.set(sessionId, {
      parentMessageId: 'parent-msg',
      startedAt: '2026-02-01T12:00:00.000Z',
    });

    const sessionRow: SessionRow = {
      id: sessionId,
      agent_id: agentId,
      name: 'Test',
      engine: 'claude-code',
      model: 'opus',
      use_worktree: 1,
      ask_mode: 0,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      worktree_path: null,
      engine_session_id: null,
      pending_skill_context: null,
      git_worktree_detected: 0,
    } as SessionRow;

    const stmts = {
      getAllActiveTasks: { all: () => [] },
      getSession: { get: (id: string) => (id === sessionId ? sessionRow : undefined) },
    } as unknown as Stmts;

    const snap = buildActiveTasksSnapshot(stmts);
    expect(snap).toHaveLength(1);
    expect(snap[0].sessionId).toBe(sessionId);
    expect(snap[0].messageId).toBe('parent-msg');
    expect(snap[0].prompt).toBe('[delegation]');
    expect(snap[0].startedAt).toBe('2026-02-01T12:00:00.000Z');
  });

  it('propagates errors from getAllActiveTasks (REST can return 500)', () => {
    const stmts = {
      getAllActiveTasks: {
        all: () => {
          throw new Error('db down');
        },
      },
      getSession: { get: vi.fn() },
    } as unknown as Stmts;

    expect(() => buildActiveTasksSnapshot(stmts)).toThrow('db down');
  });

  it('does not add overlay for activeDelegationSessions without meta (invalid delegate edge case)', () => {
    activeDelegationSessions.add(sessionId);
    const stmts = {
      getAllActiveTasks: { all: () => [] },
      getSession: { get: vi.fn() },
    } as unknown as Stmts;

    expect(buildActiveTasksSnapshot(stmts)).toHaveLength(0);
  });

  it('skips delegation overlay when DB already has an active task for the session', () => {
    activeDelegationSessions.add(sessionId);
    delegationSessionUiMeta.set(sessionId, {
      parentMessageId: 'parent-msg',
      startedAt: '2026-02-01T12:00:00.000Z',
    });

    const row: ActiveTaskRow = {
      session_id: sessionId,
      message_id: 'm-cli',
      agent_id: agentId,
      pid: 123,
      prompt: 'hi',
      streamed_output: '',
      engine: 'claude-code',
      model: 'opus',
      status: 'running',
      started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const stmts = {
      getAllActiveTasks: { all: () => [row] },
      getSession: { get: vi.fn() },
    } as unknown as Stmts;

    const snap = buildActiveTasksSnapshot(stmts);
    expect(snap).toHaveLength(1);
    expect(snap[0].messageId).toBe('m-cli');
  });

  it('lenient snapshot returns empty array when DB fails (WebSocket connect)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stmts = {
      getAllActiveTasks: {
        all: () => {
          throw new Error('db down');
        },
      },
      getSession: { get: vi.fn() },
    } as unknown as Stmts;

    expect(buildActiveTasksSnapshotLenient(stmts)).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
