import { describe, it, expect, vi } from 'vitest';
import type { ActiveTaskRow, Stmts } from './types.js';
import { buildActiveTasksSnapshot, buildActiveTasksSnapshotLenient } from './active-tasks.js';

describe('buildActiveTasksSnapshot', () => {
  const sessionId = 'sess-1';
  const agentId = 'agent-1';

  it('returns DB active tasks unchanged', () => {
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
    } as unknown as Stmts;

    const snap = buildActiveTasksSnapshot(stmts);
    expect(snap).toHaveLength(1);
    expect(snap[0].sessionId).toBe(sessionId);
    expect(snap[0].content).toBe('out');
  });

  it('propagates errors from getAllActiveTasks (REST can return 500)', () => {
    const stmts = {
      getAllActiveTasks: {
        all: () => {
          throw new Error('db down');
        },
      },
    } as unknown as Stmts;

    expect(() => buildActiveTasksSnapshot(stmts)).toThrow('db down');
  });

  it('lenient snapshot returns empty array when DB fails (WebSocket connect)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stmts = {
      getAllActiveTasks: {
        all: () => {
          throw new Error('db down');
        },
      },
    } as unknown as Stmts;

    expect(buildActiveTasksSnapshotLenient(stmts)).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
