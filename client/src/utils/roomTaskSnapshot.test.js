import { describe, it, expect } from 'vitest';
import {
  shouldApplyRoomTaskSnapshot,
  roomStreamingStateFromSnapshotTask,
} from './roomTaskSnapshot.js';

describe('shouldApplyRoomTaskSnapshot', () => {
  it('allows snapshot when no live room events since reconnect', () => {
    expect(shouldApplyRoomTaskSnapshot(100, 200)).toBe(true);
  });

  it('skips snapshot when a live room event arrived after reconnect', () => {
    expect(shouldApplyRoomTaskSnapshot(300, 200)).toBe(false);
  });
});

describe('roomStreamingStateFromSnapshotTask', () => {
  it('maps streamed_output to roomStreaming', () => {
    const out = roomStreamingStateFromSnapshotTask({
      agent_id: 'a1',
      agent_name: 'Dev',
      streamed_output: 'partial text',
      message_id: 'm1',
    });
    expect(out.roomProcessing).toBe(true);
    expect(out.roomThinking).toBeNull();
    expect(out.roomStreaming?.content).toBe('partial text');
  });

  it('uses roomThinking when output is empty', () => {
    const out = roomStreamingStateFromSnapshotTask({
      agent_id: 'a1',
      agent_name: 'Dev',
      streamed_output: '',
    });
    expect(out.roomStreaming).toBeNull();
    expect(out.roomThinking?.agentId).toBe('a1');
  });
});
