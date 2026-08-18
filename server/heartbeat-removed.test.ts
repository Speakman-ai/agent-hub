/**
 * Per-agent heartbeats are retired. These tests would have failed while the
 * scheduler, job enqueue path, or REST surface still treated heartbeats as live.
 */
import { describe, expect, it } from 'vitest';
import type { EnrichedAgent } from './types.js';
import { getRequest } from './test/helpers.js';
import * as heartbeat from './heartbeat.js';

const enabledHeartbeatAgent = {
  id: 'agent-hb',
  name: 'HB Agent',
  engine: 'claude-code',
  heartbeat: { enabled: true, interval: '* * * * *', prompt: 'check in' },
} as unknown as EnrichedAgent;

describe('per-agent heartbeats removed', () => {
  it('does not export run, dispatch, or reschedule heartbeat', () => {
    expect('runHeartbeat' in heartbeat).toBe(false);
    expect('dispatchHeartbeat' in heartbeat).toBe(false);
    expect('rescheduleHeartbeat' in heartbeat).toBe(false);
  });

  it('scheduleAll does not schedule heartbeat tasks even when agents have them enabled', () => {
    heartbeat.scheduleAll([enabledHeartbeatAgent]);
    expect(heartbeat.scheduledTaskKeys().filter((key) => key.startsWith('heartbeat:'))).toEqual([]);
  });
});

describe('GET /api/heartbeats* is gone', () => {
  it('returns 404 for list, state, logs, thread, update, and run', async () => {
    const request = await getRequest();
    await request.get('/api/heartbeats').expect(404);
    await request.get('/api/heartbeats/state').expect(404);
    await request.get('/api/heartbeats/agent-1/logs').expect(404);
    await request.get('/api/heartbeats/agent-1/thread').expect(404);
    await request.put('/api/heartbeats/agent-1').send({ enabled: true }).expect(404);
    await request.post('/api/heartbeats/agent-1/run').expect(404);
  });
});
