import { describe, expect, it, vi } from 'vitest';
import {
  drainIdleQueuedSessions,
  isPidAlive,
  isSessionChatBusy,
  logQueueDrainPoll,
} from './session-chat-busy.js';
import type { ActiveTaskRow } from './types.js';

describe('isPidAlive', () => {
  it('returns false for null, zero, and negative pids', () => {
    expect(isPidAlive(null)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  it('returns true for the current process pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('isSessionChatBusy', () => {
  const task = (overrides: Partial<ActiveTaskRow> = {}): ActiveTaskRow =>
    ({
      session_id: 'sess-1',
      message_id: 'msg-1',
      agent_id: 'agent-1',
      pid: null,
      prompt: 'p',
      streamed_output: '',
      engine: 'claude-code',
      model: null,
      status: 'running',
      started_at: '',
      updated_at: '',
      ...overrides,
    }) as ActiveTaskRow;

  it('is busy when an active process holds the session', () => {
    const procs = new Map([['sess-1', {}]]);
    expect(isSessionChatBusy('sess-1', procs)).toBe(true);
  });

  it('is not busy when only a stale active_tasks row remains (dead pid)', () => {
    expect(isSessionChatBusy('sess-1', new Map(), task({ pid: 999_999_999 }))).toBe(false);
  });

  it('is busy when active_tasks is running without pid (pre-spawn window)', () => {
    expect(isSessionChatBusy('sess-1', new Map(), task({ pid: null }))).toBe(true);
  });

  it('is not busy when active_tasks status is not running', () => {
    expect(isSessionChatBusy('sess-1', new Map(), task({ status: 'done', pid: 1 }))).toBe(false);
  });
});

describe('drainIdleQueuedSessions', () => {
  it('drains queues for idle sessions and skips busy ones', () => {
    const drainQueue = vi.fn();
    const activeProcesses = new Map<string, unknown>([['busy', {}]]);

    const stmts = {
      getAllQueuedSessions: {
        all: () => [{ session_id: 'idle' }, { session_id: 'busy' }],
      },
      getQueuedMessages: {
        all: (sessionId: string) =>
          sessionId === 'idle' || sessionId === 'busy' ? [{ id: 'q1' }] : [],
      },
      getActiveTask: {
        get: (sessionId: string) =>
          sessionId === 'busy'
            ? ({ status: 'running', pid: process.pid } as ActiveTaskRow)
            : undefined,
      },
    };

    const n = drainIdleQueuedSessions({
      stmts: stmts as never,
      activeProcesses,
      drainQueue,
    });

    expect(n).toBe(1);
    expect(drainQueue).toHaveBeenCalledTimes(1);
    expect(drainQueue).toHaveBeenCalledWith('idle');
  });
});

describe('logQueueDrainPoll', () => {
  it('emits a fixed-shape greppable line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logQueueDrainPoll('attempt', 'sess-abc', 2);
    expect(spy.mock.calls[0][0]).toBe('[QueueDrain] event=attempt session=sess-abc queued=2');
    spy.mockRestore();
  });
});
