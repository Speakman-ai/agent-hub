import { describe, it, expect } from 'vitest';
import {
  resolveStreamingFromSnapshot,
  resolveLiveStreamIdentity,
  buildStreamingAgentState,
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
      streamingModel: 'claude-opus-4-8',
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
      streamingModel: null,
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
      streamingModel: null,
      agentId: null,
      thinking: true,
    });
  });
});

describe('resolveLiveStreamIdentity', () => {
  it('labels an in-session reviewer with its own name, engine, and model', () => {
    expect(
      resolveLiveStreamIdentity({
        streamingAgent: {
          agentId: 'portfolio-reviewer',
          agentName: 'Portfolio Reviewer',
          engine: 'grok-cli',
          model: 'grok-4.6',
        },
        streamingEngine: 'grok-cli',
        sessionAgentName: 'Portfolio Dev',
        sessionAgentColor: '#111',
        sessionModel: 'claude-opus-5',
      }),
    ).toEqual({
      agentName: 'Portfolio Reviewer',
      agentColor: '#111',
      engine: 'grok-cli',
      model: 'grok-4.6',
    });
  });

  it('falls back to the session agent when nobody else is streaming', () => {
    expect(
      resolveLiveStreamIdentity({
        streamingAgent: null,
        streamingEngine: null,
        sessionAgentName: 'Portfolio Dev',
        sessionAgentColor: '#111',
        sessionModel: 'claude-opus-5',
      }),
    ).toEqual({
      agentName: 'Portfolio Dev',
      agentColor: '#111',
      engine: null,
      model: 'claude-opus-5',
    });
  });
});

describe('buildStreamingAgentState', () => {
  it('returns null when the frame has no agentId (session agent)', () => {
    expect(buildStreamingAgentState({ engine: 'claude-code' })).toBeNull();
  });

  it('keeps engine/model from the thinking frame when a later stream omits them', () => {
    const prev = buildStreamingAgentState({
      agentId: 'rev-1',
      agentName: 'Reviewer',
      engine: 'grok-cli',
      model: 'grok-4.6',
    });
    expect(
      buildStreamingAgentState({ agentId: 'rev-1', agentName: 'Reviewer' }, undefined, prev),
    ).toMatchObject({ engine: 'grok-cli', model: 'grok-4.6' });
  });
});
