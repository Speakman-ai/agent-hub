import './test/setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

const killProcessGroupMock = vi.hoisted(() => vi.fn());
const markSessionTerminationMock = vi.hoisted(() => vi.fn());

vi.mock('./process-groups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-groups.js')>();
  return { ...actual, killProcessGroup: killProcessGroupMock };
});

vi.mock('./process-termination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-termination.js')>();
  return { ...actual, markSessionTermination: markSessionTerminationMock };
});

const { cancelSessionChatRun } = await import('./session-chat-cancel.js');

describe('cancelSessionChatRun', () => {
  beforeEach(() => {
    killProcessGroupMock.mockClear();
    markSessionTerminationMock.mockClear();
  });

  it('marks user_cancel before SIGTERM when a proc is active', () => {
    const sessionId = 'sess-cancel-order';
    const proc = Object.assign(new EventEmitter(), { pid: 99 }) as ChildProcess;
    const activeProcesses = new Map<string, ChildProcess>([[sessionId, proc]]);

    cancelSessionChatRun({ sessionId, activeProcesses });

    expect(markSessionTerminationMock).toHaveBeenCalledTimes(1);
    expect(markSessionTerminationMock).toHaveBeenCalledWith(sessionId, 'user_cancel');
    expect(killProcessGroupMock).toHaveBeenCalledTimes(1);
    expect(killProcessGroupMock).toHaveBeenCalledWith(proc, 'SIGTERM');
    expect(markSessionTerminationMock.mock.invocationCallOrder[0]).toBeLessThan(
      killProcessGroupMock.mock.invocationCallOrder[0],
    );
  });

  it('no-ops when the session has no active proc', () => {
    cancelSessionChatRun({ sessionId: 'idle', activeProcesses: new Map() });
    expect(markSessionTerminationMock).not.toHaveBeenCalled();
    expect(killProcessGroupMock).not.toHaveBeenCalled();
  });
});
