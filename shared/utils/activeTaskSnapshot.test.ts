import { describe, it, expect } from 'vitest';
import {
  resolveStreamingFromSnapshot,
  type ActiveTaskSnapshotEntry,
} from './activeTaskSnapshot.js';

const task = (overrides: Partial<ActiveTaskSnapshotEntry> = {}): ActiveTaskSnapshotEntry => ({
  messageId: 'msg-1',
  agentId: 'agent-1',
  content: 'partial answer',
  engine: 'claude-code',
  model: 'claude-opus-4-8',
  ...overrides,
});

describe('resolveStreamingFromSnapshot', () => {
  it('restores streaming state for a session with a live run', () => {
    expect(resolveStreamingFromSnapshot({ s1: task() }, 's1')).toEqual({
      streamingMsgId: 'msg-1',
      streamingContent: 'partial answer',
      streamingEngine: 'claude-code',
      agentId: 'agent-1',
      thinking: false,
    });
  });

  it('reports thinking while the live run has produced no text yet', () => {
    const out = resolveStreamingFromSnapshot({ s1: task({ content: '' }) }, 's1');
    expect(out).toMatchObject({ streamingMsgId: 'msg-1', thinking: true });
  });

  // Regression: "Sessions kill processes but continue to wait". The snapshot
  // handler used to restore streaming state but never clear it, so a run whose
  // process was killed without a terminal frame reaching this client kept the
  // green "streaming" dot and the Interrupt badge up indefinitely — a reconnect
  // could not recover it, because the snapshot proving the run was gone was
  // ignored.
  it('clears streaming state when the viewed session has no live run', () => {
    expect(resolveStreamingFromSnapshot({}, 's1')).toEqual({
      streamingMsgId: null,
      streamingContent: '',
      streamingEngine: null,
      agentId: null,
      thinking: false,
    });
  });

  it('clears when other sessions are live but the viewed one is not', () => {
    const out = resolveStreamingFromSnapshot({ other: task() }, 's1');
    expect(out).toMatchObject({ streamingMsgId: null, thinking: false });
  });

  it('leaves state alone when no session is in view', () => {
    expect(resolveStreamingFromSnapshot({ s1: task() }, null)).toBeNull();
    expect(resolveStreamingFromSnapshot({ s1: task() }, undefined)).toBeNull();
    expect(resolveStreamingFromSnapshot({}, '')).toBeNull();
  });

  it('normalises missing optional fields', () => {
    const out = resolveStreamingFromSnapshot({ s1: { messageId: 'm' } }, 's1');
    expect(out).toEqual({
      streamingMsgId: 'm',
      streamingContent: '',
      streamingEngine: null,
      agentId: null,
      thinking: true,
    });
  });
});
