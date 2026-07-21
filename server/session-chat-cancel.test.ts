import './test/setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

const killProcessGroupMock = vi.hoisted(() => vi.fn());
const markSessionTerminationMock = vi.hoisted(() => vi.fn());
const requestReactChainCancelMock = vi.hoisted(() => vi.fn());

vi.mock('./process-groups.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-groups.js')>();
  return { ...actual, killProcessGroup: killProcessGroupMock };
});

vi.mock('./process-termination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process-termination.js')>();
  return { ...actual, markSessionTermination: markSessionTerminationMock };
});

vi.mock('./react-chain-cancel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./react-chain-cancel.js')>();
  return { ...actual, requestReactChainCancel: requestReactChainCancelMock };
});

const { cancelSessionChatRun } = await import('./session-chat-cancel.js');

describe('cancelSessionChatRun', () => {
  beforeEach(() => {
    killProcessGroupMock.mockClear();
    markSessionTerminationMock.mockClear();
    requestReactChainCancelMock.mockClear();
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

  it('always requests a ReAct chain-cancel, including when a proc is active', () => {
    const sessionId = 'sess-chain-cancel';
    const proc = Object.assign(new EventEmitter(), { pid: 7 }) as ChildProcess;
    cancelSessionChatRun({
      sessionId,
      activeProcesses: new Map<string, ChildProcess>([[sessionId, proc]]),
    });
    expect(requestReactChainCancelMock).toHaveBeenCalledWith(sessionId);
  });

  it('requests a ReAct chain-cancel even when the session has no active proc', () => {
    // Regression: a Stop landing in the inter-turn window (host actions
    // running / setImmediate gap before the next auto-continuation spawns) has
    // no process to SIGTERM. Without the chain-cancel flag the queued
    // continuation would run to completion after the user hit Stop.
    cancelSessionChatRun({ sessionId: 'idle', activeProcesses: new Map() });
    expect(requestReactChainCancelMock).toHaveBeenCalledTimes(1);
    expect(requestReactChainCancelMock).toHaveBeenCalledWith('idle');
    expect(markSessionTerminationMock).not.toHaveBeenCalled();
    expect(killProcessGroupMock).not.toHaveBeenCalled();
  });
});
